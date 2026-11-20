// An open file's diff: its toolbar, the source rows with their gutters, line
// actions, ownership notices, inline code insights and line threads, the
// since-approval comparison, and the Markdown preview.
import { html, nothing, type TemplateResult } from "lit-html";
import { guard } from "lit-html/directives/guard.js";
import { repeat } from "lit-html/directives/repeat.js";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { CodeToken } from "./highlight";
import { arrowIcon, bubbleIcon, bubblePlusIcon } from "./icons";
import { lineThreadView, type ThreadListView } from "./thread";

/** The note affordance in a source row's sign column. */
export interface LineActionView {
  /** The line's feedback anchor ID. */
  id: string;
  /** Unresolved threads and visible local notes on the line. */
  count: number;
  /** The line has only resolved threads. */
  resolved: boolean;
  /** The line's notes are shown below it. */
  open: boolean;
}

/** A source row that can take line notes. */
export interface AnchoredLineView extends LineActionView {
  /** Ownership class of a shared file's line: own-focus, own-other, own-mark, or empty. */
  ownership: string;
  /** A hovered or focused inline insight is linked to this line. */
  insightTarget: boolean;
}

export interface InlineInsightView {
  stageId: string;
  collection: string;
  itemId: string;
  type: string;
  glyph: string;
  label: string;
  title: string;
  needsReview: boolean;
}

export type DiffRowView =
  | { type: "code"; key: string; kind: string; old: string; new: string; sign: string; code: readonly CodeToken[]; line: AnchoredLineView | null }
  /** The banner above a whole added or deleted file. */
  | { type: "banner"; key: string; kind: "newfile" | "oldfile"; sign: string; text: string }
  | { type: "gap"; key: string; count: number }
  /** The first line of a run owned by another step of a shared file. */
  | { type: "owner"; key: string; lineId: string; nodeId: string; title: string }
  | { type: "insights"; key: string; insights: readonly InlineInsightView[] }
  | { type: "thread"; key: string; thread: ThreadListView };

export interface DiffPagerView {
  /** diff-page or approval-page. */
  action: string;
  id: string;
  /** The first row shown, counted from zero. */
  offset: number;
  rows: number;
  previousOffset: number | null;
  nextOffset: number | null;
}

export interface DiffGridView {
  hideRemoved: boolean;
  rows: readonly DiffRowView[];
  pager: DiffPagerView | null;
}

export interface ComparisonInfoView {
  approvalId: string;
  /** Whether base changes are left out, included, or could not be separated; null when the base is unchanged. */
  baseChanges: "excluded" | "included" | "mixed" | null;
  ownershipChanged: boolean;
}

export type DiffContentView =
  | { type: "message"; text: string; status?: boolean }
  | { type: "unsupported"; text: string; approvedSha: string; currentSha: string }
  | { type: "grid"; grid: DiffGridView };

export interface DiffBodyView {
  /** Present while the body compares the file with its approved content. */
  comparison: ComparisonInfoView | null;
  content: DiffContentView;
}

export interface DiffControlsView {
  /** The file's stage-scoped ID. */
  fileId: string;
  wrap: boolean;
  /** Present for the Changes / Full file and Hide removed toggles. */
  view: { full: boolean; hideRemoved: boolean } | null;
  /** Present for a stale approval: the since-approval comparison toggle. */
  comparison: { approvalId: string; on: boolean } | null;
  /** Present for Markdown files. */
  markdown: { preview: boolean } | null;
}

export type MarkdownPreviewView =
  | { type: "loading" }
  | { type: "error"; message: string }
  /** `html` is the sanitized preview from the Markdown module. */
  | { type: "ready"; label: string; html: string };

export interface DiffPanelView {
  path: string;
  kind: string;
  wrap: boolean;
  sinceApproval: boolean;
  controls: DiffControlsView;
  body: DiffBodyView;
  /** Present while the Markdown preview replaces the source rows. */
  preview: MarkdownPreviewView | null;
}

function lineAction(line: LineActionView, sign: string): TemplateResult {
  const has = line.count > 0;
  const label = has
    ? `${line.count} note${line.count === 1 ? "" : "s"} on this line — click to ${line.open ? "hide" : "show"}`
    : line.resolved ? `Resolved note on this line — click to ${line.open ? "hide" : "show"}` : "Add a note on this line";
  return html`<button class="lact${has ? " has-note" : ""}${line.resolved ? " has-resolved" : ""}${line.open ? " is-open" : ""}" type="button" data-action="line-note" data-id=${line.id} data-tooltip=${label} aria-label=${label}><span class="lact-sign" aria-hidden="true">${sign}</span><span class="lact-add" aria-hidden="true">${bubblePlusIcon}</span>${has
      ? html`<span class="lact-bub" aria-hidden="true">${bubbleIcon}${line.count > 1 ? html`<b>${line.count}</b>` : nothing}</span>`
      : line.resolved ? html`<span class="lact-bub lact-bub-resolved" aria-hidden="true">${bubbleIcon}</span>` : nothing}</button>`;
}

