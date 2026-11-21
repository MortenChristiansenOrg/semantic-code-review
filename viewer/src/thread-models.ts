// The models of feedback threads, local notes and the composer, and of the
// lists that show them beside an element.
import type { ComposeDraft, FeedbackTargetKind, FeedbackThread } from "../../scripts/src/shared/viewer-protocol";
import { sendingDrafts } from "./agent";
import { attachmentEditorModel, attachmentModels, uploadOps } from "./attachments";
import { data } from "./context";
import { compose, draftSnapshots, replyAttachments, replyDraft, replyEditId, replyTo } from "./editor";
import { currentFileEntry, fileBaseRevision, fileById, fileByPreviousId, fileKey, insightByKey, insightKey, parseLineId, requirements, stageById, stageOf } from "./lookups";
import { state } from "./state";
import { artifactThreadsForElement, elementNodeId, heldThreads, localVisibleForElement, matchesNodeContext, noteFileEntry, noteNodeId, renamedLineNote, repliesForThread, threadBusy, threadCollapsed, threadError, threadLineId, threadListKey, threadNote, threadStateKey } from "./threads";
import { isUnreadReply, replyKey, threadAgentState } from "./unread-replies";
import type { IndexedNote, Note } from "./types";
import { fmtTime, splitPath } from "./util";
import type { ComposerView, JumpView, ThreadEntryView, ThreadListView, ThreadView } from "./views/thread";

/** The element a thread or note can jump to. */
export interface ElementRef {
  kind: FeedbackTargetKind;
  id: string;
  stageId?: string;
  nodeId?: string | null;
}

/** What became of a file or line thread's target. */
export type TargetState = { state: "present" | "not-in-stage" | "deleted" } | { state: "renamed"; to: string };

// Icon + tooltip text for the kind of element a feedback thread targets.
export function threadTypeLabel(kind: string): string {
  return kind === "file" ? "File"
    : kind === "line" ? "Line"
    : kind === "stage" ? "Stage"
    : kind === "node" ? "Step"
    : kind === "specification" ? "Specification"
    : kind === "criterion" ? "Criterion"
    : kind === "insight" ? "Insight"
    : "Thread";
}

