// The saved reviews panel, the notice for a review that ended, and the review
// data dialog that previews and cleans a review's local storage.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";

export interface ReviewItemView {
  id: string;
  title: string;
  remote: boolean;
  status: string;
  current: boolean;
  /** The remote branch or implementation ID. */
  subject: string;
  location: string;
  updatedAt: string;
  updatedText: string;
  /** Why the review cannot be opened; null when it is available. */
  unavailable: string | null;
  canOpen: boolean;
  completed: boolean;
  /** Archiving the implementation ended the review, which completion no longer changes. */
  archived: boolean;
}

/** The notice of a review that ended while the page showed it. */
export interface EndedReviewView {
  /** Whether the review's data was deleted or its implementation archived. */
  reason: "deleted" | "archived";
  implementationId: string;
  /** Unsent text to copy, if any. */
  text: string;
}

export interface ReviewsPanelView {
  /** Present once this review ended. */
  ended: EndedReviewView | null;
  busy: boolean;
  error: string;
  reviews: readonly ReviewItemView[];
}

function endedReview(view: EndedReviewView): TemplateResult {
  const notice = view.reason === "archived"
    ? html`<h1>Implementation archived</h1><p>Implementation <code>${view.implementationId}</code> was archived, which ends its review. Its review data is kept, but this page no longer updates or saves changes. This viewer stops after ten minutes without use; after that, run review again to open another saved review.</p>`
    : html`<h1>Review data deleted</h1><p>This session can no longer save changes. Open another saved review, or run review again in a worktree of the repository to start a fresh session.</p>`;
  return html`<section class="ended-review" data-end=${view.reason}>${notice}
      ${view.text ? html`<label>Copy any unsent text you want to keep<textarea readonly rows="6" .value=${view.text}></textarea></label>` : nothing}</section>`;
}

function review(view: ReviewsPanelView, item: ReviewItemView): TemplateResult {
  return html`<article data-review=${item.id} aria-current=${item.current ? "true" : nothing}>
        <div><strong>${item.title}</strong> <span>${item.remote ? "Remote · " : ""}${item.status}${item.current ? " · Current" : ""}</span>
        <p>${item.subject}</p><p class="review-location">${item.location}</p>
        <p>Last edited <time datetime=${item.updatedAt}>${item.updatedText}</time></p>
        ${item.unavailable !== null ? html`<p class="review-unavailable">Unavailable: ${item.unavailable}</p>` : nothing}</div>
        <div class="review-actions"><button class="tb-btn" type="button" data-action="open-review" data-review-id=${item.id} ?disabled=${view.busy || !item.canOpen}>Open review</button>
        ${item.archived ? nothing : html`<button class="tb-btn" type="button" data-action="complete-review" data-review-id=${item.id} ?disabled=${view.busy}>${item.completed ? "Reopen review" : "Mark complete"}</button>`}
        <button class="tb-btn" type="button" data-action="manage-review-data" data-review-id=${item.id} ?disabled=${view.busy}>Delete data…</button></div>
      </article>`;
}

export function reviewsPanelView(view: ReviewsPanelView): TemplateResult {
  return html`${view.ended ? endedReview(view.ended) : nothing}
      <header><h2>Saved reviews</h2><button class="tb-btn" type="button" data-action="refresh-reviews" ?disabled=${view.busy}>Refresh</button>${view.ended ? nothing : html`<button class="tb-btn" type="button" data-action="toggle-reviews">Close</button>`}</header>
      ${view.error ? html`<p role="alert">${view.error}</p>` : nothing}
      ${view.busy ? html`<p role="status">Loading review…</p>` : nothing}
      ${!view.reviews.length && !view.busy ? html`<p>No saved reviews.</p>` : nothing}
      ${repeat(view.reviews, (item) => item.id, (item) => review(view, item))}`;
}

export interface StorageCategoryView {
  label: string;
  size: string;
  detail: string;
}

export interface ReviewStorageView {
  directory: string;
  size: string;
  categories: readonly StorageCategoryView[];
  drafts: number;
  unresolved: number;
  unusedSize: string;
  unusedCount: number;
  referenceError: string;
}

export interface ReviewCleanupView {
  title: string;
  location: string;
  id: string;
  status: string;
  /** Null until the storage details load. */
  storage: ReviewStorageView | null;
  busy: boolean;
  message: string;
  error: string;
}

/** The review data dialog's content. Its buttons carry `data-cleanup` actions. */
export function reviewCleanupView(view: ReviewCleanupView): TemplateResult {
  const storage = view.storage;
  return html`<h2 id="cleanup-title">Review data</h2><strong>${view.title}</strong><p class="review-location">${view.location}</p>
      <p class="review-location">${view.id} · ${view.status}</p>
      ${storage ? html`<p class="review-location">Stored in ${storage.directory}</p><p><strong>${storage.size}</strong> total</p>
        <table><thead><tr><th>Data</th><th>Size</th><th>Contents</th></tr></thead><tbody>${storage.categories.map((item) => html`<tr><td>${item.label}</td><td>${item.size}</td><td>${item.detail}</td></tr>`)}</tbody></table>
        ${storage.drafts || storage.unresolved ? html`<p class="cleanup-warning">This review has ${storage.drafts} unsent draft${storage.drafts === 1 ? "" : "s"} and ${storage.unresolved} unresolved feedback thread${storage.unresolved === 1 ? "" : "s"}.</p>` : nothing}
        <p>Deletion removes this review’s local data. Source files, branches, implementation artifacts, published metadata, and archives are preserved.</p>
        <p>${storage.unusedSize} in ${storage.unusedCount} unused files or folders can be cleaned separately. Cleanup keeps files referenced by messages, drafts, or approvals, and skips uploads and snapshots less than an hour old. Nothing is deleted automatically.</p>
        ${storage.referenceError ? html`<p role="alert">${storage.referenceError}</p>` : nothing}` : nothing}
      ${view.busy ? html`<p role="status">Working…</p>` : nothing}${view.message ? html`<p role="status">${view.message}</p>` : nothing}${view.error ? html`<p role="alert">${view.error}</p>` : nothing}
      <div class="cleanup-actions"><button class="tb-btn" type="button" data-cleanup="cancel" autofocus ?disabled=${view.busy}>Cancel</button>
        <button class="tb-btn" type="button" data-cleanup="refresh" ?disabled=${view.busy}>Refresh details</button>
        ${storage ? html`<button class="tb-btn" type="button" data-cleanup="unused" ?disabled=${view.busy || !storage.unusedCount || Boolean(storage.referenceError)}>Clean unused files</button>` : nothing}
        <button class="tb-btn cleanup-delete" type="button" data-cleanup="delete" ?disabled=${view.busy || !storage}>Delete review data</button></div>`;
}
