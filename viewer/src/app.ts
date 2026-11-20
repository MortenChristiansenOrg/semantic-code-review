// @ts-nocheck
// The legacy viewer closure is not yet typed. Later steps of #178 move its code
// into typed modules (and lit-html templates) one region at a time.
/* Semantic Flow review viewer — Cinema.
   Renders a semantic implementation artifact (window.SEMANTIC_IMPLEMENTATION) as a full-bleed
   inline-diff reading experience. */
import { render as renderLit } from "lit-html";
import * as api from "./api";
import { aggregateApprovalState } from "./approvals";
import { selectedNodeForFile } from "./files";
import { clearSelectionHits, hasSelectionHits, highlightSelectionHits } from "./selection-hits";
import { fileSearchView } from "./views/file-search";
import { highlightCode, langFor } from "./views/highlight";
import { codeInsightView, evidenceView } from "./views/insight-dialogs";
import { renderPage } from "./views/page";
import { reviewCleanupView, reviewsPanelView } from "./views/reviews";
import { tagPopoverView, tooltipView } from "./views/tooltip";

(async function () {
  "use strict";

  const data = window.SEMANTIC_IMPLEMENTATION;
  const app = document.querySelector("#app");
  const requestReviewId = window.SEMANTIC_REVIEW_CONTEXT?.reviewId || data.reviewId;
  const requestGeneration = window.SEMANTIC_REVIEW_CONTEXT?.generation;
  api.configureApi({ reviewId: requestReviewId, generation: requestGeneration });
  let reviewDeleted = false;
  let deletedElsewhere = false;
  let savedReview;
  try {
    const response = await api.getReviewState();
    savedReview = await response.json();
    if (!response.ok || !savedReview.ok) {
      if (savedReview.reviewUnavailable) { reviewDeleted = true; savedReview = { reviewId: requestReviewId, generation: requestGeneration, state: {} }; }
      else throw new Error(savedReview.error || "Review data could not be loaded.");
    }
  } catch (error) {
    app.textContent = `${error.message} Reload to retry.`;
    return;
  }
  let persistedState = structuredClone(savedReview.state);
  let savingState = false;
  let saveError = "";
  let saveTimer;
  let commentSaveNotBefore = 0;
  let saveOperation = null;
  let reviewsOpen = reviewDeleted;
  let reviewList = [];
  let reviewListError = "";
  let reviewListBusy = false;
  const uploadOps = new Set();
  const uploadStatus = new WeakMap();
  const approvalOps = new Map();
  const approvalComparisons = new Map();
  // Files whose comparison also shows base changes; each visit starts with the stage's changes alone.
  const approvalBaseIncluded = new Set();
  const approvalErrors = new Map();
  const markdownPreviews = new Map();

  // Listening-agent status from the server; null until the first poll answers.
  let agent = null;
  let roundNotice = null;
  let agentCommandCopied = false;
  const agentAnswers = new Map();
  const agentAnswerOps = new Map();
  // Questions the reviewer minimized; a new question opens the overlay again.
  const minimizedAgentQuestions = new Set();
  const AGENT_COMMAND = "/semantic-flow review -i";
  // The "Send automatically" choice is a viewer preference, kept in this browser across reviews.
  const AUTO_SEND_KEY = "semantic-flow:auto-send-feedback";
  // Null when storage is unavailable, so the in-page choice still applies.
  // After a failed write the stored value is stale, so this tab keeps its own choice.
  let autoSendStoreFailed = false;
  const readAutoSendPreferred = () => { if (autoSendStoreFailed) return null; try { return localStorage.getItem(AUTO_SEND_KEY) === "true"; } catch { return null; } };
  let autoSendPreferred = readAutoSendPreferred() ?? false;
  // Saved notes (objects) and reply draft IDs waiting for an automatic send.
  const autoSendQueue = { notes: new Set(), replies: new Set() };
  // Drafts in the request being sent; they cannot be edited or deleted until it answers.
  const sendingDrafts = new Set();
  // Turning it off drops queued saves; they stay as drafts for Prepare feedback.
  function adoptAutoSendPreferred(on) {
    autoSendPreferred = on;
    if (!on) { autoSendQueue.notes.clear(); autoSendQueue.replies.clear(); }
  }
  function setAutoSendPreferred(on) {
    adoptAutoSendPreferred(on);
    try { localStorage.setItem(AUTO_SEND_KEY, String(on)); autoSendStoreFailed = false; } catch { autoSendStoreFailed = true; }
  }
  // Offered only while an interactive session can take feedback as it arrives.
  const agentTakesFeedback = () => Boolean(!data.remote && agent?.session && !agent.stopRequested && (agent.listening || agent.working));
  const autoSendActive = () => autoSendPreferred && agentTakesFeedback();
  // Send just the saved note or reply at once; a save during a send goes out when that send finishes.
  function autoSendFeedback(saved) {
    const stored = readAutoSendPreferred();
    if (stored !== null && stored !== autoSendPreferred) adoptAutoSendPreferred(stored);
    if (!autoSendActive()) { autoSendQueue.notes.clear(); autoSendQueue.replies.clear(); return; }
    if (saved) autoSendQueue[saved.note ? "notes" : "replies"].add(saved.note || saved.reply);
    if (exportState.phase === "working") return;
    const only = { notes: new Set(autoSendQueue.notes), replies: new Set(autoSendQueue.replies) };
    autoSendQueue.notes.clear(); autoSendQueue.replies.clear();
    if (only.notes.size || only.replies.size) void exportFeedback(only);
  }
  const baseTitle = document.title;

  function adoptViewerSnapshot(snapshot) {
    // A local feedback write changes what the page shows, so no server
    // revision is fully shown any more; the next poll fetches again, even if
    // another session has since returned the server to the revision loaded.
    selectionRevision = notShown;
    if (!snapshot || typeof snapshot.revision !== "string") return;
    adoptAgentStatus(snapshot.agent);
  }
  const agentMinutes = (status) => status?.working
    ? Math.max(0, Math.floor((Date.parse(status.serverTime) - Date.parse(status.working.startedAt)) / 60000)) : 0;
  const agentView = (status) => status && JSON.stringify({ ...status, serverTime: null, minutes: agentMinutes(status) });
  // The agent's session files are read from disk unvalidated. Keep only what the
  // page can show, so a malformed entry cannot stop rendering. Questions keep
  // their first occurrence per ID, so buttons and handlers index the same choices.
  const isText = (value) => typeof value === "string";
  const record = (value) => value && typeof value === "object" ? value : null;
  function agentRequests(requests) {
    const seen = new Set();
    return (Array.isArray(requests) ? requests : [])
      .filter((request) => record(request) && isText(request.id) && !seen.has(request.id) && seen.add(request.id))
      .map((request) => ({ ...request, body: isText(request.body) ? request.body : "",
        choices: Array.isArray(request.choices) ? request.choices.filter(isText) : [] }));
  }
  function agentWorking(working) {
    if (!record(working)) return null;
    const threads = (Array.isArray(working.threads) ? working.threads : []).filter((thread) => record(thread) && isText(thread.id));
    return { ...working, threads, note: isText(working.note) ? working.note : undefined };
  }
  function agentStatus(next) {
    const round = record(next.lastRound) && isText(next.lastRound.id) ? next.lastRound : null;
    const refresh = record(next.targetRefresh);
    return { ...next, requests: agentRequests(next.requests), working: agentWorking(next.working),
      lastRound: round && { ...round, threadIds: Array.isArray(round.threadIds) ? round.threadIds.filter(isText) : [] },
      targetRefresh: refresh && ["at", "targetBranch", "previousBaseRevision", "baseRevision"].every((key) => isText(refresh[key])) ? refresh : null };
  }
  function adoptAgentStatus(next) {
    if (!next || typeof next !== "object" || data.remote) return;
    next = agentStatus(next);
    const previous = agent;
    agent = next;
    for (const id of minimizedAgentQuestions) if (!next.requests?.some((request) => request.id === id)) minimizedAgentQuestions.delete(id);
    if (previous && next.lastRound && next.lastRound.id !== previous.lastRound?.id) announceRound(next.lastRound);
    if (agentView(previous) !== agentView(next)) render();
  }
  function announceRound(round) {
    const count = round.threadIds.length;
    roundNotice = { count, threadIds: round.threadIds };
    refreshNotice = "";
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const notice = new Notification("Agent replied", {
        body: `${count} feedback thread${count === 1 ? "" : "s"} answered in ${data.title || data.implementationId}.`,
        tag: `semantic-flow-${data.implementationId}`,
      });
      notice.onclick = () => { window.focus(); showUnreadReplies(round.threadIds); notice.close(); };
    }
  }
  // Mirrors the CLI: a user comment after the latest answered comment awaits the agent.
  function awaitsAgent(thread) {
    if (thread.status !== "open") return false;
    const comments = thread.comments || [];
    let through = -1;
    comments.forEach((comment, index) => {
      if (comment.author !== "agent") return;
      const answered = comment.respondsTo ? comments.findIndex((item) => item.id === comment.respondsTo) : index - 1;
      through = Math.max(through, answered);
    });
    return comments.some((comment, index) => index > through && comment.author === "user");
  }
  const agentWorkingOn = (id) => Boolean(agent?.working?.threads.some((thread) => thread.id === id && !thread.answered));
  // Comment IDs are unique only within a thread, so read markers name both.
  const replyKey = (thread, comment) => JSON.stringify([thread.id, comment.id]);
  // Replies from before unread tracking started (repliesSeenThrough) count as read.
  const isUnreadReply = (thread, comment) => comment.author === "agent" && !data.remote &&
    typeof state.repliesSeenThrough === "string" && String(comment.createdAt || "") > state.repliesSeenThrough &&
    !state.readReplies?.[replyKey(thread, comment)];
  const unreadReplies = (thread) => (thread.comments || []).filter((comment) => isUnreadReply(thread, comment));
  const unreadReplyCount = () => artifactThreads.reduce((count, thread) => count + unreadReplies(thread).length, 0);
  function threadAgentState(thread) {
    if (data.remote || thread.status !== "open") return null;
    if (agentWorkingOn(thread.id)) return "working";
    if (awaitsAgent(thread)) return "queued";
    if (unreadReplies(thread).length) return "new";
    return (thread.comments || []).some((comment) => comment.author === "agent") ? "answered" : null;
  }
  function markRepliesRead(keys) {
    const fresh = keys.filter((key) => !state.readReplies?.[key]);
    if (!fresh.length) return;
    state.readReplies = { ...(state.readReplies || {}), ...Object.fromEntries(fresh.map((key) => [key, true])) };
    persist(); render();
  }
  // A reply counts as read once most of it, or half the visible area for a long
  // reply, has been on screen for a moment.
  const readTimers = new Map();
  const observedReplies = new WeakSet();
  const replyObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target;
      const visibleHeight = entry.rootBounds?.height || window.innerHeight;
      const seen = entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= visibleHeight * 0.5;
      if (seen && !document.hidden && element.classList.contains("is-unread")) {
        if (!readTimers.has(element)) readTimers.set(element, setTimeout(() => { readTimers.delete(element); markRepliesRead([element.dataset.replyKey]); }, 1200));
      } else { clearTimeout(readTimers.get(element)); readTimers.delete(element); }
    }
  }, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1] }) : null;
  function observeUnreadReplies() {
    if (!replyObserver) return;
    app.querySelectorAll(".tmsg.is-unread").forEach((element) => {
      if (!observedReplies.has(element)) { observedReplies.add(element); replyObserver.observe(element); }
    });
  }
  // Prefers an active thread from the announced round; resolved threads may hold
  // replies that stay unread because their list is out of view.
  function showUnreadReplies(threadIds = roundNotice?.threadIds || []) {
    roundNotice = null;
    const inRound = (item) => threadIds.includes(item.id);
    const active = (item) => item.status !== "resolved";
    const unread = (item) => unreadReplies(item).length > 0;
    const thread = artifactThreads.find((item) => inRound(item) && active(item) && unread(item))
      || artifactThreads.find((item) => inRound(item) && active(item))
      || artifactThreads.find((item) => active(item) && unread(item))
      || artifactThreads.find((item) => item.status === "open" && (item.comments || []).at(-1)?.author === "agent")
      || artifactThreads.find((item) => inRound(item) || unread(item));
    if (!thread) { render(); return; }
    state.notesOpen = true; state.coverageOpen = false;
    state.notesFilter = thread.status === "resolved" ? "resolved" : "active";
    if (!state.threadCollapsed) state.threadCollapsed = {};
    state.threadCollapsed[thread.id] = false;
    persist(); render();
    requestAnimationFrame(() => app.querySelector(`.side.notes .tthread[data-thread-id="${cssEsc(thread.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }
  async function stopAgent() {
    try {
      const response = await api.stopAgent();
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not stop the agent.");
      adoptAgentStatus(result.agent);
    } catch (error) { refreshNotice = error.message; render(); }
  }
  async function answerAgent(id, body) {
    body = body.trim();
    if (!body || agentAnswerOps.get(id)?.busy) return;
    agentAnswers.set(id, body);
    agentAnswerOps.set(id, { busy: true, error: "" }); render();
    try {
      const response = await api.respondToAgent({ requestId: id, body });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not send the answer.");
      agentAnswerOps.delete(id); agentAnswers.delete(id);
      adoptAgentStatus(result.agent); render();
    } catch (error) { agentAnswerOps.set(id, { busy: false, error: error.message }); render(); }
  }
  async function copyAgentCommand() {
    try { await navigator.clipboard.writeText(AGENT_COMMAND); agentCommandCopied = true; }
    catch { agentCommandCopied = false; refreshNotice = `Copy this command into your agent: ${AGENT_COMMAND}`; }
    render();
    setTimeout(() => { agentCommandCopied = false; render(); }, 2000);
  }

  let polling = false;
  let refreshNotice = "";
  let refreshingRemote = false;
  const draftSnapshots = new WeakMap();

  let lastHiddenPoll = 0;
  // The latest server revision a poll handled while a code selection deferred the
  // full implementation (see below), notShown after a local feedback write
  // (the page then matches no server revision), and null once the page shows
  // data.viewerRevision.
  const notShown = Symbol("not shown");
  let selectionRevision = null;
  const codeSelected = () => Boolean(window.getSelection()?.toString()) && !document.activeElement?.matches("input, textarea");
  // Feedback anchors to stage revisions, so it may only join a diff from the same revisions.
  const diffRevisions = (implementation) => JSON.stringify((implementation.stages || []).map((stage) =>
    [stage.id, stage.baseRevision, stage.headRevision, (stage.files || []).map((file) => [file.path, file.baseRevision || null])]));
  async function pollViewerRevision() {
    if (reviewDeleted || polling) return;
    // Hidden tabs keep checking slowly while an agent listens or works, so a finished round can notify.
    if (document.hidden && (!(agent?.working || agent?.listening) || Date.now() - lastHiddenPoll < 5000)) return;
    if (document.hidden) lastHiddenPoll = Date.now();
    polling = true;
    try {
      const response = await api.getRevision();
      if (!response.ok) {
        const failure = await response.json();
        if (failure.reviewUnavailable) markReviewDeleted(true);
        return;
      }
      const snapshot = await response.json();
      if (!snapshot.ok) return;
      // Once the selection clears, a deferred implementation is adopted whatever the revision now is.
      const handled = selectionRevision === null ? snapshot.revision === data.viewerRevision
        : selectionRevision !== notShown && snapshot.revision === selectionRevision && codeSelected();
      if (handled) { adoptAgentStatus(snapshot.agent); return; }
      // Let local feedback writes finish before adopting a server snapshot.
      if (approvalOps.size || exportState.phase === "working" || Object.values(threadOps).some((op) => op.busy)) return;
      const nextResponse = await api.getImplementation();
      if (!nextResponse.ok) return;
      const payload = await nextResponse.json();
      if (!payload.ok || payload.implementation.implementationId !== data.implementationId) return;
      if (approvalOps.size || exportState.phase === "working" || Object.values(threadOps).some((op) => op.busy)) return;
      // A code selection must not prevent an open conversation from refreshing.
      // Keep metadata aligned with the visible diff until the selection clears:
      // adopt only the threads, so rendering leaves the selected code rows alone,
      // and only while the stage revisions match the shown diff (a restack waits).
      // Leave viewerRevision unchanged so the first poll after it still adopts the
      // full snapshot; until then this revision is not fetched again, and only
      // changed feedback renders, as each render closes an open tooltip.
      // Thread lists the selection runs through keep what they show (see heldThreads).
      const feedback = payload.implementation.feedback || [];
      if (codeSelected()) {
        // Record the revision of the data adopted; the server may have moved on since the probe.
        selectionRevision = payload.implementation.viewerRevision;
        if (diffRevisions(payload.implementation) === diffRevisions(data) && JSON.stringify(feedback) !== JSON.stringify(artifactThreads)) {
          artifactThreads.splice(0, artifactThreads.length, ...feedback);
          if (!roundNotice) refreshNotice = "Review updated";
          render();
        }
      } else {
        selectionRevision = null;
        adoptImplementation(payload.implementation);
        if (!roundNotice) refreshNotice = "Review updated";
        render();
      }
      adoptAgentStatus(snapshot.agent);
    } catch {
      // External artifact writes can be transient; retry without replacing good data.
    } finally { polling = false; }
  }

  async function refreshRemote() {
    refreshingRemote = true; refreshNotice = ""; render();
    try {
      await flushReviewState();
      const response = await api.refreshRemote();
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not refresh the remote branch.");
      await pollViewerRevision();
      refreshNotice = "Remote branch refreshed";
    } catch (error) { refreshNotice = `Refresh failed: ${error.message}`; }
    finally { refreshingRemote = false; render(); }
  }

  function noteStage(note) {
    if (!note) return null;
    if (note.kind === "stage") return stageById.get(note.id);
    if (note.kind === "node") return stageById.get(note.stageId);
    if (note.kind === "file") return fileById.get(note.id)?.stage;
    if (note.kind === "line") return stageById.get(parseLineId(note.id)?.stageId);
    if (note.kind === "insight") return stageById.get(parseInsightKey(note.id)?.stageId);
    return null;
  }

  function rememberDraftSnapshot(note) {
    const stage = noteStage(note);
    if (stage && !draftSnapshots.has(note)) {
      const entry = note.kind === "line" ? noteFileEntry(note.kind, note.id) : null;
      draftSnapshots.set(note, { base: entry ? fileBaseRevision(entry) : stage.baseRevision, head: stage.headRevision,
        ...(entry?.file.revision ? { fileRevision: entry.file.revision } : {}) });
    }
  }

  function adoptImplementation(next) {
    state.comments.filter((note) => !note.exported).forEach(rememberDraftSnapshot);
    if (compose) rememberDraftSnapshot(compose);
    const previousFiles = new Map(fileById);
    Object.assign(data, next);
    nodeTitleById.clear(); stageById.clear(); stageNumberById.clear();
    fileById.clear(); fileByPreviousId.clear(); flatFiles.length = 0;
    data.stages.forEach((stage, index) => {
      stageById.set(stage.id, stage); stageNumberById.set(stage.id, index + 1);
      stage.nodes.forEach((node) => nodeTitleById.set(`${stage.id}:${node.id}`, node.title));
      stage.files.forEach((file) => {
        const id = fileKey(stage.id, file.path);
        const previous = previousFiles.get(id);
        if (previous && fileBaseRevision(previous) === (file.baseRevision || stage.baseRevision) && previous.stage.headRevision === stage.headRevision && previous.file.revision === file.revision && previous.file.kind === file.kind && Array.isArray(previous.file.lines)) {
          for (const key of ["lines", "_diffMode", "nextOffset", "_pageOffset"]) file[key] = previous.file[key];
        }
        const entry = { id, stage, file };
        flatFiles.push(entry); fileById.set(id, entry);
        if (file.previousPath) fileByPreviousId.set(fileKey(stage.id, file.previousPath), entry);
      });
    });
    rebuildFileSearchIndex();
    refreshFileSearch?.();
    requirements.splice(0, requirements.length, ...(data.requirements || []));
    allAcceptance.splice(0, allAcceptance.length, ...requirements.flatMap((r) => (r.acceptance || []).map((a) => ({ ...a, reqId: r.id, ref: `${r.id}#${a.id}` }))));
    artifactThreads.splice(0, artifactThreads.length, ...(data.feedback || []));
    reconcileApprovals();
  }

  const INSIGHT = {
    decision:    { glyph: "◆", label: "Decision" },
    assumption:  { glyph: "◇", label: "Assumption" },
    risk:        { glyph: "△", label: "Risk" },
    validation:  { glyph: "✓", label: "Check" },
    lesson:      { glyph: "↺", label: "Lesson" },
    alternative: { glyph: "⇄", label: "Alternative" },
    evidence:    { glyph: "▣", label: "Evidence" },
    question:    { glyph: "?", label: "Open question" }
  };
  const INSIGHT_ORDER = ["decision", "assumption", "risk", "lesson", "alternative", "validation", "evidence", "question"];

  const CLASS_LABEL = {
    behavior: "behavior", test: "test", configuration: "config",
    documentation: "docs", generated: "generated", dependency: "deps", chore: "chore"
  };

  /* ---- ids & lookups ---------------------------------------------------- */
  const fileKey = (stageId, path) => `f:${stageId}:${path}`;
  const fileApprovalKey = (stageId, nodeId, path) => `m:${JSON.stringify([stageId, nodeId, path])}`;
  function approvalEntry(id) {
    if (!id.startsWith("m:")) return null;
    try {
      const [stageId, nodeId, path] = JSON.parse(id.slice(2));
      const entry = fileById.get(fileKey(stageId, path));
      const membership = entry?.file.memberships?.find((item) => item.nodeId === nodeId);
      return membership ? { ...entry, nodeId, membership } : null;
    } catch { return null; }
  }
  function stageFileApprovals(stage) {
    return stage.nodes.flatMap((node) => nodeFileList(stage, node).map((file) => fileApprovalKey(stage.id, node.id, file.path)));
  }
  const insightKey = (stageId, collection, itemId) =>
    `i:${stageId}:${collection}:${itemId}`;
  function parseInsightKey(id) {
    const m = /^i:([^:]+):([^:]+):([^:]+)$/.exec(id || "");
    return m ? { stageId: m[1], collection: m[2], itemId: m[3] } : null;
  }
  const insightByKey = (id) => {
    const key = parseInsightKey(id);
    return key && stageById.get(key.stageId)?.insights.find((item) => item.collection === key.collection && item.id === key.itemId);
  };
  // A line thread's element id carries everything needed to resolve a feedback
  // target: the stage, which diff side the line lives on, its line number, and
  // the file path (kept last so paths with no colons parse unambiguously).
  const lineKey = (stageId, side, line, path) => `l:${stageId}:${side}:${line}:${path}`;
  function parseLineId(id) {
    const m = /^l:([^:]+):(old|new):(\d+):([^]+)$/.exec(id || "");
    if (!m) return null;
    return { stageId: m[1], side: m[2], line: Number(m[3]), path: m[4] };
  }
  const nodeTitleById = new Map();
  data.stages.forEach((s) => s.nodes.forEach((n) => nodeTitleById.set(`${s.id}:${n.id}`, n.title)));
  const stageById = new Map(data.stages.map((stage) => [stage.id, stage]));
  const stageNumberById = new Map(data.stages.map((stage, i) => [stage.id, i + 1]));

  const requirements = Array.isArray(data.requirements) ? data.requirements : [];
  // Criterion ids are only unique within a specification, so every acceptance
  // criterion is keyed by its full `<specificationId>#<criterionId>` ref.
  const allAcceptance = requirements.flatMap((r) =>
    (r.acceptance || []).map((a) => ({ ...a, reqId: r.id, ref: `${r.id}#${a.id}` })));

  const flatFiles = [];
  data.stages.forEach((stage) => stage.files.forEach((file) => {
    flatFiles.push({ id: fileKey(stage.id, file.path), stage, file });
  }));
  const fileById = new Map(flatFiles.map((f) => [f.id, f]));
  // Index memberships, not just paths: a shared file has a distinct destination
  // in each node. Rebuild only when the implementation snapshot changes.
  let fileSearchEntries = [];
  let fileOccurrenceCounts = new Map();
  let refreshFileSearch = null, fileSearchFileChanged = null;
  // Counts picker openings, so a closed picker's late close event leaves a
  // newer picker alone.
  let fileSearchSession = 0;
  function rebuildFileSearchIndex() {
    fileSearchEntries = [];
    fileOccurrenceCounts = new Map();
    for (const stage of data.stages) {
      for (const node of stage.nodes) {
        for (const file of nodeFileList(stage, node)) {
          fileSearchEntries.push({ stage, node, file });
          fileOccurrenceCounts.set(file.path, (fileOccurrenceCounts.get(file.path) || 0) + 1);
        }
      }
    }
  }
  rebuildFileSearchIndex();

  function matchesFileSearch(path, query) {
    return splitPath(path).name.toLowerCase().includes(query);
  }

  // `origin` names the stage and node of the occurrence the picker was opened
  // from, so that occurrence starts selected.
  function openFileSearch(path = "", origin = null) {
    if (reviewDeleted || document.querySelector("dialog[open]")) return;
    const opener = document.activeElement;
    const session = ++fileSearchSession;
    const dialog = document.createElement("dialog");
    dialog.className = "file-search";
    dialog.setAttribute("aria-labelledby", "file-search-title");
    let matches = [], selected = 0, navigating = false, composing = false, input = null;
    // Keep occurrence navigation scoped to the exact file until the user edits
    // its filename. Directory text never participates in the search query.
    let exactPath = path || null;
    let originEntry = path && origin ? origin : null;
    function completion() {
      if (!input) return "";
      const name = matches[selected] ? splitPath(matches[selected].file.path).name : "";
      const query = input.value.toLowerCase();
      const index = name.toLowerCase().indexOf(query);
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      // For an interior substring, suggest only the remainder after that match.
      return query && index >= 0 && atEnd && !composing && document.activeElement === input
        ? name.slice(index + input.value.length) : "";
    }
    // The grouped results, rebuilt only when the matches or the data they show change.
    let grouped = [], groupedMatches = null;
    function groups() {
      if (groupedMatches === matches) return grouped;
      groupedMatches = matches;
      const stages = grouped = [];
      let stage = null, node = null;
      matches.forEach(({ stage: s, node: n, file }, index) => {
        if (stage?.id !== s.id) {
          stage = { key: s.id, id: s.id, index, number: String(stageNumberById.get(s.id)).padStart(2, "0"), title: s.title, nodes: [] };
          stages.push(stage); node = null;
        }
        if (node?.id !== n.id) { node = { key: n.id, id: n.id, index, title: n.title, options: [] }; stage.nodes.push(node); }
        const { name, dir } = splitPath(file.path);
        node.options.push({ index, key: file.path, name, dir, kind: file.kind, kindLabel: kindLabel(file.kind), kindGlyph: kindGlyph(file.kind),
          binary: Boolean(file.binary), additions: file.additions, deletions: file.deletions });
      });
      return stages;
    }
    function draw() {
      renderLit(fileSearchView({
        stages: groups(), matches: matches.length, selected, typed: input?.value || "", suffix: completion(),
        onInput: () => { exactPath = null; originEntry = null; matches = []; paint(); },
        onKeydown, onCaret, onChoose: choose, onClose: () => dialog.close(),
      }), dialog);
      input ||= dialog.querySelector("input");
      // CSSOM only: the typed text under the input follows its horizontal scroll.
      dialog.querySelector(".file-search-completion-text").style.transform = `translateX(${-input.scrollLeft}px)`;
    }
    function onCaret(event) {
      if (event.type === "compositionstart") composing = true;
      else if (event.type === "compositionend") composing = false;
      draw();
    }
    function select(index, scroll = true) {
      selected = index;
      draw();
      if (scroll) dialog.querySelector(`[role="option"][data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }
    function paint() {
      const previous = matches[selected];
      const query = input.value.toLowerCase();
      matches = fileSearchEntries.filter(({ file }) => exactPath
        ? file.path === exactPath
        : matchesFileSearch(file.path, query));
      const wanted = previous ? { stageId: previous.stage.id, nodeId: previous.node.id, path: previous.file.path }
        : originEntry ? { ...originEntry, path: exactPath } : null;
      const previousIndex = wanted ? matches.findIndex((entry) => entry.stage.id === wanted.stageId && entry.node.id === wanted.nodeId && entry.file.path === wanted.path) : -1;
      select(previousIndex >= 0 ? previousIndex : 0, false);
    }
    function choose(index) {
      const entry = matches[index];
      if (!entry) return;
      navigating = true;
      dialog.close();
      const id = fileKey(entry.stage.id, entry.file.path);
      state.markdownPreview[id] = false;
      state.approvalComparisons[fileApprovalKey(entry.stage.id, entry.node.id, entry.file.path)] = false;
      jumpToElement("file", id, entry.stage.id, entry.node.id);
      requestAnimationFrame(() => fileRowElement(id, entry.node.id)?.querySelector(".frow-open")?.focus({ preventScroll: true }));
    }
    function onKeydown(event) {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && matches.length) {
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1 : (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        select(index);
      } else if (event.key === "Enter") {
        event.preventDefault(); choose(selected);
      }
    }
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (session !== fileSearchSession) return;
      refreshFileSearch = fileSearchFileChanged = null;
      if (!navigating) (opener?.isConnected ? opener : app.querySelector('[data-action="file-search"]'))?.focus({ preventScroll: true });
    });
    // A loaded diff page can change a file's line counts or binary flag, which
    // the results show; redraw only when a listed file changed.
    fileSearchFileChanged = (file) => {
      if (!matches.some((match) => match.file === file)) return;
      groupedMatches = null; draw();
    };
    refreshFileSearch = paint;
    document.body.append(dialog); draw();
    input.value = splitPath(path).name;
    paint(); dialog.showModal(); input.focus(); input.select();
    // Set the initial viewport after opening and focusing, when layout exists.
    const results = dialog.querySelector('[role="listbox"]');
    results.scrollTo({ top: 0, behavior: "instant" });
    if (selected > 0) results.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "center", behavior: "instant" });
  }

  const fileBaseRevision = (entry) => entry.file.baseRevision || entry.stage.baseRevision;
  // The revisions and view mode a diff page is requested for.
  const diffIdentity = (entry) => JSON.stringify([fileBaseRevision(entry), entry.stage.headRevision, entry.file.revision,
    fileViewMode(entry.id) === "full" ? "full" : "changes"]);
  const diffRequests = new Map();
  // An open file shows its diff once loaded. Run after each render, so a file
  // opened, restored with the review, or adopted without its lines loads the
  // diff its rendered row now waits for; the load renders again when done.
  function loadOpenDiffs() {
    Object.keys(state.activeFiles).forEach((fid) => {
      const entry = fileById.get(fid);
      if (!entry || !activeFileNodeId(fid) || !fileRowElement(fid)) return;
      if (!Array.isArray(entry.file.lines) && !entry.file._diffLoading && !entry.file._diffError) ensureFileDiff(entry);
    });
  }
  async function ensureFileDiff(entry, offset = 0, force = false, target = null, pageScroll = null) {
    if (!entry) return;
    if (diffRequests.has(entry.id)) {
      if (target || force) entry.file._queuedDiff = { offset, force, target, pageScroll, identity: diffIdentity(entry) };
      return;
    }
    const mode = fileViewMode(entry.id) === "full" ? "full" : "changes";
    if (!force && !offset && Array.isArray(entry.file.lines) && entry.file._diffMode === mode) return;
    entry.file._diffLoading = true;
    delete entry.file._diffError;
    const query = {
      stage: entry.stage.id,
      path: entry.file.path,
      base: fileBaseRevision(entry),
      head: entry.stage.headRevision,
      mode, offset: String(offset),
      ...(target ? { side: target.side, line: String(target.line) } : {}),
    };
    const identity = diffIdentity(entry);
    // A live update replaces the file objects while a page loads, and the
    // reviewer may switch the view mode. The response, or its error, belongs to
    // the file that now holds the path if it is still the requested base, head,
    // file revision and mode; otherwise it is stale.
    const currentFile = () => {
      const current = fileById.get(entry.id);
      return current && diffIdentity(current) === identity ? current.file : null;
    };
    let pageLoaded = false, stale = false;
    const request = api.getDiff(query)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `Diff request failed with status ${response.status}.`);
        }
        if (!Array.isArray(payload.lines)) {
          throw new Error("Diff response did not include lines.");
        }
        const file = currentFile();
        if (!file) { stale = true; return; }
        const additions = Number(payload.additions) || 0, deletions = Number(payload.deletions) || 0, binary = Boolean(payload.binary);
        const shownChanged = file.additions !== additions || file.deletions !== deletions || Boolean(file.binary) !== binary;
        file.lines = payload.lines;
        file._diffMode = mode;
        file._pageOffset = payload.offset ?? offset;
        file.nextOffset = payload.nextOffset;
        file.additions = additions;
        file.deletions = deletions;
        file.binary = binary;
        file.truncated = Boolean(payload.truncated);
        delete file._ownership;
        if (shownChanged) fileSearchFileChanged?.(file);
        pageLoaded = true;
      })
      .catch((error) => {
        const file = currentFile();
        if (file) file._diffError = error.message || "Diff could not be loaded.";
        else stale = true;
      })
      .finally(() => {
        const current = fileById.get(entry.id), file = current?.file;
        entry.file._diffLoading = false;
        if (file) file._diffLoading = false;
        diffRequests.delete(entry.id);
        let queued = file?._queuedDiff || entry.file._queuedDiff;
        delete entry.file._queuedDiff;
        if (file) delete file._queuedDiff;
        // A queued page belongs to the revisions and mode it was asked for; a
        // request for a line asks again for that line, and a page is dropped.
        if (queued && (!current || queued.identity !== diffIdentity(current)))
          queued = queued.target ? { offset: 0, force: true, target: queued.target, pageScroll: null } : null;
        // A stale request for a line asks again for that line in the current file.
        if (!queued && stale && target) queued = { offset: 0, force: true, target, pageScroll: null };
        if (queued) ensureFileDiff(current, queued.offset, queued.force, queued.target, queued.pageScroll);
        render();
        if (pageLoaded && pageScroll && !queued) scrollDiffPage(entry.id, pageScroll);
      });
    diffRequests.set(entry.id, request);
  }
  // A renamed file no longer answers to its old path, but feedback anchored
  // before the rename still targets that old path. Index the pre-rename path so
  // such a thread can resolve to the file at its new destination.
  const fileByPreviousId = new Map(
    flatFiles
      .filter((f) => f.file.previousPath)
      .map((f) => [fileKey(f.stage.id, f.file.previousPath), f]),
  );
  // Resolve a stage-scoped path to the file entry that currently holds it,
  // following a rename when the path was the file's pre-rename name.
  function currentFileEntry(stageId, p) {
    return fileById.get(fileKey(stageId, p)) || fileByPreviousId.get(fileKey(stageId, p)) || null;
  }

  function fileHasLine(file, side, line) {
    const key = side === "old" ? "o" : "n";
    return (file.lines || []).some((row) => row[key] === line);
  }

  function nodeFileList(stage, node) {
    return stage.files.filter((file) => file.memberships.some((m) => m.nodeId === node.id));
  }
  function activeFileNodeId(id) {
    const entry = fileById.get(id);
    return entry ? selectedNodeForFile(state.activeFiles[id], entry.file) : null;
  }
  function fileRowElement(id, nodeId = activeFileNodeId(id), root = app) {
    const entry = fileById.get(id);
    if (entry && nodeId) {
      const selector =
        `.stage[data-stage="${cssEsc(entry.stage.id)}"] ` +
        `details.node[data-node="${cssEsc(nodeId)}"] ` +
        `.frow[data-file="${cssEsc(id)}"]`;
      const row = root.querySelector(selector);
      if (row) return row;
    }
    return root.querySelector(`.frow[data-file="${cssEsc(id)}"]`);
  }
  function classificationFor(file, nodeId) {
    const m = file.memberships.find((x) => x.nodeId === nodeId) || file.memberships[0];
    // A classification this viewer does not know arrives absent and is shown neutrally.
    return m ? m.classification || "unclassified" : "behavior";
  }
  // When a file is split across nodes, resolve which node owns each changed
  // line (keyed "old:<n>"/"new:<n>") from the membership hunk or line-range
  // selectors. Whole-file members carry no selector and are ignored; returns
  // null unless the file is genuinely shared and split.
  function membershipOwnership(file) {
    if (file._ownership !== undefined) return file._ownership;
    const all = file.memberships || [];
    const split = all.filter(
      (m) => (m.hunks && m.hunks.length) || (m.lineRanges && m.lineRanges.length),
    );
    if (all.length < 2 || split.length === 0) { file._ownership = null; return null; }
    const lines = file.lines || [];
    const map = new Map();
    split.forEach((m) => {
      if (m.hunks && m.hunks.length) {
        const set = new Set(m.hunks);
        lines.forEach((r) => {
          if ((r.t === "add" || r.t === "del") && set.has(r.h)) {
            const side = r.t === "del" ? "old" : "new";
            map.set(`${side}:${r.t === "del" ? r.o : r.n}`, m.nodeId);
          }
        });
      } else {
        m.lineRanges.forEach((rg) => {
          ["old", "new"].forEach((side) => {
            const span = rg[side];
            if (!span) return;
            for (let ln = span.start; ln <= span.end; ln += 1) map.set(`${side}:${ln}`, m.nodeId);
          });
        });
      }

    });
    file._ownership = map.size ? map : null;
    return file._ownership;
  }
  // A short description of the current node's slice of a shared file, shown on
  // the file row's "shared" chip: hunk numbers or old/new line ranges.
  function ownershipHint(file, nodeId) {
    const m = (file.memberships || []).find((x) => x.nodeId === nodeId);
    if (!m) return "";
    if (m.hunks && m.hunks.length) return `hunk${m.hunks.length === 1 ? "" : "s"} ${m.hunks.join(", ")}`;
    if (m.lineRanges && m.lineRanges.length) {
      return m.lineRanges
        .map((rg) => {
          const parts = [];
          if (rg.new) parts.push(`new ${rg.new.start}–${rg.new.end}`);
          if (rg.old) parts.push(`old ${rg.old.start}–${rg.old.end}`);
          return parts.join(" · ");
        })
        .join(", ");
    }
    return "";
  }

  /* ---- state ------------------------------------------------------------ */
  let state = load();
  let compose = state.editor?.compose || null;              // inline note composer: {kind,id,stageId,editIndex,mode,body}
  let replyTo = state.editor?.replyTo || null;              // artifact thread id currently being replied to
  let replyAttachments = state.editor?.replyAttachments || [];
  let replyDraft = state.editor?.replyDraft || "";             // unsent text of the open reply, kept across re-renders
  let replyEditId = state.editor?.replyEditId || null;          // id of the pending reply draft being edited (if any)
  let replyDirty = false;
  let pendingLazyJump = null;
  function resumePendingLazyJump() {
    if (!pendingLazyJump) return;
    const pending = pendingLazyJump;
    const entry = fileById.get(pending.fileId);
    if (entry?.file._diffLoading) return;
    if (
      entry &&
      !Array.isArray(entry.file.lines) &&
      !entry.file._diffError
    ) return;
    pendingLazyJump = null;
    const parsed = parseLineId(pending.id);
    const exact =
      entry &&
      parsed &&
      Array.isArray(entry.file.lines) &&
      fileHasLine(entry.file, parsed.side, parsed.line);
    requestAnimationFrame(() => {
      if (pending.membership?.nodeId) {
        const node = entry && app.querySelector(
          `.stage[data-stage="${cssEsc(entry.stage.id)}"] details.node[data-node="${cssEsc(pending.membership.nodeId)}"]`,
        );
        if (node) node.open = true;
      }
      requestAnimationFrame(() => {
        const target = exact
          ? app.querySelector(`[data-line-id="${cssEsc(pending.id)}"]`)
          : fileRowElement(pending.fileId, pending.membership?.nodeId);
        if (target)
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        if (entry) fadeFileHighlight(entry.id, "in", pending.membership?.nodeId);
      });
    });
  }
  const threadOps = {};            // thread id -> { busy, error } for server actions
  let exportState = { phase: "idle", message: "" };
  function threadBusy(id) { return Boolean(threadOps[id] && threadOps[id].busy); }
  function threadError(id) { return threadOps[id] ? threadOps[id].error : ""; }
  // A thread is collapsed when the reviewer collapsed it, or — absent an
  // explicit choice — automatically once it has been resolved.
  function threadCollapsed(t) {
    if (state.threadCollapsed && t.id in state.threadCollapsed) return Boolean(state.threadCollapsed[t.id]);
    return t.status === "resolved";
  }

  function defaults() {
    return {
      approvals: {},
      insightReviews: {},
      comments: [],
      openStages: {},
      openThreads: {},
      lastNoteMode: "personal",
      specificationOpen: {},
      coverageOpen: false,
      notesOpen: false,
      pinnedInsight: null,
      hideApproved: false,
      fileView: {},
      hideDeleted: {},
      wrapLines: false,
      markdownPreview: {},
      threadCollapsed: {},
      openLineThreads: {},
      activeFiles: {},
      approvalComparisons: {},
      notesFilter: "active",
      replyDrafts: []
    };
  }
  // Artifact IDs name the keys of these maps. Without a prototype, keys such as
  // "__proto__", "constructor" and "prototype" are ordinary entries to assign and read.
  function load() {
    const loaded = { ...defaults(), ...savedReview.state };
    const map = (value) => value && typeof value === "object" && !Array.isArray(value);
    for (const [key, value] of Object.entries(defaults())) if (map(value) && map(loaded[key])) loaded[key] = Object.assign(Object.create(null), loaded[key]);
    return loaded;
  }
  function stateChanges(before, after, prefix = []) {
    const changes = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, key), has = Object.hasOwn(after, key);
      const a = had ? before[key] : undefined, b = has ? after[key] : undefined;
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const object = (value) => value && typeof value === "object" && !Array.isArray(value);
      if ((a === undefined || object(a)) && object(b)) changes.push(...stateChanges(a || {}, b, [...prefix, key]));
      else changes.push({ path: [...prefix, key], before: had ? { present: true, value: a } : { present: false }, after: has ? { present: true, value: b } : { present: false } });
    }
    return changes;
  }
  function captureEditor() {
    state.editor = { compose, replyTo, replyDraft, replyEditId, replyAttachments: replyTo ? replyAttachments : [] };
    for (const note of [...state.comments, compose].filter(Boolean)) {
      const snapshot = draftSnapshots.get(note);
      if (snapshot) note.snapshot = snapshot;
    }
  }
  // A completed in-flight write must also respect the latest typing deadline.
  // Explicit flushes still call saveState directly before navigation or actions.
  function scheduleSave(delay = 0) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveState();
    }, Math.max(delay, commentSaveNotBefore - Date.now()));
  }
  function persist(commentInput = false) {
    if (reviewDeleted) return;
    captureEditor();
    if (commentInput) commentSaveNotBefore = Date.now() + 300;
    scheduleSave(50);
  }
  function showSaveStatus() {
    let notice = document.querySelector("#save-status");
    if (!notice) { notice = document.createElement("div"); notice.id = "save-status"; notice.setAttribute("role", "status"); document.body.append(notice); }
    notice.className = "save-status";
    notice.hidden = !saveError;
    notice.textContent = saveError ? `Review changes are not saved: ${saveError}` : "";
  }
  function saveState() {
    if (saveOperation) return saveOperation;
    saveOperation = writeState().finally(() => { saveOperation = null; });
    return saveOperation;
  }
  async function writeState() {
    if (reviewDeleted) return;
    captureEditor();
    const next = JSON.parse(JSON.stringify(state));
    const changes = stateChanges(persistedState, next);
    if (!changes.length) return;
    savingState = true; showSaveStatus();
    try {
      const response = await api.saveReviewState({ reviewId: savedReview.reviewId, generation: savedReview.generation, changes });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        if (payload.reviewUnavailable) markReviewDeleted(true);
        throw new Error(payload.error || "Save failed. Make another edit to retry.");
      }
      persistedState = next;
      saveError = "";
    } catch (error) { saveError = error.message; }
    finally { savingState = false; showSaveStatus(); }
    if (!saveError && stateChanges(persistedState, JSON.parse(JSON.stringify(state))).length) scheduleSave();
  }
  async function flushReviewState() {
    if (reviewDeleted) return;
    await Promise.all([...uploadOps, ...approvalOps.values()]);
    clearTimeout(saveTimer);
    await saveState();
    if (saveError) throw new Error(saveError);
    captureEditor();
    while (uploadOps.size || approvalOps.size || stateChanges(persistedState, JSON.parse(JSON.stringify(state))).length) {
      await Promise.all([...uploadOps, ...approvalOps.values()]);
      await saveState();
      if (saveError) throw new Error(saveError);
      captureEditor();
    }
    clearTimeout(saveTimer);
  }

  window.addEventListener("beforeunload", (event) => {
    if (reviewDeleted) return;
    captureEditor();
    if (uploadOps.size || approvalOps.size || savingState || saveError || exportState.phase === "working" || saveTimer && stateChanges(persistedState, JSON.parse(JSON.stringify(state))).length) { event.preventDefault(); event.returnValue = ""; }
  });

  /* ---- helpers ---------------------------------------------------------- */
  /* File approvals are scoped to a node and observe the complete file plus its ownership.
     Changes outside owned ranges conservatively make that approval stale too. */
  function revisionFor(id) {
    const entry = approvalEntry(id);
    if (!entry?.file.revision) return null;
    const m = entry.membership;
    // An unknown classification keys the approval as recorded, as it did before the server narrowed it.
    return JSON.stringify([entry.file.revision, m.classification ?? m.recordedClassification, m.hunks || null, m.lineRanges || null]);
  }
  function approvalRevision(rec) {
    // Older approvals included the base commit, although the file revision
    // already identifies both sides of the diff. Preserve their ownership key.
    try {
      const parts = JSON.parse(rec.rev);
      if (Array.isArray(parts) && parts.length === 5) return JSON.stringify([parts[0], ...parts.slice(2)]);
    } catch { /* Unknown records remain stale. */ }
    return rec.rev;
  }
  function approvalEndpoint(entry) {
    return { stageId: entry.stage.id, nodeId: entry.nodeId, path: entry.file.path,
      baseRevision: fileBaseRevision(entry), headRevision: entry.stage.headRevision, fileRevision: entry.file.revision, ownership: structuredClone(entry.membership) };
  }
  function changeApproval(id, kind) {
    if (approvalOps.has(id)) return;
    const stage = kind === "stage" ? stageById.get(id) : null;
    if (stage && !stageNodesApproved(stage)) return;
    const entry = approvalEntry(id), rev = revisionFor(id), previousId = previousApprovalId(id);
    if (!stage && !rev) return;
    const remove = approvalState(id) === "approved";
    const operation = Promise.resolve().then(async () => {
      try {
        let retained = {};
        if (entry && !remove) {
          const response = await api.captureApprovalSnapshot(approvalEndpoint(entry));
          retained = await response.json();
          if (!response.ok || !retained.ok) throw new Error(retained.error || "Could not retain approved content.");
        }
        if (previousId) delete state.approvals[previousId];
        if (remove) delete state.approvals[id];
        else {
          state.approvals[id] = { rev, at: Date.now(), ...(entry ? {
            ...approvalEndpoint(entry), snapshotId: retained.snapshotId,
          } : {}) };
          delete state.approvalComparisons[id];
        }
        approvalErrors.delete(id);
        if (previousId) approvalErrors.delete(previousId);
        persist();
        if (entry && !remove) {
          // An older save may already be in flight. Wait until this approval
          // is stored before collapsing its diff; a failed save leaves it open.
          do {
            clearTimeout(saveTimer);
            await saveState();
            if (saveError) throw new Error(saveError);
          } while (JSON.stringify(persistedState.approvals?.[id]) !== JSON.stringify(state.approvals[id]));
          if (activeFileNodeId(entry.id) === entry.nodeId) {
            delete state.activeFiles[entry.id];
            persist();
          }
        }
      } catch (error) { approvalErrors.set(id, `${entry?.file.path || id}: ${error.message}`); }
      finally { approvalOps.delete(id); reconcileApprovals(); render(); }
    });
    approvalOps.set(id, operation); render();
    return operation;
  }
  // Approvals follow the implementation they were given for. Run whenever the
  // implementation or the approvals change: when the viewer starts, adopts a
  // snapshot, or finishes an approval change.
  function reconcileApprovals() {
    retainApprovalRenames();
    revokeInvalidStageApprovals();
  }
  // Retain each observed rename edge by moving the reference, never the captured endpoint.
  function retainApprovalRenames() {
    let changed = false;
    for (const { stage, file } of flatFiles) for (const membership of file.memberships || []) {
      const id = fileApprovalKey(stage.id, membership.nodeId, file.path), previousId = previousApprovalId(id);
      if (previousId && approvalErrors.has(previousId)) {
        if (!approvalErrors.has(id)) approvalErrors.set(id, approvalErrors.get(previousId));
        approvalErrors.delete(previousId);
      }
      if (!approvalRecord(id) && previousId && approvalRecord(previousId)) {
        state.approvals[id] = state.approvals[previousId]; delete state.approvals[previousId]; changed = true;
      }
    }
    if (changed) persist();
  }
  function previousApprovalId(id) {
    const entry = approvalEntry(id);
    return entry?.file.kind === "renamed" && entry.file.previousPath
      ? fileApprovalKey(entry.stage.id, entry.nodeId, entry.file.previousPath) : null;
  }
  // Commit IDs change after an amend/rebase. The newest occurrence can still use
  // the reviewer's last full-file sign-off, while historical approvals stay put.
  function remotePreviousApprovalId(id) {
    const entry = approvalEntry(id);
    if (!data.remote || !entry?.stage.id.startsWith("commit-") || entry.nodeId !== "changes") return null;
    const index = flatFiles.findIndex((item) => item.id === entry.id);
    if (flatFiles.slice(index + 1).some((item) => item.file.path === entry.file.path || item.file.previousPath === entry.file.path)) return null;
    const paths = [entry.file.path, entry.file.previousPath, ...(entry.file.previousPaths || [])].filter(Boolean);
    return Object.keys(state.approvals).filter((key) => {
      if (key === id || !key.startsWith("m:")) return false;
      try {
        const [stageId, nodeId, filePath] = JSON.parse(key.slice(2));
        const saved = approvalRecord(key);
        return stageId.startsWith("commit-") && nodeId === "changes" && paths.includes(filePath) &&
          saved?.snapshotId && saved.stageId === stageId && saved.nodeId === nodeId && saved.path === filePath;
      } catch { return false; }
    }).sort((a, b) => state.approvals[b].at - state.approvals[a].at)[0] || null;
  }
  function approvalRecord(id) {
    const rec = state.approvals[id];
    if (!rec || typeof rec !== "object" || !Number.isFinite(rec.at)) return null;
    if (id.startsWith("m:")) return typeof rec.rev === "string" && rec.rev.length > 0 ? rec : null;
    return stageById.has(id) && rec.rev === null ? rec : null;
  }
  function approvalState(id) {
    const rec = approvalRecord(id);
    if (rec) {
      if (id.startsWith("m:")) return approvalRevision(rec) === revisionFor(id) && rec.path === approvalEntry(id)?.file.path ? "approved" : "stale";
      return "approved";
    }
    // An approval inherited from before a rename can never still match the file
    // as it stands now, so surface it as stale to prompt a fresh look.
    const prevId = previousApprovalId(id);
    if (prevId && approvalRecord(prevId) || remotePreviousApprovalId(id)) return "stale";
    return "none";
  }
  const approved = (id) => approvalState(id) === "approved";
  function nodeApprovalState(stage, node) {
    return aggregateApprovalState(
      nodeFileList(stage, node).map((file) => approvalState(fileApprovalKey(stage.id, node.id, file.path))),
    );
  }
  function stageNodesApproved(stage) {
    return stage.nodes.every((node) => nodeApprovalState(stage, node) === "approved");
  }
  function stageApprovalState(stage) {
    return stageNodesApproved(stage) ? approvalState(stage.id) : "none";
  }
  function stageApproved(stage) {
    return stageApprovalState(stage) === "approved";
  }
  function revokeInvalidStageApprovals() {
    let changed = false;
    data.stages.forEach((stage) => {
      if (state.approvals[stage.id] && !stageNodesApproved(stage)) {
        delete state.approvals[stage.id];
        changed = true;
      }

    });
    if (changed) persist();
  }
  function elementNotes(id) {
    return state.comments.map((c, i) => ({ c, i })).filter(({ c }) => {
      if (c.id === id) return true;
      return id.startsWith("f:") && (c.kind === "file" || renamedLineNote(c)) && noteFileEntry(c.kind, c.id)?.id === id;
    });
  }

  /* ---- artifact feedback threads (from window.SEMANTIC_IMPLEMENTATION.feedback) -- */
  const artifactThreads = Array.isArray(data.feedback) ? [...data.feedback] : [];
  function artifactThreadById(tid) {
    return tid ? artifactThreads.find((t) => t.id === tid) : undefined;
  }
  function noteFileEntry(kind, id) {
    const line = kind === "line" ? parseLineId(id) : null;
    return kind === "file" ? fileById.get(id) || fileByPreviousId.get(id)
      : line ? currentFileEntry(line.stageId, line.path) : null;
  }
  function renamedLineNote(note) {
    const line = note.kind === "line" ? parseLineId(note.id) : null;
    const entry = line && currentFileEntry(line.stageId, line.path);
    return Boolean(entry && entry.file.path !== line.path);
  }
  function noteNodeId(note) {
    const entry = noteFileEntry(note.kind, note.id);
    if (!entry) return null;
    const memberships = entry.file.memberships || [];
    if (note.nodeId) return memberships.some((m) => m.nodeId === note.nodeId) ? note.nodeId : null;
    return memberships.length === 1 ? memberships[0].nodeId : null;
  }
  function threadNote(t) {
    const target = t.target || {};
    const local = state.comments.find((c) => c.threadId === t.id);
    return {
      kind: target.kind,
      id: target.kind === "file" ? fileKey(target.stageId, target.path)
        : target.kind === "line" ? lineKey(target.stageId, target.side, target.line, target.path)
        : target.kind === "stage" ? target.stageId
        : target.kind === "insight" ? insightKey(target.stageId, target.collection, target.itemId) : target.nodeId,
      stageId: target.stageId || t.assignedStageId,
      nodeId: target.nodeId || local?.nodeId,
      createdAt: t.comments?.[0]?.createdAt,
    };
  }
  function matchesNodeContext(note, nodeId) {
    if (note.kind !== "file" && note.kind !== "line") return true;
    return Boolean(nodeId) && noteNodeId(note) === nodeId;
  }
  function elementNodeId(kind, id) {
    const entry = noteFileEntry(kind, id);
    return entry ? activeFileNodeId(entry.id) : null;
  }
  function artifactThreadsForElement(kind, id, stageId, nodeId = elementNodeId(kind, id)) {
    return artifactThreads.filter((t) => {
      const tk = t.target && t.target.kind;
      if ((kind === "file" || kind === "line") && !matchesNodeContext(threadNote(t), nodeId)) return false;
      if (kind === "stage") return tk === "stage" && t.target.stageId === id;
      if (kind === "node")
        return tk === "node" && t.target.nodeId === id && t.target.stageId === stageId;
      if (kind === "insight") return tk === "insight" && insightKey(t.target.stageId, t.target.collection, t.target.itemId) === id;
      const entry = (tk === "file" || tk === "line") && currentFileEntry(t.target.stageId, t.target.path);
      const renamedLine = tk === "line" && entry && entry.file.path !== t.target.path;
      // A rename identifies the file, not the old line's new position. Keep
      // immutable line anchors at file level until their location is reviewed.
      if (kind === "file") return (tk === "file" || renamedLine) && entry?.id === id;
      if (kind === "line")
        return tk === "line" && !renamedLine &&
          lineKey(t.target.stageId, t.target.side, t.target.line, t.target.path) === id;
      return false;
    });
  }
  // Local notes still worth showing: drafts, plus exported notes whose artifact
  // thread has not been reloaded yet. Once the artifact thread is present the
  // local marker is hidden so a sent note is never rendered twice. A list the
  // selection holds (`list`: its key, held `threads` and `latest` threads) keeps a
  // sent note while the hold keeps out its thread, which the list would show
  // otherwise; a thread shown elsewhere, such as among resolved notes, replaces it.
  function sentNoteWaiting(c, list) {
    if (!c.exported || !artifactThreadById(c.threadId)) return true;
    const has = (threads) => threads.some((t) => t.id === c.threadId);
    if (!list || !selectedThreadLists.has(list.key) || !has(list.latest) || has(list.threads)) return false;
    heldThreadLists.add(list.key);
    return true;
  }
  function localVisibleForElement(id, nodeId = elementNodeId(id.startsWith("l:") ? "line" : "file", id), kind = null, stageId, list = null) {
    return elementNotes(id).filter(
      ({ c }) => sentNoteWaiting(c, list) && matchesNodeContext(c, nodeId) &&
        (!kind || c.kind === kind) && (kind !== "node" || c.stageId === stageId),
    );
  }
  function threadToggleCounts(kind, id, stageId) {
    const threads = artifactThreadsForElement(kind, id, stageId);
    const locals = localVisibleForElement(id, elementNodeId(kind, id), kind, stageId);
    return {
      total: threads.length + locals.length,
      open: threads.filter((t) => t.status !== "resolved").length + locals.length,
    };
  }
  function visibleThreadCount(kind, id) {
    return threadToggleCounts(kind, id).open;
  }
  function fileNoteCounts(id, nodeId) {
    const entry = fileById.get(id);
    const counts = { file: 0, line: 0, personal: 0 };
    const belongs = (note) => noteFileEntry(note.kind, note.id)?.id === entry?.id && matchesNodeContext(note, nodeId);
    artifactThreads.forEach((t) => {
      const note = threadNote(t);
      if (t.status !== "resolved" && belongs(note)) counts[note.kind] += 1;
    });
    visibleLocalNotes().forEach(({ c }) => {
      if (!belongs(c)) return;
      if ((c.mode || "personal") === "personal") counts.personal += 1;
      else counts[c.kind] += 1;
    });
    return counts;
  }
  function visibleLocalNotes(list = null) {
    return state.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => sentNoteWaiting(c, list));
  }
  function activeNoteCount() {
    return artifactThreads.filter((t) => t.status !== "resolved").length + visibleLocalNotes().length;
  }
  function fmtTime(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  function acceptanceStatus(ref) {
    const stages = data.stages
      .map((s, i) => ({ s, i }))
      .filter((x) => (x.s.specificationRefs || []).includes(ref));
    if (!stages.length) return { key: "uncovered", stages: [] };
    const allApproved = stages.every((x) => stageApproved(x.s));
    return { key: allApproved ? "approved" : "pending", stages: stages.map((x) => x.i + 1) };
  }
  function stageAcceptanceRefs(stage) {
    return (stage.specificationRefs || []).filter(Boolean);
  }
  function acceptanceChipModel(ref) {
    const ac = allAcceptance.find((a) => a.ref === ref);
    const acId = ac ? ac.id : String(ref).split("#").pop();
    const st = acceptanceStatus(ref);
    const map = {
      approved: { vstat: "passed", glyph: "✓", label: "Approved" },
      pending: { vstat: "notrun", glyph: "○", label: "In review" },
      uncovered: { vstat: "", glyph: "◇", label: "Not covered" }
    };
    const m = map[st.key] || map.pending;
    const stages = st.stages.length ? `Stage ${st.stages.map((n) => String(n).padStart(2, "0")).join(" · ")}` : "no stage";
    return { id: acId, vstat: m.vstat, glyph: m.glyph, label: m.label, meta: `${acId} · ${stages}`, text: ac ? ac.text : acId };
  }
  // Icon + tooltip text for the kind of element a feedback thread targets.
  function threadTypeLabel(kind) {
    return kind === "file" ? "File"
      : kind === "line" ? "Line"
      : kind === "stage" ? "Stage"
      : kind === "node" ? "Step"
      : kind === "specification" ? "Specification"
      : kind === "criterion" ? "Criterion"
      : kind === "insight" ? "Insight"
      : "Thread";
  }
  function reviewable() {
    let n = 0;
    data.stages.forEach((s) => { n += 1 + s.nodes.length + stageFileApprovals(s).length; });
    return n;
  }
  function approvedCount() {
    let n = 0;
    data.stages.forEach((s) => {
      if (stageApproved(s)) n += 1;
      s.nodes.forEach((node) => { if (nodeApprovalState(s, node) === "approved") n += 1; });
      stageFileApprovals(s).forEach((key) => { if (approved(key)) n += 1; });
    });
    return n;
  }
  const pct = () => reviewable() ? Math.round((approvedCount() / reviewable()) * 100) : 0;

  function splitPath(path) {
    const i = path.lastIndexOf("/");
    return { dir: i >= 0 ? path.slice(0, i + 1) : "", name: i >= 0 ? path.slice(i + 1) : path };
  }
  function dirShort(dir) {
    const trimmed = dir.replace(/\/$/, "");
    if (!trimmed) return "";
    const parts = trimmed.split("/");
    return (parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : trimmed) + "/";
  }
  function shortPath(path) {
    const parts = path.split("/");
    if (parts.length <= 3) return path;
    return `…/${parts.slice(-2).join("/")}`;
  }
  function kindGlyph(kind) {
    return kind === "added" ? "A" : kind === "deleted" ? "D" : kind === "renamed" ? "R" : "M";
  }
  function kindLabel(kind) {
    return kind === "added" ? "Added" : kind === "deleted" ? "Deleted" : kind === "renamed" ? "Renamed" : "Modified";
  }

  /* ---- reasoning tags (the signature) ----------------------------------- */
  function vstatus(ins) {
    if (ins.type !== "validation") return null;
    const s = String(ins.meta || "").toLowerCase();
    if (s === "failed") return { key: "failed", glyph: "✕", label: "Check failed" };
    if (s === "not-run" || s === "notrun" || s === "skipped")
      return { key: "notrun", glyph: "○", label: "Check not run" };
    return { key: "passed", glyph: "✓", label: "Check passed" };
  }
  function insightSort(list) {
    return list.slice().sort((a, b) => INSIGHT_ORDER.indexOf(a.type) - INSIGHT_ORDER.indexOf(b.type));
  }
  function validationTypeLabel(type) {
    return type === "automated" ? "Automated"
      : type === "manual" ? "Manual"
      : type === "analysis" ? "Analysis"
      : "";
  }
  // An insight linked to a line of an open diff; it opens beside the code.
  function inlineInsightModel(stage, ins) {
    const info = vstatus(ins) || INSIGHT[ins.type] || INSIGHT.decision;
    return { stageId: stage.id, collection: ins.collection, itemId: ins.id, type: ins.type, glyph: info.glyph, label: info.label,
      title: ins.title, needsReview: ins.codeTarget.status === "needs-review" };
  }
  function codeContextModel(target) {
    return { path: target.path, startLine: target.startLine, endLine: target.endLine, revision: target.revision.slice(0, 12),
      contextStartLine: target.contextStartLine, context: target.context };
  }
  function openCodeInsight(stage, ins, choices = [ins]) {
    if (!stage || !ins?.codeTarget) return;
    forceHidePop();
    clearInlineInsightHighlight();
    const { dialog, dismiss, show } = insightDialog("code-insight-dialog", "code-insight-title", (opener) => {
      // Restore keyboard position without treating restored focus as a new
      // request to preview the range. A fresh hover/focus can highlight again.
      clearInlineInsightHighlight();
      suppressedCodeInsight = opener?.closest(".line-code-insights .code-insight-link") || null;
    });
    const paint = () => {
      const target = ins.codeTarget, stale = target.status === "needs-review";
      renderLit(codeInsightView({
        choices: choices.length > 1 ? choices.map((item) => item.title) : [], chosen: choices.indexOf(ins),
        status: stale ? "needs-review" : target.status === "mapped" ? "mapped" : "current", reason: stale ? target.reason : "",
        kindLabel: (INSIGHT[ins.type] || INSIGHT.decision).label, title: ins.title, body: ins.body || "",
        shown: codeContextModel(stale ? target.original : target),
        original: !stale && target.status === "mapped" ? codeContextModel(target.original) : null,
        onChoose: (index) => { ins = choices[index]; paint(); },
        onClose: dismiss,
      }), dialog);
    };
    paint(); show();
  }
  function insightDialog(className, labelledBy, onClosed = () => {}) {
    const opener = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = className;
    dialog.setAttribute("aria-labelledby", labelledBy);
    let entering = null, closing = false;
    const dismiss = () => {
      if (closing) return;
      closing = true;
      if (motionReduced()) { dialog.close(); return; }
      const current = getComputedStyle(dialog);
      const from = { opacity: current.opacity, transform: current.transform };
      entering?.cancel();
      dialog.classList.add("is-closing");
      const animation = dialog.animate([from, { opacity: 0, transform: "translateY(8px) scale(.985)" }], { duration: 140, easing: "ease-in", fill: "forwards" });
      afterAnim(animation, 140, () => dialog.close());
    };
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      onClosed(opener);
    });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
    });
    const show = () => {
      document.body.append(dialog); dialog.showModal();
      if (!motionReduced()) entering = dialog.animate([
        { opacity: 0, transform: "translateY(10px) scale(.985)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ], { duration: 180, easing: "cubic-bezier(.22,.7,.2,1)" });
    };
    return { dialog, dismiss, show };
  }
  const EVIDENCE_TEXT_LIMIT = 200000;
  async function loadEvidenceText(url) {
    try {
      const response = await api.getEvidence(url);
      if (!response.ok) throw new Error();
      const text = await response.text();
      return text.length > EVIDENCE_TEXT_LIMIT ? `${text.slice(0, EVIDENCE_TEXT_LIMIT)}\n… Download the file for the rest.` : text;
    } catch { return "This evidence could not be loaded."; }
  }
  function openEvidence(stage, ins) {
    if (!stage || !ins?.evidence) return;
    forceHidePop();
    const evidence = ins.evidence;
    const { dialog, dismiss, show } = insightDialog("code-insight-dialog evidence-dialog", "evidence-title");
    const zoomed = new Set(), failed = new Set(), texts = new Map();
    const items = evidence.attachments.map((attachment, index) => {
      const type = attachment.mediaType;
      return { attachment, index, url: api.evidenceUrl({ stage: stage.id, item: ins.id, index: String(index) }),
        type: type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("text/") || type === "application/json" ? "text" : "file" };
    });
    const model = ({ attachment, index, url, type }) => ({ index, type, url, caption: attachment.caption || "", download: `${ins.id}-${index + 1}`,
      name: attachment.caption || `${EVIDENCE_KIND[evidence.kind] || "Evidence"} ${index + 1}`,
      failed: failed.has(index), zoomed: zoomed.has(index), text: texts.get(index) ?? null });
    const role = (value) => items.filter((item) => item.attachment.role === value).map(model);
    const paint = () => renderLit(evidenceView({
      captured: new Date(evidence.capturedAt).toLocaleString(), kindLabel: (evidence.kind === "other" && ins.meta) || EVIDENCE_KIND[evidence.kind] || evidence.kind, title: ins.title,
      reproduction: evidence.reproduction || "", before: role("before"), after: role("after"),
      others: items.filter((item) => !item.attachment.role).map(model), inline: evidence.inline || "",
      criteria: evidence.specificationRefs.map((ref) => ({ ref, text: allAcceptance.find((item) => item.ref === ref)?.text || "" })),
      nodes: (ins.nodeRefs || []).map((id) => nodeTitleById.get(`${stage.id}:${id}`) || id),
      onZoom: (index) => { if (!zoomed.delete(index)) zoomed.add(index); paint(); },
      onFailed: (index) => { failed.add(index); paint(); },
      onClose: dismiss,
    }), dialog);
    paint();
    for (const item of items) if (item.type === "text") void loadEvidenceText(item.url).then((text) => { texts.set(item.index, text); paint(); });
    show();
  }
  const EVIDENCE_KIND = { screenshot: "Screenshot", recording: "Recording", terminal: "Terminal output", http: "HTTP exchange", log: "Log excerpt", "output-file": "Output file", measurement: "Measurement", report: "Report", other: "Evidence" };
  // Evidence of a kind this viewer does not know arrives as "other"; its insight's meta holds the recorded kind.
  function fileCodeInsights(stage, filePath) {
    return stage.insights.filter(ins => ins.codeTarget && (ins.codeTarget.path === filePath || ins.codeTarget.original.path === filePath));
  }
  // Reviewed marks are personal reading progress, kept apart from approvals. The
  // stored fingerprint reveals an insight rewritten after it was marked.
  function insightFingerprint(ins) {
    const text = JSON.stringify([ins.type, ins.title, ins.body, ins.meta, ins.validationType, ...(ins.evidence ? [ins.evidence.attachments.map((item) => item.sha256), ins.evidence.inline] : [])]);
    let a = 0xdeadbeef, b = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 2654435761);
      b = Math.imul(b ^ code, 1597334677);
    }
    return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0");
  }
  function insightReviewState(stage, ins) {
    const record = state.insightReviews[insightKey(stage.id, ins.collection, ins.id)];
    if (!record) return "none";
    return record.fingerprint === insightFingerprint(ins) ? "reviewed" : "changed";
  }
  const INSIGHT_REVIEW = {
    none: { mark: "", text: "Not reviewed", tooltip: "Not reviewed – click to mark as reviewed" },
    reviewed: { mark: "✓", text: "Reviewed", tooltip: "Reviewed – click to mark as not reviewed" },
    changed: { mark: "!", text: "Changed since reviewed", tooltip: "Changed since reviewed – click to mark as reviewed" }
  };
  // Evidence linked to several nodes hosts its one thread under the first of them.
  const hostsEvidenceThread = (ins, node) => ins.evidence && ins.nodeRefs?.[0] === node.id;
  function insightTagModel(stage, ins, node) {
    const info = INSIGHT[ins.type] || INSIGHT.decision;
    const vs = vstatus(ins);
    // For validation, the status is already carried by the glyph, so the free
    // meta slot instead surfaces the evidence type (automated/manual/analysis)
    // without displacing the pass/fail signal.
    const vtype = ins.type === "validation" ? validationTypeLabel(ins.validationType) : "";
    const review = insightReviewState(stage, ins), reviewInfo = INSIGHT_REVIEW[review];
    const key = insightKey(stage.id, ins.collection, ins.id);
    return {
      key, stageId: stage.id, collection: ins.collection, itemId: ins.id, type: ins.type,
      vstat: vs ? vs.key : "", glyph: vs ? vs.glyph : info.glyph, label: vs ? vs.label : info.label,
      kindText: vtype ? `${info.label} · ${vtype}` : info.label,
      meta: (vs ? vtype : ins.evidence ? (EVIDENCE_KIND[ins.meta] || ins.meta) : ins.meta) || "",
      title: ins.title, body: ins.body || "",
      review, reviewMark: reviewInfo.mark, reviewText: reviewInfo.text, reviewTooltip: reviewInfo.tooltip,
      evidence: ins.evidence ? { notes: hostsEvidenceThread(ins, node) ? notesToggleModel("insight", key) : null } : null,
      code: ins.codeTarget ? { stageId: stage.id, collection: ins.collection, itemId: ins.id, needsReview: ins.codeTarget.status === "needs-review" } : null,
    };
  }
  function reasoningLegendModel(insights) {
    if (!insights.length) return null;
    return {
      entries: INSIGHT_ORDER
        .map((type) => ({ type, glyph: INSIGHT[type].glyph, label: INSIGHT[type].label, count: insights.filter((i) => i.type === type).length }))
        .filter((entry) => entry.count),
      notPassed: insights.filter((i) => { const v = vstatus(i); return v && v.key !== "passed"; }).length,
    };
  }

  /* ---- approvals / comments UI ----------------------------------------- */
  function stageApproveModel(stage) {
    const blocked = approvalOps.has(stage.id) || !stageNodesApproved(stage);
    const st = stageApprovalState(stage);
    const verb = blocked ? "Approve" : st === "stale" ? "Re-approve" : st === "approved" ? "Approved" : "Approve";
    return { kind: "stage", id: stage.id, state: st, blocked: blocked ? "Approve every step before approving the stage" : "",
      label: `${verb} stage ${stageNumber(stage)}: ${stage.title}` };
  }
  function stageNumber(stage) { return String(data.stages.indexOf(stage) + 1).padStart(2, "0"); }
  function threadStateKey(kind, id, stageId) {
    return kind === "node" ? `n:${stageId}:${id}` : id;
  }
  function notesToggleModel(kind, id, stageId) {
    const { total, open } = threadToggleCounts(kind, id, stageId);
    if (!total) return null;
    return { kind, id, stageId: stageId || "", total, open, expanded: Boolean(state.openThreads[threadStateKey(kind, id, stageId)]) };
  }
  // Notes list: show only the filename for file targets, keep the full path on hover.
  function threadTargetDisplay(t) {
    const tgt = (t && t.target) || {};
    if ((tgt.kind === "file" || tgt.kind === "line") && tgt.path) {
      const name = splitPath(tgt.path).name;
      const suffix = tgt.kind === "line" && tgt.line ? `:${tgt.line}` : "";
      return { text: `${name}${suffix}`, title: `${tgt.path}${suffix}` };
    }
    const l = tgt.label || tgt.kind || "thread";
    return { text: l, title: l };
  }
  // Which reviewable element (if any) an artifact thread points at, so the
  // notes list can offer a "show" jump.
  // File and line targets resolve against the file that currently holds the
  // path (following a rename); a target whose file no longer exists yields no
  // ref so the jump control can be withheld.
  function threadElementRef(t) {
    const tgt = (t && t.target) || {};
    const nodeId = noteNodeId(threadNote(t));
    if ((tgt.kind === "file" || tgt.kind === "line") && !nodeId) return null;
    if (tgt.kind === "file" && tgt.path && tgt.stageId) {
      const entry = currentFileEntry(tgt.stageId, tgt.path);
      return entry ? { kind: "file", id: entry.id, nodeId } : null;
    }
    if (tgt.kind === "line" && tgt.path && tgt.stageId && tgt.line) {
      const entry = currentFileEntry(tgt.stageId, tgt.path);
      if (!entry) return null;
      // A later stage head can remove or move the saved line. Only offer an
      // exact jump while that side and line still exist in the rendered diff.
      if (entry.file.path === tgt.path && !t.anchorStale)
        return { kind: "line", id: lineKey(tgt.stageId, tgt.side, tgt.line, tgt.path), nodeId };
      if (entry.file.path === tgt.path && fileHasLine(entry.file, tgt.side, tgt.line))
        return { kind: "line", id: lineKey(tgt.stageId, tgt.side, tgt.line, tgt.path), nodeId };
      return { kind: "file", id: entry.id, nodeId };
    }
    if (tgt.kind === "stage" && tgt.stageId)
      return data.stages.some((s) => s.id === tgt.stageId) ? { kind: "stage", id: tgt.stageId } : null;
    if (tgt.kind === "node" && tgt.stageId && tgt.nodeId) {
      const stage = stageById.get(tgt.stageId);
      return stage?.nodes.some((node) => node.id === tgt.nodeId)
        ? { kind: "node", id: tgt.nodeId, stageId: tgt.stageId }
        : stage ? { kind: "stage", id: tgt.stageId } : null;
    }
    if (tgt.kind === "specification" && tgt.specificationId)
      return requirements.some((r) => r.id === tgt.specificationId)
        ? { kind: "specification", id: tgt.specificationId }
        : null;
    if (tgt.kind === "criterion" && tgt.specificationId && tgt.criterionId) {
      const req = requirements.find((r) => r.id === tgt.specificationId);
      if (!req) return null;
      return (req.acceptance || []).some((a) => a.id === tgt.criterionId)
        ? { kind: "criterion", id: `${tgt.specificationId}#${tgt.criterionId}` }
        : { kind: "specification", id: tgt.specificationId };
    }
    if (tgt.kind === "insight" && tgt.stageId && tgt.collection && tgt.itemId) {
      const stage = stageById.get(tgt.stageId);
      const insight = stage?.insights.find(
        (item) => item.collection === tgt.collection && item.id === tgt.itemId,
      );
      return insight
        ? {
            kind: "insight",
            id: insightKey(tgt.stageId, tgt.collection, tgt.itemId),
            stageId: tgt.stageId,
          }
        : stage ? { kind: "stage", id: tgt.stageId } : null;
    }
    return null;
  }
  // Classify what became of a file/line thread's target. The current stage diff
  // controls whether the thread can jump to a file; snapshot status distinguishes
  // a file removed from this stage's diff from one deleted from the repository.
  function threadTargetState(t) {
    const tgt = (t && t.target) || {};
    if ((tgt.kind === "file" || tgt.kind === "line") && tgt.path && tgt.stageId) {
      const direct = fileById.get(fileKey(tgt.stageId, tgt.path));
      if (direct) return { state: "present" };
      const renamed = fileByPreviousId.get(fileKey(tgt.stageId, tgt.path));
      if (renamed) return { state: "renamed", to: renamed.file.path };
      if (t.targetState && t.targetState.state === "present")
        return { state: "not-in-stage" };
      if (t.targetState && t.targetState.state === "renamed")
        return { state: "renamed", to: t.targetState.path };
      if (t.targetState && t.targetState.state === "deleted")
        return { state: "deleted" };
      return { state: "not-in-stage" };
    }
    return { state: "present" };
  }
  function jumpModel(ref) {
    return { kind: ref.kind, id: ref.id, stageId: ref.stageId || "", nodeId: ref.nodeId || "" };
  }
  // An exported feedback thread: a reviewer <-> agent conversation the reviewer
  // can continue, mark resolved, or reopen. Only the reviewer controls closure.
  // `withLabel` marks the notes panel's copy, which names the target and can jump to it.
  function threadModel(t, withLabel) {
    const disp = threadTargetDisplay(t);
    const ref = threadElementRef(t);
    const kind = (t.target && t.target.kind) || "thread";
    const tstate = threadTargetState(t);
    // The stage the review conversation is anchored to. Shown only when it adds
    // information: a target in a different stage, or a spec/criterion/insight
    // thread that has no stage of its own. Same-stage threads stay unlabelled.
    const assignedStage = t.assignedStageId ? stageById.get(t.assignedStageId) : null;
    const tgtStageId = t.target && t.target.stageId;
    const showAssigned = Boolean(
      assignedStage &&
        (["specification", "criterion", "insight"].includes(kind) ||
          (tgtStageId && tgtStageId !== t.assignedStageId)),
    );
    let staleMsg = "";
    if ((kind === "file" || kind === "line") && !noteNodeId(threadNote(t)))
      staleMsg = "Original step unknown or unavailable. This conversation is kept in the global list.";
    if (tstate.state === "deleted")
      staleMsg = `This file was deleted after the feedback was sent.`;
    else if (tstate.state === "renamed")
      staleMsg = `This file was renamed to ${splitPath(tstate.to).name} after the feedback was sent.${kind === "line" ? " The original line is shown here at file level; its current position is unverified." : ""}`;
    else if (tstate.state === "not-in-stage")
      staleMsg = `This file is no longer changed in this stage.`;
    else if (t.anchorStale && !(t.comments || []).some((cm) => cm.author === "agent"))
      staleMsg = `Stage changed since this feedback was sent.`;
    if (withLabel && !ref && !staleMsg) staleMsg = "The original target is no longer available.";
    return {
      id: t.id, status: t.status, collapsed: threadCollapsed(t), kind, kindLabel: threadTypeLabel(kind),
      title: (withLabel || kind === "line" && tstate.state === "renamed") && t.target && t.target.label
        ? { text: disp.text, tooltip: disp.title } : null,
      assignedStage: showAssigned ? assignedStage.title : "",
      agentState: threadAgentState(t),
      jump: !withLabel ? null : ref ? jumpModel(ref) : tstate.state === "deleted" ? "deleted" : null,
      stale: staleMsg,
      error: threadError(t.id),
      busy: threadBusy(t.id),
      messages: (t.comments || []).map((cm) => {
        const agent = cm.author === "agent";
        return { author: agent ? "agent" : "user", unread: isUnreadReply(t, cm), replyKey: agent ? replyKey(t, cm) : "",
          time: fmtTime(cm.createdAt), body: cm.body, attachments: attachmentModels(cm.attachments) };
      }),
      // Pending reply drafts render as unsent messages the reviewer can revise or
      // remove before preparing feedback; the one being edited is shown as a form.
      drafts: repliesForThread(t.id).filter((r) => r.id !== replyEditId)
        .map((r) => ({ id: r.id, body: r.body, attachments: attachmentModels(r.attachments), sending: sendingDrafts.has(r.id) })),
      actionable: t.status === "open" || t.status === "resolved",
      replying: replyTo === t.id,
      reply: replyTo === t.id && Boolean(withLabel) === state.notesOpen
        ? { draft: replyDraft, editing: replyEditId != null, attachments: attachmentEditorModel(replyAttachments), saveDisabled: uploadOps.size > 0 }
        : null,
    };
  }
  const localNoteIds = new WeakMap();
  let lastLocalNoteId = 0;
  function localNoteId(note) {
    if (!localNoteIds.has(note)) localNoteIds.set(note, `note-${++lastLocalNoteId}`);
    return localNoteIds.get(note);
  }
  // A browser-local note, or the composer editing it in its place. Drafts can be
  // edited/deleted; a sent note awaiting its artifact thread is shown read-only.
  function localNoteEntry({ c, i }, withLabel = false) {
    // Keyed by the note itself, so a deleted note's row is removed rather than reused for another.
    const key = `n:${localNoteId(c)}`;
    if (compose && compose.editIndex === i && withLabel === state.notesOpen) return { type: "composer", key, composer: composerModel(compose) };
    const ref = localNoteRef(c);
    return { type: "note", key, note: {
      index: i, id: localNoteId(c), mode: c.mode === "feedback" ? "feedback" : "personal", sent: Boolean(c.exported), sending: sendingDrafts.has(c),
      label: withLabel || renamedLineNote(c) ? noteTargetLabel(c) : null,
      jump: withLabel && ref ? jumpModel(ref) : null,
      missing: withLabel && !ref ? "Original target or step unavailable. This note is kept in the global list."
        : ref && ref.kind !== c.kind ? "The line snapshot changed. Open the current file to review its location." : "",
      time: fmtTime(c.createdAt), body: c.body, attachments: attachmentModels(c.attachments),
    } };
  }
  function threadEntry(t, withLabel = false) {
    return { type: "thread", key: `t:${t.id}`, thread: threadModel(t, withLabel) };
  }
  // A thread list a code selection runs through keeps the threads it showed
  // until the selection leaves it: which threads it has, their comments and
  // their status stay as the server last sent them while shown, so what is
  // selected (and copied) does not change under the reviewer. Models are still
  // built from the reviewer's own state (busy, errors, collapse, replies,
  // drafts and local notes). Each render works out the held lists afresh from
  // the current selection, so a list adopts the latest threads once it leaves.
  let shownThreadLists = new Map();     // list key -> the threads it last showed
  let nextThreadLists = shownThreadLists;
  let selectedThreadLists = new Set();
  let heldThreadLists = new Set();      // lists that show older threads than the latest
  function threadListsInSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.matches("input, textarea")) return new Set();
    const range = selection.getRangeAt(0);
    // A hidden or inert list (the inactive notes tab, a closed panel) shows
    // nothing that is selected, nor does one inside a closed step or file.
    const insideClosed = (el) => {
      for (let det = el.closest("details:not([open])"); det; det = det.parentElement?.closest("details:not([open])") || null) {
        const summary = det.querySelector(":scope > summary");
        if (!summary || !summary.contains(el)) return true;
      }
      return false;
    };
    const shown = (el) => !el.closest("[hidden], [inert]") && !insideClosed(el) && el.getClientRects().length > 0;
    return new Set([...app.querySelectorAll("[data-thread-list]")].filter((el) => shown(el) && range.intersectsNode(el)).map((el) => el.dataset.threadList));
  }
  // A list's key names everything that decides its threads, so a held list is reused only for the same list.
  const threadListKey = (...identity) => JSON.stringify(identity);
  function heldThreads(key, latest) {
    const shown = selectedThreadLists.has(key) && shownThreadLists.get(key);
    const threads = shown || latest;
    if (shown && (shown.length !== latest.length || shown.some((t, i) => t !== latest[i]))) heldThreadLists.add(key);
    nextThreadLists.set(key, threads);
    return threads;
  }
  // The held copies of a thread, which the reviewer's own resolve or reopen updates.
  function heldThreadCopies(id) {
    return [...shownThreadLists.values()].flat().filter((t) => t.id === id);
  }
  document.addEventListener("selectionchange", () => {
    if (!heldThreadLists.size) return;
    const selected = threadListsInSelection();
    if ([...heldThreadLists].some((key) => !selected.has(key))) render();
  });
  // Keys stay unique when local notes share a timestamp.
  function uniqueKeys(entries) {
    const seen = new Set();
    return entries.map((entry, index) => {
      const key = seen.has(entry.key) ? `${entry.key}#${index}` : entry.key;
      seen.add(key);
      return key === entry.key ? entry : { ...entry, key };
    });
  }
  // An element's threads, then its local notes.
  function threadListEntries(threads, locals) {
    return uniqueKeys([...threads.map((t) => threadEntry(t)), ...locals.map((local) => localNoteEntry(local))]);
  }
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  function attachmentModels(attachments = []) {
    return attachments.map((file) => ({ id: file.id, filename: file.filename, size: (file.size / 1024).toFixed(1),
      preview: IMAGE_TYPES.includes(file.mediaType) ? api.attachmentUrl(file.id, true) : "" }));
  }
  function attachmentEditorModel(attachments) {
    const status = uploadStatus.get(attachments);
    return { attachments: attachmentModels(attachments), uploading: Boolean(status?.busy), error: status?.error || "" };
  }
  function editorAttachments(form) {
    if (form?.matches("[data-note-form]") && compose) return compose.attachments ||= [];
    if (form?.matches("[data-reply-form]") && replyTo === form.dataset.id) return replyAttachments;
    return null;
  }
  function uploadFiles(files, attachments) {
    if (!attachments || !files.length) return;
    const status = uploadStatus.get(attachments) || { busy: false, error: "", errors: new Map(), pending: [] };
    status.pending.push(...files); uploadStatus.set(attachments, status);
    if (status.busy) { render(); return; }
    status.busy = true;
    const operation = Promise.resolve().then(async () => {
      while (status.pending.length) {
        const file = status.pending.shift();
        let errorKey = JSON.stringify(["oversize", file.name, file.type, file.size]);
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: files must be 20 MiB or smaller.`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
          errorKey = JSON.stringify([file.name, file.type, sha256]);
          if (attachments.length >= 10) {
            if (!attachments.some((item) => item.filename === file.name && item.size === file.size && item.sha256 === sha256)) throw new Error("Use at most 10 files per message.");
            // The exact content is already retained by this draft; no transfer is needed.
            status.errors.delete(errorKey); status.error = [...status.errors.values()].join(" "); continue;
          }
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          const response = await api.uploadAttachment({ filename: file.name, mediaType: file.type || "application/octet-stream", data: btoa(binary) });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || `Could not upload ${file.name}.`);
          if (!attachments.some((item) => item.id === result.attachment.id)) {
            if (attachments.length >= 10) throw new Error("Use at most 10 files per message.");
            attachments.push(result.attachment);
          }
          status.errors.delete(errorKey); status.error = [...status.errors.values()].join(" ");
          persist();
        } catch (error) { status.errors.set(errorKey, error.message); status.error = [...status.errors.values()].join(" "); }
      }
    }).finally(() => { status.busy = false; uploadOps.delete(operation); render(); });
    uploadOps.add(operation); render();
  }
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-attachment-input]")) {
      const files = [...event.target.files];
      event.target.value = ""; // The persistent input must allow selecting the same file again.
      uploadFiles(files, editorAttachments(event.target.closest("form")));
    }
  });
  let fileDropTarget = null;
  function clearFileDropTarget() { fileDropTarget?.classList.remove("is-file-drop-target"); fileDropTarget = null; }
  function messageDropTarget(target) {
    return target instanceof HTMLTextAreaElement && target.matches('textarea[name="nc-body"], textarea[name="reply-body"]') && target.closest("[data-note-form], [data-reply-form]") ? target : null;
  }
  document.addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    const target = messageDropTarget(event.target);
    event.dataTransfer.dropEffect = target ? "copy" : "none";
    if (target !== fileDropTarget) { clearFileDropTarget(); fileDropTarget = target; }
    target?.classList.add("is-file-drop-target");
  });
  document.addEventListener("dragleave", (event) => { if (event.target === fileDropTarget) clearFileDropTarget(); });
  document.addEventListener("dragend", clearFileDropTarget);
  window.addEventListener("blur", clearFileDropTarget);
  document.addEventListener("drop", (event) => {
    clearFileDropTarget();
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); // Rejected file drops must not navigate away from the review.
    const target = messageDropTarget(event.target);
    if (target) uploadFiles([...event.dataTransfer.files], editorAttachments(target.form));
  });
  document.addEventListener("paste", (event) => {
    const form = event.target.closest?.("[data-note-form], [data-reply-form]");
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (form && files.length) { event.preventDefault(); uploadFiles(files, editorAttachments(form)); }
  });
  function composerModel(ctx) {
    return { mode: !data.remote && ctx.mode === "feedback" ? "feedback" : "personal", remote: Boolean(data.remote), body: ctx.body || "",
      attachments: attachmentEditorModel(ctx.attachments ||= []), editing: ctx.editIndex != null, saveDisabled: uploadOps.size > 0 };
  }
  // The notes on a stage, step or evidence, while they are shown.
  function inlineThreadModel(id, kind, stageId) {
    const composingNew = compose && compose.kind === kind && compose.id === id &&
      (kind !== "node" || compose.stageId === stageId) &&
      matchesNodeContext(compose, elementNodeId(kind, id)) && compose.editIndex == null;
    if (!state.openThreads[threadStateKey(kind, id, stageId)] && !composingNew) return null;
    const listKey = threadListKey(kind, stageId || "", id);
    const latest = artifactThreadsForElement(kind, id, stageId);
    const threads = heldThreads(listKey, latest);
    const entries = threadListEntries(threads, localVisibleForElement(id, elementNodeId(kind, id), kind, stageId, { key: listKey, threads, latest }));
    if (!entries.length && !composingNew) return null;
    return { id, kind, stageId: stageId || "", listKey, entries, composer: composingNew ? composerModel(compose) : null };
  }

  /* ---- file rows -------------------------------------------------------- */
  function fileRowModel(stage, node, file) {
    const id = fileKey(stage.id, file.path);
    const approvalId = fileApprovalKey(stage.id, node.id, file.path);
    const cls = classificationFor(file, node.id);
    const { dir, name } = splitPath(file.path);
    const renamed = file.kind === "renamed" && file.previousPath;
    const entry = fileById.get(id);
    // Each open file's diff and notes follow its row in the step it was opened in.
    const open = activeFileNodeId(id) === node.id;
    const counts = fileNoteCounts(id, node.id);
    return {
      id, stageId: stage.id, nodeId: node.id, path: file.path, dir: dirShort(dir), name,
      kind: file.kind, kindLabel: kindLabel(file.kind), kindGlyph: kindGlyph(file.kind),
      previousPath: renamed ? file.previousPath : "", previousShort: renamed ? shortPath(file.previousPath) : "",
      classification: cls, classificationLabel: CLASS_LABEL[cls] || cls,
      sharedHint: (file.memberships || []).length > 1 ? ownershipHint(file, node.id) : "",
      additions: file.additions, deletions: file.deletions,
      approvalId, approval: approvalState(approvalId), approvalDisabled: approvalOps.has(approvalId) || !revisionFor(approvalId),
      occurrences: fileOccurrenceCounts.get(file.path) || 0,
      insights: fileCodeInsights(stage, file.path).length,
      notes: counts.file || counts.personal ? { threads: counts.file, personal: counts.personal, expanded: open && state.openThreads[id] !== false } : null,
      lineComments: counts.line,
      open: open && entry ? { diff: diffPanelModel(entry, node.id), notes: fileNotesModel(id) } : null,
    };
  }
  // File notes can be hidden independently of the open diff.
  function fileNotesModel(id) {
    const composingNew = compose && compose.id === id && matchesNodeContext(compose, elementNodeId("file", id)) && compose.editIndex == null;
    const listKey = threadListKey("file", elementNodeId("file", id), id);
    const latest = artifactThreadsForElement("file", id);
    const threads = state.openThreads[id] === false ? [] : heldThreads(listKey, latest);
    const entries = state.openThreads[id] === false ? [] : threadListEntries(threads, localVisibleForElement(id, undefined, null, undefined, { key: listKey, threads, latest }));
    return { id, kind: "file", stageId: null, listKey, entries, composer: composingNew ? composerModel(compose) : null };
  }
  // A group's unapproved or stale file approvals that can be captured now.
  function groupPendingApprovals(stage, node, files) {
    return files.map((f) => fileApprovalKey(stage.id, node.id, f.path))
      .filter((id) => !approved(id) && revisionFor(id) && !approvalOps.has(id));
  }
  function approveGroup(stageId, nodeId, group) {
    const stage = stageById.get(stageId), node = stage?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const files = nodeFileList(stage, node).filter((f) => (f.project || "Other") === group);
    return Promise.all(groupPendingApprovals(stage, node, files).map((id) => changeApproval(id, "file")));
  }
  function nodeFilesModel(stage, node) {
    const files = nodeFileList(stage, node);
    const fileApproved = (f) => approved(fileApprovalKey(stage.id, node.id, f.path));
    // Group by owning .NET project (convention-based) for a quick overview.
    const groups = new Map();
    files.forEach((f) => {
      const k = f.project || "Other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    });
    return {
      stageId: stage.id, nodeId: node.id, allApproved: files.every(fileApproved),
      groups: [...groups.entries()].map(([name, gfiles]) => ({
        name,
        approved: gfiles.filter(fileApproved).length,
        canApprove: !gfiles.some((f) => approvalOps.has(fileApprovalKey(stage.id, node.id, f.path))) && groupPendingApprovals(stage, node, gfiles).length > 0,
        files: gfiles.map((f) => fileRowModel(stage, node, f)),
      })),
    };
  }

  /* ---- diff panel ------------------------------------------------------- */
  function fileViewMode(id) { return state.fileView[id] === "full" ? "full" : "hunk"; }

  // A line's thread, shown as a full-width row directly beneath the line while
  // the line's gutter bubble is toggled open, so notes never crowd the code.
  function lineThreadContent(lineId) {
    const composingNew =
      compose && compose.kind === "line" && compose.id === lineId && matchesNodeContext(compose, elementNodeId("line", lineId)) && compose.editIndex == null;
    if (!state.openLineThreads[lineId] && !composingNew) return null;
    const key = lineListKey(lineId);
    const latest = artifactThreadsForElement("line", lineId);
    const arts = heldThreads(key, latest);
    const locals = localVisibleForElement(lineId, undefined, null, undefined, { key, threads: arts, latest });
    if (!arts.length && !locals.length && !composingNew) return null;
    return { arts, locals, composingNew };
  }
  function lineListKey(lineId) { return threadListKey("line", elementNodeId("line", lineId), lineId); }
  function lineThreadModel(lineId) {
    const content = lineThreadContent(lineId);
    return content && { id: lineId, kind: "line", stageId: null, listKey: lineListKey(lineId), entries: threadListEntries(content.arts, content.locals),
      composer: content.composingNew ? composerModel(compose) : null };
  }
  // The inline insight whose linked lines are highlighted in one open diff:
  // { fileId, nodeId, stageId, path, startLine, endLine }, or null. Rows
  // render the highlight from it; hovering and focusing an insight toggle the
  // same class on the affected rows directly (setInsightPreview), so a later
  // render produces the classes already shown.
  let insightPreview = null;
  // The inline insight button that set the preview, and the ones hovered,
  // focused or just dismissed.
  let insightPreviewSource = null;
  let hoveredCodeInsight = null, focusedCodeInsight = null, suppressedCodeInsight = null;
  let insightPreviewRows = [];
  // Set while the page renders: rows already carry the classes computed for
  // the preview, so a focus change during the render, such as a focused
  // insight button blurring as it is removed, leaves the repaint to
  // forgetRemovedInsights after the render.
  let renderingPage = false;
  // The rows a render highlights for `preview`. The insight's button sits in the
  // diff it previews; rows are the grid's children, so walking them skips the
  // code inside each row. The work follows the rendered rows, not the length
  // of the linked range.
  function previewedRows(preview, source) {
    if (!preview) return [];
    let grid = source?.isConnected ? source.closest(".diff-grid") : null;
    if (!grid) {
      const diff = fileRowElement(preview.fileId, preview.nodeId)?.nextElementSibling;
      grid = diff?.classList.contains("cinema-diff") ? diff.querySelector(".diff-grid") : null;
    }
    if (!grid) return [];
    const prefix = lineKey(preview.stageId, "new", "", "").slice(0, -1), suffix = `:${preview.path}`;
    const rows = [];
    for (const row of grid.children) {
      const id = row.dataset.lineId;
      if (!id || !row.classList.contains("drow") || !id.startsWith(prefix) || !id.endsWith(suffix)) continue;
      const digits = id.slice(prefix.length, id.length - suffix.length);
      if (!/^\d+$/.test(digits)) continue;
      const line = Number(digits);
      if (line >= preview.startLine && line <= preview.endLine) rows.push(row);
    }
    return rows;
  }
  // `force` repaints even when the preview is unchanged, after a render that
  // may have replaced or repainted rows from an earlier preview.
  function setInsightPreview(next, source, force = false) {
    const previousSource = insightPreviewSource;
    insightPreviewSource = next ? source : null;
    if (!force && JSON.stringify(next) === JSON.stringify(insightPreview)) return;
    const previous = new Set([...insightPreviewRows, ...previewedRows(insightPreview, previousSource)]);
    insightPreview = next;
    insightPreviewRows = previewedRows(next, source);
    const current = new Set(insightPreviewRows);
    for (const row of previous) if (!current.has(row)) row.classList.remove("is-code-insight-target");
    for (const row of insightPreviewRows) row.classList.add("is-code-insight-target");
  }
  // After each render, an insight removed by it, such as when its diff closes,
  // neither hovers nor keeps its lines highlighted; one that remains is looked
  // up again, so a refreshed range or a removed insight replaces the old one.
  // When the insight that set the highlight is removed, a remaining hovered or
  // focused one takes over.
  function forgetRemovedInsights() {
    if (hoveredCodeInsight && !hoveredCodeInsight.isConnected) hoveredCodeInsight = null;
    if (focusedCodeInsight && !focusedCodeInsight.isConnected) focusedCodeInsight = null;
    if (suppressedCodeInsight && !suppressedCodeInsight.isConnected) suppressedCodeInsight = null;
    if (!insightPreview && !insightPreviewRows.length) return;
    const source = insightPreviewSource?.isConnected ? insightPreviewSource : hoveredCodeInsight || focusedCodeInsight;
    setInsightPreview(source ? codeInsightPreview(source) : null, source, true);
  }
  function insightTargetsLine(ctx, side, lineNo) {
    const preview = insightPreview;
    return Boolean(preview && side === "new" && preview.fileId === ctx.fileId && preview.nodeId === ctx.diffNodeId &&
      preview.stageId === ctx.stageId && preview.path === ctx.path && lineNo >= preview.startLine && lineNo <= preview.endLine);
  }
  // Adds a code row and, when the file is diff-anchored (ctx present) and the
  // row maps to a real line, the ownership notice and inline insights above it
  // and its thread below it. The sign column doubles as the line's note
  // affordance: a "+" on hover, or a bubble that toggles the line's thread.
  function pushCodeRow(out, row, ctx, side, lineNo) {
    if (!ctx || !ctx.stageId || !lineNo) { out.push({ type: "code", key: `${row.kind}:${row.old}:${row.new}`, ...row, line: null }); return; }
    const lineId = lineKey(ctx.stageId, side, lineNo, ctx.path);
    // Most lines have no notes; only look up the ones that might.
    const noted = ctx.notedLines.has(lineId);
    const count = noted ? visibleThreadCount("line", lineId) : 0;
    const resolved = noted && !count && artifactThreadsForElement("line", lineId).some((t) => t.status === "resolved");
    // For a file split across steps, dim the lines owned by other steps so the
    // step currently in focus reads as this node's slice of the shared diff.
    let ownership = "";
    if (ctx.ownership && (side === "old" || side === "new")) {
      const owner = ctx.ownership.get(`${side}:${lineNo}`);
      if (owner) {
        ownership = ctx.focusNodeId ? owner === ctx.focusNodeId ? "own-focus" : "own-other" : "own-mark";
        if (ctx.focusNodeId && owner !== ctx.focusNodeId && ctx.previousOwner !== owner)
          out.push({ type: "owner", key: `owner:${lineId}`, lineId, nodeId: owner, title: nodeTitleById.get(`${ctx.stageId}:${owner}`) || owner });
        ctx.previousOwner = owner;
      } else ctx.previousOwner = null;
    }
    const linked = side === "new" ? ctx.insightsByLine.get(lineNo) : null;
    if (linked) out.push({ type: "insights", key: `insights:${lineId}`, insights: linked });
    out.push({ type: "code", key: lineId, ...row, line: { id: lineId, count, resolved, open: Boolean(state.openLineThreads[lineId]),
      ownership, insightTarget: insightTargetsLine(ctx, side, lineNo) } });
    // A selection holds the list it touches, so a thread a live update removed
    // stays until the selection clears.
    const thread = noted || compose?.id === lineId || (selectedThreadLists.size && selectedThreadLists.has(lineListKey(lineId))) ? lineThreadModel(lineId) : null;
    if (thread) out.push({ type: "thread", key: `thread:${lineId}`, thread });
  }
  // What a diff's rows look up per line, gathered once per diff: the lines that
  // threads or local notes may be attached to, and the current inline insights
  // by the new line they start on.
  function diffContext(entry, nodeId, extra = {}) {
    const notedLines = new Set(state.comments.filter((c) => c.kind === "line").map((c) => c.id));
    for (const t of artifactThreads) if (t.target?.kind === "line") notedLines.add(lineKey(t.target.stageId, t.target.side, t.target.line, t.target.path));
    const insightsByLine = new Map();
    for (const ins of entry.stage.insights) {
      if (ins.codeTarget?.status === "needs-review" || ins.codeTarget?.path !== entry.file.path) continue;
      const start = ins.codeTarget.startLine;
      insightsByLine.set(start, [...(insightsByLine.get(start) || []), inlineInsightModel(entry.stage, ins)]);
    }
    return { stageId: entry.stage.id, path: entry.file.path, fileId: entry.id, diffNodeId: nodeId, notedLines, insightsByLine, ...extra };
  }
  function pushDiffRow(out, r, lang, ctx) {
    if (ctx && ctx.previousHunk !== r.h) { ctx.previousOwner = null; ctx.previousHunk = r.h; }
    const side = r.t === "del" ? "old" : "new";
    pushCodeRow(out, { kind: r.t, old: String(r.o || ""), new: String(r.n || ""), sign: r.t === "add" ? "+" : r.t === "del" ? "−" : "",
      code: highlightCode(r.s || " ", lang) }, ctx, side, r.t === "del" ? r.o : r.n);
  }
  // Added and deleted files show their full contents once, as neutral lines.
  function pushWholeFileRow(out, r, lang, ctx, side) {
    pushCodeRow(out, { kind: "newline", old: "", new: String(r.n || r.o || ""), sign: "", code: highlightCode(r.s || " ", lang) },
      ctx, side, side === "old" ? r.o || r.n : r.n || r.o);
  }
  const gapRow = (count, key) => ({ type: "gap", key: `gap:${key}`, count });
  const diffMessage = (text, status = false) => ({ type: "message", text, status });
  // Rows are keyed so an unchanged row keeps its element; keys stay unique even
  // when a page repeats a line.
  function uniqueRowKeys(rows) {
    const seen = new Set();
    for (const row of rows) {
      let key = row.key;
      for (let n = 2; seen.has(key); n++) key = `${row.key}#${n}`;
      row.key = key; seen.add(key);
    }
    return rows;
  }
  function diffContentModel(file, mode, hideDel, ctx) {
    if (file._diffError) return diffMessage(`Could not load diff: ${file._diffError}`);
    if (!Array.isArray(file.lines)) return diffMessage("Loading diff…");
    if (file.binary) return diffMessage("Binary file — not shown.");
    const lines = file.lines;
    if (!lines.length) return diffMessage("No line changes recorded for this file.");
    const lang = langFor(file.path);
    const out = [];
    if (file.kind === "added") {
      out.push({ type: "banner", key: "banner", kind: "newfile", sign: "＋", text: "New file — full contents" });
      lines.forEach((r) => pushWholeFileRow(out, r, lang, ctx, "new"));
    } else if (file.kind === "deleted") {
      out.push({ type: "banner", key: "banner", kind: "oldfile", sign: "－", text: "Deleted file — previous contents" });
      lines.forEach((r) => pushWholeFileRow(out, r, lang, ctx, "old"));
    } else {
      const CTX = 3;
      const n = lines.length;
      const keep = new Array(n).fill(mode === "full");
      for (let i = 0; i < n; i++) {
        if (lines[i].t !== "ctx") {
          for (let j = Math.max(0, i - CTX); j <= Math.min(n - 1, i + CTX); j++) keep[j] = true;
        }
      }
      let oldNo = null, newNo = null, omitted = 0;
      for (let i = 0; i < n; i++) {
        const row = lines[i];
        // Git omits context between hunks. Track each side independently so
        // additions/deletions do not look like gaps when the other side resumes.
        const oldGap = oldNo != null && row.o != null ? row.o - oldNo - 1 : 0;
        const newGap = newNo != null && row.n != null ? row.n - newNo - 1 : 0;
        const gap = Math.max(0, oldGap, newGap);
        omitted += gap;
        if (oldNo != null) oldNo += gap;
        if (newNo != null) newNo += gap;
        if (row.o != null) oldNo = row.o;
        if (row.n != null) newNo = row.n;
        if (!keep[i]) { omitted++; continue; }
        if (omitted) { out.push(gapRow(omitted, i)); omitted = 0; }
        pushDiffRow(out, row, lang, ctx);
      }
      if (omitted) out.push(gapRow(omitted, "end"));
    }
    const offset = file._pageOffset || 0;
    const pager = file.nextOffset != null || offset > 0 ? { action: "diff-page", id: fileKey(ctx.stageId, file.path), offset, rows: lines.length,
      previousOffset: offset > 0 ? Math.max(0, offset - 900) : null, nextOffset: file.nextOffset ?? null } : null;
    return { type: "grid", grid: { hideRemoved: hideDel, rows: uniqueRowKeys(out), pager } };
  }
  // Diff view controls: mode toggle + hide-removed. Added/deleted files render
  // their full contents once, so neither control applies to them.
  function sinceApprovalEnabled(id) { return approvalState(id) === "stale" && state.approvalComparisons[id] !== false; }
  function isMarkdown(entry) { return /\.(md|markdown)$/i.test(entry.file.path); }
  function markdownMode(entry) { return isMarkdown(entry) && Boolean(state.markdownPreview[entry.id]); }
  function markdownUrl(entry, target, image = false) {
    const query = { stage: entry.stage.id, path: entry.file.path, base: fileBaseRevision(entry), head: entry.stage.headRevision };
    if (target == null) return api.fileContentJsonUrl(query);
    const filePath = entry.file.kind === "deleted" ? entry.file.previousPath || entry.file.path : entry.file.path;
    try {
      const root = new URL("https://repository.invalid/");
      const resolved = new URL(target, new URL(filePath.split("/").map(encodeURIComponent).join("/"), root));
      if (resolved.origin !== root.origin) return null;
      return api.fileContentUrl({ ...query, target: decodeURIComponent(resolved.pathname.slice(1)), raw: "1", ...(image ? { image: "1" } : {}) }, resolved.hash);
    } catch { return null; }
  }
  function markdownPreviewModel(entry) {
    const key = markdownUrl(entry);
    let preview = markdownPreviews.get(key);
    if (!preview) {
      preview = { loading: true, entryId: entry.id };
      markdownPreviews.set(key, preview);
      // Open previews must survive cache pressure, including collapsed nodes.
      for (const [cachedKey, cached] of markdownPreviews) {
        if (markdownPreviews.size <= 12) break;
        if (cachedKey !== key && !(cached.entryId in state.activeFiles && state.markdownPreview[cached.entryId])) markdownPreviews.delete(cachedKey);
      }
      api.getFileContent(key).then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Could not load Markdown.");
        if (!window.renderMarkdownPreview) throw new Error("Markdown renderer unavailable; reload the viewer.");
        // Sanitized by the Markdown module (DOMPurify, validated link and image URLs).
        preview.html = window.renderMarkdownPreview(result.content, (target, image) => markdownUrl(entry, target, image));
        preview.label = `Complete file · ${result.side === "base" ? "Base revision (deleted file)" : "Head revision"} ${result.revision.slice(0, 12)}`;
      }).catch((error) => { preview.error = error.message; }).finally(() => { preview.loading = false; render(); });
    }
    if (preview.loading) return { type: "loading" };
    if (preview.error) return { type: "error", message: preview.error };
    return { type: "ready", label: preview.label, html: preview.html };
  }
  function diffControlsModel(entry) {
    const k = entry.file.kind, id = fileApprovalKey(entry.stage.id, activeFileNodeId(entry.id), entry.file.path);
    const stale = approvalState(id) === "stale", since = sinceApprovalEnabled(id);
    return {
      fileId: entry.id, wrap: Boolean(state.wrapLines),
      view: since || !["added", "deleted"].includes(k) ? { full: fileViewMode(entry.id) === "full", hideRemoved: Boolean(state.hideDeleted[entry.id]) } : null,
      comparison: stale ? { approvalId: id, on: since } : null,
      markdown: isMarkdown(entry) ? { preview: markdownMode(entry) } : null,
    };
  }
  function retainedApproval(id) {
    return approvalRecord(id) || approvalRecord(previousApprovalId(id) || "") || approvalRecord(remotePreviousApprovalId(id) || "");
  }
  function comparisonKey(id, entry) {
    return JSON.stringify([id, retainedApproval(id)?.snapshotId, fileBaseRevision(entry), entry.stage.headRevision, revisionFor(id), fileViewMode(entry.id), approvalBaseIncluded.has(id)]);
  }
  function scrollDiffPage(id, navigation) {
    // A response may arrive after this shared file was opened in another node.
    if (activeFileNodeId(id) !== navigation.nodeId) return;
    const scroller = cinemaHolder(id, navigation.nodeId)?.querySelector(".diff-scroll");
    if (scroller) scroller.scrollTop = navigation.direction === "backward" ? scroller.scrollHeight : 0;
  }
  async function loadApprovalComparison(id, entry, offset = 0, pageScroll = null) {
    const approval = retainedApproval(id);
    if (!approval?.snapshotId) return;
    const key = comparisonKey(id, entry), mode = fileViewMode(entry.id) === "full" ? "full" : "changes";
    if (approvalComparisons.get(key)?.loading) return;
    approvalComparisons.set(key, { loading: true, offset }); render();
    let pageLoaded = false;
    try {
      await flushReviewState();
      const response = await api.compareApproval({ ...approvalEndpoint(entry), snapshotId: approval.snapshotId, offset, mode, scope: approvalBaseIncluded.has(id) ? "all" : "stage" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not compare approved content.");
      approvalComparisons.set(key, result);
      pageLoaded = true;
    } catch (error) { approvalComparisons.set(key, { error: error.message, offset }); }
    while (approvalComparisons.size > 32) approvalComparisons.delete(approvalComparisons.keys().next().value);
    render();
    if (pageLoaded && pageScroll && comparisonKey(id, entry) === key && sinceApprovalEnabled(id))
      scrollDiffPage(entry.id, pageScroll);
  }
  function approvalComparisonModel(id, entry) {
    const approval = retainedApproval(id);
    const plain = (text) => ({ comparison: null, content: diffMessage(text) });
    if (!approval?.snapshotId) return plain("Approved content is unavailable. Re-approve the current file to retain a snapshot.");
    const key = comparisonKey(id, entry), comparison = approvalComparisons.get(key);
    if (!comparison) { queueMicrotask(() => { if (sinceApprovalEnabled(id)) void loadApprovalComparison(id, entry); }); return plain("Loading approved comparison…"); }
    if (comparison.loading) return plain("Loading approved comparison…");
    if (comparison.error) return plain(comparison.error);
    const info = { approvalId: id, ownershipChanged: Boolean(comparison.ownershipChanged),
      baseChanges: !comparison.baseChanged ? null : comparison.baseChanges === "excluded" || comparison.baseChanges === "included" ? comparison.baseChanges : "mixed" };
    if (comparison.unsupported) return { comparison: info, content: { type: "unsupported", text: comparison.unsupported,
      approvedSha: comparison.approved.sha256 || "Not retained", currentSha: comparison.current.sha256 || "Not retained" } };
    if (!comparison.lines.length) return { comparison: info, content: diffMessage(comparison.baseChanges === "excluded"
      ? "This stage made no changes to the file since approval. Only its base changed." : "No file content changes since approval.") };
    // Only current lines have a feedback anchor. A removed row's number belongs to
    // the approved snapshot, not to the stage's old side, so it gets no affordance.
    const ctx = diffContext(entry, entry.nodeId);
    const lang = langFor(entry.file.path);
    const rows = []; let previousNew = 0;
    comparison.lines.forEach((row, index) => {
      if (previousNew && row.n > previousNew + 1) rows.push(gapRow(row.n - previousNew - 1, index));
      pushDiffRow(rows, row, lang, row.t === "del" ? null : ctx);
      if (row.n) previousNew = row.n;
    });
    const offset = comparison.offset || 0;
    const pager = offset || comparison.nextOffset != null ? { action: "approval-page", id, offset, rows: comparison.lines.length,
      previousOffset: offset ? Math.max(0, offset - 900) : null, nextOffset: comparison.nextOffset ?? null } : null;
    return { comparison: info, content: { type: "grid", grid: { hideRemoved: Boolean(state.hideDeleted[entry.id]), rows: uniqueRowKeys(rows), pager } } };
  }
  // The diff of a file opened in the step `nodeId`.
  function diffPanelModel(entry, nodeId) {
    const ctx = diffContext(entry, nodeId, { ownership: membershipOwnership(entry.file), focusNodeId: nodeId });
    const approvalId = fileApprovalKey(entry.stage.id, nodeId, entry.file.path);
    const sinceApproval = sinceApprovalEnabled(approvalId);
    const preview = markdownMode(entry);
    return {
      path: entry.file.path, kind: entry.file.kind, wrap: Boolean(state.wrapLines), sinceApproval,
      controls: diffControlsModel(entry),
      // The source rows stay rendered under a Markdown preview, so line drafts survive switching.
      body: sinceApproval ? approvalComparisonModel(approvalId, approvalEntry(approvalId))
        : { comparison: null, content: diffContentModel(entry.file, fileViewMode(entry.id), Boolean(state.hideDeleted[entry.id]), ctx) },
      preview: preview ? markdownPreviewModel(entry) : null,
    };
  }

  /* ---- chrome ----------------------------------------------------------- */
  function topbarModel() {
    const presence = !agent ? null : agent.stopRequested ? "stopping" : agent.working ? "working" : agent.listening ? "listening" : "offline";
    return {
      remote: Boolean(data.remote), subject: data.remote?.branch || data.implementationId,
      agent: data.remote || !presence ? null : { presence, canStop: Boolean(agent.session && !agent.stopRequested), command: AGENT_COMMAND, commandCopied: agentCommandCopied },
      refreshingRemote, reviewsOpen: Boolean(reviewsOpen), coverageOpen: Boolean(state.coverageOpen), notesOpen: Boolean(state.notesOpen),
      approved: approvedCount(), reviewable: reviewable(), percent: pct(), activeNotes: activeNoteCount(),
    };
  }
  function agentBarModel() {
    if (data.remote || !agent) return null;
    const queued = artifactThreads.filter((thread) => awaitsAgent(thread) && !agentWorkingOn(thread.id)).length;
    const status = agent.working
      ? { kind: "working", total: agent.working.threads.length, answered: agent.working.threads.filter((thread) => thread.answered).length,
        note: agent.working.note || "", minutes: agentMinutes(agent) || 0, queued, stopRequested: Boolean(agent.stopRequested) }
      : queued && !agent.listening ? { kind: "waiting", queued, command: AGENT_COMMAND, commandCopied: agentCommandCopied } : null;
    const refresh = agent.targetRefresh;
    return {
      status,
      targetRefresh: refresh && state.dismissedTargetRefresh !== refresh.at ? refresh : null,
      questions: agent.requests.map((request) => {
        const op = agentAnswerOps.get(request.id) || {};
        return { id: request.id, body: request.body, choices: request.choices, answer: agentAnswers.get(request.id) || "", busy: Boolean(op.busy), error: op.error || "" };
      }),
      questionsMinimized: agent.requests.every((request) => minimizedAgentQuestions.has(request.id)),
    };
  }

  function markReviewDeleted(external = false) {
    document.querySelector(".file-search[open]")?.close();
    reviewDeleted = true; deletedElsewhere = external; reviewsOpen = true;
    clearTimeout(saveTimer); saveError = ""; showSaveStatus(); render(); void refreshReviews();
  }
  // Unsent text the reviewer can copy after another tab deleted this review.
  function deletedReviewText() {
    return deletedElsewhere ? [...new Set([compose?.body, replyTo ? replyDraft : "", ...state.comments.filter((note) => !note.exported).map((note) => note.body), ...pendingReplies().map((reply) => reply.body)].filter(Boolean))].join("\n\n") : "";
  }
  const storageSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
  async function manageReviewData(id) {
    const review = reviewList.find((item) => item.id === id);
    if (!review || reviewListBusy || document.querySelector(".review-cleanup")) return;
    const target = { reviewId: review.id, generation: review.generation };
    const dialog = document.createElement("dialog"); dialog.className = "review-cleanup"; dialog.setAttribute("aria-labelledby", "cleanup-title");
    let storage = null, busy = false, error = "", message = "";
    function paint() {
      renderLit(reviewCleanupView({
        title: review.title, location: review.repositoryRoot, id: review.id,
        status: storage?.deletionPending || review.deletionPending ? "Deletion pending" : review.completedAt ? "Completed" : "Active",
        storage: storage && {
          directory: storage.storageDirectory, size: storageSize(storage.bytes),
          categories: storage.categories.map((item) => ({ label: item.label, size: storageSize(item.bytes), detail: item.detail })),
          drafts: storage.drafts, unresolved: storage.unresolved, deletionPending: Boolean(storage.deletionPending),
          unusedSize: storageSize(storage.unusedBytes), unusedCount: storage.unused.length, referenceError: storage.referenceError || "",
        },
        busy, message, error,
      }), dialog);
    }
    async function details() {
      const response = await api.inspectReviewStorage(target);
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || "Could not inspect review storage.");
      storage = result.storage;
      if (storage.error) error = storage.error;
    }
    dialog.addEventListener("close", () => dialog.remove());
    dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
    dialog.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-cleanup]")?.dataset.cleanup;
      if (!action || busy) return;
      if (action === "cancel") { dialog.close(); return; }
      busy = true; error = ""; message = ""; paint();
      try {
        if (action === "refresh") await details();
        else {
          const response = await (action === "delete" ? api.deleteReviewData : api.cleanUnusedReviewData)({ ...target, fingerprint: storage.fingerprint });
          const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || "Could not clean review data.");
          if (result.deleted && id === savedReview.reviewId && target.generation === savedReview.generation && !reviewDeleted) markReviewDeleted();
          if (result.deleted && !result.cleanupPending) { dialog.close(); await refreshReviews(true); return; }
          if (result.cleanupPending) error = result.error;
          else { message = `Reclaimed ${storageSize(result.reclaimedBytes)}.`; error = (result.failures || []).join(" "); }
          await details(); await refreshReviews(true);
        }
      } catch (failure) { error = failure.message; }
      finally { busy = false; if (dialog.isConnected) paint(); }
    });
    document.body.append(dialog); busy = true; paint(); dialog.showModal();
    try { if (id === savedReview.reviewId) await flushReviewState(); await details(); }
    catch (failure) { error = failure.message; }
    finally { busy = false; paint(); }
  }
  const isCurrentReview = (review) => !reviewDeleted && review.id === savedReview.reviewId && review.generation === savedReview.generation;
  function reviewsPanelModel() {
    return {
      deleted: reviewDeleted ? { text: deletedReviewText() } : null,
      busy: reviewListBusy, error: reviewListError,
      reviews: reviewList.map((review) => ({
        id: review.id, title: review.title, remote: Boolean(review.remote), current: isCurrentReview(review),
        status: review.deletionPending ? "Deletion pending" : review.completedAt ? "Completed" : "Active",
        subject: review.remote ? `${review.remote.remoteName}/${review.remote.branch}` : review.implementationId,
        location: review.remote?.sourceRoot || review.repositoryRoot,
        updatedAt: review.updatedAt, updatedText: new Date(review.updatedAt).toLocaleString(),
        unavailable: review.available ? null : String(review.unavailableReason ?? ""),
        canOpen: Boolean(review.available) && !isCurrentReview(review),
        completed: Boolean(review.completedAt), deletionPending: Boolean(review.deletionPending),
      })),
    };
  }
  let reviewsDialog = null, reviewsCloseTimer;
  function setReviewsOpen(open) {
    if (!open && reviewDeleted) return;
    clearTimeout(reviewsCloseTimer);
    reviewsOpen = open;
    document.querySelector('.topbar [data-action="toggle-reviews"]')?.setAttribute("aria-expanded", String(open));
    forceHidePop();
    if (open) {
      clearTimeout(reviewsCloseTimer);
      if (!reviewsDialog) {
        reviewsDialog = document.createElement("dialog");
        reviewsDialog.id = "review-list"; reviewsDialog.className = "review-list";
        reviewsDialog.setAttribute("aria-label", "Saved reviews");
        reviewsDialog.addEventListener("cancel", (event) => { event.preventDefault(); setReviewsOpen(false); });
        reviewsDialog.addEventListener("click", (event) => {
          if (event.target !== reviewsDialog) return;
          const box = reviewsDialog.getBoundingClientRect();
          if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setReviewsOpen(false);
        });
        document.body.append(reviewsDialog); updateReviewList();
      }
      reviewsDialog.classList.remove("is-closing");
      if (!reviewsDialog.open) reviewsDialog.showModal();
    } else if (reviewsDialog) {
      reviewsDialog.classList.add("is-closing");
      reviewsCloseTimer = setTimeout(() => {
        reviewsDialog.close(); reviewsDialog.remove(); reviewsDialog = null;
        if (!reviewDeleted) document.querySelector('.topbar [data-action="toggle-reviews"]')?.focus({ preventScroll: true });
      }, reduced() ? 0 : 180);
    }
  }
  function updateReviewList() {
    if (!reviewsDialog) return;
    const active = reviewsDialog.contains(document.activeElement) ? document.activeElement : null;
    const action = active?.dataset.action, reviewId = active?.dataset.reviewId;
    const top = reviewsDialog.scrollTop;
    renderLit(reviewsPanelView(reviewsPanelModel()), reviewsDialog);
    reviewsDialog.scrollTop = top;
    // Rendering keeps the focused button unless it became disabled.
    if (action && document.activeElement !== active) reviewsDialog.querySelector(`[data-action="${cssEsc(action)}"]${reviewId ? `[data-review-id="${cssEsc(reviewId)}"]` : ""}`)?.focus({ preventScroll: true });
    if (reviewsDialog.open && !document.querySelector(".review-cleanup[open]") && !reviewsDialog.contains(document.activeElement)) {
      reviewsDialog.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    }
  }
  async function refreshReviews(force = false) {
    if (reviewListBusy && !force) return;
    reviewListBusy = true; reviewListError = ""; updateReviewList();
    try {
      const response = await api.getReviews();
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.reviews)) throw new Error(result.error || "Could not load saved reviews.");
      reviewList = result.reviews;
    } catch (error) { reviewListError = error.message; }
    finally { reviewListBusy = false; updateReviewList(); }
  }
  async function changeReview(id, complete = false) {
    if (reviewListBusy) return;
    const review = reviewList.find((item) => item.id === id);
    if (!review) return;
    // Capture the selected target before any await; another selection cannot redirect it.
    const target = { reviewId: review.id, generation: review.generation, completed: !review.completedAt, expectedCompletedAt: review.completedAt };
    reviewListBusy = true; reviewListError = ""; updateReviewList();
    try {
      await flushReviewState();
      const response = await (complete ? api.setReviewCompletion : api.openReview)(target);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not open the selected review.");
      if (complete) await refreshReviews(true);
      else {
        // Save edits made while the service was starting. A full navigation also
        // discards old responses, listeners, and caches instead of retargeting them.
        await flushReviewState();
        window.location.assign(result.url);
      }
    } catch (error) { reviewListError = error.message; }
    finally { reviewListBusy = false; updateReviewList(); }
  }

  const SOURCE_LABEL = {
    "azure-devops": "Azure DevOps", github: "GitHub", url: "Link", local: "Local",
  };
  // Only http(s) links are made clickable; anything else is shown as plain text
  // so a spec source can never smuggle a javascript: or data: URL into an href.
  function safeHref(url) {
    if (typeof url !== "string") return "";
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch { return ""; }
  }
  function sourceModel(source) {
    if (!source || !source.kind) return null;
    const label = SOURCE_LABEL[source.kind] || source.kind;
    return { label, text: source.reference || label, href: safeHref(source.url) };
  }
  function specificationModel(req) {
    return {
      id: req.id, title: req.title, summary: req.summary,
      open: specificationIsOpen(req.id),
      source: sourceModel(req.source),
      criteria: req.acceptance.map((a) => {
        const ref = `${req.id}#${a.id}`, st = acceptanceStatus(ref);
        return { id: a.id, ref, text: a.text, status: st.key,
          stages: st.stages.length ? `Stage ${st.stages.map((n) => String(n).padStart(2, "0")).join(" · ")}` : "no stage" };
      }),
    };
  }

  function nodeModel(stage, node, nodeIndex, stageIndex) {
    const linked = stage.insights.filter((i) => (i.nodeRefs || []).includes(node.id));
    const list = insightSort(linked);
    return {
      id: node.id, stageId: stage.id, index: `${stageIndex + 1}.${nodeIndex + 1}`,
      title: node.title, description: node.description,
      approval: nodeApprovalState(stage, node),
      legend: reasoningLegendModel(linked),
      insights: list.map((ins) => insightTagModel(stage, ins, node)),
      insightThreads: list.filter((ins) => hostsEvidenceThread(ins, node)).map((ins) => inlineThreadModel(insightKey(stage.id, ins.collection, ins.id), "insight")).filter(Boolean),
      files: nodeFilesModel(stage, node),
      notes: notesToggleModel("node", node.id, stage.id),
      thread: inlineThreadModel(node.id, "node", stage.id),
    };
  }

  function stageModel(stage, i) {
    const fileApprovals = stageFileApprovals(stage);
    const deps = (stage.dependsOn || []).map((depId) => {
      const s = stageById.get(depId);
      return { id: depId, number: stageNumberById.get(depId), title: s ? s.title : depId };
    });
    return {
      id: stage.id, number: String(i + 1).padStart(2, "0"), title: stage.title, summary: stage.summary, rationale: stage.rationale,
      open: Boolean(state.openStages[stage.id]), approved: stageApproved(stage),
      nodesApproved: stage.nodes.filter((n) => nodeApprovalState(stage, n) === "approved").length, nodeCount: stage.nodes.length,
      filesApproved: fileApprovals.filter(approved).length, fileCount: fileApprovals.length,
      insightsReviewed: stage.insights.filter((ins) => insightReviewState(stage, ins) === "reviewed").length, insightCount: stage.insights.length,
      dependencies: deps.map((d) => ({ text: d.number ? String(d.number).padStart(2, "0") : d.id, title: d.title })),
      dependencySummary: deps.map((d) => d.number ? `Stage ${String(d.number).padStart(2, "0")}: ${d.title}` : d.title).join(", "),
      acceptance: stageAcceptanceRefs(stage).map(acceptanceChipModel),
      notes: notesToggleModel("stage", stage.id),
      approve: stageApproveModel(stage),
      thread: inlineThreadModel(stage.id, "stage"),
      nodes: stage.nodes.map((n, ni) => nodeModel(stage, n, ni, i)),
    };
  }

  function storyModel() {
    return {
      hero: {
        title: data.title, summary: data.summary, stages: data.stages.length,
        steps: data.stages.reduce((a, s) => a + s.nodes.length, 0),
        files: data.stages.reduce((a, s) => a + s.files.length, 0),
        viewerVersion: data.viewerReleaseVersion || "Unknown", targetBranch: data.targetBranch, baseRevision: data.baseRevision.slice(0, 7),
      },
      specifications: requirements.map(specificationModel),
      stages: data.stages.map(stageModel),
      approved: approvedCount(), reviewable: reviewable(),
    };
  }

  /* ---- side panels ------------------------------------------------------ */
  function coverageModel() {
    return {
      open: Boolean(state.coverageOpen), approved: approvedCount(), reviewable: reviewable(), percent: pct(),
      stages: data.stages.map((s, i) => {
        const fileApprovals = stageFileApprovals(s);
        return { id: s.id, number: String(i + 1).padStart(2, "0"), title: s.title, approved: stageApproved(s),
          nodesApproved: s.nodes.filter((n) => nodeApprovalState(s, n) === "approved").length, nodes: s.nodes.length,
          filesApproved: fileApprovals.filter(approved).length, files: fileApprovals.length };
      }),
    };
  }
  function localNoteRef(c) {
    if (c.kind === "stage") return stageById.has(c.id) ? c : null;
    if (c.kind === "node") return stageById.get(c.stageId)?.nodes.some((n) => n.id === c.id) ? c : null;
    if (c.kind === "insight") return insightByKey(c.id) ? c : null;
    const entry = noteFileEntry(c.kind, c.id);
    const nodeId = noteNodeId(c);
    if (!entry || !nodeId) return null;
    const snapshot = draftSnapshots.get(c);
    const stale = snapshot && (snapshot.fileRevision ? snapshot.fileRevision !== entry.file.revision
      : snapshot.base !== fileBaseRevision(entry) || snapshot.head !== entry.stage.headRevision);
    return c.kind === "line" && !stale && !renamedLineNote(c) ? { ...c, nodeId } : { kind: "file", id: entry.id, nodeId };
  }
  function noteGroupKey(c) {
    const entry = noteFileEntry(c.kind, c.id);
    const stage = c.kind === "stage" ? stageById.get(c.id) : entry?.stage || stageById.get(c.kind === "insight" ? parseInsightKey(c.id)?.stageId : c.stageId);
    const si = stage ? data.stages.indexOf(stage) : 900;
    const nodeId = c.kind === "node" ? c.id : c.kind === "insight" ? insightByKey(c.id)?.nodeRefs?.[0] : noteNodeId(c);
    const ni = nodeId ? stage?.nodes.findIndex((n) => n.id === nodeId) ?? -1 : -1;
    // The stage's ID keys its group, so a reordered stage keeps its notes' elements.
    return { si, stageKey: stage ? `stage:${stage.id}` : "other", stageTitle: stage?.title || "Other targets", ni,
      nodeKey: `${stage?.id || ""}::${nodeId || c.kind === "stage" && "overview" || "unknown"}`,
      nodeTitle: ni >= 0 ? stage.nodes[ni].title : c.kind === "stage" ? "Stage overview" : "Other targets / original step unknown" };
  }
  function noteDayKey(c) {
    if (!c.createdAt) return { key: "0000-00-00", label: "Undated" };
    const d = new Date(c.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return { key, label };
  }
  function groupedNotes(entries) {
    const stageMap = new Map();
    entries.forEach(({ c, i, thread }) => {
      const g = noteGroupKey(c);
      const d = noteDayKey(c);
      if (!stageMap.has(g.si)) stageMap.set(g.si, { si: g.si, key: g.stageKey, title: g.stageTitle, nodes: new Map() });
      const st = stageMap.get(g.si);
      if (!st.nodes.has(g.nodeKey)) st.nodes.set(g.nodeKey, { key: g.nodeKey, ni: g.ni, title: g.nodeTitle, days: new Map() });
      const nd = st.nodes.get(g.nodeKey);
      if (!nd.days.has(d.key)) nd.days.set(d.key, { key: d.key, label: d.label, items: [] });
      nd.days.get(d.key).items.push({ c, i, thread });
    });
    const stages = [...stageMap.values()].sort((a, b) => a.si - b.si);
    for (const st of stages) {
      st.nodesArr = [...st.nodes.values()].sort((a, b) => a.ni - b.ni);
      for (const nd of st.nodesArr) {
        nd.daysArr = [...nd.days.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }
    }
    return stages;
  }
  function pendingFeedback() {
    return state.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.mode === "feedback" && !c.exported);
  }
  // Reviewer replies are held as revisable local drafts (like unsent feedback
  // notes) and only sent to the artifact when the reviewer prepares feedback.
  function pendingReplies() {
    return Array.isArray(state.replyDrafts) ? state.replyDrafts : [];
  }
  function repliesForThread(threadId) {
    return pendingReplies().filter((r) => r.threadId === threadId);
  }
  function pendingFeedbackCount() {
    return pendingFeedback().length + pendingReplies().length;
  }
  function noteGroupsModel(entries) {
    return groupedNotes(entries).map((st) => ({ key: st.key, title: st.title,
      nodes: st.nodesArr.map((nd) => ({ key: nd.key, title: nd.title,
        days: nd.daysArr.map((day) => ({ key: day.key, label: day.label,
          entries: uniqueKeys(day.items.map((item) => item.thread ? threadEntry(item.thread, true) : localNoteEntry(item, true))) })) })) }));
  }
  function notesPanelModel() {
    // Each column is held on its own; the reviewer's own resolve or reopen still moves a held thread.
    const latestActive = artifactThreads.filter((t) => t.status !== "resolved");
    const activeThreads = heldThreads("notes:active", latestActive).filter((t) => t.status !== "resolved");
    const resolvedThreads = heldThreads("notes:resolved", artifactThreads.filter((t) => t.status === "resolved")).filter((t) => t.status === "resolved");
    const groups = (threads, locals) => noteGroupsModel([...threads.map((thread) => ({ c: threadNote(thread), thread })), ...locals]);
    const activeCount = activeNoteCount();
    const pending = pendingFeedbackCount();
    const hint = autoSendActive()
      ? `Feedback notes and replies go to the listening agent when you save them. ${pending ? "Prepare feedback sends earlier drafts." : "Personal notes stay local."}`
      : pending ? "Feedback notes are sent to the semantic-flow artifact as threads your implementation agent can reply to."
        : "Only unsent “Feedback” notes are sent. Personal notes stay local. Agent replies appear here automatically.";
    return {
      open: Boolean(state.notesOpen), remote: Boolean(data.remote),
      filter: state.notesFilter === "resolved" ? "resolved" : "active",
      activeCount, resolvedCount: resolvedThreads.length,
      active: groups(activeThreads, visibleLocalNotes({ key: "notes:active", threads: activeThreads, latest: latestActive })), resolved: groups(resolvedThreads, []),
      export: data.remote ? null : {
        pending, working: exportState.phase === "working",
        outcome: exportState.phase === "error" ? "error" : exportState.phase === "done" ? "done" : "",
        message: exportState.message || "", hint, skips: exportState.skips || [],
        autoSend: agentTakesFeedback() ? autoSendPreferred : null,
      },
    };
  }
  function labelFor(kind, id, stageId) {
    if (kind === "node" && stageId) return stageById.get(stageId)?.nodes.find((node) => node.id === id)?.title || id;
    if (kind === "file") return fileById.get(id)?.file.path || id;
    if (kind === "insight") return insightByKey(id)?.title || id;
    if (kind === "line") {
      const p = parseLineId(id);
      return p ? `${p.path}:${p.line}` : id;
    }
    for (const s of data.stages) {
      if (s.id === id) return s.title;
      const n = s.nodes.find((x) => x.id === id);
      if (n) return n.title;
    }
    return id;
  }
  // Notes list: show only the filename, keep the full project-relative path on hover.
  function noteTargetLabel(c) {
    if (c.kind === "file") {
      const full = noteFileEntry(c.kind, c.id)?.file.path || c.id;
      return { text: splitPath(full).name, title: full };
    }
    if (c.kind === "line") {
      const p = parseLineId(c.id);
      if (p) return { text: `${splitPath(p.path).name}:${p.line}`, title: `${p.path}:${p.line}` };
    }
    const t = labelFor(c.kind, c.id, c.stageId);
    return { text: t, title: t };
  }
  /* ---- render ----------------------------------------------------------- */
  function render() {
    if (reviewDeleted) { renderPage(app, null); setReviewsOpen(true); updateReviewList(); return; }
    selectedThreadLists = threadListsInSelection();
    heldThreadLists = new Set();
    nextThreadLists = new Map();
    const model = {
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
    renderingPage = true;
    try { renderPage(app, model); } finally { renderingPage = false; }
    shownThreadLists = nextThreadLists;
    enhance();
    if (reviewsOpen && !reviewsDialog) setReviewsOpen(true);
  }

  function enhance() {
    forgetRemovedInsights();
    animateDetails();
    observeUnreadReplies();
    // Rendering can replace rows whose text held matches; match again.
    if (hasSelectionHits()) refreshDiffSelection();
    const unread = unreadReplyCount();
    document.title = unread ? `(${unread}) ${baseTitle}` : baseTitle;
    if (pendingHighlight) {
      const { id, nodeId } = pendingHighlight;
      pendingHighlight = null;
      requestAnimationFrame(() => fadeFileHighlight(id, "in", nodeId));
    }
  }

  /* ---- animated <details> ---------------------------------------------- */
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animatedSummaries = new WeakSet();
  // A specification also opens and closes natively (reduced motion skips the
  // animation), so its saved state follows every toggle.
  app.addEventListener("toggle", (e) => {
    if (e.target instanceof HTMLDetailsElement && e.target.matches(".specification")) syncReqState(e.target);
  }, true);
  function animateDetails() {
    app.querySelectorAll("details > summary").forEach((summary) => {
      if (animatedSummaries.has(summary)) return;
      animatedSummaries.add(summary);
      summary.addEventListener("click", (e) => {
        if (e.target.closest("button:not(.stage-title), a, [data-action]") || reduced()) return;
        e.preventDefault();
        const det = summary.parentElement;
        if (det.dataset.animating) return;
        det.dataset.animating = "1";
        const start = det.getBoundingClientRect().height;
        const closing = det.open;
        if (!det.open) det.open = true;
        const end = closing ? summary.getBoundingClientRect().height : det.scrollHeight;
        det.style.overflow = "clip";
        const anim = det.animate([{ height: `${start}px` }, { height: `${end}px` }],
          { duration: closing ? 200 : 260, easing: "cubic-bezier(.22,.7,.2,1)" });
        anim.finished.catch(() => {}).then(() => {
          if (closing) det.open = false;
          det.style.removeProperty("height");
          det.style.removeProperty("overflow");
          delete det.dataset.animating;
          syncReqState(det);
        });
      });
    });
  }
  function syncReqState(det) {
    if (det.matches(".specification") && setSpecificationOpen(det.dataset.reqId, det.open)) persist();
  }
  // Specification IDs come from the artifact, so only own keys count.
  function specificationIsOpen(id) {
    const open = state.specificationOpen;
    return Boolean(open && typeof open === "object" && Object.hasOwn(open, id) && open[id]);
  }
  /** Records whether a specification is open; returns whether that changed. */
  function setSpecificationOpen(id, open) {
    if (typeof id !== "string") return false;
    if (specificationIsOpen(id) === open) return false;
    if (!state.specificationOpen || typeof state.specificationOpen !== "object") state.specificationOpen = Object.create(null);
    state.specificationOpen[id] = open;
    return true;
  }

  function cssEsc(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"); }

  /* ---- reasoning popover (portal, escapes clipped containers) ----------- */
  let popEl = null, popSticky = false, popOwner = null, popTimer = null;
  // Templates render hints as data-tooltip, and as data-tooltip-clipped where
  // the hint only names a label in full while the layout cuts it off.
  const TOOLTIP_TARGET = ".tag-face[data-tagpop], [data-tooltip], [data-tooltip-clipped]";
  /** The plain hint an element shows now; empty when it has none. */
  function tooltipText(el) {
    const { tooltip = "", tooltipClipped } = el.dataset;
    if (!tooltipClipped) return tooltip;
    const labels = [...(el.matches("[data-clippable]") ? [el] : []), ...el.querySelectorAll("[data-clippable]")];
    return labels.some((label) => label.scrollWidth > label.clientWidth) ? tooltipClipped : tooltip;
  }
  /** The nearest element at `target` with a popover or a hint to show now. */
  function tooltipTarget(target) {
    for (let el = target.closest?.(TOOLTIP_TARGET); el; el = el.parentElement?.closest(TOOLTIP_TARGET))
      if (el.matches(".tag-face[data-tagpop]") || tooltipText(el)) return el;
    return null;
  }
  function clearPopDescription() {
    if (!popOwner) return;
    const ids = (popOwner.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== "review-tooltip");
    if (ids.length) popOwner.setAttribute("aria-describedby", ids.join(" "));
    else popOwner.removeAttribute("aria-describedby");
  }
  function ensurePop() {
    if (popEl) return popEl;
    popEl = document.createElement("div");
    popEl.className = "tag-pop-float";
    popEl.id = "review-tooltip";
    popEl.setAttribute("role", "tooltip");
    document.body.appendChild(popEl);
    popEl.addEventListener("pointerenter", () => clearTimeout(popTimer));
    popEl.addEventListener("pointerleave", () => { if (!popSticky) scheduleHide(); });
    return popEl;
  }
  function fillPop(btn) {
    const d = btn.dataset;
    const el = ensurePop();
    const text = tooltipText(btn);
    if (text) {
      el.className = "tag-pop-float is-tooltip";
      renderLit(tooltipView(text), el);
      return;
    }
    const kindLine = `${d.glyph} ${d.label}${d.meta ? ` · ${d.meta}` : ""}${d.review ? ` · ${d.review}` : ""}`;
    el.className = `tag-pop-float type-${d.type}${d.vstat ? ` vstat-${d.vstat}` : ""}`;
    renderLit(tagPopoverView({ kind: kindLine, title: d.title ?? "", body: d.body || "" }), el);
  }
  function positionPop(btn) {
    const r = btn.getBoundingClientRect();
    const p = popEl.getBoundingClientRect();
    const margin = 12, gap = 9;
    let left = Math.max(margin, Math.min(r.left, window.innerWidth - p.width - margin));
    let top = r.bottom + gap;
    if (top + p.height > window.innerHeight - margin && r.top - gap - p.height > margin) {
      top = r.top - gap - p.height; popEl.classList.add("is-above");
    } else {
      popEl.classList.remove("is-above");
      // A popover too tall for either side stays on screen and scrolls.
      top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin));
    }
    popEl.style.left = `${left}px`;
    popEl.style.top = `${top}px`;
  }
  function showPop(btn) {
    clearTimeout(popTimer);
    if (popOwner === btn && popEl?.classList.contains("is-shown")) return;
    clearPopDescription();
    popOwner = btn;
    const ids = new Set((btn.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add("review-tooltip");
    btn.setAttribute("aria-describedby", [...ids].join(" "));
    fillPop(btn);
    popEl.style.visibility = "hidden";
    popEl.classList.add("is-shown");
    requestAnimationFrame(() => {
      if (popOwner !== btn) return;
      positionPop(btn);
      popEl.style.visibility = "";
    });
  }
  function scheduleHide() { clearTimeout(popTimer); popTimer = setTimeout(hidePop, 130); }
  function hidePop() {
    if (popSticky) return;
    if (popEl) popEl.classList.remove("is-shown", "is-above");
    clearPopDescription();
    popOwner = null;
  }
  function forceHidePop() {
    popSticky = false;
    if (popEl) popEl.classList.remove("is-shown", "is-above");
    clearPopDescription();
    popOwner = null;
  }
  document.addEventListener("pointerover", (e) => {
    const b = tooltipTarget(e.target);
    if (!b) return;
    if (popSticky && popOwner !== b) return;
    showPop(b);
  });
  document.addEventListener("pointerout", (e) => {
    const b = tooltipTarget(e.target);
    if (b && !b.contains(e.relatedTarget) && !popSticky) scheduleHide();
  });
  document.addEventListener("focusin", (e) => {
    const b = tooltipTarget(e.target);
    if (b) showPop(b);
  });
  document.addEventListener("focusout", (e) => {
    const b = tooltipTarget(e.target);
    if (b && !popSticky) scheduleHide();
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".tag-face[data-tagpop]");
    if (b) {
      e.preventDefault();
      if (popSticky && popOwner === b) { popSticky = false; hidePop(); }
      else { popSticky = true; showPop(b); }
      return;
    }
    if (popSticky && !e.target.closest(".tag-pop-float")) forceHidePop();
  });
  window.addEventListener("scroll", () => {
    if (!popEl || !popEl.classList.contains("is-shown")) return;
    if (popOwner && popOwner.isConnected) positionPop(popOwner); else forceHidePop();
  }, true);
  window.addEventListener("resize", () => { if (popOwner && popOwner.isConnected) positionPop(popOwner); });

  /* ---- events ----------------------------------------------------------- */
  // Keep the hit area stable: highlighting only changes paint, never layout or
  // the insight DOM. Moving between its icon, text, and padding is one hover.
  function clearInlineInsightHighlight() {
    hoveredCodeInsight = focusedCodeInsight = null;
    highlightInlineInsight(null);
  }
  // Highlights the lines an inline insight is linked to, in the diff that
  // shows the insight, without rendering the viewer.
  function highlightInlineInsight(button) {
    if (renderingPage) return;
    setInsightPreview(codeInsightPreview(button), button);
  }
  // The lines an inline insight button previews, from the current insight data.
  function codeInsightPreview(button) {
    let next = null;
    if (button?.isConnected) {
      const stage = stageById.get(button.dataset.stage);
      const target = stage?.insights.find(ins => ins.collection === button.dataset.collection && ins.id === button.dataset.item)?.codeTarget;
      // The open diff follows its file row, inside the step it was opened in.
      const fileId = button.closest(".cinema-diff")?.previousElementSibling?.dataset.file;
      const nodeId = button.closest("details[data-node]")?.dataset.node;
      if (target && target.status !== "needs-review" && fileId && nodeId)
        next = { fileId, nodeId, stageId: stage.id, path: target.path, startLine: target.startLine, endLine: target.endLine };
    }
    return next;
  }
  document.addEventListener("pointerover", e => {
    const button = e.target.closest(".line-code-insights .code-insight-link");
    if (!button || button === suppressedCodeInsight || button.contains(e.relatedTarget)) return;
    hoveredCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("pointerout", e => {
    const button = e.target.closest(".line-code-insights .code-insight-link");
    if (!button || button.contains(e.relatedTarget)) return;
    if (button === suppressedCodeInsight) suppressedCodeInsight = null;
    hoveredCodeInsight = null;
    highlightInlineInsight(focusedCodeInsight);
  });
  document.addEventListener("pointermove", e => {
    const button = e.target.closest(".line-code-insights .code-insight-link");
    if (!button || button !== suppressedCodeInsight) return;
    suppressedCodeInsight = null;
    hoveredCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("focusin", e => {
    const button = e.target.closest(".line-code-insights .code-insight-link");
    if (!button || button === suppressedCodeInsight) return;
    focusedCodeInsight = button;
    highlightInlineInsight(button);
  });
  document.addEventListener("focusout", e => {
    const button = e.target.closest(".line-code-insights .code-insight-link");
    if (!button) return;
    if (button === suppressedCodeInsight) suppressedCodeInsight = null;
    focusedCodeInsight = null;
    highlightInlineInsight(hoveredCodeInsight);
  });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const a = btn.dataset.action;

    if (a === "view-evidence") {
      const stage = stageById.get(btn.dataset.stage);
      openEvidence(stage, stage?.insights.find((item) => item.collection === "evidence" && item.id === btn.dataset.item));
    } else if (a === "toggle-insight-review") {
      const stage = stageById.get(btn.dataset.stage);
      const ins = stage?.insights.find((item) => item.collection === btn.dataset.collection && item.id === btn.dataset.item);
      if (!ins) return;
      const key = insightKey(stage.id, ins.collection, ins.id);
      if (insightReviewState(stage, ins) === "reviewed") delete state.insightReviews[key];
      else state.insightReviews[key] = { fingerprint: insightFingerprint(ins), at: Date.now() };
      // Rendering hides the tooltip, so reopen it with the new state.
      const tooltipOpen = popOwner === btn;
      persist(); render();
      if (tooltipOpen) showPop(btn);
    } else if (a === "code-insight") {
      const stage = stageById.get(btn.dataset.stage);
      openCodeInsight(stage, stage?.insights.find(ins => ins.collection === btn.dataset.collection && ins.id === btn.dataset.item));
    } else if (a === "file-insights") {
      const stage = stageById.get(btn.dataset.stage), choices = stage ? fileCodeInsights(stage, btn.dataset.path) : [];
      openCodeInsight(stage, choices[0], choices);
    } else if (a === "file-search") {
      openFileSearch(btn.dataset.path || "", btn.dataset.stageId ? { stageId: btn.dataset.stageId, nodeId: btn.dataset.nodeId } : null);
    } else if (a === "focus-reasoning") {
      e.preventDefault();
      const node = btn.closest("details[data-node]");
      node.open = true;
      const selector = btn.dataset.type === "not-passed"
        ? '.node-reasoning .tag-face[data-vstat="failed"], .node-reasoning .tag-face[data-vstat="notrun"]'
        : `.node-reasoning .tag-face[data-type="${cssEsc(btn.dataset.type)}"]`;
      const target = node.querySelector(selector);
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
      render(); document.querySelector('[data-action="show-agent-questions"]')?.focus();
    } else if (a === "show-agent-questions") {
      minimizedAgentQuestions.clear(); render();
      document.querySelector('[data-action="minimize-agent-questions"]')?.focus();
    } else if (a === "agent-choice") {
      const request = agent?.requests.find((item) => item.id === btn.dataset.id);
      if (request) void answerAgent(request.id, request.choices[Number(btn.dataset.choice)] || "");
    } else if (a === "show-unread") {
      showUnreadReplies();
    } else if (a === "dismiss-round") {
      roundNotice = null; render();
    } else if (a === "refresh-reviews") {
      if (!reviewListBusy) void refreshReviews();
    } else if (a === "open-review" || a === "complete-review") {
      void changeReview(btn.dataset.reviewId, a === "complete-review");
    } else if (a === "approve") {
      void changeApproval(btn.dataset.id, btn.dataset.kind);
    } else if (a === "approve-group") {
      void approveGroup(btn.dataset.stage, btn.dataset.nodeId, btn.dataset.group);
    } else if (a === "approval-comparison") {
      state.approvalComparisons[btn.dataset.id] = !sinceApprovalEnabled(btn.dataset.id);
      persist(); render();
    } else if (a === "approval-base-scope") {
      if (!approvalBaseIncluded.delete(btn.dataset.id)) approvalBaseIncluded.add(btn.dataset.id);
      render();
    } else if (a === "dismiss-target-refresh") {
      state.dismissedTargetRefresh = agent?.targetRefresh?.at;
      persist(); render();
    } else if (a === "approval-page") {
      const entry = approvalEntry(btn.dataset.id);
      const offset = Number(btn.dataset.offset);
      const previous = entry ? approvalComparisons.get(comparisonKey(btn.dataset.id, entry))?.offset || 0 : 0;
      if (entry) void loadApprovalComparison(btn.dataset.id, entry, offset, {
        direction: offset > previous ? "forward" : "backward", nodeId: entry.nodeId,
      });
    } else if (a === "toggle-stage") {
      animateStageToggle(btn.dataset.id);
    } else if (a === "toggle-coverage") {
      state.coverageOpen = !state.coverageOpen; state.notesOpen = false; persist(); render();
    } else if (a === "toggle-notes") {
      state.notesOpen = !state.notesOpen; state.coverageOpen = false; persist(); render();
    } else if (a === "close-panels") {
      state.coverageOpen = false; state.notesOpen = false; persist(); render();
    } else if (a === "comment") {
      openComment(btn.dataset.kind, btn.dataset.id, btn.dataset.stage);
    } else if (a === "line-note") {
      const id = btn.dataset.id;
      const hasContent =
        artifactThreadsForElement("line", id).length || localVisibleForElement(id).length;
      if (hasContent) {
        const opening = !state.openLineThreads[id];
        state.openLineThreads[id] = opening;
        persist();
        if (opening) { render(); }
        else { collapseThenRender(app.querySelector(`.line-thread[data-thread="${cssEsc(id)}"]`)); }
      } else {
        openComment("line", id);
      }
    } else if (a === "toggle-file-notes") {
      const id = btn.dataset.id, nodeId = btn.dataset.nodeId;
      const opening = activeFileNodeId(id) !== nodeId || state.openThreads[id] === false;
      state.activeFiles[id] = nodeId;
      state.openThreads[id] = opening;
      persist();
      if (opening) render();
      else collapseThenRender(cinemaHolder(id, nodeId)?.querySelector(".file-note-threads"));
    } else if (a === "toggle-thread") {
      const id = btn.dataset.id;
      const key = threadStateKey(btn.dataset.kind, id, btn.dataset.stage);
      const opening = !state.openThreads[key];
      state.openThreads[key] = opening;
      persist();
      if (opening) { render(); }
      else { collapseThenRender((btn.closest("details.node") || btn.closest(".stage") || app).querySelector(`.thread[data-thread="${cssEsc(id)}"]`)); }
    } else if (a === "edit-note") {
      if (sendingDrafts.has(state.comments[Number(btn.dataset.index)])) return;
      openNoteEdit(Number(btn.dataset.index));
    } else if (a === "markdown-mode") {
      const entry = fileById.get(btn.dataset.id);
      if (entry && btn.dataset.mode === "preview") {
        const key = markdownUrl(entry);
        if (markdownPreviews.get(key)?.error) markdownPreviews.delete(key);
      }
      state.markdownPreview[btn.dataset.id] = btn.dataset.mode === "preview";
      persist(); render();
    } else if (a === "toggle-wrap") {
      state.wrapLines = !state.wrapLines;
      persist(); render();
    } else if (a === "set-view") {
      state.fileView[btn.dataset.id] = btn.dataset.mode;
      const entry = fileById.get(btn.dataset.id);
      if (entry) { delete entry.file.lines; delete entry.file._diffError; }
      persist(); render();
    } else if (a === "diff-page") {
      const entry = fileById.get(btn.dataset.id), offset = Number(btn.dataset.offset);
      if (entry) ensureFileDiff(entry, offset, true, null, {
        direction: offset > (entry.file._pageOffset || 0) ? "forward" : "backward", nodeId: activeFileNodeId(entry.id),
      });
    } else if (a === "toggle-hide-removed") {
      const id = btn.dataset.id;
      state.hideDeleted[id] = !state.hideDeleted[id];
      persist();
      render();
    } else if (a === "del-note") {
      const idx = Number(btn.dataset.index);
      const c = state.comments[idx];
      if (c && !c.exported && !sendingDrafts.has(c)) {
        state.comments.splice(idx, 1);
        if (compose?.editIndex === idx) compose = null;
        else if (compose?.editIndex > idx) compose.editIndex -= 1;
        persist(); render();
      }
    } else if (a === "open-file") {
      // Let the reviewer select the filename text without toggling the diff:
      // a click that completes a selection over the name is not a toggle.
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && e.target.closest && e.target.closest(".fp-name")) return;
      toggleCinema(btn.dataset.id, btn.dataset.nodeId);
    } else if (a === "export-feedback") {
      exportFeedback();
    } else if (a === "remove-attachment") {
      const attachments = editorAttachments(btn.closest("form"));
      const index = attachments?.findIndex((file) => file.id === btn.dataset.id);
      if (index >= 0) { attachments.splice(index, 1); persist(); render(); }
    } else if (a === "compose-cancel") {
      compose = null; persist(); render();
    } else if (a === "jump-to") {
      jumpToElement(btn.dataset.kind, btn.dataset.id, btn.dataset.stage, btn.dataset.nodeId);
    } else if (a === "thread-reply") {
      compose = null;
      replyTo = btn.dataset.id;
      replyDraft = ""; replyAttachments = [];
      replyEditId = null;
      replyDirty = false;
      if (threadOps[replyTo]) threadOps[replyTo].error = "";
      render(); focusComposer();
    } else if (a === "reply-edit") {
      if (sendingDrafts.has(btn.dataset.replyId)) return;
      compose = null;
      const draft = pendingReplies().find((r) => r.id === btn.dataset.replyId);
      if (!draft) return;
      replyTo = btn.dataset.id;
      replyEditId = draft.id;
      replyDraft = draft.body;
      replyAttachments = structuredClone(draft.attachments || []);
      replyDirty = false;
      render(); focusComposer();
    } else if (a === "reply-del") {
      if (sendingDrafts.has(btn.dataset.replyId)) return;
      state.replyDrafts = pendingReplies().filter((r) => r.id !== btn.dataset.replyId);
      if (replyEditId === btn.dataset.replyId) { replyEditId = null; replyTo = null; replyDraft = ""; replyAttachments = []; replyDirty = false; }
      persist(); render();
    } else if (a === "reply-cancel") {
      replyTo = null; replyDraft = ""; replyAttachments = []; replyEditId = null; replyDirty = false; persist(); render();
    } else if (a === "thread-resolve") {
      threadAction(btn.dataset.id, "resolve");
    } else if (a === "thread-reopen") {
      threadAction(btn.dataset.id, "reopen");
    } else if (a === "toggle-thread-collapse") {
      toggleThreadCollapse(btn.dataset.id, btn);
    } else if (a === "notes-filter") {
      const f = btn.dataset.filter === "resolved" ? "resolved" : "active";
      if (state.notesFilter !== f) { state.notesFilter = f; persist(); applyNotesFilter(); }
    }
  });

  // Open the reviewable element an artifact thread points at, close the notes
  // panel, and scroll its conversation into view (targeting the comments so a
  // tall file body cannot push them off-screen).
  function jumpToElement(kind, id, stageId, nodeId) {
    pendingLazyJump = null;
    state.notesOpen = false;
    state.coverageOpen = false;
    if (kind === "line") state.openLineThreads[id] = true;
    else state.openThreads[threadStateKey(kind, id, stageId)] = true;
    let lineFileId = null;
    let lineMembership = null;
    let lineEntry = null;
    if (kind === "file") {
      const entry = fileById.get(id);
      if (entry) {
        const membership = (entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0];
        state.openStages[entry.stage.id] = true;
        state.activeFiles[id] = membership?.nodeId || null;
      }
    } else if (kind === "line") {
      const p = parseLineId(id);
      const entry = p && fileById.get(fileKey(p.stageId, p.path));
      if (entry) {
        if (p.side === "old") state.hideDeleted[entry.id] = false;
        state.markdownPreview[entry.id] = false;
        lineEntry = entry;
        lineFileId = entry.id;
        lineMembership = (entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0];
        state.openStages[entry.stage.id] = true;
        state.activeFiles[entry.id] = lineMembership?.nodeId || null;
        if (lineMembership) state.approvalComparisons[fileApprovalKey(entry.stage.id, lineMembership.nodeId, entry.file.path)] = false;
      }
    } else if (kind === "stage") {
      state.openStages[id] = true;
    } else if (kind === "node") {
      if (stageId) state.openStages[stageId] = true;
    } else if (kind === "specification") {
      setSpecificationOpen(id, true);
    } else if (kind === "criterion") {
      setSpecificationOpen(String(id).split("#")[0], true);
    } else if (kind === "insight") {
      const stageOfInsight = parseInsightKey(id)?.stageId;
      if (stageOfInsight) state.openStages[stageOfInsight] = true;
    }
    persist();
    const waitForLazyLine =
      kind === "line" && lineEntry && !fileHasLine(lineEntry.file, parseLineId(id).side, parseLineId(id).line);
    if (waitForLazyLine) {
      pendingLazyJump = { id, fileId: lineEntry.id, membership: lineMembership };
      state.fileView[lineEntry.id] = "full";
      delete lineEntry.file.lines;
      ensureFileDiff(lineEntry, 0, true, parseLineId(id));
    }
    render();
    if (waitForLazyLine) return;
    // Expand the owning node <details> for file/line targets, then scroll.
    requestAnimationFrame(() => {
      if (kind === "file") {
        const entry = fileById.get(id);
        const membership = entry && ((entry.file.memberships || []).find((m) => m.nodeId === nodeId) || (entry.file.memberships || [])[0]);
        if (membership && membership.nodeId) {
          const nodeEl = app.querySelector(`.stage[data-stage="${cssEsc(entry.stage.id)}"] details.node[data-node="${cssEsc(membership.nodeId)}"]`);
          if (nodeEl) nodeEl.open = true;
        }
      } else if (kind === "line" && lineMembership && lineMembership.nodeId) {
        const nodeEl = app.querySelector(`.stage[data-stage="${cssEsc(lineEntry.stage.id)}"] details.node[data-node="${cssEsc(lineMembership.nodeId)}"]`);
        if (nodeEl) nodeEl.open = true;
      } else if (kind === "node") {
        const nodeEl = stageId
          ? app.querySelector(`.stage[data-stage="${cssEsc(stageId)}"] details.node[data-node="${cssEsc(id)}"]`)
          : app.querySelector(`details.node[data-node="${cssEsc(id)}"]`);
        if (nodeEl) nodeEl.open = true;
      }
      requestAnimationFrame(() => {
        const nodeTarget = kind === "node" && stageId
          ? app.querySelector(`.stage[data-stage="${cssEsc(stageId)}"] details.node[data-node="${cssEsc(id)}"]`)
          : null;
        const thread = nodeTarget?.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
          || nodeTarget
          || app.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
          || app.querySelector(`.line-thread[data-thread="${cssEsc(id)}"]`)
          || app.querySelector(`[data-line-id="${cssEsc(id)}"]`)
          || fileRowElement(id)
          || app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`)
          || app.querySelector(`details.node[data-node="${cssEsc(id)}"]`)
          || app.querySelector(`.ac-item[data-ac="${cssEsc(id)}"]`)
          || app.querySelector(`.specification[data-req-id="${cssEsc(id)}"]`)
          || app.querySelector(`[data-insight="${cssEsc(id)}"]`);
        if (thread) {
          const node = kind === "insight" ? thread.closest("details.node") : null;
          if (node) node.open = true;
          thread.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (kind === "file") fadeFileHighlight(id, "in");
        else if (kind === "line" && lineFileId)
          fadeFileHighlight(lineFileId, "in", lineMembership?.nodeId);
      });
    });
  }

  // Continue an artifact thread with a reviewer reply (server-backed).
  // Save (or update) a reviewer reply as a local draft. Drafts are revisable
  // and only sent to the artifact when the reviewer prepares feedback.
  function saveReplyDraft(threadId, body) {
    if (!artifactThreadById(threadId)) return;
    if (!Array.isArray(state.replyDrafts)) state.replyDrafts = [];
    let savedId = replyEditId;
    if (replyEditId != null) {
      const draft = state.replyDrafts.find((r) => r.id === replyEditId);
      if (draft) { draft.body = body; draft.attachments = structuredClone(replyAttachments); }
    } else {
      savedId = `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      state.replyDrafts.push({
        id: savedId,
        threadId,
        body,
        attachments: structuredClone(replyAttachments),
        createdAt: Date.now(),
      });
    }
    replyTo = null;
    replyDraft = ""; replyAttachments = [];
    replyEditId = null;
    replyDirty = false;
    persist();
    render();
    autoSendFeedback({ reply: savedId });
  }

  // Mark a thread resolved / reopen it. Only the reviewer controls closure.
  // The render wrapper preserves scroll and drafts while refreshing every count
  // and grouped list after a successful mutation.
  async function threadAction(threadId, kind) {
    const thread = artifactThreadById(threadId);
    if (!thread) return;
    threadOps[threadId] = { busy: true, error: "" };
    render();
    try {
      const res = await api.threadAction(kind, { implementationId: data.implementationId, threadId });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Action failed (HTTP ${res.status}).`);
      adoptViewerSnapshot(out);
      for (const copy of [thread, ...heldThreadCopies(threadId)]) {
        if (out.status) copy.status = out.status;
        if ("resolvedAt" in out) copy.resolvedAt = out.resolvedAt;
      }
      threadOps[threadId] = { busy: false, error: "" };
      if (!state.threadCollapsed) state.threadCollapsed = {};
      if (kind === "resolve") state.threadCollapsed[threadId] = true;
      else if (kind === "reopen") state.threadCollapsed[threadId] = false;
      persist();
      // Resolving the last active thread/comment on a diff line should hide the
      // whole line-notes section, not leave a collapsed thread the reviewer must
      // dismiss by hand. Collapse the inline row and re-render.
      if (kind === "resolve" && thread.target && thread.target.kind === "line") {
        const lineId = lineKey(
          thread.target.stageId, thread.target.side, thread.target.line, thread.target.path,
        );
        const activeLeft =
          artifactThreadsForElement("line", lineId).some((t) => t.status !== "resolved") ||
          localVisibleForElement(lineId).length > 0;
        if (!activeLeft) {
          state.openLineThreads[lineId] = false;
          persist();
          const inline = app.querySelector(`.line-thread[data-thread="${cssEsc(lineId)}"]`);
          const rowEl = inline ? inline.closest(".drow-thread") : null;
          collapseThenRender(rowEl);
          return;
        }
      }
      render();
    } catch (err) {
      threadOps[threadId] = { busy: false, error: err.message || "Action failed." };
      render();
    }
  }

  // Toggles what the reviewer sees in the header used, which a held list may show
  // differently from the latest copy (a thread resolved since defaults to collapsed).
  function toggleThreadCollapse(id, header) {
    const t = artifactThreadById(id);
    if (!t) return;
    if (!state.threadCollapsed) state.threadCollapsed = {};
    const shown = header?.getAttribute("aria-expanded");
    const collapsed = shown ? shown === "true" : !threadCollapsed(t);
    state.threadCollapsed[id] = collapsed;
    persist();
    render();
  }
  function requestReplyNotifications() {
    if ((agent?.listening || agent?.working) && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }
  // Notes and replies go in one request, so a listening agent picks them up as one round.
  // `only` limits an automatic send to the drafts just saved.
  async function exportFeedback(only = null) {
    if (exportState.phase === "working") return;
    // A draft open in an editor waits until its edit is saved.
    const editingNote = compose?.editIndex != null ? state.comments[compose.editIndex] : null;
    const pending = pendingFeedback().filter(({ c }) => c !== editingNote && (!only || only.notes.has(c)));
    const replies = pendingReplies().filter((draft) => draft.id !== replyEditId && (!only || only.replies.has(draft.id)));
    if (!pending.length && !replies.length) return;
    // Each send locks and releases only its own drafts.
    const locked = [...pending.map(({ c }) => c), ...replies.map((draft) => draft.id)];
    locked.forEach((draft) => sendingDrafts.add(draft));
    const release = () => locked.forEach((draft) => sendingDrafts.delete(draft));
    // The finally releases the drafts if setup throws; normal paths release them before rendering.
    try {
      requestReplyNotifications();
      exportState = { phase: "working", message: "" };
      render();
      const skips = replies.filter((draft) => !artifactThreadById(draft.threadId)).map(() => "reply — thread no longer exists");
      const sendable = replies.filter((draft) => artifactThreadById(draft.threadId));
      let notesSent = 0;
      let repliesSent = 0;
      if (pending.length || sendable.length) {
        try {
          const res = await api.exportFeedback({
            implementationId: data.implementationId,
            notes: pending.map(({ c, i }) => { rememberDraftSnapshot(c); return { ref: i, kind: c.kind, id: c.id, stageId: c.stageId, body: c.body, attachments: c.attachments || [], clientId: String(c.createdAt), snapshot: draftSnapshots.get(c) }; }),
            replies: sendable.map((draft) => ({ ref: draft.id, threadId: draft.threadId, body: draft.body, attachments: draft.attachments || [] })),
          });
          let out = {};
          try { out = await res.json(); } catch { /* non-JSON error body */ }
          const byRef = new Map(pending.map(({ c, i }) => [i, c]));
          (out.skipped || []).forEach((s) => {
            const c = byRef.get(s.ref);
            const label = c ? labelFor(c.kind, c.id, c.stageId) : `note ${s.ref}`;
            skips.push(`${label} — ${s.reason}`);
          });
          (out.replySkipped || []).forEach((entry) => skips.push(`reply — ${entry.reason}`));
          if (!res.ok || !out.ok) throw new Error(out.error || `Export failed (HTTP ${res.status}).`);
          adoptViewerSnapshot(out);
          (out.exported || []).forEach((entry) => {
            const ref = typeof entry === "number" ? entry : entry && entry.ref;
            const note = byRef.get(ref);
            if (note) {
              note.exported = true;
              if (entry && entry.threadId) note.threadId = entry.threadId;
            }
          });
          notesSent = (out.exported || []).length;
          (out.replied || []).forEach((entry) => {
            const thread = artifactThreadById(entry.threadId);
            if (!thread) return;
            // Held copies show the sent reply in place of its draft; a copy shared by several lists gets it once.
            // A retried send whose earlier response was lost returns a comment a poll may already have loaded.
            for (const copy of new Set([thread, ...heldThreadCopies(entry.threadId)])) {
              if (entry.comment && !copy.comments.some((comment) => entry.comment.id != null && comment.id === entry.comment.id)) copy.comments.push(entry.comment);
              if (entry.status) copy.status = entry.status;
              if ("resolvedAt" in entry) copy.resolvedAt = entry.resolvedAt;
            }
          });
          const sentIds = new Set((out.replied || []).map((entry) => entry.ref));
          repliesSent = sentIds.size;
          state.replyDrafts = pendingReplies().filter((draft) => !sentIds.has(draft.id));
        } catch (err) {
          persist();
          exportState = { phase: "error", message: err.message || "Export failed.", skips };
          release();
          render();
          // The failed drafts stay for Prepare feedback; saves queued meanwhile still go out.
          autoSendFeedback();
          return;
        }
      }
      release();
      persist();
      const parts = [];
      if (notesSent || !repliesSent) parts.push(`${notesSent} feedback thread${notesSent === 1 ? "" : "s"}`);
      if (repliesSent) parts.push(`${repliesSent} repl${repliesSent === 1 ? "y" : "ies"}`);
      const next = agent?.listening || agent?.working
        ? "The listening agent picks this up automatically."
        : `Run “${AGENT_COMMAND}” in your agent to have it handled.`;
      exportState = {
        phase: "done",
        message: `Sent ${parts.join(" and ")}${skips.length ? `, ${skips.length} skipped` : ""}. ${next} Replies and edits appear here.`,
        skips
      };
      render();
      autoSendFeedback();
    } finally {
      release();
    }
  }

  const ANIM_EASE = "cubic-bezier(.22,.7,.2,1)";
  const motionReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The file row that should fade its orange highlight in on the next render.
  // Shared files need the node id too because they appear more than once.
  let pendingHighlight = null;
  const fileHighlights = new WeakMap();

  // Fade the file-row highlight (orange background + inset border) in or out.
  // Animate the highlight when explicitly opening or closing a file.
  function fadeFileHighlight(id, dir, nodeId) {
    if (id == null || motionReduced()) return;
    const row = fileRowElement(id, nodeId);
    if (!row) return;
    fileHighlights.get(row)?.cancel();
    const on = { background: "rgba(255, 106, 69, .13)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, .35)" };
    const off = { background: "rgba(255, 106, 69, 0)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, 0)" };
    const frames = dir === "in" ? [off, on] : [on, off];
    const animation = row.animate(frames, {
      duration: dir === "in" ? 260 : 200,
      easing: ANIM_EASE,
      fill: dir === "in" ? "none" : "forwards",
    });
    fileHighlights.set(row, animation);
    return animation;
  }

  // Run `cb` once when the animation ends, with a safety timeout so a stuck or
  // non-resolving `finished` promise can never leave the UI mid-animation.
  function afterAnim(anim, ms, cb) {
    let done = false;
    const run = () => { if (done) return; done = true; cb(); };
    anim.finished.catch(() => {}).then(run);
    setTimeout(run, (ms || 0) + 80);
  }

  function applyNotesFilter() {
    // Each filter starts at its own content; the hidden list contributes no height.
    const list = app.querySelector(".notes-list");
    if (list) list.scrollTop = 0;
    render();
  }

  // Animate a stage body open/closed in place so both directions transition.
  function animateStageToggle(id) {
    const open = !state.openStages[id];
    state.openStages[id] = open;
    persist();
    const stageEl = app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`);
    const body = stageEl && stageEl.querySelector(".stage-body");
    if (!stageEl || !body || motionReduced()) { render(); return; }
    const start = body.getBoundingClientRect().height;
    render();
    const end = body.getBoundingClientRect().height;
    body.style.overflow = "hidden";
    const anim = body.animate([{ height: `${start}px` }, { height: `${end}px` }],
      { duration: open ? 300 : 230, easing: ANIM_EASE });
    afterAnim(anim, open ? 300 : 230, () => { body.style.removeProperty("overflow"); });
  }

  // Collapse an element to zero height, then re-render (used for closing
  // element-scoped note threads and the inline diff).
  function collapseThenRender(el, dur) {
    if (!el || motionReduced()) { render(); return; }
    const start = el.getBoundingClientRect().height;
    el.style.overflow = "hidden";
    const anim = el.animate([{ height: `${start}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: dur || 200, easing: ANIM_EASE });
    afterAnim(anim, dur || 200, () => { el.style.removeProperty("overflow"); render(); });
  }

  function toggleCinema(id, nodeId) {
    const entry = fileById.get(id);
    const targetNodeId =
      nodeId || (entry && (entry.file.memberships || [])[0]?.nodeId) || null;
    if (activeFileNodeId(id) === targetNodeId) { closeCinema(id); return; }
    // Open in place — never auto-scroll, so the file stays where the reviewer
    // clicked it (jumping from the notes list handles its own scrolling).
    if (entry) delete entry.file._diffError;
    state.activeFiles[id] = targetNodeId || null;
    persist();
    pendingHighlight = { id, nodeId: targetNodeId };
    render();
  }
  function cinemaHolder(id, nodeId = activeFileNodeId(id)) {
    const row = fileRowElement(id, nodeId);
    const next = row && row.nextElementSibling;
    return next && next.classList.contains("cinema-diff") ? next : null;
  }
  function closeCinema(id) {
    // No id → close every open file (used by the Escape shortcut).
    if (id == null) { state.activeFiles = {}; persist(); render(); return; }
    const nodeId = activeFileNodeId(id);
    const holder = cinemaHolder(id, nodeId);
    delete state.activeFiles[id]; persist();
    if (!holder || motionReduced()) { render(); return; }
    const highlight = fadeFileHighlight(id, "out", nodeId);
    const start = holder.getBoundingClientRect().height;
    holder.style.overflow = "hidden";
    const anim = holder.animate([{ height: `${start}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: 210, easing: ANIM_EASE });
    afterAnim(anim, 210, () => {
      holder.style.removeProperty("overflow"); render();
      // Rows survive rendering; release the closing fill so CSS can highlight
      // an open or hovered row again. A newer opening animation is independent.
      highlight?.cancel();
    });
  }

  function openComment(kind, id, stageId) {
    const target = { kind, id };
    if (kind === "file" || kind === "line") target.nodeId = elementNodeId(kind, id);
    if (kind === "node" && stageId) target.stageId = stageId;
    replyTo = null; replyEditId = null; replyDraft = ""; replyAttachments = []; replyDirty = false;
    compose = {
      ...target,
      editIndex: null,
      mode: !data.remote && state.lastNoteMode === "feedback" ? "feedback" : "personal",
      body: "",
      dirty: false,
    };
    rememberDraftSnapshot(compose);
    if (kind === "line") state.openLineThreads[id] = true;
    else state.openThreads[threadStateKey(kind, id, stageId)] = true;
    // File notes live inside the file's open diff unit, so adding one opens it.
    if (kind === "file") {
      const entry = fileById.get(id);
      if (!state.activeFiles[id])
        state.activeFiles[id] = (entry?.file.memberships || [])[0]?.nodeId || null;
      pendingHighlight = { id, nodeId: activeFileNodeId(id) };
    }
    persist();
    render();
    focusComposer();
  }

  // Edit a browser-local draft note in place. Exported notes are immutable.
  function openNoteEdit(index) {
    const c = state.comments[index];
    if (!c || c.exported) return;
    replyTo = null; replyEditId = null; replyDraft = ""; replyAttachments = []; replyDirty = false;
    compose = {
      kind: c.kind,
      id: c.id,
      stageId: c.stageId,
      nodeId: noteNodeId(c),
      editIndex: index,
      mode: c.mode || "personal",
      body: c.body,
      attachments: structuredClone(c.attachments || []),
      dirty: false,
    };
    if (c.kind === "line") state.openLineThreads[c.id] = true;
    else state.openThreads[threadStateKey(c.kind, c.id, c.stageId)] = true;
    if (c.kind === "file" || c.kind === "line") {
      const entry = noteFileEntry(c.kind, c.id);
      if (entry && noteNodeId(c)) state.activeFiles[entry.id] = noteNodeId(c);
      if (entry) pendingHighlight = { id: entry.id, nodeId: activeFileNodeId(entry.id) };
    }
    persist();
    render();
    focusComposer();
  }

  function focusComposer() {
    requestAnimationFrame(() => {
      const root = state.notesOpen ? app.querySelector(".side.notes") : app.querySelector(".shell");
      const ta = root?.querySelector(".note-compose textarea, .tthread-reply textarea");
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
  }

  // Keep unsent editor text in state for persistence and live updates.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (compose && t.matches('.note-compose textarea[name="nc-body"]')) {
      compose.body = t.value;
      compose.dirty = true;
      persist(true);
    } else if (t.matches('.tthread-reply textarea[name="reply-body"]')) {
      replyDraft = t.value;
      replyDirty = true;
      persist(true);
    } else if (t.matches(".agent-answer textarea")) {
      agentAnswers.set(t.closest("[data-agent-answer]").dataset.id, t.value);
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches('.notes-auto-send input[name="auto-send"]')) {
      setAutoSendPreferred(t.checked);
      render();
      return;
    }
    if (compose && t.matches('.note-compose input[name="nc-mode"]') && t.checked) {
      compose.mode = t.value;
      compose.dirty = true;
      persist(); render();
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.matches("[data-note-form]")) {
      e.preventDefault();
      const body = e.target.querySelector("textarea").value.trim();
      const mode = e.target.querySelector('input[name="nc-mode"]:checked')?.value || "personal";
      if (uploadOps.size || !compose || (!body && !compose.attachments?.length)) return;
      let saved = null;
      if (compose) {
        if (compose.editIndex != null) {
          const c = state.comments[compose.editIndex];
          if (c && !c.exported && !sendingDrafts.has(c)) { c.body = body; c.mode = mode; c.attachments = structuredClone(compose.attachments || []); saved = c; }
        } else {
          const note = { kind: compose.kind, id: compose.id, body, mode, attachments: structuredClone(compose.attachments || []), createdAt: Date.now() };
          if (compose.stageId) note.stageId = compose.stageId;
          if (compose.nodeId) note.nodeId = compose.nodeId;
          const snapshot = draftSnapshots.get(compose);
          if (snapshot) draftSnapshots.set(note, snapshot); else rememberDraftSnapshot(note);
          state.comments.push(note);
          saved = note;
        }
        state.lastNoteMode = mode;
      }
      compose = null;
      persist();
      render();
      if (saved && mode === "feedback") autoSendFeedback({ note: saved });
      return;
    }
    if (e.target.matches("[data-agent-answer]")) {
      e.preventDefault();
      void answerAgent(e.target.dataset.id, e.target.querySelector("textarea").value);
      return;
    }
    if (e.target.matches("[data-reply-form]")) {
      e.preventDefault();
      const body = e.target.querySelector("textarea").value.trim();
      if (!uploadOps.size && (body || replyAttachments.length)) saveReplyDraft(e.target.dataset.id, body);
      return;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
        !e.defaultPrevented && !e.isComposing && !e.repeat && !reviewDeleted &&
        !document.querySelector("dialog[open]") && e.target instanceof Element &&
        !e.target.isContentEditable && !e.target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')) {
      e.preventDefault();
      openFileSearch();
      return;
    }
    if (e.key === "Enter" && e.ctrlKey && !e.isComposing && !e.repeat && e.target instanceof Element && e.target.matches('textarea[name="nc-body"], textarea[name="reply-body"]')) {
      e.preventDefault();
      e.target.form?.requestSubmit();
      return;
    }
    if (e.key === "Escape") clearFileDropTarget();
    // Let the topmost native dialog handle Escape without touching a background draft.
    if (e.key === "Escape" && document.querySelector("dialog[open]")) return;
    if (e.key === "Escape" && popOwner) { forceHidePop(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches('[data-action="open-file"]')) {
      e.preventDefault(); toggleCinema(e.target.dataset.id, e.target.dataset.nodeId); return;
    }
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element) {
      const h = e.target.closest('[data-action="toggle-thread-collapse"]');
      if (h && !e.target.closest("button, a")) { e.preventDefault(); toggleThreadCollapse(h.dataset.id, h); return; }
    }
    if (e.key === "Escape") {
      if (compose) { compose = null; persist(); render(); return; }
      if (replyTo) { replyTo = null; replyDraft = ""; replyAttachments = []; replyEditId = null; replyDirty = false; persist(); render(); return; }
      if (state.coverageOpen || state.notesOpen) { state.coverageOpen = false; state.notesOpen = false; persist(); render(); return; }
      if (Object.keys(state.activeFiles).length) { closeCinema(); return; }
    }
  });

  /* ---- diff selection highlighting -------------------------------------
     When the reviewer selects a token inside a diff, highlight every other
     occurrence of that exact text within the same file view (selection-hits.ts). */
  // The diff grid holding the document selection, if any. A selection inside a
  // text field (such as a line thread's draft) is the field's, not the diff's.
  function diffSelectionGrid(sel) {
    if (!sel || sel.isCollapsed || !sel.anchorNode) return null;
    const active = document.activeElement;
    if (active?.matches("input, textarea") && sel.anchorNode.contains(active)) return null;
    return sel.anchorNode.parentElement?.closest(".diff-grid") || null;
  }
  // The selection the matches were last computed for, so a scheduled refresh
  // that finds the same selection, such as the mouseup and selection change of
  // one double-click, does no work.
  let matchedSelection = null;
  const sameSelection = (a, b) => !a || !b ? a === b : a.grid === b.grid && a.term === b.term &&
    a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  function refreshDiffSelection(onlyIfChanged = false) {
    const sel = document.getSelection();
    let grid = null;
    let term = "";
    let range = null;
    const host = diffSelectionGrid(sel);
    if (host) {
      const t = String(sel).trim();
      if (t && t.length >= 2 && !/\n/.test(t)) {
        grid = host; term = t;
        range = sel.rangeCount ? sel.getRangeAt(0) : null;
      }
    }
    // The selection's range is live, so record its bounds.
    const current = grid ? { grid, term, startContainer: range?.startContainer, startOffset: range?.startOffset,
      endContainer: range?.endContainer, endOffset: range?.endOffset } : null;
    if (onlyIfChanged && sameSelection(current, matchedSelection)) return;
    matchedSelection = current;
    if (grid) highlightSelectionHits(grid, term, range);
    else clearSelectionHits();
  }
  function clearDiffSelection() {
    matchedSelection = null;
    clearSelectionHits();
  }
  // A drag in a diff is matched once, after the browser finishes the selection;
  // other selection changes, such as from the keyboard or select all, at most
  // once per frame. Both share one scheduled refresh.
  let selectingInDiff = false, selectionFrame = 0;
  function scheduleSelectionRefresh() {
    if (selectionFrame) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      if (!selectingInDiff) refreshDiffSelection(true);
    });
  }
  // Dragging already selected text starts a native drag that swallows the
  // mouseup, so the drag, a cancelled pointer, or a move with the button
  // released also end the selecting drag. The selection may have changed
  // during the drag, and no mouseup will refresh its matches.
  const endSelectingDrag = () => {
    if (!selectingInDiff) return;
    selectingInDiff = false;
    scheduleSelectionRefresh();
  };
  document.addEventListener("dragstart", endSelectingDrag);
  document.addEventListener("dragend", endSelectingDrag);
  document.addEventListener("pointercancel", endSelectingDrag);
  document.addEventListener("pointermove", (e) => { if (!(e.buttons & 1)) endSelectingDrag(); });
  document.addEventListener("mouseup", (e) => {
    selectingInDiff = false;
    if (!e.target.closest || !e.target.closest(".diff-scroll")) { clearDiffSelection(); return; }
    scheduleSelectionRefresh();
  });
  document.addEventListener("mousedown", (e) => {
    const inDiff = Boolean(e.target.closest && e.target.closest(".diff-scroll"));
    selectingInDiff = inDiff && e.button === 0;
    if (!inDiff) clearDiffSelection();
  });
  // Typing or moving the caret in a text field changes the selection without
  // touching a diff; only refresh when there are matches to clear or the
  // selection is in a diff.
  document.addEventListener("selectionchange", () => {
    if (selectingInDiff) return;
    if (document.activeElement?.matches("input, textarea") && !hasSelectionHits() && !diffSelectionGrid(document.getSelection())) return;
    scheduleSelectionRefresh();
  });

  // The scrolling parts of an open file's diff.
  const fileScrollers = [".diff-scroll", ".markdown-preview"];
  const _render = render;
  render = function () {
    forceHidePop();
    const focused = document.activeElement;
    // A control replaced by the render, as a draft's editor is when it moves
    // between its inline thread and the notes panel, passes focus to the one
    // that matches all it is identified by: its data attributes other than
    // tooltips, and its name and value. A control for something else, such as
    // another draft's Delete, never matches, so focus then stays where it fell.
    const focusSelector = focused?.matches?.("[data-action], textarea[name], input[name]")
      ? [...focused.attributes].filter(({ name }) => name === "name" || name === "value" || name.startsWith("data-") && !name.startsWith("data-tooltip"))
        .map(({ name, value }) => `[${name}="${cssEsc(value)}"]`).join("")
      : focused?.tagName === "SUMMARY" && focused.parentElement?.matches("details.node")
        ? `.stage[data-stage="${cssEsc(focused.closest(".stage")?.dataset.stage)}"] details.node[data-node="${cssEsc(focused.parentElement.dataset.node)}"] > summary`
        : null;
    const caret = focused && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    // Each open file's diff has its own inner scroll; capture it per file so
    // adding a line note (or any re-render) never resets where the reviewer is
    // looking within the diff.
    // Moving or recreating an element, as keyed lists do when stages, steps
    // or groups change, also resets the scroll of the diff or Markdown preview
    // inside it. Only a visible scroller reports its position, and only the
    // same scroller, still visible, gets it back after this render.
    const viewScrolls = new Map();
    Object.keys(state.activeFiles).forEach((fid) => {
      if (!activeFileNodeId(fid)) return;
      const holder = fileRowElement(fid)?.nextElementSibling;
      if (!holder?.classList.contains("cinema-diff")) return;
      for (const selector of fileScrollers) {
        const scroller = holder.querySelector(selector);
        if (scroller?.getClientRects().length) viewScrolls.set(`${fid}\0${selector}`, { top: scroller.scrollTop, left: scroller.scrollLeft });
      }
    });
    _render();
    Object.keys(state.activeFiles).forEach((fid) => {
      if (!activeFileNodeId(fid)) return;
      const row = fileRowElement(fid);
      const entry = fileById.get(fid);
      if (row && entry) {
        const holder = cinemaHolder(fid);
        for (const selector of fileScrollers) {
          const saved = viewScrolls.get(`${fid}\0${selector}`);
          const scroller = saved && holder?.querySelector(selector);
          if (scroller?.getClientRects().length) { scroller.scrollTop = saved.top; scroller.scrollLeft = saved.left; }
        }
      }
    });
    document.body.classList.toggle("no-scroll", state.notesOpen);
    // Moving a node, as a keyed list does when it reorders, blurs it although it survives.
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focused?.isConnected && focused !== document.body && focusLost && typeof focused.focus === "function") {
      focused.focus({ preventScroll: true });
    } else if (!focused?.isConnected && focusLost && focusSelector) {
      // A closed panel stays in the page, inert; only a usable control takes focus.
      const replacement = [...app.querySelectorAll(focusSelector)].find((el) => !el.closest("[inert]"));
      if (replacement) { replacement.focus({ preventScroll: true }); if (caret && replacement.setSelectionRange) replacement.setSelectionRange(...caret); }
    }
    loadOpenDiffs();
    resumePendingLazyJump();
  };

  const legacyDrafts = [...state.comments, compose].filter(note => note?.kind === "line" && !note.exported && note.snapshot && !note.snapshot.fileRevision);
  if (legacyDrafts.length && !reviewDeleted) {
    try {
      const response = await api.resolveDraftSnapshots({ notes: legacyDrafts });
      const result = await response.json();
      if (response.ok && result.ok) legacyDrafts.forEach((note, index) => {
        if (result.snapshots?.[index]?.fileRevision) note.snapshot = result.snapshots[index];
      });
    } catch { /* Unavailable original snapshots remain conservatively stale. */ }
  }
  for (const note of [...state.comments, compose].filter(Boolean)) {
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
    if (node) node.open = true;
  }
  if (reviewDeleted) void refreshReviews();
  window.setInterval(pollViewerRevision, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollViewerRevision(); });
  void pollViewerRevision();
})();
