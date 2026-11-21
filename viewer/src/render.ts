// Rendering the page from its model, and what runs after each render.
import { roundNotice } from "./agent";
import { approvalErrors } from "./approval-state";
import { app } from "./context";
import { animateDetails } from "./details";
import { loadOpenDiffs } from "./diffs";
import { forgetRemovedInsights, setRenderingPage } from "./insight-preview";
import { fadePendingHighlight, resumePendingLazyJump } from "./navigation";
import { agentBarModel, coverageModel, notesPanelModel, storyModel, topbarModel } from "./page-model";
import { refreshNotice } from "./polling";
import { keepFocusedPop } from "./popover";
import { captureFileScrolls, captureFocus, restoreFileScrolls, restoreFocus } from "./render-steps";
import { reviewsDialog, reviewsOpen, setReviewsOpen, updateReviewList } from "./saved-reviews";
import { refreshDiffSelection } from "./selection";
import { hasSelectionHits } from "./selection-hits";
import { reviewEnded, state } from "./state";
import { beginThreadLists, endThreadLists } from "./threads";
import { observeUnreadReplies, unreadReplyCount } from "./unread-replies";
import { renderPage, type PageView } from "./views/page";

export const baseTitle = document.title;


/* ---- render ----------------------------------------------------------- */
export function render(): void {
  const focus = captureFocus(), scrolls = captureFileScrolls();
  renderView();
  restoreFileScrolls(scrolls);
  document.body.classList.toggle("no-scroll", state.notesOpen);
  restoreFocus(focus);
  keepFocusedPop();
  loadOpenDiffs();
  resumePendingLazyJump();
}
export function renderView(): void {
  if (reviewEnded) { renderPage(app, null); setReviewsOpen(true); updateReviewList(); return; }
  beginThreadLists();
  const model: PageView = {
    topbar: topbarModel(),
    agentBar: agentBarModel(),
    notices: {
      approvalErrors: [...approvalErrors].map(([id, message]) => ({ id, message })),
      roundCount: roundNotice ? roundNotice.count : null,
      refresh: refreshNotice,
    },
    story: storyModel(),
    coverage: coverageModel(),
    notes: notesPanelModel(),
  };
  setRenderingPage(true);
  try { renderPage(app, model); } finally { setRenderingPage(false); }
  endThreadLists();
  enhance();
  if (reviewsOpen && !reviewsDialog) setReviewsOpen(true);
}

export function enhance(): void {
  forgetRemovedInsights();
  animateDetails();
  observeUnreadReplies();
  // Rendering can replace rows whose text held matches; match again.
  if (hasSelectionHits()) refreshDiffSelection();
  const unread = unreadReplyCount();
  document.title = unread ? `(${unread}) ${baseTitle}` : baseTitle;
  fadePendingHighlight();
}

