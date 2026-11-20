// The actions of the page's controls, dispatched by their data-action.
import { agent, answerAgent, copyAgentCommand, minimizedAgentQuestions, sendingDrafts, setRoundNotice, stopAgent } from "./agent";
import { approveGroup, changeApproval } from "./approval-state";
import { editorAttachments } from "./attachments";
import { app } from "./context";
import { openCodeInsight, openEvidence } from "./dialogs";
import { approvalBaseIncluded, approvalComparisons, comparisonKey, ensureFileDiff, loadApprovalComparison, markdownPreviews, markdownUrl, sinceApprovalEnabled } from "./diffs";
import { closeReply, compose, focusComposer, openComment, openNoteEdit, replyEditId, replyTo, setCompose, setReply } from "./editor";
import { exportFeedback, threadAction, toggleThreadCollapse } from "./feedback-actions";
import { openFileSearch } from "./file-search-dialog";
import { fileCodeInsights, insightFingerprint, insightReviewState } from "./insights";
import { activeFileNodeId, approvalEntry, fileById, insightKey, stageOf } from "./lookups";
import { animateStageToggle, applyNotesFilter, cinemaHolder, collapseThenRender, jumpToElement, toggleCinema } from "./navigation";
import { refreshRemote, refreshingRemote } from "./polling";
import { popOwner, showPop } from "./popover";
import { render } from "./render";
import { changeReview, manageReviewData, refreshReviews, reviewListBusy, reviewsOpen, setReviewsOpen } from "./saved-reviews";
import { oneOf } from "./narrow";
import { persist, state } from "./state";
import { artifactThreadsForElement, localVisibleForElement, noteAt, pendingReplies, threadOps, threadStateKey } from "./threads";
import { showUnreadReplies } from "./unread-replies";
import { isFeedbackTargetKind, isNoteKind } from "./stored-state";
import { cssEsc, focusable } from "./util";

const isFileView = oneOf("hunk", "full");


/** An HTML element to animate, or null. */
const htmlElement = (element: Element | null | undefined): HTMLElement | null => element instanceof HTMLElement ? element : null;

