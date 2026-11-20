// The open editors: the note composer and the reply being written, with the
// revisions each draft was written against.
import type { Attachment, ComposeDraft, DraftSnapshot, NoteKind } from "../../scripts/src/shared/viewer-protocol";
import { autoSendFeedback } from "./agent";
import { app, data } from "./context";
import { activeFileNodeId, artifactThreadById, fileBaseRevision, fileById, fileOf, parseInsightKey, parseLineId, stageOf } from "./lookups";
import { setPendingHighlight } from "./navigation";
import { render } from "./render";
import { persist, state } from "./state";
import { elementNodeId, noteFileEntry, noteNodeId, threadStateKey } from "./threads";
import type { Note, NoteTarget, ViewerStage } from "./types";

/** A draft: a saved note or the open composer. */
export type Draft = Note | ComposeDraft;

export const draftSnapshots = new WeakMap<Draft, DraftSnapshot>();

export function noteStage(note: NoteTarget | null): ViewerStage | null | undefined {
  if (!note) return null;
  if (note.kind === "stage") return stageOf(note.id);
  if (note.kind === "node") return stageOf(note.stageId);
  if (note.kind === "file") return fileOf(note.id)?.stage;
  if (note.kind === "line") return stageOf(parseLineId(note.id)?.stageId);
  if (note.kind === "insight") return stageOf(parseInsightKey(note.id)?.stageId);
  return null;
}

export function rememberDraftSnapshot(note: Draft): void {
  const stage = noteStage(note);
  if (stage && !draftSnapshots.has(note)) {
    const entry = note.kind === "line" ? noteFileEntry(note.kind, note.id) : null;
    draftSnapshots.set(note, { base: entry ? fileBaseRevision(entry) : stage.baseRevision, head: stage.headRevision,
      ...(entry?.file.revision ? { fileRevision: entry.file.revision } : {}) });
  }
}

export let compose: ComposeDraft | null = null;              // inline note composer: {kind,id,stageId,editIndex,mode,body}
export let replyTo: string | null = null;              // artifact thread id currently being replied to
export let replyAttachments: Attachment[] = [];
export let replyDraft = "";             // unsent text of the open reply, kept across re-renders
export let replyEditId: string | null = null;          // id of the pending reply draft being edited (if any)
export let replyDirty = false;
/** Restores the editors saved with the review state. */
export function initEditor(): void {
  compose = state.editor?.compose || null;
  replyTo = state.editor?.replyTo || null;
  replyAttachments = state.editor?.replyAttachments || [];
  replyDraft = state.editor?.replyDraft || "";
  replyEditId = state.editor?.replyEditId || null;
}
export function setCompose(next: ComposeDraft | null): void { compose = next; }
/** Opens the reply editor of a thread, or closes it when `threadId` is null. */
export function setReply(threadId: string | null, draft = "", attachments: Attachment[] = [], editId: string | null = null): void {
  replyTo = threadId; replyDraft = draft; replyAttachments = attachments; replyEditId = editId; replyDirty = false;
}
export function closeReply(): void { setReply(null); }
/** Records text typed into the open reply. */
export function setReplyDraft(text: string): void { replyDraft = text; replyDirty = true; }

export function captureEditor(): void {
  state.editor = { compose, replyTo, replyDraft, replyEditId, replyAttachments: replyTo ? replyAttachments : [] };
  for (const note of [...state.comments, compose].filter((item) => item !== null)) {
    const snapshot = draftSnapshots.get(note);
    if (snapshot) note.snapshot = snapshot;
  }
}

// Continue an artifact thread with a reviewer reply (server-backed).
// Save (or update) a reviewer reply as a local draft. Drafts are revisable
// and only sent to the artifact when the reviewer prepares feedback.
export function saveReplyDraft(threadId: string, body: string): void {
  if (!artifactThreadById(threadId)) return;
  if (!Array.isArray(state.replyDrafts)) state.replyDrafts = [];
  let savedId = replyEditId;
  if (replyEditId != null) {
    const draft = state.replyDrafts.find((r) => r.id === replyEditId);
    if (draft) { draft.body = body; draft.attachments = structuredClone(replyAttachments); }
  } else {
    savedId = `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    state.replyDrafts.push({
      id: savedId,
      threadId,
      body,
      attachments: structuredClone(replyAttachments),
      createdAt: Date.now(),
    });
  }
  replyTo = null;
  replyDraft = ""; replyAttachments = [];
  replyEditId = null;
  replyDirty = false;
  persist();
  render();
  autoSendFeedback({ reply: savedId });
}

export function openComment(kind: NoteKind, id: string, stageId?: string): void {
  const target: { kind: NoteKind; id: string; nodeId?: string | null; stageId?: string } = { kind, id };
  if (kind === "file" || kind === "line") target.nodeId = elementNodeId(kind, id);
  if (kind === "node" && stageId) target.stageId = stageId;
  replyTo = null; replyEditId = null; replyDraft = ""; replyAttachments = []; replyDirty = false;
  compose = {
    ...target,
    editIndex: null,
    mode: !data.remote && state.lastNoteMode === "feedback" ? "feedback" : "personal",
    body: "",
    dirty: false,
  };
  rememberDraftSnapshot(compose);
  if (kind === "line") state.openLineThreads[id] = true;
  else state.openThreads[threadStateKey(kind, id, stageId)] = true;
  // File notes live inside the file's open diff unit, so adding one opens it.
  if (kind === "file") {
    const entry = fileById.get(id);
    if (!state.activeFiles[id])
      state.activeFiles[id] = (entry?.file.memberships || [])[0]?.nodeId || null;
    setPendingHighlight({ id, nodeId: activeFileNodeId(id) });
  }
  persist();
  render();
  focusComposer();
}

// Edit a browser-local draft note in place. Exported notes are immutable.
export function openNoteEdit(index: number): void {
  const c = state.comments[index];
  if (!c || c.exported) return;
  replyTo = null; replyEditId = null; replyDraft = ""; replyAttachments = []; replyDirty = false;
  compose = {
    kind: c.kind,
    id: c.id,
    stageId: c.stageId,
    nodeId: noteNodeId(c),
    editIndex: index,
    mode: c.mode || "personal",
    body: c.body ?? "",
    attachments: structuredClone(c.attachments || []),
    dirty: false,
  };
  if (c.kind === "line") state.openLineThreads[c.id] = true;
  else state.openThreads[threadStateKey(c.kind, c.id, c.stageId)] = true;
  if (c.kind === "file" || c.kind === "line") {
    const entry = noteFileEntry(c.kind, c.id);
    if (entry && noteNodeId(c)) state.activeFiles[entry.id] = noteNodeId(c);
    if (entry) setPendingHighlight({ id: entry.id, nodeId: activeFileNodeId(entry.id) });
  }
  persist();
  render();
  focusComposer();
}

export function focusComposer(): void {
  requestAnimationFrame(() => {
    const root = state.notesOpen ? app.querySelector(".side.notes") : app.querySelector(".shell");
    const ta = root?.querySelector(".note-compose textarea, .tthread-reply textarea");
    if (ta instanceof HTMLElement) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });
}
