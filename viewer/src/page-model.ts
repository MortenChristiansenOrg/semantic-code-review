// The model of the page: the story column with its stages, steps and files,
// the top bar, the agent bar, and the coverage and notes panels.
import type { ChangeNode, FeedbackThread, Insight, Requirement, SpecificationSource } from "../../scripts/src/shared/viewer-protocol";
import { AGENT_COMMAND, agent, agentAnswerOps, agentAnswers, agentCommandCopied, agentMinutes, agentTakesFeedback, agentWorkingOn, autoSendActive, autoSendPreferred, awaitsAgent, minimizedAgentQuestions } from "./agent";
import { acceptanceStatus, approvalOps, approvalState, approved, approvedCount, groupPendingApprovals, nodeApprovalState, pct, reviewable, revisionFor, stageApprovalState, stageApproved, stageNodesApproved } from "./approval-state";
import { data } from "./context";
import { specificationIsOpen } from "./details";
import { diffPanelModel } from "./diff-model";
import { compose } from "./editor";
import { exportState } from "./feedback-actions";
import { fileOccurrenceCounts } from "./file-search-dialog";
import { INSIGHT, evidenceKindLabel, INSIGHT_ORDER, INSIGHT_REVIEW, fileCodeInsights, hostsEvidenceThread, insightReviewState, insightSort, validationTypeLabel, vstatus } from "./insights";
import { activeFileNodeId, allAcceptance, artifactThreads, classificationFor, fileApprovalKey, fileById, fileKey, insightByKey, insightKey, nodeFileList, ownershipHint, parseInsightKey, requirements, stageById, stageFileApprovals, stageNumberById, stageOf } from "./lookups";
import { reviewsOpen } from "./saved-reviews";
import { refreshingRemote } from "./polling";
import { state } from "./state";
import { composerModel, inlineThreadModel, localNoteEntry, threadEntry, threadListEntries, uniqueKeys } from "./thread-models";
import { activeNoteCount, artifactThreadsForElement, elementNodeId, fileNoteCounts, heldThreads, localVisibleForElement, matchesNodeContext, noteFileEntry, noteNodeId, pendingFeedbackCount, threadListKey, threadNote, threadStateKey, threadToggleCounts, visibleLocalNotes } from "./threads";
import type { IndexedNote, NoteTarget, ThreadNote, ViewerFile, ViewerStage } from "./types";
import { dirShort, kindGlyph, kindLabel, shortPath, splitPath } from "./util";
import type { AgentBarView, AgentWaitingView, AgentWorkingView } from "./views/agent-bar";
import type { AcceptanceChipView, ApproveButtonView, NoteTargetKind, NotesToggleView } from "./views/controls";
import type { CoverageView } from "./views/coverage";
import type { FileRowView, NodeFilesView } from "./views/files";
import type { InsightTagView, ReasoningLegendView } from "./views/insights";
import type { NodeView } from "./views/node";
import type { NoteStageView, NotesPanelView } from "./views/notes-panel";
import type { StageView } from "./views/stage";
import type { SpecificationSourceView, SpecificationView, StoryView } from "./views/story";
import type { ThreadListView } from "./views/thread";
import type { AgentPresence, TopbarView } from "./views/topbar";

export const CLASS_LABEL: Record<string, string | undefined> = {
  behavior: "behavior", test: "test", configuration: "config",
  documentation: "docs", generated: "generated", dependency: "deps", chore: "chore"
};

