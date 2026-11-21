// Feedback actions: resolving, reopening and collapsing threads, and sending
// feedback notes and replies to the artifact.
import type { FeedbackExportResponse, ThreadActionKind, ThreadActionResponse } from "../../scripts/src/shared/viewer-protocol";
import { AGENT_COMMAND, agent, autoSendFeedback, requestReplyNotifications, sendingDrafts, type DraftSelection } from "./agent";
import * as api from "./api";
import { app, data } from "./context";
import { compose, draftSnapshots, rememberDraftSnapshot, replyEditId } from "./editor";
import { artifactThreadById } from "./lookups";
import { collapseThenRender } from "./navigation";
import { adoptViewerSnapshot } from "./polling";
import { render } from "./render";
import { persist, state } from "./state";
import { labelFor } from "./thread-models";
import { artifactThreadsForElement, heldThreadCopies, localVisibleForElement, noteAt, pendingFeedback, pendingReplies, threadCollapsed, threadLineId, threadOps } from "./threads";
import { errorMessage, failureOf } from "./narrow";
import type { Note } from "./types";
import { cssEsc } from "./util";

/** The last send: idle, in progress, failed or done, with what was skipped. */
export interface ExportState {
  phase: "idle" | "working" | "error" | "done";
  message: string;
  skips?: string[];
}
export let exportState: ExportState = { phase: "idle", message: "" };
/** Whether a send is in progress; a function, so a check after an await reads the current state. */
export const exportWorking = (): boolean => exportState.phase === "working";


// Mark a thread resolved / reopen it. Only the reviewer controls closure.
// Rendering keeps scroll and drafts while refreshing every count and grouped
// list after a successful mutation.
export async function threadAction(threadId: string, kind: ThreadActionKind): Promise<void> {
  const thread = artifactThreadById(threadId);
  if (!thread) return;
  threadOps[threadId] = { busy: true, error: "" };
  render();
  try {
    const res = await api.threadAction(kind, { implementationId: data.implementationId, threadId });
    let out: ThreadActionResponse | null = null;
    try { out = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !out?.ok) throw new Error((out && failureOf(out).error) || `Action failed (HTTP ${res.status}).`);
    const read = "status" in out ? out : null;
    adoptViewerSnapshot(read ?? undefined);
    for (const copy of [thread, ...heldThreadCopies(threadId)]) {
      if (read?.status) copy.status = read.status;
      if (read) copy.resolvedAt = read.resolvedAt;
    }
    threadOps[threadId] = { busy: false, error: "" };
    if (!state.threadCollapsed) state.threadCollapsed = {};
    if (kind === "resolve") state.threadCollapsed[threadId] = true;
    else if (kind === "reopen") state.threadCollapsed[threadId] = false;
    persist();
    // Resolving the last active thread/comment on a diff line should hide the
    // whole line-notes section, not leave a collapsed thread the reviewer must
    // dismiss by hand. Collapse the inline row and re-render.
    const lineId = kind === "resolve" ? threadLineId(thread) : null;
    if (lineId) {
      const activeLeft =
        artifactThreadsForElement("line", lineId).some((t) => t.status !== "resolved") ||
        localVisibleForElement(lineId).length > 0;
      if (!activeLeft) {
        state.openLineThreads[lineId] = false;
        persist();
        const inline = app.querySelector(`.line-thread[data-thread="${cssEsc(lineId)}"]`);
        const rowEl = inline ? inline.closest(".drow-thread") : null;
        collapseThenRender(rowEl instanceof HTMLElement ? rowEl : null);
        return;
      }
    }
    render();
  } catch (err) {
    threadOps[threadId] = { busy: false, error: errorMessage(err) || "Action failed." };
    render();
  }
}

// Toggles what the reviewer sees in the header used, which a held list may show
// differently from the latest copy (a thread resolved since defaults to collapsed).
export function toggleThreadCollapse(id: string, header: Element | null | undefined): void {
  const t = artifactThreadById(id);
  if (!t) return;
  if (!state.threadCollapsed) state.threadCollapsed = {};
  const shown = header?.getAttribute("aria-expanded");
  const collapsed = shown ? shown === "true" : !threadCollapsed(t);
  state.threadCollapsed[id] = collapsed;
  persist();
  render();
}