// A line's tokens are cached, so an unchanged line skips its code entirely.
const code = (tokens: readonly CodeToken[]) => html`<code>${guard([tokens], () => tokens)}</code>`;

function codeRow(row: Extract<DiffRowView, { type: "code" }>): TemplateResult {
  const line = row.line;
  if (!line) return html`<div class="drow d-${row.kind}"><span class="ln">${row.old}</span><span class="ln">${row.new}</span><i>${row.sign}</i>${code(row.code)}</div>`;
  const notes = line.count > 0 ? " has-line-note" : line.resolved ? " has-line-note-resolved" : "";
  const ownership = line.ownership ? ` ${line.ownership}` : "";
  return html`<div data-line-id=${line.id} class="drow d-${row.kind}${notes}${ownership}${line.insightTarget ? " is-code-insight-target" : ""}"><span class="ln">${row.old}</span><span class="ln">${row.new}</span>${lineAction(line, row.sign)}${code(row.code)}</div>`;
}

function inlineInsight(view: InlineInsightView): TemplateResult {
  return html`<button type="button" class="code-insight-link type-${view.type} ${view.needsReview ? "needs-review" : ""}" data-action="code-insight" data-stage=${view.stageId} data-collection=${view.collection} data-item=${view.itemId}><b class="inline-insight-icon" role="img" aria-label=${view.label}>${view.glyph}</b><span class="inline-insight-text">${view.title}</span>${view.needsReview ? " · Needs review" : ""}</button>`;
}

function diffRow(row: DiffRowView): TemplateResult {
  switch (row.type) {
    case "code": return codeRow(row);
    case "banner": return html`<div class="drow d-${row.kind}"><span class="ln"></span><span class="ln"></span><i>${row.sign}</i><code>${row.text}</code></div>`;
    case "gap": return html`<div class="drow d-gap"><span class="ln"></span><span class="ln"></span><i></i><code>⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"} omitted ⋯</code></div>`;
    case "owner": return html`<div class="ownership-notice">Edited in <button type="button" data-action="jump-to" data-kind="line" data-id=${row.lineId} data-node-id=${row.nodeId} data-tooltip="Show change node">${row.title} ${arrowIcon}</button></div>`;
    // Keyed by insight, so removing one removes its button rather than
    // handing the button, and any focus on it, to the next insight on the line.
    case "insights": return html`<div class="line-code-insights">${repeat(row.insights, (view) => `${view.stageId}:${view.collection}:${view.itemId}`, inlineInsight)}</div>`;
    case "thread": return html`<div class="drow drow-thread">${lineThreadView(row.thread)}</div>`;
  }
}

function pager(view: DiffPagerView): TemplateResult {
  return html`<div class="diff-pages">
      <button type="button" data-action=${view.action} data-id=${view.id} data-offset=${view.previousOffset ?? 0} ?disabled=${view.previousOffset === null}>Previous page</button>
      <span>Rows ${view.offset + 1}–${view.offset + view.rows}</span>
      <button type="button" data-action=${view.action} data-id=${view.id} data-offset=${view.nextOffset ?? 0} ?disabled=${view.nextOffset === null}>Next page</button>
    </div>`;
}

// Rows are keyed, so a render that leaves a row unchanged keeps its element,
// its text nodes and any code selection inside it.
function grid(view: DiffGridView): TemplateResult {
  return html`<div class="diff-scroll${view.hideRemoved ? " hide-removed" : ""}"><div class="diff-grid">${repeat(view.rows, (row) => row.key, diffRow)}${view.pager ? pager(view.pager) : nothing}</div></div>`;
}

