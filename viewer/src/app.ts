/* Semantic Flow review viewer — Cinema.
   Renders a semantic implementation artifact (window.SEMANTIC_IMPLEMENTATION) as a full-bleed
   inline-diff reading experience. This module starts the page: it loads the saved
   review, wires the page's event handlers in order, and starts polling. */
import { installActions } from "./actions";
import { AUTO_SEND_KEY, adoptAutoSendPreferred, autoSendPreferred, readAutoSendPreferred } from "./agent";
import * as api from "./api";
import { reconcileApprovals } from "./approval-state";
import { installAttachments } from "./attachments";
import { app, data } from "./context";
import { installDetails } from "./details";
import { compose, draftSnapshots, initEditor, noteStage, type Draft } from "./editor";
import { rebuildFileSearchIndex } from "./file-search-dialog";
import { installForms } from "./forms";
import { installInsightPreview } from "./insight-preview";
import { installKeyboard } from "./keyboard";
import { artifactThreads } from "./lookups";
import { errorMessage, failureOf } from "./narrow";
import { pollViewerRevision } from "./polling";
import { installPopover } from "./popover";
import { render } from "./render";
import { initSavedReviews, refreshReviews } from "./saved-reviews";
import { installSelection } from "./selection";
import { initState, installUnloadGuard, persist, reviewDeleted, state, type SavedReview } from "./state";
import { installHeldThreadLists, usableNotes } from "./threads";
import { installUnreadReplies } from "./unread-replies";
import { cssEsc } from "./util";


/** Loads the saved review and starts the page. Returns false, having started
 * nothing, when the saved review could not be loaded, so a later attempt, for
 * example with the access of a fresh link, can start it. */
async function startApp(): Promise<boolean> {
  "use strict";

  const requestReviewId = window.SEMANTIC_REVIEW_CONTEXT?.reviewId || data.reviewId;
  const requestGeneration = window.SEMANTIC_REVIEW_CONTEXT?.generation;
  api.configureApi({ reviewId: requestReviewId, generation: requestGeneration });
  let unavailable = false;
  let saved: SavedReview;
  try {
    const response = await api.getReviewState();
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const failure = failureOf(body);
      if (failure.reviewUnavailable) { unavailable = true; saved = { reviewId: requestReviewId, generation: requestGeneration ?? "", state: {}, stateRevision: 0 }; }
      else throw new Error(failure.error || "Review data could not be loaded.");
    } else saved = body;
  } catch (error) {
    app.textContent = `${errorMessage(error)} Reload to retry.`;
    return false;
  }
  rebuildFileSearchIndex();
  initState(saved, unavailable);
  initSavedReviews();
  initEditor();
  // Handlers of one event run in the order they are added.
  installUnloadGuard();
  installHeldThreadLists();
  installAttachments();
  installDetails();
  installPopover();
  installInsightPreview();
  installActions();
  installForms();
  installKeyboard();
  installSelection();
  installUnreadReplies();

  const drafts: Draft[] = compose ? [...usableNotes(), compose] : usableNotes();
  const legacyDrafts = drafts.filter(note => note.kind === "line" && !("exported" in note && note.exported) && note.snapshot && !note.snapshot.fileRevision);
  if (legacyDrafts.length && !reviewDeleted) {
    try {
      const response = await api.resolveDraftSnapshots({ notes: legacyDrafts });
      const result = await response.json();
      if (response.ok && result.ok) legacyDrafts.forEach((note, index) => {
        const snapshot = result.snapshots?.[index];
        if (snapshot?.fileRevision) note.snapshot = snapshot;
      });
    } catch { /* Unavailable original snapshots remain conservatively stale. */ }
  }
  for (const note of drafts) {
    if (note.snapshot) draftSnapshots.set(note, note.snapshot);
  }
  // Replies that existed before unread tracking are treated as read. A timestamp
  // always persists, unlike an empty object, so later replies stay unread.
  if (!data.remote && !reviewDeleted && typeof state.repliesSeenThrough !== "string") {
    state.repliesSeenThrough = artifactThreads.flatMap((thread) => (thread.comments || []).filter((comment) => comment.author === "agent"))
      .map((comment) => String(comment.createdAt || "")).sort().at(-1) || "";
    persist();
  }
  reconcileApprovals();
  const recoveredStage = compose && noteStage(compose);
  if (recoveredStage) state.openStages[recoveredStage.id] = true;
  // Follow the preference across tabs only once the viewer is ready to render.
  adoptAutoSendPreferred(readAutoSendPreferred() ?? autoSendPreferred);
  window.addEventListener("storage", (e) => {
    if (e.key !== AUTO_SEND_KEY) return;
    // Events can arrive late; the stored value is the latest choice.
    adoptAutoSendPreferred(readAutoSendPreferred() ?? e.newValue === "true");
    render();
  });
  render();
  if (compose?.nodeId && recoveredStage) {
    const node = app.querySelector(`.stage[data-stage="${cssEsc(recoveredStage.id)}"] details[data-node="${cssEsc(compose.nodeId)}"]`);
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  if (reviewDeleted) void refreshReviews();
  window.setInterval(pollViewerRevision, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollViewerRevision(); });
  void pollViewerRevision();
  return true;
}

// Attempts run one after another, and none after one has started the page.
let attempt = startApp();
window.SEMANTIC_APP = {
  started: () => attempt,
  start: () => (attempt = attempt.then((started) => started || startApp())),
};
