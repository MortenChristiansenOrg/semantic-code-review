// The saved reviews panel and the dialog that cleans a review's local data.
import type { ReviewStorage, ReviewSummary } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { compose, replyDraft, replyTo } from "./editor";
import { errorMessage, failureOf } from "./narrow";
import { forceHidePop } from "./popover";
import { render } from "./render";
import { approvalsNotSaved } from "./approval-state";
import { data } from "./context";
import { endedElsewhere, flushReviewState, reviewEnded, savedReview, setReviewEnded, state, stopSaving, type ReviewEnd } from "./state";
import { pendingReplies, usableNotes } from "./threads";
import { cssEsc, focusable, reduced, storageSize } from "./util";
import { reviewCleanupView, reviewsPanelView, type ReviewsPanelView } from "./views/reviews";
import { render as renderLit } from "lit-html";

export let reviewsOpen = false;
/** A review that ended starts with the saved reviews open. */
export function initSavedReviews(): void { reviewsOpen = Boolean(reviewEnded); }
export let reviewList: ReviewSummary[] = [];
export let reviewListError = "";
export let reviewListBusy = false;

/** Ends the page's review: its data was deleted, or its implementation archived. */
export function markReviewEnded(end: ReviewEnd, external = false): void {
  const fileSearch = document.querySelector(".file-search[open]");
  if (fileSearch instanceof HTMLDialogElement) fileSearch.close();
  setReviewEnded(end, external); reviewsOpen = true;
  stopSaving(); render(); void refreshReviews();
  // Screen readers learn of the end from its notice, even when the saved
  // reviews were already open. A deletion this page made keeps its own focus.
  if (external) focusable(reviewsDialog?.querySelector(".ended-review h1"))?.focus({ preventScroll: true });
}
// Unsent text the reviewer can copy after another tab or session ended this review.
export function endedReviewText(): string {
  return endedElsewhere ? [...new Set([compose?.body, replyTo ? replyDraft : "", ...usableNotes().filter((note) => !note.exported).map((note) => note.body), ...pendingReplies().map((reply) => reply.body)].filter(Boolean))].join("\n\n") : "";
}

