// The notes side panel: every thread and local note, grouped by stage, step
// and day, with the controls that send feedback to the agent.
import { html, nothing, type TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { threadEntries, type ThreadEntryView } from "./thread";

export interface NoteDayView {
  key: string;
  label: string;
  entries: readonly ThreadEntryView[];
}

export interface NoteNodeView {
  key: string;
  title: string;
  days: readonly NoteDayView[];
}

export interface NoteStageView {
  key: string;
  title: string;
  nodes: readonly NoteNodeView[];
}

export interface NotesExportView {
  /** Unsent feedback notes and replies. */
  pending: number;
  /** A send is in progress. */
  working: boolean;
  /** The outcome of the last send; empty while there is none. */
  outcome: "" | "done" | "error";
  /** Reports the last send; empty to show the hint instead. */
  message: string;
  hint: string;
  /** What the last send left out, and why. */
  skips: readonly string[];
  /** Whether saved feedback goes to the agent at once; null while no agent takes it. */
  autoSend: boolean | null;
}

export interface NotesPanelView {
  open: boolean;
  remote: boolean;
  filter: "active" | "resolved";
  activeCount: number;
  resolvedCount: number;
  active: readonly NoteStageView[];
  resolved: readonly NoteStageView[];
  /** Absent for remote reviews, whose notes stay local. */
  export: NotesExportView | null;
}

function noteDay(day: NoteDayView): TemplateResult {
  return html`<div class="note-day">${day.label}</div><div class="note-convos">${threadEntries(day.entries)}</div>`;
}

function noteNode(node: NoteNodeView): TemplateResult {
  return html`<div class="note-node"><h4 class="note-node-h">${node.title}</h4>
        ${repeat(node.days, (day) => day.key, noteDay)}
      </div>`;
}

function noteStages(stages: readonly NoteStageView[]): unknown {
  return repeat(stages, (stage) => stage.key, (stage) => html`<section class="note-stage">
      <h3 class="note-stage-h">${stage.title}</h3>
      ${repeat(stage.nodes, (node) => node.key, noteNode)}</section>`);
}

function filterButton(filter: NotesPanelView["filter"], label: string, count: number, on: boolean): TemplateResult {
  return html`<button class="notes-switch-btn ${on ? "is-on" : ""}" data-action="notes-filter" data-filter=${filter} type="button" role="tab" aria-selected=${String(on)}>${label}${count ? html`<b>${count}</b>` : nothing}</button>`;
}

const AUTO_SEND = "Send each feedback note and reply to the listening agent when you save it. Personal notes stay local.";

function exportFoot(view: NotesExportView): TemplateResult {
  return html`<div class="notes-foot">
        <div class="notes-export-row">
          <button class="notes-export" data-action="export-feedback" type="button" ?disabled=${!view.pending || view.working}>
            ${view.working ? "Sending…" : `Prepare feedback${view.pending ? ` (${view.pending})` : ""}`}
          </button>
          ${view.autoSend === null ? nothing : html`<label class="notes-auto-send" data-tooltip=${AUTO_SEND}><input type="checkbox" name="auto-send" .checked=${live(view.autoSend)}><span>Send automatically</span></label>`}
        </div>
        ${view.message ? html`<p class="notes-export-msg ${view.outcome ? `is-${view.outcome}` : ""}">${view.message}</p>`
          : html`<p class="notes-export-hint">${view.hint}</p>`}
        ${view.skips.length ? html`<ul class="notes-export-skips">${view.skips.map((skip) => html`<li>${skip}</li>`)}</ul>` : nothing}
      </div>`;
}

export function notesPanelView(view: NotesPanelView): TemplateResult {
  const active = view.filter === "active";
  return html`<aside class="side notes ${view.open ? "is-open" : ""}" aria-hidden=${String(!view.open)} ?inert=${!view.open}>
      <div class="side-head"><div><span class="eyebrow">Your review notes</span><h2>${view.remote ? "Personal notes" : "Notes & feedback"}</h2></div><button data-action="toggle-notes" aria-label="Close" type="button">×</button></div>
      <div class="notes-list"><div class="notes-switch" role="tablist">
      ${filterButton("active", "Active", view.activeCount, active)}
      ${filterButton("resolved", "Resolved", view.resolvedCount, !active)}
    </div><div class="notes-track is-${view.filter}">
      <div class="notes-col notes-col-active" data-thread-list="notes:active" ?hidden=${!active} ?inert=${!active}>${view.active.length ? noteStages(view.active)
        : html`<div class="notes-empty"><span>✎</span><p>No notes yet.</p><small>Leave a note on any stage, step, file, or line.</small></div>`}</div>
      <div class="notes-col notes-col-resolved" data-thread-list="notes:resolved" ?hidden=${active} ?inert=${active}>${noteStages(view.resolved)}${view.resolvedCount
        ? nothing : html`<div class="notes-empty small"><small>No resolved threads yet.</small></div>`}</div>
    </div></div>
      ${view.export ? exportFoot(view.export) : html`<div class="notes-foot"><p>Personal notes stay on this computer.</p></div>`}
    </aside>`;
}
