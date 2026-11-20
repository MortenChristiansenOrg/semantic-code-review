import { html, nothing, type TemplateResult } from "lit-html";
import { barWidth } from "./bar-width";

export type AgentPresence = "stopping" | "working" | "listening" | "offline";

export interface AgentPillView {
  presence: AgentPresence;
  /** A session runs that can be asked to stop. */
  canStop: boolean;
  command: string;
  commandCopied: boolean;
}

export interface TopbarView {
  remote: boolean;
  /** The remote branch or the implementation ID. */
  subject: string;
  /** Absent for remote reviews and before the agent status is known. */
  agent: AgentPillView | null;
  refreshingRemote: boolean;
  reviewsOpen: boolean;
  coverageOpen: boolean;
  notesOpen: boolean;
  approved: number;
  reviewable: number;
  percent: number;
  activeNotes: number;
}

const dot = html`<span class="agent-dot" aria-hidden="true"></span>`;

// Always-visible agent presence; stopping is offered while a session runs.
function agentPill(agent: AgentPillView): TemplateResult {
  if (agent.presence === "offline") {
    return html`<button class="tb-btn agent-pill is-offline" data-action="copy-agent-command" type="button" data-tooltip="No agent is listening. Copy ${agent.command} and run it in your agent.">${dot}${agent.commandCopied ? "Command copied" : "No agent listening"}</button>`;
  }
  const label = { stopping: "Agent stopping", working: "Agent working", listening: "Agent listening" }[agent.presence];
  const stop = agent.canStop && agent.presence !== "stopping"
    ? html`<button class="tb-btn agent-stop" data-action="stop-agent" type="button" data-tooltip="The agent finishes its current round, then stops listening">Stop agent</button>`
    : nothing;
  return html`<span class="agent-pill is-${agent.presence}" role="status">${dot}${label}</span>${stop}`;
}

export function topbarView(view: TopbarView): TemplateResult {
  return html`<div class="topbar-wrap">
      <header class="topbar">
        <div class="lockup">
          <span class="vindex">◆</span>
          <div><strong>${view.remote ? "Remote review" : "Implementation"}</strong><span>${view.subject}</span></div>
        </div>
        <div class="tb-actions">
          ${view.agent ? agentPill(view.agent) : nothing}
          <button class="tb-btn" data-action="file-search" type="button" aria-keyshortcuts="t" data-tooltip="Find file (T)">Find file <kbd aria-hidden="true">T</kbd></button>
          ${view.remote ? html`<button class="tb-btn" data-action="refresh-remote" type="button" ?disabled=${view.refreshingRemote}>${view.refreshingRemote ? "Refreshing…" : "Refresh branch"}</button>` : nothing}
          <button class="tb-btn" data-action="toggle-reviews" type="button" aria-expanded=${String(view.reviewsOpen)} aria-controls="review-list">Reviews</button>
          <button class="tb-btn ${view.coverageOpen ? "is-on" : ""}" data-action="toggle-coverage" type="button" aria-expanded=${String(view.coverageOpen)}>Coverage <b>${view.approved}/${view.reviewable}</b></button>
          <button class="tb-btn ${view.notesOpen ? "is-on" : ""}" data-action="toggle-notes" type="button" aria-expanded=${String(view.notesOpen)}>Notes <b>${view.activeNotes}</b></button>
        </div>
      </header>
      <div class="progressbar" aria-hidden="true"><span ${barWidth(view.percent)}></span></div>
    </div>`;
}