export function stageAcceptanceRefs(stage: ViewerStage): string[] {
  return (stage.specificationRefs || []).filter(Boolean);
}
export function acceptanceChipModel(ref: string): AcceptanceChipView {
  const ac = allAcceptance.find((a) => a.ref === ref);
  const acId = ac ? ac.id : String(ref).split("#").at(-1) ?? "";
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

export function insightTagModel(stage: ViewerStage, ins: Insight, node: ChangeNode): InsightTagView {
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
    meta: (vs ? vtype : ins.evidence ? (evidenceKindLabel(ins.meta) || ins.meta) : ins.meta) || "",
    title: ins.title, body: ins.body || "",
    review, reviewMark: reviewInfo.mark, reviewText: reviewInfo.text, reviewTooltip: reviewInfo.tooltip,
    evidence: ins.evidence ? { notes: hostsEvidenceThread(ins, node) ? notesToggleModel("insight", key) : null } : null,
    code: ins.codeTarget ? { stageId: stage.id, collection: ins.collection, itemId: ins.id, needsReview: ins.codeTarget.status === "needs-review" } : null,
  };
}
export function reasoningLegendModel(insights: Insight[]): ReasoningLegendView | null {
  if (!insights.length) return null;
  return {
    entries: INSIGHT_ORDER
      .map((type) => ({ type, glyph: INSIGHT[type].glyph, label: INSIGHT[type].label, count: insights.filter((i) => i.type === type).length }))
      .filter((entry) => entry.count),
    notPassed: insights.filter((i) => { const v = vstatus(i); return Boolean(v) && v?.key !== "passed"; }).length,
  };
}

/* ---- approvals / comments UI ----------------------------------------- */
export function stageApproveModel(stage: ViewerStage): ApproveButtonView {
  const blocked = approvalOps.has(stage.id) || !stageNodesApproved(stage);
  const st = stageApprovalState(stage);
  const verb = blocked ? "Approve" : st === "stale" ? "Re-approve" : st === "approved" ? "Approved" : "Approve";
  return { kind: "stage", id: stage.id, state: st, blocked: blocked ? "Approve every step before approving the stage" : "",
    label: `${verb} stage ${stageNumber(stage)}: ${stage.title}` };
}
export function stageNumber(stage: ViewerStage): string { return String(data.stages.indexOf(stage) + 1).padStart(2, "0"); }

export function notesToggleModel(kind: NoteTargetKind, id: string, stageId?: string): NotesToggleView | null {
  const { total, open } = threadToggleCounts(kind, id, stageId);
  if (!total) return null;
  return { kind, id, stageId: stageId || "", total, open, expanded: Boolean(state.openThreads[threadStateKey(kind, id, stageId)]) };
}