// Notes and replies go in one request, so a listening agent picks them up as one round.
// `only` limits an automatic send to the drafts just saved.
export async function exportFeedback(only: DraftSelection | null = null): Promise<void> {
  if (exportState.phase === "working") return;
  // A draft open in an editor waits until its edit is saved.
  const editingNote = compose?.editIndex != null ? noteAt(compose.editIndex) : null;
  const pending = pendingFeedback().filter(({ c }) => c !== editingNote && (!only || only.notes.has(c)));
  const replies = pendingReplies().filter((draft) => draft.id !== replyEditId && (!only || only.replies.has(draft.id)));
  if (!pending.length && !replies.length) return;
  // Each send locks and releases only its own drafts.
  const locked: (Note | string)[] = [...pending.map(({ c }) => c), ...replies.map((draft) => draft.id)];
  locked.forEach((draft) => sendingDrafts.add(draft));
  const release = () => locked.forEach((draft) => sendingDrafts.delete(draft));
  // The finally releases the drafts if setup throws; normal paths release them before rendering.
  try {
    requestReplyNotifications();
    exportState = { phase: "working", message: "" };
    render();
    const skips = replies.filter((draft) => !artifactThreadById(draft.threadId)).map(() => "reply — thread no longer exists");
    const sendable = replies.filter((draft) => artifactThreadById(draft.threadId));
    let notesSent = 0;
    let repliesSent = 0;
    if (pending.length || sendable.length) {
      try {
        const res = await api.exportFeedback({
          implementationId: data.implementationId,
          notes: pending.map(({ c, i }) => { rememberDraftSnapshot(c); return { ref: i, kind: c.kind, id: c.id, stageId: c.stageId, body: c.body ?? "", attachments: c.attachments || [], clientId: String(c.createdAt), snapshot: draftSnapshots.get(c) }; }),
          replies: sendable.map((draft) => ({ ref: draft.id, threadId: draft.threadId, body: draft.body, attachments: draft.attachments || [] })),
        });
        let out: FeedbackExportResponse | null = null;
        try { out = await res.json(); } catch { /* non-JSON error body */ }
        const byRef = new Map(pending.map(({ c, i }) => [i, c]));
        if (!out) throw new Error(`Export failed (HTTP ${res.status}).`);
        (out.skipped || []).forEach((s) => {
          const c = byRef.get(s.ref);
          const label = c ? labelFor(c.kind, c.id, c.stageId) : `note ${s.ref}`;
          skips.push(`${label} — ${s.reason}`);
        });
        (out.replySkipped || []).forEach((entry) => skips.push(`reply — ${entry.reason}`));
        if (!res.ok || !out.ok) throw new Error(failureOf(out).error || `Export failed (HTTP ${res.status}).`);
        adoptViewerSnapshot(out);
        // An older server listed sent notes by their ref alone.
        const exported: ({ ref: number; threadId?: string } | number)[] = out.exported || [];
        exported.forEach((entry) => {
          const ref = typeof entry === "number" ? entry : entry && entry.ref;
          const note = byRef.get(ref);
          if (note) {
            note.exported = true;
            if (typeof entry !== "number" && entry.threadId) note.threadId = entry.threadId;
          }
        });
        notesSent = (out.exported || []).length;
        (out.replied || []).forEach((entry) => {
          const thread = artifactThreadById(entry.threadId);
          if (!thread) return;
          // Held copies show the sent reply in place of its draft; a copy shared by several lists gets it once.
          // A retried send whose earlier response was lost returns a comment a poll may already have loaded.
          for (const copy of new Set([thread, ...heldThreadCopies(entry.threadId)])) {
            const sent = entry.comment;
            if (sent && !copy.comments.some((comment) => sent.id != null && comment.id === sent.id)) copy.comments.push({ ...sent, attachments: sent.attachments || [] });
            if (entry.status) copy.status = entry.status;
            if ("resolvedAt" in entry) copy.resolvedAt = entry.resolvedAt;
          }
        });
        const sentIds = new Set((out.replied || []).map((entry) => entry.ref));
        repliesSent = sentIds.size;
        state.replyDrafts = pendingReplies().filter((draft) => !sentIds.has(draft.id));
      } catch (err) {
        persist();
        exportState = { phase: "error", message: errorMessage(err) || "Export failed.", skips };
        release();
        render();
        // The failed drafts stay for Prepare feedback; saves queued meanwhile still go out.
        autoSendFeedback();
        return;
      }
    }
    release();
    persist();
    const parts: string[] = [];
    if (notesSent || !repliesSent) parts.push(`${notesSent} feedback thread${notesSent === 1 ? "" : "s"}`);
    if (repliesSent) parts.push(`${repliesSent} repl${repliesSent === 1 ? "y" : "ies"}`);
    const next = agent?.listening || agent?.working
      ? "The listening agent picks this up automatically."
      : `Run “${AGENT_COMMAND}” in your agent to have it handled.`;
    exportState = {
      phase: "done",
      message: `Sent ${parts.join(" and ")}${skips.length ? `, ${skips.length} skipped` : ""}. ${next} Replies and edits appear here.`,
      skips
    };
    render();
    autoSendFeedback();
  } finally {
    release();
  }
}