/** Runs the action of a clicked control. */
export function installActions(): void {
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-action]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const a = btn.dataset.action;

    if (a === "view-evidence") {
      const stage = stageOf(btn.dataset.stage);
      openEvidence(stage, stage?.insights.find((item) => item.collection === "evidence" && item.id === btn.dataset.item));
    } else if (a === "toggle-insight-review") {
      const stage = stageOf(btn.dataset.stage);
      const ins = stage?.insights.find((item) => item.collection === btn.dataset.collection && item.id === btn.dataset.item);
      if (!stage || !ins) return;
      const key = insightKey(stage.id, ins.collection, ins.id);
      if (insightReviewState(stage, ins) === "reviewed") delete state.insightReviews[key];
      else state.insightReviews[key] = { fingerprint: insightFingerprint(ins), at: Date.now() };
      // Rendering hides the tooltip, so reopen it with the new state.
      const tooltipOpen = popOwner === btn;
      persist(); render();
      if (tooltipOpen) showPop(btn);
    } else if (a === "code-insight") {
      const stage = stageOf(btn.dataset.stage);
      openCodeInsight(stage, stage?.insights.find(ins => ins.collection === btn.dataset.collection && ins.id === btn.dataset.item));
    } else if (a === "file-insights") {
      const stage = stageOf(btn.dataset.stage), choices = stage ? fileCodeInsights(stage, btn.dataset.path) : [];
      openCodeInsight(stage, choices[0], choices);
    } else if (a === "file-search") {
      openFileSearch(btn.dataset.path || "", btn.dataset.stageId ? { stageId: btn.dataset.stageId, nodeId: btn.dataset.nodeId } : null);
    } else if (a === "focus-reasoning") {
      e.preventDefault();
      const node = btn.closest("details[data-node]");
      if (!(node instanceof HTMLDetailsElement)) return;
      node.open = true;
      const selector = btn.dataset.type === "not-passed"
        ? '.node-reasoning .tag-face[data-vstat="failed"], .node-reasoning .tag-face[data-vstat="notrun"]'
        : `.node-reasoning .tag-face[data-type="${cssEsc(String(btn.dataset.type))}"]`;
      const target = focusable(node.querySelector(selector));
      if (target) { target.focus(); target.scrollIntoView({ block: "nearest" }); }
    } else if (a === "toggle-reviews") {
      setReviewsOpen(!reviewsOpen);
      if (reviewsOpen) void refreshReviews();
    } else if (a === "manage-review-data") {
      void manageReviewData(btn.dataset.reviewId);

    } else if (a === "refresh-remote") {
      if (!refreshingRemote) void refreshRemote();
    } else if (a === "stop-agent") {
      void stopAgent();
    } else if (a === "copy-agent-command") {
      void copyAgentCommand();
    } else if (a === "minimize-agent-questions") {
      for (const request of agent?.requests || []) minimizedAgentQuestions.add(request.id);
      render(); focusable(document.querySelector('[data-action="show-agent-questions"]'))?.focus();
    } else if (a === "show-agent-questions") {
      minimizedAgentQuestions.clear(); render();
      focusable(document.querySelector('[data-action="minimize-agent-questions"]'))?.focus();
    } else if (a === "agent-choice") {
      const request = agent?.requests.find((item) => item.id === btn.dataset.id);
      if (request) void answerAgent(request.id, request.choices[Number(btn.dataset.choice)] || "");
    } else if (a === "show-unread") {
      showUnreadReplies();
    } else if (a === "dismiss-round") {
      setRoundNotice(null); render();
    } else if (a === "refresh-reviews") {
      if (!reviewListBusy) void refreshReviews();
    } else if (a === "open-review" || a === "complete-review") {
      void changeReview(btn.dataset.reviewId, a === "complete-review");
    } else if (a === "approve") {
      if (btn.dataset.id !== undefined) void changeApproval(btn.dataset.id, btn.dataset.kind);
    } else if (a === "approve-group") {
      void approveGroup(btn.dataset.stage, btn.dataset.nodeId, btn.dataset.group);
    } else if (a === "approval-comparison") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      const enable = !sinceApprovalEnabled(id);
      state.approvalComparisons[id] = enable;
      // Showing the comparison again retries a page that failed to load.
      const entry = enable ? approvalEntry(id) : null;
      const key = entry ? comparisonKey(id, entry) : null, cached = key ? approvalComparisons.get(key) : undefined;
      if (key && cached && "error" in cached) approvalComparisons.delete(key);
      persist(); render();
    } else if (a === "approval-base-scope") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      if (!approvalBaseIncluded.delete(id)) approvalBaseIncluded.add(id);
      render();
    } else if (a === "dismiss-target-refresh") {
      state.dismissedTargetRefresh = agent?.targetRefresh?.at;
      persist(); render();
    } else if (a === "approval-page") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      const entry = approvalEntry(id);
      const offset = Number(btn.dataset.offset);
      const previous = entry ? approvalComparisons.get(comparisonKey(id, entry))?.offset || 0 : 0;
      if (entry) void loadApprovalComparison(id, entry, offset, {
        direction: offset > previous ? "forward" : "backward", nodeId: entry.nodeId,
      });
    } else if (a === "toggle-stage") {
      if (btn.dataset.id !== undefined) animateStageToggle(btn.dataset.id);
    } else if (a === "toggle-coverage") {
      state.coverageOpen = !state.coverageOpen; state.notesOpen = false; persist(); render();
    } else if (a === "toggle-notes") {
      state.notesOpen = !state.notesOpen; state.coverageOpen = false; persist(); render();
    } else if (a === "close-panels") {
      state.coverageOpen = false; state.notesOpen = false; persist(); render();
    } else if (a === "comment") {
      const kind = btn.dataset.kind;
      if (isNoteKind(kind) && btn.dataset.id !== undefined) openComment(kind, btn.dataset.id, btn.dataset.stage);
    } else if (a === "line-note") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      const hasContent =
        artifactThreadsForElement("line", id).length || localVisibleForElement(id).length;
      if (hasContent) {
        const opening = !state.openLineThreads[id];
        state.openLineThreads[id] = opening;
        persist();
        if (opening) { render(); }
        else { collapseThenRender(htmlElement(app.querySelector(`.line-thread[data-thread="${cssEsc(id)}"]`))); }
      } else {
        openComment("line", id);
      }
    } else if (a === "toggle-file-notes") {
      const id = btn.dataset.id, nodeId = btn.dataset.nodeId;
      if (id === undefined) return;
      const opening = activeFileNodeId(id) !== nodeId || state.openThreads[id] === false;
      state.activeFiles[id] = nodeId ?? null;
      state.openThreads[id] = opening;
      persist();
      if (opening) render();
      else collapseThenRender(htmlElement(cinemaHolder(id, nodeId)?.querySelector(".file-note-threads")));
    } else if (a === "toggle-thread") {
      const id = btn.dataset.id, kind = btn.dataset.kind;
      if (id === undefined) return;
      const key = threadStateKey(isFeedbackTargetKind(kind) ? kind : undefined, id, btn.dataset.stage);
      const opening = !state.openThreads[key];
      state.openThreads[key] = opening;
      persist();
      if (opening) { render(); }
      else { collapseThenRender(htmlElement((btn.closest("details.node") || btn.closest(".stage") || app).querySelector(`.thread[data-thread="${cssEsc(id)}"]`))); }
    } else if (a === "edit-note") {
      const note = noteAt(Number(btn.dataset.index));
      if (note && sendingDrafts.has(note)) return;
      openNoteEdit(Number(btn.dataset.index));
    } else if (a === "markdown-mode") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      const entry = fileById.get(id);
      if (entry && btn.dataset.mode === "preview") {
        const key = markdownUrl(entry);
        if (markdownPreviews.get(key)?.error) markdownPreviews.delete(key);
      }
      state.markdownPreview[id] = btn.dataset.mode === "preview";
      persist(); render();
    } else if (a === "toggle-wrap") {
      state.wrapLines = !state.wrapLines;
      persist(); render();
    } else if (a === "set-view") {
      const id = btn.dataset.id, mode = btn.dataset.mode;
      if (id === undefined) return;
      if (isFileView(mode)) state.fileView[id] = mode;
      const entry = fileById.get(id);
      if (entry) { delete entry.file.lines; delete entry.file._diffError; }
      persist(); render();
    } else if (a === "diff-page") {
      const entry = fileById.get(btn.dataset.id ?? ""), offset = Number(btn.dataset.offset);
      if (entry) ensureFileDiff(entry, offset, true, null, {
        direction: offset > (entry.file._pageOffset || 0) ? "forward" : "backward", nodeId: activeFileNodeId(entry.id),
      });
    } else if (a === "toggle-hide-removed") {
      const id = btn.dataset.id;
      if (id === undefined) return;
      state.hideDeleted[id] = !state.hideDeleted[id];
      persist();
      render();
    } else if (a === "del-note") {
      const idx = Number(btn.dataset.index);
      const c = noteAt(idx);
      if (c && !c.exported && !sendingDrafts.has(c)) {
        state.comments.splice(idx, 1);
        if (compose?.editIndex === idx) setCompose(null);
        else if (compose && compose.editIndex != null && compose.editIndex > idx) compose.editIndex -= 1;
        persist(); render();
      }
    } else if (a === "open-file") {
      // Let the reviewer select the filename text without toggling the diff:
      // a click that completes a selection over the name is not a toggle.
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && e.target instanceof Element && e.target.closest(".fp-name")) return;
      toggleCinema(btn.dataset.id, btn.dataset.nodeId);
    } else if (a === "export-feedback") {
      exportFeedback();
    } else if (a === "remove-attachment") {
      const attachments = editorAttachments(btn.closest("form"));
      const index = attachments?.findIndex((file) => file.id === btn.dataset.id) ?? -1;
      if (attachments && index >= 0) { attachments.splice(index, 1); persist(); render(); }
    } else if (a === "compose-cancel") {
      setCompose(null); persist(); render();
    } else if (a === "jump-to") {
      const kind = btn.dataset.kind;
      if (isFeedbackTargetKind(kind) && btn.dataset.id !== undefined) jumpToElement(kind, btn.dataset.id, btn.dataset.stage, btn.dataset.nodeId);
    } else if (a === "thread-reply") {
      setCompose(null);
      setReply(btn.dataset.id ?? null);
      const op = replyTo === null ? undefined : threadOps[replyTo];
      if (op) op.error = "";
      render(); focusComposer();
    } else if (a === "reply-edit") {
      if (btn.dataset.replyId === undefined || sendingDrafts.has(btn.dataset.replyId)) return;
      setCompose(null);
      const draft = pendingReplies().find((r) => r.id === btn.dataset.replyId);
      if (!draft) return;
      setReply(btn.dataset.id ?? null, draft.body, structuredClone(draft.attachments || []), draft.id);
      render(); focusComposer();
    } else if (a === "reply-del") {
      if (btn.dataset.replyId === undefined || sendingDrafts.has(btn.dataset.replyId)) return;
      state.replyDrafts = pendingReplies().filter((r) => r.id !== btn.dataset.replyId);
      if (replyEditId === btn.dataset.replyId) closeReply();
      persist(); render();
    } else if (a === "reply-cancel") {
      closeReply(); persist(); render();
    } else if (a === "thread-resolve") {
      if (btn.dataset.id !== undefined) threadAction(btn.dataset.id, "resolve");
    } else if (a === "thread-reopen") {
      if (btn.dataset.id !== undefined) threadAction(btn.dataset.id, "reopen");
    } else if (a === "toggle-thread-collapse") {
      if (btn.dataset.id !== undefined) toggleThreadCollapse(btn.dataset.id, btn);
    } else if (a === "notes-filter") {
      const f = btn.dataset.filter === "resolved" ? "resolved" : "active";
      if (state.notesFilter !== f) { state.notesFilter = f; persist(); applyNotesFilter(); }
    }
  });
}
