// Highlights the lines an inline insight is linked to while it is hovered or focused.
import type { DiffSide } from "../../scripts/src/shared/viewer-protocol";
import type { DiffContext } from "./diff-model";
import { lineKey, stageOf } from "./lookups";
import { fileRowElement } from "./navigation";

// The inline insight whose linked lines are highlighted in one open diff:
// { fileId, nodeId, stageId, path, startLine, endLine }, or null. Rows
// render the highlight from it; hovering and focusing an insight toggle the
// same class on the affected rows directly (setInsightPreview), so a later
// render produces the classes already shown.
export interface InsightPreview {
  fileId: string;
  nodeId: string;
  stageId: string;
  path: string;
  startLine: number;
  endLine: number;
}
export let insightPreview: InsightPreview | null = null;
// The inline insight button that set the preview, and the ones hovered,
// focused or just dismissed.
export let insightPreviewSource: HTMLElement | null = null;
export let hoveredCodeInsight: HTMLElement | null = null, focusedCodeInsight: HTMLElement | null = null, suppressedCodeInsight: Element | null = null;
export function setSuppressedCodeInsight(button: Element | null): void { suppressedCodeInsight = button; }
export let insightPreviewRows: HTMLElement[] = [];
// Set while the page renders: rows already carry the classes computed for
// the preview, so a focus change during the render, such as a focused
// insight button blurring as it is removed, leaves the repaint to
// forgetRemovedInsights after the render.
export let renderingPage = false;
export function setRenderingPage(on: boolean): void { renderingPage = on; }
// The rows a render highlights for `preview`. The insight's button sits in the
// diff it previews; rows are the grid's children, so walking them skips the
// code inside each row. The work follows the rendered rows, not the length
// of the linked range.
export function previewedRows(preview: InsightPreview | null, source: Element | null): HTMLElement[] {
  if (!preview) return [];
  let grid = source?.isConnected ? source.closest(".diff-grid") : null;
  if (!grid) {
    const diff = fileRowElement(preview.fileId, preview.nodeId)?.nextElementSibling;
    grid = diff?.classList.contains("cinema-diff") ? diff.querySelector(".diff-grid") : null;
  }
  if (!grid) return [];
  const prefix = lineKey(preview.stageId, "new", "", "").slice(0, -1), suffix = `:${preview.path}`;
  const rows: HTMLElement[] = [];
  for (const row of grid.children) {
    const id = row instanceof HTMLElement ? row.dataset.lineId : undefined;
    if (!(row instanceof HTMLElement) || !id || !row.classList.contains("drow") || !id.startsWith(prefix) || !id.endsWith(suffix)) continue;
    const digits = id.slice(prefix.length, id.length - suffix.length);
    if (!/^\d+$/.test(digits)) continue;
    const line = Number(digits);
    if (line >= preview.startLine && line <= preview.endLine) rows.push(row);
  }
  return rows;
}
// `force` repaints even when the preview is unchanged, after a render that
// may have replaced or repainted rows from an earlier preview.
export function setInsightPreview(next: InsightPreview | null, source: HTMLElement | null, force = false): void {
  const previousSource = insightPreviewSource;
  insightPreviewSource = next ? source : null;
  if (!force && JSON.stringify(next) === JSON.stringify(insightPreview)) return;
  const previous = new Set([...insightPreviewRows, ...previewedRows(insightPreview, previousSource)]);
  insightPreview = next;
  insightPreviewRows = previewedRows(next, source);
  const current = new Set(insightPreviewRows);
  for (const row of previous) if (!current.has(row)) row.classList.remove("is-code-insight-target");
  for (const row of insightPreviewRows) row.classList.add("is-code-insight-target");
}
// After each render, an insight removed by it, such as when its diff closes,
// neither hovers nor keeps its lines highlighted; one that remains is looked
// up again, so a refreshed range or a removed insight replaces the old one.
// When the insight that set the highlight is removed, a remaining hovered or
// focused one takes over.
export function forgetRemovedInsights(): void {
  if (hoveredCodeInsight && !hoveredCodeInsight.isConnected) hoveredCodeInsight = null;
  if (focusedCodeInsight && !focusedCodeInsight.isConnected) focusedCodeInsight = null;
  if (suppressedCodeInsight && !suppressedCodeInsight.isConnected) suppressedCodeInsight = null;
  if (!insightPreview && !insightPreviewRows.length) return;
  const source = insightPreviewSource?.isConnected ? insightPreviewSource : hoveredCodeInsight || focusedCodeInsight;
  setInsightPreview(source ? codeInsightPreview(source) : null, source, true);
}
export function insightTargetsLine(ctx: DiffContext, side: DiffSide, lineNo: number): boolean {
  const preview = insightPreview;
  return Boolean(preview && side === "new" && preview.fileId === ctx.fileId && preview.nodeId === ctx.diffNodeId &&
    preview.stageId === ctx.stageId && preview.path === ctx.path && lineNo >= preview.startLine && lineNo <= preview.endLine);
}

