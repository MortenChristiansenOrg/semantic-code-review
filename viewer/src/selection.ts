// Highlights every match of a selection in a diff.
import { clearSelectionHits, hasSelectionHits, highlightSelectionHits } from "./selection-hits";

/* ---- diff selection highlighting -------------------------------------
   When the reviewer selects a token inside a diff, highlight every other
   occurrence of that exact text within the same file view (selection-hits.ts). */
// The diff grid holding the document selection, if any. A selection inside a
// text field (such as a line thread's draft) is the field's, not the diff's.
export function diffSelectionGrid(sel: Selection | null): Element | null {
  if (!sel || sel.isCollapsed || !sel.anchorNode) return null;
  const active = document.activeElement;
  if (active?.matches("input, textarea") && sel.anchorNode.contains(active)) return null;
  return sel.anchorNode.parentElement?.closest(".diff-grid") || null;
}
// The selection the matches were last computed for, so a scheduled refresh
// that finds the same selection, such as the mouseup and selection change of
// one double-click, does no work.
/** A selection in a diff, with the bounds of its range when it was matched. */
export interface DiffSelection {
  grid: Element;
  term: string;
  startContainer: Node | undefined;
  startOffset: number | undefined;
  endContainer: Node | undefined;
  endOffset: number | undefined;
}
export let matchedSelection: DiffSelection | null = null;
export const sameSelection = (a: DiffSelection | null, b: DiffSelection | null): boolean => !a || !b ? a === b : a.grid === b.grid && a.term === b.term &&
  a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
export function refreshDiffSelection(onlyIfChanged = false): void {
  const sel = document.getSelection();
  let grid: Element | null = null;
  let term = "";
  let range: Range | null = null;
  const host = diffSelectionGrid(sel);
  if (host && sel) {
    const t = String(sel).trim();
    if (t && t.length >= 2 && !/\n/.test(t)) {
      grid = host; term = t;
      range = sel.rangeCount ? sel.getRangeAt(0) : null;
    }
  }
  // The selection's range is live, so record its bounds.
  const current: DiffSelection | null = grid ? { grid, term, startContainer: range?.startContainer, startOffset: range?.startOffset,
    endContainer: range?.endContainer, endOffset: range?.endOffset } : null;
  if (onlyIfChanged && sameSelection(current, matchedSelection)) return;
  matchedSelection = current;
  if (grid) highlightSelectionHits(grid, term, range);
  else clearSelectionHits();
}
export function clearDiffSelection(): void {
  matchedSelection = null;
  clearSelectionHits();
}
// A drag in a diff is matched once, after the browser finishes the selection;
// other selection changes, such as from the keyboard or select all, at most
// once per frame. Both share one scheduled refresh.
export let selectingInDiff = false, selectionFrame = 0;
export function scheduleSelectionRefresh(): void {
  if (selectionFrame) return;
  selectionFrame = requestAnimationFrame(() => {
    selectionFrame = 0;
    if (!selectingInDiff) refreshDiffSelection(true);
  });
}
// Dragging already selected text starts a native drag that swallows the
// mouseup, so the drag, a cancelled pointer, or a move with the button
// released also end the selecting drag. The selection may have changed
// during the drag, and no mouseup will refresh its matches.
export const endSelectingDrag = (): void => {
  if (!selectingInDiff) return;
  selectingInDiff = false;
  scheduleSelectionRefresh();
};
// Typing or moving the caret in a text field changes the selection without
// touching a diff; only refresh when there are matches to clear or the
// selection is in a diff.

/** Highlights the matches of a diff selection as it changes. */
export function installSelection(): void {
  document.addEventListener("dragstart", endSelectingDrag);
  document.addEventListener("dragend", endSelectingDrag);
  document.addEventListener("pointercancel", endSelectingDrag);
  document.addEventListener("pointermove", (e) => { if (!(e.buttons & 1)) endSelectingDrag(); });
  document.addEventListener("mouseup", (e) => {
    selectingInDiff = false;
    if (!(e.target instanceof Element) || !e.target.closest(".diff-scroll")) { clearDiffSelection(); return; }
    scheduleSelectionRefresh();
  });
  document.addEventListener("mousedown", (e) => {
    const inDiff = e.target instanceof Element && Boolean(e.target.closest(".diff-scroll"));
    selectingInDiff = inDiff && e.button === 0;
    if (!inDiff) clearDiffSelection();
  });
  document.addEventListener("selectionchange", () => {
    if (selectingInDiff) return;
    if (document.activeElement?.matches("input, textarea") && !hasSelectionHits() && !diffSelectionGrid(document.getSelection())) return;
    scheduleSelectionRefresh();
  });
}