// Notes list: show only the filename for file targets, keep the full path on hover.
// A line thread names the row it is shown on; at file level, its original line.
export function threadTargetDisplay(t: FeedbackThread): { text: string; title: string } {
  const tgt = t.target;
  if ((tgt.kind === "file" || tgt.kind === "line") && tgt.path) {
    const name = splitPath(tgt.path).name;
    const line = tgt.kind === "line" ? threadLineId(t) && t.currentLine || tgt.line : 0;
    const suffix = line ? `:${line}` : "";
    const moved = tgt.kind === "line" && line !== tgt.line ? ` (written on line ${tgt.line})` : "";
    return { text: `${name}${suffix}`, title: `${tgt.path}${suffix}${moved}` };
  }
  const l = tgt.label || tgt.kind || "thread";
  return { text: l, title: l };
}
// Which reviewable element (if any) an artifact thread points at, so the
// notes list can offer a "show" jump.
// File and line targets resolve against the file that currently holds the
// path (following a rename); a target whose file no longer exists yields no
// ref so the jump control can be withheld.
export function threadElementRef(t: FeedbackThread): ElementRef | null {
  const tgt = t.target;
  const nodeId = noteNodeId(threadNote(t));
  if ((tgt.kind === "file" || tgt.kind === "line") && !nodeId) return null;
  if (tgt.kind === "file" && tgt.path && tgt.stageId) {
    const entry = currentFileEntry(tgt.stageId, tgt.path);
    return entry ? { kind: "file", id: entry.id, nodeId } : null;
  }
  if (tgt.kind === "line" && tgt.path && tgt.stageId) {
    const entry = currentFileEntry(tgt.stageId, tgt.path);
    if (!entry) return null;
    // Jump to the row the thread is shown on, never to another line that now
    // has the saved number; without a row, to the file-level thread.
    const lineId = threadLineId(t);
    return lineId ? { kind: "line", id: lineId, nodeId } : { kind: "file", id: entry.id, nodeId };
  }
  if (tgt.kind === "stage" && tgt.stageId)
    return data.stages.some((s) => s.id === tgt.stageId) ? { kind: "stage", id: tgt.stageId } : null;
  if (tgt.kind === "node" && tgt.stageId && tgt.nodeId) {
    const stage = stageById.get(tgt.stageId);
    return stage?.nodes.some((node) => node.id === tgt.nodeId)
      ? { kind: "node", id: tgt.nodeId, stageId: tgt.stageId }
      : stage ? { kind: "stage", id: tgt.stageId } : null;
  }
  if (tgt.kind === "specification" && tgt.specificationId)
    return requirements.some((r) => r.id === tgt.specificationId)
      ? { kind: "specification", id: tgt.specificationId }
      : null;
  if (tgt.kind === "criterion" && tgt.specificationId && tgt.criterionId) {
    const req = requirements.find((r) => r.id === tgt.specificationId);
    if (!req) return null;
    return (req.acceptance || []).some((a) => a.id === tgt.criterionId)
      ? { kind: "criterion", id: `${tgt.specificationId}#${tgt.criterionId}` }
      : { kind: "specification", id: tgt.specificationId };
  }
  if (tgt.kind === "insight" && tgt.stageId && tgt.collection && tgt.itemId) {
    const stage = stageById.get(tgt.stageId);
    const insight = stage?.insights.find(
      (item) => item.collection === tgt.collection && item.id === tgt.itemId,
    );
    return insight
      ? {
          kind: "insight",
          id: insightKey(tgt.stageId, tgt.collection, tgt.itemId),
          stageId: tgt.stageId,
        }
      : stage ? { kind: "stage", id: tgt.stageId } : null;
  }
  return null;
}
// Classify what became of a file/line thread's target. The current stage diff
// controls whether the thread can jump to a file; snapshot status distinguishes
// a file removed from this stage's diff from one deleted from the repository.
export function threadTargetState(t: FeedbackThread): TargetState {
  const tgt = t.target;
  if ((tgt.kind === "file" || tgt.kind === "line") && tgt.path && tgt.stageId) {
    const direct = fileById.get(fileKey(tgt.stageId, tgt.path));
    if (direct) return { state: "present" };
    const renamed = fileByPreviousId.get(fileKey(tgt.stageId, tgt.path));
    if (renamed) return { state: "renamed", to: renamed.file.path };
    if (t.targetState && t.targetState.state === "present")
      return { state: "not-in-stage" };
    if (t.targetState && t.targetState.state === "renamed")
      return { state: "renamed", to: t.targetState.path };
    if (t.targetState && t.targetState.state === "deleted")
      return { state: "deleted" };
    return { state: "not-in-stage" };
  }
  return { state: "present" };
}
export function jumpModel(ref: ElementRef): JumpView {
  return { kind: ref.kind, id: ref.id, stageId: ref.stageId || "", nodeId: ref.nodeId || "" };
}
// An exported feedback thread: a reviewer <-> agent conversation the reviewer
// can continue, mark resolved, or reopen. Only the reviewer controls closure.
// `withLabel` marks the notes panel's copy, which names the target and can jump to it.
export function threadModel(t: FeedbackThread, withLabel?: boolean): ThreadView {
  const disp = threadTargetDisplay(t);
  const ref = threadElementRef(t);
  const kind = (t.target && t.target.kind) || "thread";
  const tstate = threadTargetState(t);
  // The stage the review conversation is anchored to. Shown only when it adds
  // information: a target in a different stage, or a spec/criterion/insight
  // thread that has no stage of its own. Same-stage threads stay unlabelled.
  const assignedStage = t.assignedStageId ? stageById.get(t.assignedStageId) : null;
  const tgtStageId = t.target && t.target.stageId;
  const showAssigned = Boolean(
    assignedStage &&
      (["specification", "criterion", "insight"].includes(kind) ||
        (tgtStageId && tgtStageId !== t.assignedStageId)),
  );
  let staleMsg = "";
  if ((kind === "file" || kind === "line") && !noteNodeId(threadNote(t)))
    staleMsg = "Original step unknown or unavailable. This conversation is kept in the global list.";
  if (tstate.state === "deleted")
    staleMsg = `This file was deleted after the feedback was sent.`;
  else if (tstate.state === "renamed")
    staleMsg = `This file was renamed to ${splitPath(tstate.to).name} after the feedback was sent.${kind === "line" ? " The original line is shown here at file level; its current position is unverified." : ""}`;
  else if (tstate.state === "not-in-stage")
    staleMsg = `This file is no longer changed in this stage.`;
  // Shown whoever replied: the thread is no longer about a line of the current diff.
  else if (kind === "line" && !threadLineId(t))
    staleMsg = "The line this feedback was written about changed or left this diff after it was sent. The original line is shown here at file level.";
  else if (kind !== "line" && t.anchorStale && !(t.comments || []).some((cm) => cm.author === "agent"))
    staleMsg = `Stage changed since this feedback was sent.`;
  if (withLabel && !ref && !staleMsg) staleMsg = "The original target is no longer available.";
  return {
    id: t.id, status: t.status, collapsed: threadCollapsed(t), kind, kindLabel: threadTypeLabel(kind),
    title: (withLabel || kind === "line" && !threadLineId(t)) && t.target && t.target.label
      ? { text: disp.text, tooltip: disp.title } : null,
    assignedStage: showAssigned && assignedStage ? assignedStage.title : "",
    agentState: threadAgentState(t),
    jump: !withLabel ? null : ref ? jumpModel(ref) : tstate.state === "deleted" ? "deleted" : null,
    stale: staleMsg,
    error: threadError(t.id),
    busy: threadBusy(t.id),
    messages: (t.comments || []).map((cm) => {
      const agent = cm.author === "agent";
      return { author: agent ? "agent" : "user", unread: isUnreadReply(t, cm), replyKey: agent ? replyKey(t, cm) : "",
        time: fmtTime(cm.createdAt), body: cm.body, attachments: attachmentModels(cm.attachments) };
    }),
    // Pending reply drafts render as unsent messages the reviewer can revise or
    // remove before preparing feedback; the one being edited is shown as a form.
    drafts: repliesForThread(t.id).filter((r) => r.id !== replyEditId)
      .map((r) => ({ id: r.id, body: r.body, attachments: attachmentModels(r.attachments), sending: sendingDrafts.has(r.id) })),
    actionable: t.status === "open" || t.status === "resolved",
    replying: replyTo === t.id,
    reply: replyTo === t.id && Boolean(withLabel) === state.notesOpen
      ? { draft: replyDraft, editing: replyEditId != null, attachments: attachmentEditorModel(replyAttachments), saveDisabled: uploadOps.size > 0 }
      : null,
  };
}
export const localNoteIds = new WeakMap<Note, string>();
export let lastLocalNoteId = 0;
export function localNoteId(note: Note): string {
  let id = localNoteIds.get(note);
  if (id === undefined) { id = `note-${++lastLocalNoteId}`; localNoteIds.set(note, id); }
  return id;
}
// A browser-local note, or the composer editing it in its place. Drafts can be
// edited/deleted; a sent note awaiting its artifact thread is shown read-only.
export function localNoteEntry({ c, i }: IndexedNote, withLabel = false): ThreadEntryView {
  // Keyed by the note itself, so a deleted note's row is removed rather than reused for another.
  const key = `n:${localNoteId(c)}`;
  if (compose && compose.editIndex === i && withLabel === state.notesOpen) return { type: "composer", key, composer: composerModel(compose) };
  const ref = localNoteRef(c);
  return { type: "note", key, note: {
    index: i, id: localNoteId(c), mode: c.mode === "feedback" ? "feedback" : "personal", sent: Boolean(c.exported), sending: sendingDrafts.has(c),
    label: withLabel || renamedLineNote(c) ? noteTargetLabel(c) : null,
    jump: withLabel && ref ? jumpModel(ref) : null,
    missing: withLabel && !ref ? "Original target or step unavailable. This note is kept in the global list."
      : ref && ref.kind !== c.kind ? "The line snapshot changed. Open the current file to review its location." : "",
    time: fmtTime(c.createdAt), body: c.body ?? "", attachments: attachmentModels(c.attachments),
  } };
}
export function threadEntry(t: FeedbackThread, withLabel = false): ThreadEntryView {
  return { type: "thread", key: `t:${t.id}`, thread: threadModel(t, withLabel) };
}

