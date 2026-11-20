// Which feedback threads and local notes belong to each element, the drafts
// waiting to be sent, and the thread lists a code selection holds.
import type { FeedbackTargetKind, FeedbackThread, ReplyDraft } from "../../scripts/src/shared/viewer-protocol";
import { app } from "./context";
import { activeFileNodeId, artifactThreadById, artifactThreads, currentFileEntry, fileById, fileByPreviousId, fileKey, insightKey, lineKey, parseLineId } from "./lookups";
import { render } from "./render";
import { state } from "./state";
import { isUsableNote } from "./stored-state";
import type { FileEntry, HeldList, IndexedNote, Note, NoteTarget, ThreadNote } from "./types";

/** A server action on a thread: running, or its error. */
export interface ThreadOp {
  busy: boolean;
  error: string;
}
export const threadOps: Record<string, ThreadOp | undefined> = {};            // thread id -> { busy, error } for server actions

export function threadBusy(id: string): boolean { return Boolean(threadOps[id] && threadOps[id].busy); }
export function threadError(id: string): string { return threadOps[id] ? threadOps[id].error : ""; }
// A thread is collapsed when the reviewer collapsed it, or — absent an
// explicit choice — automatically once it has been resolved.
export function threadCollapsed(t: FeedbackThread): boolean {
  if (state.threadCollapsed && t.id in state.threadCollapsed) return Boolean(state.threadCollapsed[t.id]);
  return t.status === "resolved";
}

/** The saved notes the page can use, each with its index in `state.comments`. */
export function indexedNotes(): IndexedNote[] {
  return state.comments.flatMap((c, i) => isUsableNote(c) ? [{ c, i }] : []);
}
/** The saved notes the page can use. */
export function usableNotes(): Note[] {
  return state.comments.filter(isUsableNote);
}
/** The saved note at `index`, unless there is none or the page cannot use it. */
export function noteAt(index: number): Note | undefined {
  const note = state.comments.at(index);
  return note && isUsableNote(note) ? note : undefined;
}

export function elementNotes(id: string): IndexedNote[] {
  return indexedNotes().filter(({ c }) => {
    if (c.id === id) return true;
    return id.startsWith("f:") && (c.kind === "file" || renamedLineNote(c)) && noteFileEntry(c.kind, c.id)?.id === id;
  });
}


