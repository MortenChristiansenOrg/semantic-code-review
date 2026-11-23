import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";

export interface ApprovalErrorView {
  id: string;
  message: string;
}

/** An agent reply that arrived while the page was open. */
export interface ReplyToastView {
  /** The reply's read marker key. */
  key: string;
  /** The kind of element its thread is about, such as "Line". */
  kind: string;
  /** The element its thread is about, and its full name. */
  target: string;
  targetTitle: string;
  /** The reply's first line. */
  excerpt: string;
  /** Names the toast for assistive technology. */
  label: string;
}

export interface ReplyToastsView {
  /** Oldest first. */
  items: readonly ReplyToastView[];
  /** Too many to show one by one; they collapse into one group. */
  grouped: boolean;
  /** The group shows each toast. */
  expanded: boolean;
  /** What the status region announces about the latest replies. */
  announcement: string;
}

export interface NoticesView {
  approvalErrors: readonly ApprovalErrorView[];
  /** Agent replies the reviewer has not shown, dismissed or read. */
  replies: ReplyToastsView;
  /** A refresh or failure message. */
  refresh: string;
}

function replyToast(toast: ReplyToastView): TemplateResult {
  return html`<div class="reply-toast" role="group" aria-label=${toast.label}>
    <div class="reply-toast-text">
      <span class="reply-toast-about"><span class="reply-toast-kind">${toast.kind}</span><span class="reply-toast-target" data-tooltip=${toast.targetTitle}>${toast.target}</span></span>
      ${toast.excerpt ? html`<span class="reply-toast-excerpt">${toast.excerpt}</span>` : nothing}
    </div>
    <button type="button" data-action="show-reply-toast" data-key=${toast.key}>Show</button>
    <button type="button" class="reply-toast-dismiss" data-action="dismiss-reply-toast" data-key=${toast.key} aria-label="Dismiss" data-tooltip="Dismiss">×</button>
  </div>`;
}

function replyToasts(view: ReplyToastsView): TemplateResult {
  const count = view.items.length;
  const dismissAll = count > 1
    ? html`<button type="button" class="reply-toasts-dismiss" data-action="dismiss-reply-toasts">Dismiss all</button>` : nothing;
  if (!view.grouped) return html`<div class="reply-toasts">${dismissAll}${repeat(view.items, (toast) => toast.key, replyToast)}</div>`;
  const summary = `${count} agent replies`;
  return html`<div class="reply-toasts is-grouped${view.expanded ? " is-expanded" : ""}">
    <div class="reply-toast reply-toast-group" role="group" aria-label=${summary}>
      <button type="button" class="reply-toast-expand" data-action="toggle-reply-toasts" aria-expanded=${String(view.expanded)}>
        <span class="reply-toast-count">${summary}</span><span class="reply-toast-hint">${view.expanded ? "Collapse" : "Expand"}</span>
      </button>
      ${dismissAll}
    </div>
    ${view.expanded ? html`<div class="reply-toast-list">${repeat(view.items, (toast) => toast.key, replyToast)}</div>` : nothing}
  </div>`;
}

export function noticesView(view: NoticesView): TemplateResult {
  const approvals = repeat(view.approvalErrors, (error) => error.id, (error) => html`<div class="review-update" role="alert">Approval was not saved: ${error.message}</div>`);
  // The status region stays in the page, so screen readers announce the text it receives.
  const status = html`<div class="visually-hidden" role="status">${view.replies.announcement}</div>`;
  if (!view.approvalErrors.length && !view.replies.items.length && !view.refresh) return status;
  return html`${status}<div class="notice-stack">${approvals}${view.refresh ? html`<div class="review-update" role="status">${view.refresh}</div>` : nothing}${view.replies.items.length ? replyToasts(view.replies) : nothing}</div>`;
}