// Keys stay unique when local notes share a timestamp.
export function uniqueKeys<T extends { key: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const key = seen.has(entry.key) ? `${entry.key}#${index}` : entry.key;
    seen.add(key);
    return key === entry.key ? entry : { ...entry, key };
  });
}
// An element's threads, then its local notes.
export function threadListEntries(threads: FeedbackThread[], locals: IndexedNote[]): ThreadEntryView[] {
  return uniqueKeys([...threads.map((t) => threadEntry(t)), ...locals.map((local) => localNoteEntry(local))]);
}

export function composerModel(ctx: ComposeDraft): ComposerView {
  return { mode: !data.remote && ctx.mode === "feedback" ? "feedback" : "personal", remote: Boolean(data.remote), body: ctx.body || "",
    attachments: attachmentEditorModel(ctx.attachments ||= []), editing: ctx.editIndex != null, saveDisabled: uploadOps.size > 0 };
}
// The notes on a stage, step or evidence, while they are shown.
export function inlineThreadModel(id: string, kind: FeedbackTargetKind, stageId?: string): ThreadListView | null {
  const composingNew = compose && compose.kind === kind && compose.id === id &&
    (kind !== "node" || compose.stageId === stageId) &&
    matchesNodeContext(compose, elementNodeId(kind, id)) && compose.editIndex == null;
  if (!state.openThreads[threadStateKey(kind, id, stageId)] && !composingNew) return null;
  const listKey = threadListKey(kind, stageId || "", id);
  const latest = artifactThreadsForElement(kind, id, stageId);
  const threads = heldThreads(listKey, latest);
  const entries = threadListEntries(threads, localVisibleForElement(id, elementNodeId(kind, id), kind, stageId, { key: listKey, threads, latest }));
  if (!entries.length && !composingNew) return null;
  return { id, kind, stageId: stageId || "", listKey, entries, composer: composingNew && compose ? composerModel(compose) : null };
}


