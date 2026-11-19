// A stage: its title bar, summary and progress, its steps, and its approval.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { acceptanceChip, addNoteButton, approveButton, notesToggle, type AcceptanceChipView, type ApproveButtonView, type NotesToggleView } from "./controls";
import { nodeView, type NodeView } from "./node";
import { inlineThread, type ThreadListView } from "./thread";

export interface StageDependencyView {
  /** The chip text: the stage number, or the ID of an unknown stage. */
  text: string;
  title: string;
}

export interface StageView {
  id: string;
  /** The stage's two-digit position. */
  number: string;
  title: string;
  summary: string;
  rationale: string;
  open: boolean;
  approved: boolean;
  nodesApproved: number;
  nodeCount: number;
  filesApproved: number;
  fileCount: number;
  insightsReviewed: number;
  insightCount: number;
  dependencies: readonly StageDependencyView[];
  /** Every dependency in words, for the dependency list's tooltip. */
  dependencySummary: string;
  acceptance: readonly AcceptanceChipView[];
  notes: NotesToggleView | null;
  approve: ApproveButtonView;
  /** The stage's thread, while it is shown. */
  thread: ThreadListView | null;
  nodes: readonly NodeView[];
}

function stageMeta(stage: StageView): TemplateResult {
  return html`<div class="stage-meta">
            <span>${stage.nodesApproved}/${stage.nodeCount} steps</span>
            <span>${stage.filesApproved}/${stage.fileCount} file reviews</span>
            ${stage.insightCount ? html`<span>${stage.insightsReviewed}/${stage.insightCount} insights reviewed</span>` : nothing}
            ${stage.dependencies.length ? html`<span class="sm-deps" data-tooltip-focus title="Depends on ${stage.dependencySummary}"><span class="sm-deps-label">Depends on</span>${stage.dependencies.map((dep) => html`<span class="dep-chip" title=${dep.title}>${dep.text}</span>`)}</span>` : nothing}
            ${stage.acceptance.length ? html`<span class="sm-ac"><span class="sm-ac-label" aria-label="Acceptance criteria">✦</span>${stage.acceptance.map(acceptanceChip)}</span>` : nothing}
          </div>`;
}

/** The body is inert while the stage is closed, so its steps leave the tab order. */
export function stageView(stage: StageView): TemplateResult {
  const target = { kind: "stage", id: stage.id, stageId: "" } as const;
  return html`<section class="stage ${stage.approved ? "is-approved" : ""} ${stage.open ? "is-open" : ""}" data-stage=${stage.id} aria-labelledby="stage-title-${stage.id}">
      <div class="stage-card">
      <div class="stage-bar">
        <button class="stop ${stage.approved ? "is-approved" : ""}" data-action="toggle-stage" data-id=${stage.id} type="button" aria-expanded=${String(stage.open)}>
          <span class="stop-num">${stage.approved ? "✓" : stage.number}</span>
        </button>
        <div class="stage-head">
          <button class="stage-title" data-action="toggle-stage" data-id=${stage.id} type="button" aria-expanded=${String(stage.open)}>
            <span class="stage-kicker">Stage ${stage.number}</span>
            <h2 id="stage-title-${stage.id}">${stage.title}</h2>
          </button>
          <p class="stage-sum">${stage.summary}</p>
          <p class="rationale"><span class="rationale-label" data-tooltip-focus title=${stage.rationale}>Why this stage</span></p>
          ${stageMeta(stage)}
        </div>
        <div class="stage-approve"><div class="note-cluster">${notesToggle(stage.notes)}${addNoteButton(target)}</div>${approveButton(stage.approve, "sm")}</div>
      </div>
      ${inlineThread(stage.thread)}
      <div class="stage-body" ?inert=${!stage.open}>
        <div class="stage-children-head">
          <span class="eyebrow">Steps in stage ${stage.number}</span>
          <span class="stage-children-count">${stage.nodesApproved}/${stage.nodeCount} approved</span>
        </div>
        <div class="nodes">${repeat(stage.nodes, (node) => node.id, nodeView)}</div>
        <div class="stage-foot">
          <span class="stage-foot-label">End of stage ${stage.number}</span>
          ${approveButton(stage.approve, "", `stage ${stage.number}`)}
        </div>
      </div>
      </div>
    </section>`;
}
