// The story column: the implementation's header, its specifications, and its stages.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { stageView, type StageView } from "./stage";
import { labelHint } from "../tooltips";

export interface HeroView {
  title: string;
  summary: string;
  stages: number;
  steps: number;
  files: number;
  viewerVersion: string;
  targetBranch: string;
  baseRevision: string;
}

export interface SpecificationSourceView {
  /** The kind of source, e.g. "GitHub". */
  label: string;
  /** The reference shown, or the label without one. */
  text: string;
  /** A validated http(s) link; empty shows the reference as text. */
  href: string;
}

export type CriterionStatus = "approved" | "pending" | "uncovered";

export interface CriterionView {
  id: string;
  /** `<specificationId>#<criterionId>`. */
  ref: string;
  text: string;
  status: CriterionStatus;
  /** The stages covering the criterion, e.g. "Stage 01 · 03". */
  stages: string;
}

export interface SpecificationView {
  id: string;
  title: string;
  summary: string;
  /** The disclosure's saved state; the browser owns it between changes. */
  open: boolean;
  source: SpecificationSourceView | null;
  criteria: readonly CriterionView[];
}

export interface StoryView {
  hero: HeroView;
  specifications: readonly SpecificationView[];
  stages: readonly StageView[];
  approved: number;
  reviewable: number;
}

const CRITERION_LABEL: Record<CriterionStatus, string> = { approved: "Approved", pending: "In review", uncovered: "Not covered" };

function hero(view: HeroView): TemplateResult {
  return html`<section class="hero">
      <h1>${view.title}</h1>
      <p class="hero-sum">${view.summary}</p>
      <div class="hero-line">
        <span><b>${view.stages}</b> stages</span>
        <span><b>${view.steps}</b> steps</span>
        <span><b>${view.files}</b> files</span>
        <span class="hero-skill-version">Viewer version: ${view.viewerVersion}</span>
        <span class="hero-target">${view.targetBranch} ← ${view.baseRevision}</span>
      </div>
    </section>`;
}

function specificationSource(source: SpecificationSourceView | null): TemplateResult | typeof nothing {
  if (!source) return nothing;
  // A reference names its link target, and its text where the layout cuts it off.
  const hint = labelHint(source.href || source.text, source.text);
  const reference = source.href
    ? html`<a class="req-src-ref" href=${source.href} target="_blank" rel="noopener noreferrer" data-clippable data-tooltip=${hint.tooltip || nothing} data-tooltip-clipped=${hint.clipped || nothing}>${source.text}</a>`
    : html`<span class="req-src-ref" tabindex=${hint.clipped ? "0" : nothing} data-clippable data-tooltip-clipped=${hint.clipped || nothing}>${source.text}</span>`;
  return html`<p class="req-source"><span class="req-src-kind">${source.label}</span>${reference}</p>`;
}

function criterion(item: CriterionView): TemplateResult {
  return html`<li class="ac-item ac-${item.status}" data-ac=${item.ref}><span class="ac-id">${item.id}</span><span class="ac-text">${item.text}</span><span class="ac-status" tabindex=${item.stages ? "0" : nothing} data-tooltip=${item.stages || nothing}>${CRITERION_LABEL[item.status]}</span></li>`;
}

// `open` is set only when the saved state changes, as the animated toggle
// updates the saved state once it has opened or closed the disclosure.
function specification(spec: SpecificationView): TemplateResult {
  return html`<details class="specification" ?open=${spec.open} data-req data-req-id=${spec.id}>
      <summary>
        <span class="req-mark">✦</span>
        <div><span class="eyebrow">Specification · ${spec.id}</span><h2>${spec.title}</h2></div>
        <span class="req-more">${spec.criteria.length} acceptance criteria</span>
      </summary>
      <div class="req-body">
        <p>${spec.summary}</p>
        ${specificationSource(spec.source)}
        <ol class="ac-list">${repeat(spec.criteria, (item) => item.ref, criterion)}</ol>
      </div>
    </details>`;
}

export function storyView(view: StoryView): TemplateResult {
  const remaining = view.reviewable - view.approved;
  return html`<div class="story">
      ${hero(view.hero)}
      ${repeat(view.specifications, (spec) => spec.id, specification)}
      <div class="spine">
        ${repeat(view.stages, (stage) => stage.id, stageView)}
      </div>
      <footer class="story-end">
        <span class="eyebrow">End of review</span>
        <p>${remaining ? `${remaining} of ${view.reviewable} items still await your review.` : "Every stage, step, and file review has your approval."}</p>
      </footer>
    </div>`;
}