function comparisonInfo(view: ComparisonInfoView): TemplateResult {
  const toggle = (label: string) => html`<button class="tb-btn" type="button" data-action="approval-base-scope" data-id=${view.approvalId}>${label}</button>`;
  const base = view.baseChanges === "excluded"
    ? html`<p>The stage base changed since approval. Changes from the target branch or a lower stage are left out, so this shows only what changed in this stage. ${toggle("Include base changes")}</p>`
    : view.baseChanges === "included"
      ? html`<p>The stage base changed since approval. This comparison includes changes from the target branch or a lower stage, which were not made in this stage. ${toggle("Leave out base changes")}</p>`
      : view.baseChanges === "mixed"
        ? html`<p>The stage base changed since approval. Changes from the target branch or a lower stage could not be separated here, so not every change below was made in this stage.</p>`
        : nothing;
  return html`<div class="comparison-info"><p>Comparison with the approved file. Lines removed since approval are no longer in the file, so they cannot take line comments.</p>
      ${base}${view.ownershipChanged ? html`<p>This node’s file ownership or classification changed since approval.</p>` : nothing}</div>`;
}

function content(view: DiffContentView): TemplateResult {
  switch (view.type) {
    case "message": return html`<div class="diff-empty" role=${view.status ? "status" : nothing}>${view.text}</div>`;
    case "unsupported": return html`<div class="diff-empty">${view.text}<p>Approved SHA-256: ${view.approvedSha}<br>Current SHA-256: ${view.currentSha}</p></div>`;
    case "grid": return grid(view.grid);
  }
}

function toggle(on: boolean, action: string, label: string, attrs: { id?: string; mode?: string; title?: string } = {}): TemplateResult {
  return html`<button class="vt ${on ? "is-on" : ""}" type="button" data-action=${action} data-id=${attrs.id ?? nothing} data-mode=${attrs.mode ?? nothing} aria-pressed=${String(on)} data-tooltip=${attrs.title || nothing}>${label}</button>`;
}

function controls(view: DiffControlsView, preview: boolean): TemplateResult {
  // The Markdown toggle keeps its own place, so switching to Preview keeps the
  // focused button while the source controls go.
  const source = preview ? nothing : html`<div class="view-toggle">${toggle(view.wrap, "toggle-wrap", "Wrap lines")}</div>${view.view
    ? html`<div class="view-toggle" role="group" aria-label="Diff view">${toggle(!view.view.full, "set-view", "Changes", { id: view.fileId, mode: "hunk" })}${toggle(view.view.full, "set-view", "Full file", { id: view.fileId, mode: "full" })}</div>
        <div class="view-toggle" role="group" aria-label="Removed lines">${toggle(view.view.hideRemoved, "toggle-hide-removed", "Hide removed", { id: view.fileId, title: "Hide removed lines to preview the resulting file" })}</div>`
    : nothing}${view.comparison
    ? html`<div class="view-toggle">${toggle(view.comparison.on, "approval-comparison", "Since approval", { id: view.comparison.approvalId })}</div>`
    : nothing}`;
  const markdown = view.markdown
    ? html`<div class="view-toggle" role="group" aria-label="Markdown view">${toggle(!view.markdown.preview, "markdown-mode", "Source", { id: view.fileId, mode: "source" })}${toggle(view.markdown.preview, "markdown-mode", "Preview", { id: view.fileId, mode: "preview" })}</div>`
    : nothing;
  return html`${source}${markdown}`;
}

function markdownPreview(view: MarkdownPreviewView): TemplateResult {
  if (view.type === "loading") return html`<div class="diff-empty" role="status">Loading Markdown preview…</div>`;
  if (view.type === "error") return html`<div class="diff-empty" role="status">Preview unavailable: ${view.message}</div>`;
  // The one place the page inserts HTML: the Markdown module's DOMPurify output,
  // limited to formatting tags, with link and image URLs validated and
  // resolved. Every other value on the page is rendered as text.
  return html`<div class="markdown-revision">${view.label} · Switch to Source to review lines.</div><article class="markdown-preview">${unsafeHTML(view.html)}</article>`;
}

export function diffPanelView(view: DiffPanelView): TemplateResult {
  const hint = view.kind === "added" ? "New file" : view.kind === "deleted" ? "Deleted file" : "Inline diff";
  return html`<section class="diff-panel ${view.wrap ? "wrap-lines" : ""} ${view.sinceApproval ? "is-approved-comparison" : ""} is-compact" aria-label="Diff for ${view.path}">
      <header class="diff-bar">
        <span class="diff-bar-hint">${hint}</span>
        ${controls(view.controls, Boolean(view.preview))}
      </header>
      <div class="source-view" ?hidden=${Boolean(view.preview)}>${view.body.comparison ? comparisonInfo(view.body.comparison) : nothing}${content(view.body.content)}</div>
      ${view.preview ? markdownPreview(view.preview) : nothing}
    </section>`;
}