/* ---- events ----------------------------------------------------------- */
// Keep the hit area stable: highlighting only changes paint, never layout or
// the insight DOM. Moving between its icon, text, and padding is one hover.
export function clearInlineInsightHighlight(): void {
  hoveredCodeInsight = focusedCodeInsight = null;
  highlightInlineInsight(null);
}
// Highlights the lines an inline insight is linked to, in the diff that
// shows the insight, without rendering the viewer.
export function highlightInlineInsight(button: HTMLElement | null): void {
  if (renderingPage) return;
  setInsightPreview(codeInsightPreview(button), button);
}
// The lines an inline insight button previews, from the current insight data.
export function codeInsightPreview(button: HTMLElement | null): InsightPreview | null {
  let next: InsightPreview | null = null;
  if (button?.isConnected) {
    const stage = stageOf(button.dataset.stage);
    const target = stage?.insights.find(ins => ins.collection === button.dataset.collection && ins.id === button.dataset.item)?.codeTarget;
    // The open diff follows its file row, inside the step it was opened in.
    const fileId = dataOf(button.closest(".cinema-diff")?.previousElementSibling, "file");
    const nodeId = dataOf(button.closest("details[data-node]"), "node");
    if (stage && target && target.status !== "needs-review" && fileId && nodeId)
      next = { fileId, nodeId, stageId: stage.id, path: target.path, startLine: target.startLine, endLine: target.endLine };
  }
  return next;
}

/** A data attribute of an HTML element. */
const dataOf = (element: Element | null | undefined, key: string): string | undefined =>
  element instanceof HTMLElement ? element.dataset[key] : undefined;
/** The inline insight button an event happened in. */
function insightButton(target: EventTarget | null): HTMLElement | null {
  const button = target instanceof Element ? target.closest(".line-code-insights .code-insight-link") : null;
  return button instanceof HTMLElement ? button : null;
}
/** Whether a pointer moved within the button. */
const within = (button: Element, related: EventTarget | null): boolean => related instanceof Node && button.contains(related);

/** Previews the lines of the inline insight hovered or focused. */
export function installInsightPreview(): void {
  document.addEventListener("pointerover", e => {
    const button = insightButton(e.target);
    if (!button || button === suppressedCodeInsight || within(button, e.relatedTarget)) return;
    hoveredCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("pointerout", e => {
    const button = insightButton(e.target);
    if (!button || within(button, e.relatedTarget)) return;
    if (button === suppressedCodeInsight) suppressedCodeInsight = null;
    hoveredCodeInsight = null;
    highlightInlineInsight(focusedCodeInsight);
  });
  document.addEventListener("pointermove", e => {
    const button = insightButton(e.target);
    if (!button || button !== suppressedCodeInsight) return;
    suppressedCodeInsight = null;
    hoveredCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("focusin", e => {
    const button = insightButton(e.target);
    if (!button || button === suppressedCodeInsight) return;
    focusedCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("focusout", e => {
    const button = insightButton(e.target);
    if (!button) return;
    if (button === suppressedCodeInsight) suppressedCodeInsight = null;
    focusedCodeInsight = null;
    highlightInlineInsight(hoveredCodeInsight);
  });
}
