// A change node ("step"): a disclosure with its reasoning, files and notes.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { addNoteButton, notesToggle, type ApprovalState, type NotesToggleView } from "./controls";
import { nodeFiles, type NodeFilesView } from "./files";
import { caretIcon } from "./icons";
import { insightTags, reasoningLegend, type InsightTagView, type ReasoningLegendView } from "./insights";
import { inlineThread, type ThreadListView } from "./thread";

export interface NodeView {
  id: string;
  stageId: string;
  /** The step's position, e.g. "2.3" for the third step of stage 2. */
  index: string;
  title: string;
  description: string;
  approval: ApprovalState;
  legend: ReasoningLegendView | null;
  insights: readonly InsightTagView[];
  /** Threads on evidence this step hosts, while they are shown. */
  insightThreads: readonly ThreadListView[];
  files: NodeFilesView;
  notes: NotesToggleView | null;
  /** The step's own thread, while it is shown. */
  thread: ThreadListView | null;
}

const STALE = "One or more file approvals are stale";

/** The open state of the disclosure belongs to the browser: the template never
 * binds `open`, so rendering keeps what the reviewer (or code) set. */
export function nodeView(node: NodeView): TemplateResult {
  const done = node.approval === "approved", stale = node.approval === "stale";
  // The check's hint is also the summary's, so keyboard focus describes it.
  const tooltip = stale ? STALE : nothing;
  return html`<details class="node ${done ? "is-approved" : ""} ${stale ? "is-stale" : ""}" data-node=${node.id}>
      <summary data-tooltip=${tooltip}>
        <span class="node-check" data-tooltip=${tooltip}>${stale ? "!" : done ? "✓" : ""}</span>
        <span class="node-ix">${node.index}</span>
        <div class="node-head">
          <h3>${node.title}</h3>
          <p>${node.description}</p>
          ${reasoningLegend(node.legend)}
        </div>
        <span class="node-caret">${caretIcon}</span>
      </summary>
      <div class="node-body">
        ${node.insights.length ? html`<div class="node-reasoning">
          <span class="eyebrow">Reasoning</span>
          <div class="tag-row">${insightTags(node.insights)}</div>
          ${repeat(node.insightThreads, (thread) => thread.id, inlineThread)}
        </div>` : nothing}
        ${nodeFiles(node.files)}
        <div class="node-foot"><div class="note-cluster">${addNoteButton({ kind: "node", id: node.id, stageId: node.stageId })}${notesToggle(node.notes)}</div></div>
        ${inlineThread(node.thread)}
      </div>
    </details>`;
}
