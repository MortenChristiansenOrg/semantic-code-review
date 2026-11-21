// Navigation: opening and scrolling to an element, opening and closing files,
// and the animations that go with it.
import type { FeedbackTargetKind, FileMembership } from "../../scripts/src/shared/viewer-protocol";
import { app } from "./context";
import { setSpecificationOpen } from "./details";
import { ensureFileDiff } from "./diffs";
import { activeFileNodeId, artifactThreads, fileApprovalKey, fileById, fileHasLine, fileKey, parseInsightKey, parseLineId } from "./lookups";
import { render } from "./render";
import { persist, state } from "./state";
import { threadLineId, threadStateKey } from "./threads";
import type { FileEntry } from "./types";
import { ANIM_EASE, afterAnim, cssEsc, motionReduced } from "./util";

/** The element of an HTML type, or null. */
const htmlElement = (element: Element | null | undefined): HTMLElement | null => element instanceof HTMLElement ? element : null;
/** A step's <details>, opened by the jumps below. */
function openNode(element: Element | null | undefined): void {
  if (element instanceof HTMLDetailsElement) element.open = true;
}

export function fileRowElement(id: string, nodeId: string | null | undefined = activeFileNodeId(id), root: ParentNode = app): HTMLElement | null {
  const entry = fileById.get(id);
  if (entry && nodeId) {
    const selector =
      `.stage[data-stage="${cssEsc(entry.stage.id)}"] ` +
      `details.node[data-node="${cssEsc(nodeId)}"] ` +
      `.frow[data-file="${cssEsc(id)}"]`;
    const row = htmlElement(root.querySelector(selector));
    if (row) return row;
  }
  return htmlElement(root.querySelector(`.frow[data-file="${cssEsc(id)}"]`));
}

/** A jump to a line whose diff page is still loading. */
interface LazyJump {
  id: string;
  fileId: string;
  membership: FileMembership | null | undefined;
  /** The stage head the line ID was taken from. */
  head: string;
  /** The threads shown on that line then. */
  threads: string[];
}
export let pendingLazyJump: LazyJump | null = null;
/** The loaded jump whose scheduled frames may still open and scroll to its target. */
let resumingJump: LazyJump | null = null;
/** Cancels a line jump into `fileId`, or any line jump, when its diff closes. */
function cancelLazyJump(fileId?: string | null): void {
  if (fileId == null || pendingLazyJump?.fileId === fileId) pendingLazyJump = null;
  if (fileId == null || resumingJump?.fileId === fileId) resumingJump = null;
}
export function resumePendingLazyJump(): void {
  if (!pendingLazyJump) return;
  const pending = pendingLazyJump;
  const entry = fileById.get(pending.fileId);
  if (entry?.file._diffLoading) return;
  if (
    entry &&
    !Array.isArray(entry.file.lines) &&
    !entry.file._diffError
  ) return;
  pendingLazyJump = null;
  resumingJump = pending;
  const parsed = parseLineId(pending.id);
  // A line number is only the same line in the diff it was taken from. After a
  // live update moved the stage, the jump ends at the line only while a thread
  // it was going to is still shown there, and otherwise at the file. Decided
  // when it scrolls, as an update can land before.
  const exact = () => {
    const current = fileById.get(pending.fileId);
    return Boolean(current && parsed && (current.stage.headRevision === pending.head ||
      artifactThreads.some((t) => pending.threads.includes(t.id) && threadLineId(t) === pending.id)) &&
      Array.isArray(current.file.lines) && fileHasLine(current.file, parsed.side, parsed.line));
  };
  requestAnimationFrame(() => {
    if (resumingJump !== pending) return;
    if (pending.membership?.nodeId) {
      const node = entry && app.querySelector(
        `.stage[data-stage="${cssEsc(entry.stage.id)}"] details.node[data-node="${cssEsc(pending.membership.nodeId)}"]`,
      );
      openNode(node);
    }
    requestAnimationFrame(() => {
      if (resumingJump !== pending) return;
      resumingJump = null;
      const target = exact()
        ? app.querySelector(`[data-line-id="${cssEsc(pending.id)}"]`)
        : fileRowElement(pending.fileId, pending.membership?.nodeId);
      if (target)
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (entry) fadeFileHighlight(entry.id, "in", pending.membership?.nodeId);
    });
  });
}