export function noteFileEntry(kind: FeedbackTargetKind, id: string | undefined): FileEntry | null | undefined {
  const line = kind === "line" ? parseLineId(id) : null;
  return kind === "file" ? id === undefined ? undefined : fileById.get(id) || fileByPreviousId.get(id)
    : line ? currentFileEntry(line.stageId, line.path) : null;
}
export function renamedLineNote(note: NoteTarget): boolean {
  const line = note.kind === "line" ? parseLineId(note.id) : null;
  const entry = line && currentFileEntry(line.stageId, line.path);
  return Boolean(entry && line && entry.file.path !== line.path);
}
export function noteNodeId(note: NoteTarget): string | null {
  const entry = noteFileEntry(note.kind, note.id);
  if (!entry) return null;
  const memberships = entry.file.memberships || [];
  if (note.nodeId) return memberships.some((m) => m.nodeId === note.nodeId) ? note.nodeId : null;
  return memberships.length === 1 ? memberships[0].nodeId : null;
}
export function threadNote(t: FeedbackThread): ThreadNote {
  const target = t.target;
  const local = usableNotes().find((c) => c.threadId === t.id);
  return {
    kind: target.kind,
    id: target.kind === "file" ? fileKey(target.stageId, target.path)
      : target.kind === "line" ? lineKey(target.stageId, target.side, target.line, target.path)
      : target.kind === "stage" ? target.stageId
      : target.kind === "insight" ? insightKey(target.stageId, target.collection, target.itemId) : target.nodeId,
    stageId: target.stageId || t.assignedStageId,
    nodeId: target.nodeId || local?.nodeId,
    createdAt: t.comments?.[0]?.createdAt,
  };
}
export function matchesNodeContext(note: NoteTarget, nodeId: string | null | undefined): boolean {
  if (note.kind !== "file" && note.kind !== "line") return true;
  return Boolean(nodeId) && noteNodeId(note) === nodeId;
}
export function elementNodeId(kind: FeedbackTargetKind, id: string | undefined): string | null {
  const entry = noteFileEntry(kind, id);
  return entry ? activeFileNodeId(entry.id) : null;
}
export function artifactThreadsForElement(kind: FeedbackTargetKind, id: string | undefined, stageId?: string | null, nodeId: string | null | undefined = elementNodeId(kind, id)): FeedbackThread[] {
  return artifactThreads.filter((t) => {
    const tk = t.target && t.target.kind;
    if ((kind === "file" || kind === "line") && !matchesNodeContext(threadNote(t), nodeId)) return false;
    if (kind === "stage") return tk === "stage" && t.target.stageId === id;
    if (kind === "node")
      return tk === "node" && t.target.nodeId === id && t.target.stageId === stageId;
    if (kind === "insight") return tk === "insight" && insightKey(t.target.stageId, t.target.collection, t.target.itemId) === id;
    const entry = tk === "file" || tk === "line" ? currentFileEntry(t.target.stageId, t.target.path) : null;
    const renamedLine = tk === "line" && entry && entry.file.path !== t.target.path;
    // A rename identifies the file, not the old line's new position. Keep
    // immutable line anchors at file level until their location is reviewed.
    if (kind === "file") return (tk === "file" || renamedLine) && entry?.id === id;
    if (kind === "line")
      return tk === "line" && !renamedLine &&
        lineKey(t.target.stageId, t.target.side, t.target.line, t.target.path) === id;
    return false;
  });
}
// Local notes still worth showing: drafts, plus exported notes whose artifact
// thread has not been reloaded yet. Once the artifact thread is present the
// local marker is hidden so a sent note is never rendered twice. A list the
// selection holds (`list`: its key, held `threads` and `latest` threads) keeps a
// sent note while the hold keeps out its thread, which the list would show
// otherwise; a thread shown elsewhere, such as among resolved notes, replaces it.
export function sentNoteWaiting(c: Note, list: HeldList | null | undefined): boolean {
  if (!c.exported || !artifactThreadById(c.threadId)) return true;
  const has = (threads: FeedbackThread[]) => threads.some((t) => t.id === c.threadId);
  if (!list || !selectedThreadLists.has(list.key) || !has(list.latest) || has(list.threads)) return false;
  heldThreadLists.add(list.key);
  return true;
}
export function localVisibleForElement(id: string, nodeId: string | null | undefined = elementNodeId(id.startsWith("l:") ? "line" : "file", id), kind: FeedbackTargetKind | null = null, stageId?: string, list: HeldList | null = null): IndexedNote[] {
  return elementNotes(id).filter(
    ({ c }) => sentNoteWaiting(c, list) && matchesNodeContext(c, nodeId) &&
      (!kind || c.kind === kind) && (kind !== "node" || c.stageId === stageId),
  );
}
export function threadToggleCounts(kind: FeedbackTargetKind, id: string, stageId?: string): { total: number; open: number } {
  const threads = artifactThreadsForElement(kind, id, stageId);
  const locals = localVisibleForElement(id, elementNodeId(kind, id), kind, stageId);
  return {
    total: threads.length + locals.length,
    open: threads.filter((t) => t.status !== "resolved").length + locals.length,
  };
}
export function visibleThreadCount(kind: FeedbackTargetKind, id: string): number {
  return threadToggleCounts(kind, id).open;
}
export function fileNoteCounts(id: string, nodeId: string): { file: number; line: number; personal: number } {
  const entry = fileById.get(id);
  const counts = { file: 0, line: 0, personal: 0 };
  const belongs = (note: NoteTarget) => noteFileEntry(note.kind, note.id)?.id === entry?.id && matchesNodeContext(note, nodeId);
  // Only file and line notes belong to a file.
  const count = (kind: FeedbackTargetKind) => { if (kind === "file" || kind === "line") counts[kind] += 1; };
  artifactThreads.forEach((t) => {
    const note = threadNote(t);
    if (t.status !== "resolved" && belongs(note)) count(note.kind);
  });
  visibleLocalNotes().forEach(({ c }) => {
    if (!belongs(c)) return;
    if ((c.mode || "personal") === "personal") counts.personal += 1;
    else count(c.kind);
  });
  return counts;
}
export function visibleLocalNotes(list: HeldList | null = null): IndexedNote[] {
  return indexedNotes().filter(({ c }) => sentNoteWaiting(c, list));
}
export function activeNoteCount(): number {
  return artifactThreads.filter((t) => t.status !== "resolved").length + visibleLocalNotes().length;
}

