import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";

export interface ApprovalErrorView {
  id: string;
  message: string;
}

export interface NoticesView {
  approvalErrors: readonly ApprovalErrorView[];
  /** Threads the agent answered in its last round, while the notice shows. */
  roundCount: number | null;
  /** A page refresh message, shown when no round notice is. */
  refresh: string;
}

function roundNotice(count: number): TemplateResult {
  return html`<div class="review-update agent-round" role="status"><span>Agent replied to ${count} thread${count === 1 ? "" : "s"}</span><button type="button" data-action="show-unread">Show</button><button type="button" data-action="dismiss-round" aria-label="Dismiss">×</button></div>`;
}

export function noticesView(view: NoticesView): TemplateResult {
  return html`${repeat(view.approvalErrors, (error) => error.id, (error) => html`<div class="review-update" role="alert">Approval was not saved: ${error.message}</div>`)}${view.roundCount !== null
    ? roundNotice(view.roundCount)
    : view.refresh ? html`<div class="review-update" role="status">${view.refresh}</div>` : nothing}`;
}
