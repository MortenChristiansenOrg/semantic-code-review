// The contents of the code insight and evidence dialogs. The dialogs
// themselves, with their animations and focus handling, are created by the page.
import { html, nothing, type TemplateResult } from "lit-html";

export interface CodeContextView {
  path: string;
  startLine: number;
  endLine: number;
  /** The revision, shortened for display. */
  revision: string;
  contextStartLine: number;
  context: readonly string[];
}

export interface CodeInsightView {
  /** The insight titles to choose between; empty when there is one insight. */
  choices: readonly string[];
  chosen: number;
  status: "current" | "mapped" | "needs-review";
  /** Why the linked code needs review; empty otherwise. */
  reason: string;
  kindLabel: string;
  title: string;
  body: string;
  /** The code shown: the linked code, or the original code when it needs review. */
  shown: CodeContextView;
  /** The original context of a mapped insight. */
  original: CodeContextView | null;
  onChoose: (index: number) => void;
  onClose: () => void;
}

function codeContext(view: CodeContextView): TemplateResult {
  return html`<div class="insight-code-block" tabindex="0" aria-label="Code context">${view.context.map((line, index) => {
    const number = view.contextStartLine + index;
    return html`<div class="insight-code-line ${number >= view.startLine && number <= view.endLine ? "is-target" : ""}"><span>${number}</span><code>${line || " "}</code></div>`;
  })}</div>`;
}

export function codeInsightView(view: CodeInsightView): TemplateResult {
  const stale = view.status === "needs-review";
  const status = stale ? `Needs review: ${view.reason}`
    : view.status === "mapped" ? "Linked code is unchanged; mapped to this stage revision. The insight has not been re-reviewed." : "Linked to this stage revision.";
  return html`<header><h2 id="code-insight-title">Insight and code</h2><button type="button" data-close aria-label="Close insight" @click=${view.onClose}>Close</button></header>
      ${view.choices.length > 1 ? html`<label class="insight-picker">Insight <select @change=${(event: Event) => view.onChoose(Number((event.target as HTMLSelectElement).value))}>${view.choices.map((title, index) => html`<option value=${index} .selected=${index === view.chosen}>${title}</option>`)}</select></label>` : nothing}
      <p class="insight-target-status ${stale ? "needs-review" : ""}">${status}</p>
      <div class="code-insight-columns"><article tabindex="0" aria-label="Insight text"><p class="eyebrow">${view.kindLabel}</p><h3>${view.title}</h3><div class="insight-full-body">${view.body}</div>
          ${stale ? html`<p>Review the insight against the revised code, then use <code>stage target</code> to retarget it or remove its code link. Its original context is preserved here.</p>` : nothing}</article>
        <section aria-label="Linked code"><h3>${stale ? "Original code" : "Linked code"}</h3><p class="insight-code-location">${view.shown.path}:${view.shown.startLine}–${view.shown.endLine} · ${view.shown.revision}</p>${codeContext(view.shown)}
          ${view.original ? html`<details class="insight-original"><summary>Original context · ${view.original.revision}</summary><p>${view.original.path}:${view.original.startLine}–${view.original.endLine}</p>${codeContext(view.original)}</details>` : nothing}</section></div>`;
}

export interface EvidenceAttachmentView {
  /** The attachment's position in the evidence, which identifies it. */
  index: number;
  type: "image" | "video" | "text" | "file";
  url: string;
  name: string;
  caption: string;
  download: string;
  /** The capture could not be loaded. */
  failed: boolean;
  zoomed: boolean;
  /** Loaded text; null while it loads. */
  text: string | null;
}

export interface EvidenceView {
  captured: string;
  kindLabel: string;
  title: string;
  reproduction: string;
  before: readonly EvidenceAttachmentView[];
  after: readonly EvidenceAttachmentView[];
  others: readonly EvidenceAttachmentView[];
  inline: string;
  criteria: readonly { ref: string; text: string }[];
  nodes: readonly string[];
  onZoom: (index: number) => void;
  onFailed: (index: number) => void;
  onClose: () => void;
}

function attachment(view: EvidenceView, item: EvidenceAttachmentView): TemplateResult {
  // A capture that cannot load leaves only the notice in its figure.
  if (item.failed) return html`<figure><p class="evidence-file" role="status">This evidence could not be loaded.</p></figure>`;
  const caption = item.caption ? html`<figcaption>${item.caption}</figcaption>` : nothing;
  const open = html`<a class="evidence-open" href=${item.url} download=${item.download}>Download</a>`;
  const failed = () => view.onFailed(item.index);
  switch (item.type) {
    case "image": return html`<figure><button type="button" class="evidence-zoom ${item.zoomed ? "is-zoomed" : ""}" data-evidence-zoom aria-pressed=${String(item.zoomed)} aria-label="Zoom ${item.name}" @click=${() => view.onZoom(item.index)}><img src=${item.url} alt=${item.name} @error=${failed}></button>${caption}${open}</figure>`;
    case "video": return html`<figure><video src=${item.url} controls preload="metadata" aria-label=${item.name} @error=${failed}></video>${caption}${open}</figure>`;
    case "text": return html`<figure><pre class="evidence-text" tabindex="0" aria-label=${item.name} data-evidence-text=${item.url}>${item.text ?? "Loading…"}</pre>${caption}${open}</figure>`;
    case "file": return html`<figure><p class="evidence-file">${item.name}</p>${caption}${open}</figure>`;
  }
}

function column(view: EvidenceView, title: string, list: readonly EvidenceAttachmentView[]): TemplateResult {
  return html`<section aria-label=${title}><h4>${title}</h4>${list.map((item) => attachment(view, item))}</section>`;
}

export function evidenceView(view: EvidenceView): TemplateResult {
  return html`<header><h2 id="evidence-title">Evidence</h2><button type="button" class="evidence-close" data-close aria-label="Close evidence" @click=${view.onClose}>×</button></header>
      <p class="insight-target-status">Captured ${view.captured}</p>
      <p class="eyebrow">${view.kindLabel}</p><h3>${view.title}</h3>
      ${view.reproduction ? html`<p class="evidence-reproduction"><b>Reproduce:</b> ${view.reproduction}</p>` : nothing}
      ${view.before.length || view.after.length ? html`<div class="evidence-compare">${column(view, "Before", view.before)}${column(view, "After", view.after)}</div>` : nothing}
      ${view.others.map((item) => attachment(view, item))}
      ${view.inline ? html`<pre class="evidence-text" tabindex="0" aria-label="Captured output">${view.inline}</pre>` : nothing}
      ${view.criteria.length ? html`<h4>Acceptance criteria</h4><ul class="evidence-links">${view.criteria.map((item) => html`<li><code>${item.ref}</code>${item.text ? ` ${item.text}` : nothing}</li>`)}</ul>` : nothing}
      ${view.nodes.length ? html`<h4>Changes</h4><ul class="evidence-links">${view.nodes.map((title) => html`<li>${title}</li>`)}</ul>` : nothing}`;
}
