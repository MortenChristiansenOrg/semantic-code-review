// A step's reasoning: the legend in its summary and the linked insight tags.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { notesToggle, type NotesToggleView } from "./controls";

export type InsightReview = "none" | "reviewed" | "changed";

export interface InsightLegendEntry {
  type: string;
  glyph: string;
  label: string;
  count: number;
}

export interface ReasoningLegendView {
  entries: readonly InsightLegendEntry[];
  /** Checks that failed or did not run. */
  notPassed: number;
}

/** Counts of a step's linked reasoning by type; each opens the matching tags. */
export function reasoningLegend(view: ReasoningLegendView | null): TemplateResult | typeof nothing {
  if (!view) return nothing;
  return html`<div class="reasoning-summary"><span class="eyebrow">Reasoning</span><div class="reasoning-key">${view.entries.map((entry) => html`<button type="button" class="rk type-${entry.type}" data-action="focus-reasoning" data-type=${entry.type} aria-label="${entry.label}: ${entry.count}"><b aria-hidden="true">${entry.glyph}</b>${entry.count}</button>`)}${view.notPassed
    ? html`<button type="button" class="rk rk-alert" data-action="focus-reasoning" data-type="not-passed" aria-label="Checks not passed: ${view.notPassed}"><b aria-hidden="true">✕</b>${view.notPassed}</button>`
    : nothing}</div></div>`;
}

export interface CodeInsightLinkView {
  stageId: string;
  collection: string;
  itemId: string;
  needsReview: boolean;
}

/** Opens an insight beside the code it is linked to. */
export function codeInsightLink(view: CodeInsightLinkView | null): TemplateResult | typeof nothing {
  if (!view) return nothing;
  return html`<button type="button" class="code-insight-link ${view.needsReview ? "needs-review" : ""}" data-action="code-insight" data-stage=${view.stageId} data-collection=${view.collection} data-item=${view.itemId}>View code${view.needsReview ? " · Needs review" : ""}</button>`;
}

export interface InsightTagView {
  /** The insight's key, which also identifies its feedback thread. */
  key: string;
  stageId: string;
  collection: string;
  itemId: string;
  type: string;
  /** The validation status (passed, failed, notrun), or empty for other insights. */
  vstat: string;
  glyph: string;
  label: string;
  /** The kind as shown on the tag, e.g. "Check · Automated". */
  kindText: string;
  meta: string;
  title: string;
  body: string;
  review: InsightReview;
  reviewMark: string;
  reviewText: string;
  reviewTooltip: string;
  /** Present for evidence; its notes toggle shows on the step hosting its thread. */
  evidence: { notes: NotesToggleView | null } | null;
  code: CodeInsightLinkView | null;
}

function insightTag(tag: InsightTagView): TemplateResult {
  const reviewLabel = `${tag.review === "changed" ? "Reviewed before it changed" : "Reviewed"}: ${tag.title}`;
  return html`<span class="tag ${tag.code || tag.evidence ? "has-code" : ""} type-${tag.type} ${tag.vstat ? `vstat-${tag.vstat}` : ""} review-${tag.review}" data-insight=${tag.key}>
      <button class="insight-review" type="button" data-action="toggle-insight-review" data-stage=${tag.stageId} data-collection=${tag.collection} data-item=${tag.itemId}
        aria-pressed=${String(tag.review === "reviewed")} aria-label=${reviewLabel} data-tooltip=${tag.reviewTooltip}><span aria-hidden="true">${tag.reviewMark}</span></button><button class="tag-face" type="button" data-tagpop="1"
        data-type=${tag.type} data-vstat=${tag.vstat}
        data-glyph=${tag.glyph} data-label=${tag.label} data-meta=${tag.meta} data-review=${tag.reviewText}
        data-title=${tag.title} data-body=${tag.body}
        aria-haspopup="true">
        <b>${tag.glyph}</b><span class="tag-kind">${tag.kindText}</span><span class="tag-gist">${tag.title}</span>
      </button>${tag.evidence
        ? html`<button type="button" class="code-insight-link" data-action="view-evidence" data-stage=${tag.stageId} data-item=${tag.itemId}>View evidence</button>${notesToggle(tag.evidence.notes)}`
        : nothing}${codeInsightLink(tag.code)}
    </span>`;
}

/** A step's linked insights as tags, keyed so open popovers and focus survive updates. */
export function insightTags(tags: readonly InsightTagView[]): TemplateResult {
  return html`${repeat(tags, (tag) => tag.key, insightTag)}`;
}