export async function manageReviewData(id: string | undefined): Promise<void> {
  const found = reviewList.find((item) => item.id === id);
  if (!found || reviewListBusy || document.querySelector(".review-cleanup")) return;
  const review: ReviewSummary = found;
  const target = { reviewId: review.id, generation: review.generation };
  const dialog = document.createElement("dialog"); dialog.className = "review-cleanup"; dialog.setAttribute("aria-labelledby", "cleanup-title");
  let storage: ReviewStorage | null = null, busy = false, error = "", message = "";
  function paint() {
    renderLit(reviewCleanupView({
      title: review.title, location: review.repositoryRoot, id: review.id,
      status: reviewStatus(review),
      storage: storage && {
        directory: storage.storageDirectory, size: storageSize(storage.bytes),
        categories: storage.categories.map((item) => ({ label: item.label, size: storageSize(item.bytes), detail: item.detail })),
        drafts: storage.drafts, unresolved: storage.unresolved,
        unusedSize: storageSize(storage.unusedBytes), unusedCount: storage.unused.length, referenceError: storage.referenceError || "",
      },
      busy, message, error,
    }), dialog);
  }
  async function details() {
    const response = await api.inspectReviewStorage(target);
    const result = await response.json(); if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not inspect review storage.");
    storage = result.storage;
  }
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-cleanup]") : null;
    const action = button instanceof HTMLElement ? button.dataset.cleanup : undefined;
    if (!action || busy) return;
    if (action === "cancel") { dialog.close(); return; }
    busy = true; error = ""; message = ""; paint();
    try {
      if (action === "refresh") await details();
      else {
        if (!storage) throw new Error("Could not inspect review storage.");
        const request = { ...target, fingerprint: storage.fingerprint };
        if (action === "delete") {
          const response = await api.deleteReviewData(request);
          const result = await response.json(); if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not clean review data.");
          if (result.deleted && id === savedReview.reviewId && target.generation === savedReview.generation && reviewEnded !== "deleted") markReviewEnded("deleted");
          dialog.close(); await refreshReviews(true); return;
        } else {
          const response = await api.cleanUnusedReviewData(request);
          const result = await response.json(); if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not clean review data.");
          message = `Reclaimed ${storageSize(result.reclaimedBytes)}.`; error = (result.failures || []).join(" ");
        }
        await details(); await refreshReviews(true);
      }
    } catch (failure) { error = errorMessage(failure); }
    finally { busy = false; if (dialog.isConnected) paint(); }
  });
  document.body.append(dialog); busy = true; paint(); dialog.showModal();
  try { if (id === savedReview.reviewId) await flushReviewState(); await details(); }
  catch (failure) { error = errorMessage(failure); }
  finally { busy = false; paint(); }
}
/** The review shown on this page; one whose data was deleted is none. */
export const isCurrentReview = (review: ReviewSummary): boolean => reviewEnded !== "deleted" && review.id === savedReview.reviewId && review.generation === savedReview.generation;
/** A review's lifecycle status: archiving its implementation ends it, as completing it does. */
const reviewStatus = (review: ReviewSummary): string => review.archived ? "Archived" : review.completedAt ? "Completed" : "Active";
export function reviewsPanelModel(): ReviewsPanelView {
  return {
    ended: reviewEnded ? { reason: reviewEnded, implementationId: data.implementationId, text: endedReviewText(), approvalsNotSaved: [...approvalsNotSaved.values()] } : null,
    busy: reviewListBusy, error: reviewListError,
    reviews: reviewList.map((review) => ({
      id: review.id, title: review.title, remote: Boolean(review.remote), current: isCurrentReview(review),
      status: reviewStatus(review),
      subject: review.remote ? `${review.remote.remoteName}/${review.remote.branch}` : review.implementationId,
      location: review.remote?.sourceRoot || review.repositoryRoot,
      updatedAt: review.updatedAt, updatedText: new Date(review.updatedAt).toLocaleString(),
      // The status says why an archived review cannot be opened.
      unavailable: review.available || review.archived ? null : String(review.unavailableReason ?? ""),
      canOpen: Boolean(review.available) && !isCurrentReview(review),
      completed: Boolean(review.completedAt),
      archived: Boolean(review.archived),
    })),
  };
}
export let reviewsDialog: HTMLDialogElement | null = null, reviewsCloseTimer: number | undefined;
export function setReviewsOpen(open: boolean): void {
  if (!open && reviewEnded) return;
  clearTimeout(reviewsCloseTimer);
  reviewsOpen = open;
  document.querySelector('.topbar [data-action="toggle-reviews"]')?.setAttribute("aria-expanded", String(open));
  forceHidePop();
  if (open) {
    clearTimeout(reviewsCloseTimer);
    let dialog = reviewsDialog;
    if (!dialog) {
      const created = document.createElement("dialog");
      dialog = reviewsDialog = created;
      created.id = "review-list"; created.className = "review-list";
      created.setAttribute("aria-label", "Saved reviews");
      created.addEventListener("cancel", (event) => { event.preventDefault(); setReviewsOpen(false); });
      created.addEventListener("click", (event) => {
        if (event.target !== created) return;
        const box = created.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setReviewsOpen(false);
      });
      document.body.append(created); updateReviewList();
    }
    dialog.classList.remove("is-closing");
    if (!dialog.open) dialog.showModal();
  } else if (reviewsDialog) {
    const dialog = reviewsDialog;
    dialog.classList.add("is-closing");
    reviewsCloseTimer = setTimeout(() => {
      dialog.close(); dialog.remove(); reviewsDialog = null;
      if (!reviewEnded) focusable(document.querySelector('.topbar [data-action="toggle-reviews"]'))?.focus({ preventScroll: true });
    }, reduced() ? 0 : 180);
  }
}
export function updateReviewList(): void {
  const dialog = reviewsDialog;
  if (!dialog) return;
  const active = dialog.contains(document.activeElement) ? document.activeElement : null;
  const data = active instanceof HTMLElement || active instanceof SVGElement ? active.dataset : undefined;
  const action = data?.action, reviewId = data?.reviewId;
  const top = dialog.scrollTop;
  renderLit(reviewsPanelView(reviewsPanelModel()), dialog);
  dialog.scrollTop = top;
  // Rendering keeps the focused button unless it became disabled.
  if (action && document.activeElement !== active) focusable(dialog.querySelector(`[data-action="${cssEsc(action)}"]${reviewId ? `[data-review-id="${cssEsc(reviewId)}"]` : ""}`))?.focus({ preventScroll: true });
  if (dialog.open && !document.querySelector(".review-cleanup[open]") && !dialog.contains(document.activeElement)) {
    focusable(dialog.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }
}
/** Numbers list refreshes; only the latest may change the list, its error, or the busy state. */
let reviewListRequest = 0;
export async function refreshReviews(force = false): Promise<void> {
  if (reviewListBusy && !force) return;
  const request = ++reviewListRequest;
  reviewListBusy = true; reviewListError = ""; updateReviewList();
  try {
    const response = await api.getReviews();
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.reviews)) throw new Error(failureOf(result).error || "Could not load saved reviews.");
    if (request === reviewListRequest) reviewList = result.reviews;
  } catch (error) { if (request === reviewListRequest) reviewListError = errorMessage(error); }
  finally { if (request === reviewListRequest) { reviewListBusy = false; updateReviewList(); } }
}
export async function changeReview(id: string | undefined, complete = false): Promise<void> {
  if (reviewListBusy) return;
  const review = reviewList.find((item) => item.id === id);
  if (!review) return;
  // Capture the selected target before any await; another selection cannot redirect it.
  const target = { reviewId: review.id, generation: review.generation, completed: !review.completedAt, expectedCompletedAt: review.completedAt };
  reviewListBusy = true; reviewListError = ""; updateReviewList();
  try {
    await flushReviewState();
    if (complete) {
      const response = await api.setReviewCompletion(target);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not open the selected review.");
      await refreshReviews(true);
    } else {
      const response = await api.openReview(target);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not open the selected review.");
      // Save edits made while the service was starting. A full navigation also
      // discards old responses, listeners, and caches instead of retargeting them.
      await flushReviewState();
      window.location.assign(result.url);
    }
  } catch (error) { reviewListError = errorMessage(error); }
  finally { reviewListBusy = false; updateReviewList(); }
}