export function threadStateKey(kind: FeedbackTargetKind | undefined, id: string, stageId?: string): string {
  return kind === "node" ? `n:${stageId}:${id}` : id;
}

// A thread list a code selection runs through keeps the threads it showed
// until the selection leaves it: which threads it has, their comments and
// their status stay as the server last sent them while shown, so what is
// selected (and copied) does not change under the reviewer. Models are still
// built from the reviewer's own state (busy, errors, collapse, replies,
// drafts and local notes). Each render works out the held lists afresh from
// the current selection, so a list adopts the latest threads once it leaves.
export let shownThreadLists = new Map<string, FeedbackThread[]>();     // list key -> the threads it last showed
export let nextThreadLists = shownThreadLists;
export let selectedThreadLists = new Set<string>();
export let heldThreadLists = new Set<string>();      // lists that show older threads than the latest
/** Starts the held thread lists of a render from the current selection. */
export function beginThreadLists(): void {
  selectedThreadLists = threadListsInSelection();
  heldThreadLists = new Set();
  nextThreadLists = new Map();
}
/** Keeps the lists a render showed for the next one. */
export function endThreadLists(): void { shownThreadLists = nextThreadLists; }
export function threadListsInSelection(): Set<string> {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.matches("input, textarea")) return new Set();
  const range = selection.getRangeAt(0);
  // A hidden or inert list (the inactive notes tab, a closed panel) shows
  // nothing that is selected, nor does one inside a closed step or file.
  const insideClosed = (el: Element) => {
    for (let det = el.closest("details:not([open])"); det; det = det.parentElement?.closest("details:not([open])") || null) {
      const summary = det.querySelector(":scope > summary");
      if (!summary || !summary.contains(el)) return true;
    }
    return false;
  };
  const shown = (el: Element) => !el.closest("[hidden], [inert]") && !insideClosed(el) && el.getClientRects().length > 0;
  return new Set([...app.querySelectorAll("[data-thread-list]")].filter((el) => shown(el) && range.intersectsNode(el)).map((el) => String(el.getAttribute("data-thread-list"))));
}
// A list's key names everything that decides its threads, so a held list is reused only for the same list.
export const threadListKey = (...identity: unknown[]): string => JSON.stringify(identity);
export function heldThreads(key: string, latest: FeedbackThread[]): FeedbackThread[] {
  const shown = selectedThreadLists.has(key) && shownThreadLists.get(key);
  const threads = shown || latest;
  if (shown && (shown.length !== latest.length || shown.some((t, i) => t !== latest[i]))) heldThreadLists.add(key);
  nextThreadLists.set(key, threads);
  return threads;
}
// The held copies of a thread, which the reviewer's own resolve or reopen updates.
export function heldThreadCopies(id: string): FeedbackThread[] {
  return [...shownThreadLists.values()].flat().filter((t) => t.id === id);
}

export function pendingFeedback(): IndexedNote[] {
  return indexedNotes().filter(({ c }) => c.mode === "feedback" && !c.exported);
}
// Reviewer replies are held as revisable local drafts (like unsent feedback
// notes) and only sent to the artifact when the reviewer prepares feedback.
export function pendingReplies(): ReplyDraft[] {
  return Array.isArray(state.replyDrafts) ? state.replyDrafts : [];
}
export function repliesForThread(threadId: string): ReplyDraft[] {
  return pendingReplies().filter((r) => r.threadId === threadId);
}
export function pendingFeedbackCount(): number {
  return pendingFeedback().length + pendingReplies().length;
}

/** Renders again when a selection leaves a list it held. */
export function installHeldThreadLists(): void {
  document.addEventListener("selectionchange", () => {
    if (!heldThreadLists.size) return;
    const selected = threadListsInSelection();
    if ([...heldThreadLists].some((key) => !selected.has(key))) render();
  });
}
