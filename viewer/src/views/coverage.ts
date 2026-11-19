import { html, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { barWidth, percentOf } from "./bar-width";

export interface CoverageStageView {
  id: string;
  /** The stage's two-digit position. */
  number: string;
  title: string;
  approved: boolean;
  nodesApproved: number;
  nodes: number;
  filesApproved: number;
  files: number;
}

export interface CoverageView {
  open: boolean;
  approved: number;
  reviewable: number;
  percent: number;
  stages: readonly CoverageStageView[];
}

function coverageStage(stage: CoverageStageView): TemplateResult {
  return html`<div class="cov-stage ${stage.approved ? "is-approved" : ""}">
        <div class="cov-h"><span>${stage.approved ? "✓" : stage.number}</span><strong>${stage.title}</strong></div>
        <div class="cov-bars">
          <span class="cov-bar" title="${stage.nodesApproved}/${stage.nodes} steps"><i ${barWidth(percentOf(stage.nodesApproved, stage.nodes))}></i></span>
          <span class="cov-bar files" title="${stage.filesApproved}/${stage.files} file reviews"><i ${barWidth(percentOf(stage.filesApproved, stage.files))}></i></span>
        </div>
        <small>${stage.approved ? "Stage approved" : "Stage approval pending"} · ${stage.nodesApproved}/${stage.nodes} steps · ${stage.filesApproved}/${stage.files} file reviews</small>
      </div>`;
}

export function coverageView(view: CoverageView): TemplateResult {
  return html`<aside class="side coverage ${view.open ? "is-open" : ""}" aria-hidden=${String(!view.open)} ?inert=${!view.open}>
      <div class="side-head"><div><span class="eyebrow">At a glance</span><h2>Review coverage</h2></div><button data-action="toggle-coverage" aria-label="Close" type="button">×</button></div>
      <div class="cov-score"><strong>${view.percent}%</strong><span>${view.approved} of ${view.reviewable} approved</span><div class="mini-bar"><i ${barWidth(view.percent)}></i></div></div>
      <div class="cov-list">${repeat(view.stages, (stage) => stage.id, coverageStage)}</div>
      <div class="cov-key"><span><i class="steps"></i>Steps</span><span><i class="files"></i>File reviews</span></div>
    </aside>`;
}