// A line's thread, shown as a full-width row directly beneath the line while
// the line's gutter bubble is toggled open, so notes never crowd the code.
export function lineThreadContent(lineId: string): { arts: FeedbackThread[]; locals: IndexedNote[]; composingNew: boolean } | null {
  const composingNew = Boolean(
    compose && compose.kind === "line" && compose.id === lineId && matchesNodeContext(compose, elementNodeId("line", lineId)) && compose.editIndex == null);
  if (!state.openLineThreads[lineId] && !composingNew) return null;
  const key = lineListKey(lineId);
  const latest = artifactThreadsForElement("line", lineId);
  const arts = heldThreads(key, latest);
  const locals = localVisibleForElement(lineId, undefined, null, undefined, { key, threads: arts, latest });
  if (!arts.length && !locals.length && !composingNew) return null;
  return { arts, locals, composingNew };
}
export function lineListKey(lineId: string): string { return threadListKey("line", elementNodeId("line", lineId), lineId); }
export function lineThreadModel(lineId: string): ThreadListView | null {
  const content = lineThreadContent(lineId);
  return content && { id: lineId, kind: "line", stageId: null, listKey: lineListKey(lineId), entries: threadListEntries(content.arts, content.locals),
    composer: content.composingNew && compose ? composerModel(compose) : null };
}

export function localNoteRef(c: Note): ElementRef | null {
  if (c.kind === "stage") return stageById.has(c.id) ? c : null;
  if (c.kind === "node") return stageOf(c.stageId)?.nodes.some((n) => n.id === c.id) ? c : null;
  if (c.kind === "insight") return insightByKey(c.id) ? c : null;
  const entry = noteFileEntry(c.kind, c.id);
  const nodeId = noteNodeId(c);
  if (!entry || !nodeId) return null;
  const snapshot = draftSnapshots.get(c);
  const stale = snapshot && (snapshot.fileRevision ? snapshot.fileRevision !== entry.file.revision
    : snapshot.base !== fileBaseRevision(entry) || snapshot.head !== entry.stage.headRevision);
  return c.kind === "line" && !stale && !renamedLineNote(c) ? { ...c, nodeId } : { kind: "file", id: entry.id, nodeId };
}

export function labelFor(kind: FeedbackTargetKind, id: string, stageId?: string): string {
  if (kind === "node" && stageId) return stageById.get(stageId)?.nodes.find((node) => node.id === id)?.title || id;
  if (kind === "file") return fileById.get(id)?.file.path || id;
  if (kind === "insight") return insightByKey(id)?.title || id;
  if (kind === "line") {
    const p = parseLineId(id);
    return p ? `${p.path}:${p.line}` : id;
  }
  for (const s of data.stages) {
    if (s.id === id) return s.title;
    const n = s.nodes.find((x) => x.id === id);
    if (n) return n.title;
  }
  return id;
}
// Notes list: show only the filename, keep the full project-relative path on hover.
export function noteTargetLabel(c: Note): { text: string; title: string } {
  if (c.kind === "file") {
    const full = noteFileEntry(c.kind, c.id)?.file.path || c.id;
    return { text: splitPath(full).name, title: full };
  }
  if (c.kind === "line") {
    const p = parseLineId(c.id);
    if (p) return { text: `${splitPath(p.path).name}:${p.line}`, title: `${p.path}:${p.line}` };
  }
  const t = labelFor(c.kind, c.id, c.stageId);
  return { text: t, title: t };
}