// Open the reviewable element an artifact thread points at, close the notes
// panel, and scroll its conversation into view (targeting the comments so a
// tall file body cannot push them off-screen).
export function jumpToElement(kind: FeedbackTargetKind, id: string, stageId?: string | null, nodeId?: string | null): void {
  cancelLazyJump();
  state.notesOpen = false;
  state.coverageOpen = false;
  if (kind === "line") state.openLineThreads[id] = true;
  else state.openThreads[threadStateKey(kind, id, stageId ?? undefined)] = true;
  let lineFileId: string | null = null;
  let lineMembership: FileMembership | null | undefined = null;
  let lineEntry: FileEntry | null = null;
  const lineTarget = kind === "line" ? parseLineId(id) : null;
  if (kind === "file") {
    const entry = fileById.get(id);
    if (entry) {
      const membership = (entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0];
      state.openStages[entry.stage.id] = true;
      state.activeFiles[id] = membership?.nodeId || null;
    }
  } else if (kind === "line") {
    const p = parseLineId(id);
    const entry = p && fileById.get(fileKey(p.stageId, p.path));
    if (entry) {
      if (p.side === "old") state.hideDeleted[entry.id] = false;
      state.markdownPreview[entry.id] = false;
      lineEntry = entry;
      lineFileId = entry.id;
      lineMembership = (entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0];
      state.openStages[entry.stage.id] = true;
      state.activeFiles[entry.id] = lineMembership?.nodeId || null;
      if (lineMembership) state.approvalComparisons[fileApprovalKey(entry.stage.id, lineMembership.nodeId, entry.file.path)] = false;
    }
  } else if (kind === "stage") {
    state.openStages[id] = true;
  } else if (kind === "node") {
    if (stageId) state.openStages[stageId] = true;
  } else if (kind === "specification") {
    setSpecificationOpen(id, true);
  } else if (kind === "criterion") {
    setSpecificationOpen(String(id).split("#")[0], true);
  } else if (kind === "insight") {
    const stageOfInsight = parseInsightKey(id)?.stageId;
    if (stageOfInsight) state.openStages[stageOfInsight] = true;
  }
  persist();
  // A parsed line ID found its entry above, so lineEntry implies lineTarget.
  const waitForLazyLine =
    kind === "line" && lineEntry && lineTarget && !fileHasLine(lineEntry.file, lineTarget.side, lineTarget.line)
      ? { entry: lineEntry, target: lineTarget } : null;
  if (waitForLazyLine) {
    const { entry, target } = waitForLazyLine;
    pendingLazyJump = { id, fileId: entry.id, membership: lineMembership, head: entry.stage.headRevision,
      threads: artifactThreads.filter((t) => threadLineId(t) === id).map((t) => t.id) };
    state.fileView[entry.id] = "full";
    delete entry.file.lines;
    ensureFileDiff(entry, 0, true, target);
  }
  render();
  if (waitForLazyLine) return;
  const lineStage = lineEntry?.stage;
  // Expand the owning node <details> for file/line targets, then scroll.
  requestAnimationFrame(() => {
    if (kind === "file") {
      const entry = fileById.get(id);
      const membership = entry && ((entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0]);
      if (entry && membership && membership.nodeId) {
        const nodeEl = app.querySelector(`.stage[data-stage="${cssEsc(entry.stage.id)}"] details.node[data-node="${cssEsc(membership.nodeId)}"]`);
        openNode(nodeEl);
      }
    } else if (kind === "line" && lineStage && lineMembership && lineMembership.nodeId) {
      const nodeEl = app.querySelector(`.stage[data-stage="${cssEsc(lineStage.id)}"] details.node[data-node="${cssEsc(lineMembership.nodeId)}"]`);
      openNode(nodeEl);
    } else if (kind === "node") {
      const nodeEl = stageId
        ? app.querySelector(`.stage[data-stage="${cssEsc(stageId)}"] details.node[data-node="${cssEsc(id)}"]`)
        : app.querySelector(`details.node[data-node="${cssEsc(id)}"]`);
      openNode(nodeEl);
    }
    requestAnimationFrame(() => {
      const nodeTarget = kind === "node" && stageId
        ? app.querySelector(`.stage[data-stage="${cssEsc(stageId)}"] details.node[data-node="${cssEsc(id)}"]`)
        : null;
      const thread = nodeTarget?.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
        || nodeTarget
        || app.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
        || app.querySelector(`.line-thread[data-thread="${cssEsc(id)}"]`)
        || app.querySelector(`[data-line-id="${cssEsc(id)}"]`)
        || fileRowElement(id)
        || app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`)
        || app.querySelector(`details.node[data-node="${cssEsc(id)}"]`)
        || app.querySelector(`.ac-item[data-ac="${cssEsc(id)}"]`)
        || app.querySelector(`.specification[data-req-id="${cssEsc(id)}"]`)
        || app.querySelector(`[data-insight="${cssEsc(id)}"]`);
      if (thread) {
        const node = kind === "insight" ? thread.closest("details.node") : null;
        openNode(node);
        thread.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (kind === "file") fadeFileHighlight(id, "in");
      else if (kind === "line" && lineFileId)
        fadeFileHighlight(lineFileId, "in", lineMembership?.nodeId);
    });
  });
}


// The file row that should fade its orange highlight in on the next render.
// Shared files need the node id too because they appear more than once.
export let pendingHighlight: { id: string; nodeId: string | null | undefined } | null = null;
export function setPendingHighlight(next: typeof pendingHighlight): void { pendingHighlight = next; }
/** Fades in the highlight of a file row opened by the last render. */
export function fadePendingHighlight(): void {
  if (pendingHighlight) {
    const { id, nodeId } = pendingHighlight;
    pendingHighlight = null;
    requestAnimationFrame(() => fadeFileHighlight(id, "in", nodeId));
  }
}
export const fileHighlights = new WeakMap<Element, Animation>();

// Fade the file-row highlight (orange background + inset border) in or out.
// Animate the highlight when explicitly opening or closing a file.
export function fadeFileHighlight(id: string | null | undefined, dir: "in" | "out", nodeId?: string | null): Animation | undefined {
  if (id == null || motionReduced()) return;
  const row = fileRowElement(id, nodeId);
  if (!row) return;
  fileHighlights.get(row)?.cancel();
  const on = { background: "rgba(255, 106, 69, .13)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, .35)" };
  const off = { background: "rgba(255, 106, 69, 0)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, 0)" };
  const frames = dir === "in" ? [off, on] : [on, off];
  const animation = row.animate(frames, {
    duration: dir === "in" ? 260 : 200,
    easing: ANIM_EASE,
    fill: dir === "in" ? "none" : "forwards",
  });
  fileHighlights.set(row, animation);
  return animation;
}

export function applyNotesFilter(): void {
  // Each filter starts at its own content; the hidden list contributes no height.
  const list = app.querySelector(".notes-list");
  if (list) list.scrollTop = 0;
  render();
}

// Animate a stage body open/closed in place so both directions transition.
export function animateStageToggle(id: string): void {
  const open = !state.openStages[id];
  state.openStages[id] = open;
  persist();
  const stageEl = app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`);
  const body = htmlElement(stageEl && stageEl.querySelector(".stage-body"));
  if (!stageEl || !body || motionReduced()) { render(); return; }
  const start = body.getBoundingClientRect().height;
  render();
  const end = body.getBoundingClientRect().height;
  body.style.overflow = "hidden";
  const anim = body.animate([{ height: `${start}px` }, { height: `${end}px` }],
    { duration: open ? 300 : 230, easing: ANIM_EASE });
  afterAnim(anim, open ? 300 : 230, () => { body.style.removeProperty("overflow"); });
}

// Collapse an element to zero height, then re-render (used for closing
// element-scoped note threads and the inline diff).
export function collapseThenRender(el: HTMLElement | null | undefined, dur?: number): void {
  if (!el || motionReduced()) { render(); return; }
  const start = el.getBoundingClientRect().height;
  el.style.overflow = "hidden";
  const anim = el.animate([{ height: `${start}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
    { duration: dur || 200, easing: ANIM_EASE });
  afterAnim(anim, dur || 200, () => { el.style.removeProperty("overflow"); render(); });
}

export function toggleCinema(id: string | undefined, nodeId?: string | null): void {
  if (id === undefined) return;
  const entry = fileById.get(id);
  const targetNodeId =
    nodeId || (entry && (entry.file.memberships || [])[0]?.nodeId) || null;
  if (activeFileNodeId(id) === targetNodeId) { closeCinema(id); return; }
  // Open in place — never auto-scroll, so the file stays where the reviewer
  // clicked it (jumping from the notes list handles its own scrolling).
  if (entry) delete entry.file._diffError;
  state.activeFiles[id] = targetNodeId || null;
  persist();
  pendingHighlight = { id, nodeId: targetNodeId };
  render();
}
export function cinemaHolder(id: string, nodeId: string | null | undefined = activeFileNodeId(id)): HTMLElement | null {
  const row = fileRowElement(id, nodeId);
  const next = htmlElement(row && row.nextElementSibling);
  return next && next.classList.contains("cinema-diff") ? next : null;
}
export function closeCinema(id?: string | null): void {
  // No id → close every open file (used by the Escape shortcut).
  if (id == null) { cancelLazyJump(); state.activeFiles = {}; persist(); render(); return; }
  cancelLazyJump(id);
  const nodeId = activeFileNodeId(id);
  const holder = cinemaHolder(id, nodeId);
  delete state.activeFiles[id]; persist();
  if (!holder || motionReduced()) { render(); return; }
  const highlight = fadeFileHighlight(id, "out", nodeId);
  const start = holder.getBoundingClientRect().height;
  holder.style.overflow = "hidden";
  const anim = holder.animate([{ height: `${start}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
    { duration: 210, easing: ANIM_EASE });
  afterAnim(anim, 210, () => {
    holder.style.removeProperty("overflow"); render();
    // Rows survive rendering; release the closing fill so CSS can highlight
    // an open or hovered row again. A newer opening animation is independent.
    highlight?.cancel();
  });
}