/* ---- file rows -------------------------------------------------------- */
export function fileRowModel(stage: ViewerStage, node: ChangeNode, file: ViewerFile): FileRowView {
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
    previousPath: renamed || "", previousShort: renamed ? shortPath(renamed) : "",
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
export function fileNotesModel(id: string): ThreadListView {
  const composingNew = compose && compose.id === id && matchesNodeContext(compose, elementNodeId("file", id)) && compose.editIndex == null;
  const listKey = threadListKey("file", elementNodeId("file", id), id);
  const latest = artifactThreadsForElement("file", id);
  const threads = state.openThreads[id] === false ? [] : heldThreads(listKey, latest);
  const entries = state.openThreads[id] === false ? [] : threadListEntries(threads, localVisibleForElement(id, undefined, null, undefined, { key: listKey, threads, latest }));
  return { id, kind: "file", stageId: null, listKey, entries, composer: composingNew && compose ? composerModel(compose) : null };
}

export function nodeFilesModel(stage: ViewerStage, node: ChangeNode): NodeFilesView {
  const files = nodeFileList(stage, node);
  const fileApproved = (f: ViewerFile) => approved(fileApprovalKey(stage.id, node.id, f.path));
  // Group by owning .NET project (convention-based) for a quick overview.
  const groups = new Map<string, ViewerFile[]>();
  files.forEach((f) => {
    const k = f.project || "Other";
    let group = groups.get(k);
    if (!group) { group = []; groups.set(k, group); }
    group.push(f);
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


/* ---- chrome ----------------------------------------------------------- */
export function topbarModel(): TopbarView {
  const presence: AgentPresence | null = !agent ? null : agent.stopRequested ? "stopping" : agent.working ? "working" : agent.listening ? "listening" : "offline";
  return {
    remote: Boolean(data.remote), subject: data.remote?.branch || data.implementationId,
    agent: data.remote || !presence ? null : { presence, canStop: Boolean(agent?.session && !agent.stopRequested), command: AGENT_COMMAND, commandCopied: agentCommandCopied },
    refreshingRemote, reviewsOpen: Boolean(reviewsOpen), coverageOpen: Boolean(state.coverageOpen), notesOpen: Boolean(state.notesOpen),
    approved: approvedCount(), reviewable: reviewable(), percent: pct(), activeNotes: activeNoteCount(),
  };
}
export function agentBarModel(): AgentBarView | null {
  if (data.remote || !agent) return null;
  const queued = artifactThreads.filter((thread) => awaitsAgent(thread) && !agentWorkingOn(thread.id)).length;
  const status: AgentWorkingView | AgentWaitingView | null = agent.working
    ? { kind: "working", total: agent.working.threads.length, answered: agent.working.threads.filter((thread) => thread.answered).length,
      note: agent.working.note || "", minutes: agentMinutes(agent) || 0, queued, stopRequested: Boolean(agent.stopRequested) }
    : queued && !agent.listening ? { kind: "waiting", queued, command: AGENT_COMMAND, commandCopied: agentCommandCopied } : null;
  const refresh = agent.targetRefresh;
  return {
    status,
    targetRefresh: refresh && state.dismissedTargetRefresh !== refresh.at ? refresh : null,
    questions: agent.requests.map((request) => {
      const op = agentAnswerOps.get(request.id);
      return { id: request.id, body: request.body, choices: request.choices, answer: agentAnswers.get(request.id) || "", busy: Boolean(op?.busy), error: op?.error || "" };
    }),
    questionsMinimized: agent.requests.every((request) => minimizedAgentQuestions.has(request.id)),
  };
}


export const SOURCE_LABEL = new Map(Object.entries({
  "azure-devops": "Azure DevOps", github: "GitHub", url: "Link", local: "Local",
}));
// Only http(s) links are made clickable; anything else is shown as plain text
// so a spec source can never smuggle a javascript: or data: URL into an href.
export function safeHref(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch { return ""; }
}
export function sourceModel(source: SpecificationSource | undefined): SpecificationSourceView | null {
  if (!source || !source.kind) return null;
  const label = SOURCE_LABEL.get(source.kind) || source.kind;
  return { label, text: source.reference || label, href: safeHref(source.url) };
}
export function specificationModel(req: Requirement): SpecificationView {
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

export function nodeModel(stage: ViewerStage, node: ChangeNode, nodeIndex: number, stageIndex: number): NodeView {
  const linked = stage.insights.filter((i) => (i.nodeRefs || []).includes(node.id));
  const list = insightSort(linked);
  return {
    id: node.id, stageId: stage.id, index: `${stageIndex + 1}.${nodeIndex + 1}`,
    title: node.title, description: node.description,
    approval: nodeApprovalState(stage, node),
    legend: reasoningLegendModel(linked),
    insights: list.map((ins) => insightTagModel(stage, ins, node)),
    insightThreads: list.filter((ins) => hostsEvidenceThread(ins, node)).map((ins) => inlineThreadModel(insightKey(stage.id, ins.collection, ins.id), "insight")).filter((thread) => thread !== null),
    files: nodeFilesModel(stage, node),
    notes: notesToggleModel("node", node.id, stage.id),
    thread: inlineThreadModel(node.id, "node", stage.id),
  };
}

export function stageModel(stage: ViewerStage, i: number): StageView {
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

export function storyModel(): StoryView {
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
export function coverageModel(): CoverageView {
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

/** A note or a thread in the notes panel. */
export type NoteListItem = (IndexedNote & { thread?: undefined }) | { c: ThreadNote; i?: undefined; thread: FeedbackThread };
interface DayGroup { key: string; label: string; items: NoteListItem[] }
interface NodeGroup { key: string; ni: number; title: string; days: Map<string, DayGroup>; daysArr: DayGroup[] }
interface StageGroup { si: number; key: string; title: string; nodes: Map<string, NodeGroup>; nodesArr: NodeGroup[] }

export function noteGroupKey(c: NoteTarget) {
  const entry = noteFileEntry(c.kind, c.id);
  const stage = c.kind === "stage" ? stageOf(c.id) : entry?.stage || stageOf(c.kind === "insight" ? parseInsightKey(c.id)?.stageId : c.stageId);
  const si = stage ? data.stages.indexOf(stage) : 900;
  const nodeId = c.kind === "node" ? c.id : c.kind === "insight" ? insightByKey(c.id ?? "")?.nodeRefs?.[0] : noteNodeId(c);
  const ni = nodeId ? stage?.nodes.findIndex((n) => n.id === nodeId) ?? -1 : -1;
  // The stage's ID keys its group, so a reordered stage keeps its notes' elements.
  return { si, stageKey: stage ? `stage:${stage.id}` : "other", stageTitle: stage?.title || "Other targets", ni,
    // Real node IDs have their own namespace, so a node named "overview" or "unknown" keeps its own group.
    nodeKey: JSON.stringify([stage?.id || "", nodeId ? `node:${nodeId}` : c.kind === "stage" ? "overview" : "unknown"]),
    nodeTitle: ni >= 0 && stage ? stage.nodes[ni].title : c.kind === "stage" ? "Stage overview" : "Other targets / original step unknown" };
}
export function noteDayKey(c: { createdAt?: string | number }): { key: string; label: string } {
  if (!c.createdAt) return { key: "0000-00-00", label: "Undated" };
  const d = new Date(c.createdAt);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const label = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return { key, label };
}
export function groupedNotes(entries: NoteListItem[]): StageGroup[] {
  const stageMap = new Map<number, StageGroup>();
  entries.forEach((item) => {
    const g = noteGroupKey(item.c);
    const d = noteDayKey(item.c);
    let st = stageMap.get(g.si);
    if (!st) { st = { si: g.si, key: g.stageKey, title: g.stageTitle, nodes: new Map(), nodesArr: [] }; stageMap.set(g.si, st); }
    let nd = st.nodes.get(g.nodeKey);
    if (!nd) { nd = { key: g.nodeKey, ni: g.ni, title: g.nodeTitle, days: new Map(), daysArr: [] }; st.nodes.set(g.nodeKey, nd); }
    let day = nd.days.get(d.key);
    if (!day) { day = { key: d.key, label: d.label, items: [] }; nd.days.set(d.key, day); }
    day.items.push(item);
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

export function noteGroupsModel(entries: NoteListItem[]): NoteStageView[] {
  return groupedNotes(entries).map((st) => ({ key: st.key, title: st.title,
    nodes: st.nodesArr.map((nd) => ({ key: nd.key, title: nd.title,
      days: nd.daysArr.map((day) => ({ key: day.key, label: day.label,
        entries: uniqueKeys(day.items.map((item) => item.thread ? threadEntry(item.thread, true) : localNoteEntry({ c: item.c, i: item.i }, true))) })) })) }));
}
export function notesPanelModel(): NotesPanelView {
  // Each column is held on its own; the reviewer's own resolve or reopen still moves a held thread.
  const latestActive = artifactThreads.filter((t) => t.status !== "resolved");
  const activeThreads = heldThreads("notes:active", latestActive).filter((t) => t.status !== "resolved");
  const resolvedThreads = heldThreads("notes:resolved", artifactThreads.filter((t) => t.status === "resolved")).filter((t) => t.status === "resolved");
  const groups = (threads: FeedbackThread[], locals: IndexedNote[]) => noteGroupsModel([...threads.map((thread) => ({ c: threadNote(thread), thread })), ...locals]);
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
