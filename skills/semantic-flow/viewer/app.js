/* Semantic Flow review viewer — Cinema.
   Renders a semantic implementation artifact (window.SEMANTIC_IMPLEMENTATION) as a full-bleed
   inline-diff reading experience. */
(function () {
  "use strict";

  const data = window.SEMANTIC_IMPLEMENTATION;
  const app = document.querySelector("#app");
  const storeKey = `semantic-view:${data.implementationId}`;
  let observedAwaitingAgentReplies = Number(data.awaitingAgentReplies) || 0;

  function adoptViewerSnapshot(snapshot) {
    if (!snapshot || typeof snapshot.revision !== "string") return;
    observedAwaitingAgentReplies = Number(snapshot.awaitingAgentReplies) || 0;
  }

  async function pollViewerRevision() {
    try {
      const response = await fetch("/api/revision", { cache: "no-store" });
      if (!response.ok) return;
      const snapshot = await response.json();
      if (!snapshot.ok || typeof snapshot.revision !== "string") return;
      const awaiting = Number(snapshot.awaitingAgentReplies) || 0;
      const feedbackCompleted =
        observedAwaitingAgentReplies > 0 && awaiting === 0;
      if (feedbackCompleted) {
        const hasUnsavedNote =
          Boolean(compose && compose.dirty) ||
          Boolean(replyTo && replyDirty);
        if (
          !hasUnsavedNote ||
          window.confirm(
            "Feedback is ready. Reload now and lose your unsaved note? Select Cancel to keep editing and reload manually.",
          )
        ) {
          window.location.reload();
          return;
        }
      }
      observedAwaitingAgentReplies = awaiting;
    } catch {
      // The viewer may be restarting. The next poll will retry.
    }
  }

  const INSIGHT = {
    decision:    { glyph: "◆", label: "Decision" },
    assumption:  { glyph: "◇", label: "Assumption" },
    risk:        { glyph: "△", label: "Risk" },
    validation:  { glyph: "✓", label: "Check" },
    lesson:      { glyph: "↺", label: "Lesson" },
    alternative: { glyph: "⇄", label: "Alternative" },
    question:    { glyph: "?", label: "Open question" }
  };
  const INSIGHT_ORDER = ["decision", "assumption", "risk", "lesson", "alternative", "validation", "question"];

  const CLASS_LABEL = {
    behavior: "behavior", test: "test", configuration: "config",
    documentation: "docs", generated: "generated", dependency: "deps", chore: "chore"
  };

  /* ---- ids & lookups ---------------------------------------------------- */
  const fileKey = (stageId, path) => `f:${stageId}:${path}`;
  const insightKey = (stageId, collection, itemId) =>
    `i:${stageId}:${collection}:${itemId}`;
  // A line thread's element id carries everything needed to resolve a feedback
  // target: the stage, which diff side the line lives on, its line number, and
  // the file path (kept last so paths with no colons parse unambiguously).
  const lineKey = (stageId, side, line, path) => `l:${stageId}:${side}:${line}:${path}`;
  function parseLineId(id) {
    const m = /^l:([^:]+):(old|new):(\d+):(.+)$/.exec(id || "");
    if (!m) return null;
    return { stageId: m[1], side: m[2], line: Number(m[3]), path: m[4] };
  }
  const nodeTitleById = new Map();
  data.stages.forEach((s) => s.nodes.forEach((n) => nodeTitleById.set(n.id, n.title)));
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
  const diffRequests = new Map();
  async function ensureFileDiff(entry) {
    if (!entry || Array.isArray(entry.file.lines) || diffRequests.has(entry.id)) return;
    entry.file._diffLoading = true;
    delete entry.file._diffError;
    const query = new URLSearchParams({
      stage: entry.stage.id,
      path: entry.file.path,
      base: entry.stage.baseRevision,
      head: entry.stage.headRevision,
    });
    const request = fetch(`/api/diff?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `Diff request failed with status ${response.status}.`);
        }
        if (!Array.isArray(payload.lines)) {
          throw new Error("Diff response did not include lines.");
        }
        entry.file.lines = payload.lines;
        entry.file.additions = Number(payload.additions) || 0;
        entry.file.deletions = Number(payload.deletions) || 0;
        entry.file.binary = Boolean(payload.binary);
        entry.file.truncated = Boolean(payload.truncated);
        delete entry.file._ownership;
      })
      .catch((error) => {
        entry.file._diffError = error.message || "Diff could not be loaded.";
      })
      .finally(() => {
        entry.file._diffLoading = false;
        diffRequests.delete(entry.id);
        render();
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

  function stageFileEntry(stageId, path) {
    return fileById.get(fileKey(stageId, path));
  }
  function nodeFileList(stage, node) {
    return stage.files.filter((file) => file.memberships.some((m) => m.nodeId === node.id));
  }
  function classificationFor(file, nodeId) {
    const m = file.memberships.find((x) => x.nodeId === nodeId) || file.memberships[0];
    return m ? m.classification : "behavior";
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
  let compose = null;              // inline note composer: {kind,id,stageId,editIndex,mode,body}
  let replyTo = null;              // artifact thread id currently being replied to
  let replyDraft = "";             // unsent text of the open reply, kept across re-renders
  let replyEditId = null;          // id of the pending reply draft being edited (if any)
  let replyDirty = false;
  let pendingLazyJump = null;
  function resumePendingLazyJump() {
    if (!pendingLazyJump) return;
    const pending = pendingLazyJump;
    const entry = fileById.get(pending.fileId);
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
        const node = app.querySelector(
          `details.node[data-node="${cssEsc(pending.membership.nodeId)}"]`,
        );
        if (node) node.open = true;
      }
      requestAnimationFrame(() => {
        const target = exact
          ? app.querySelector(`.line-thread[data-thread="${cssEsc(pending.id)}"]`)
          : app.querySelector(`.frow[data-file="${cssEsc(pending.fileId)}"]`);
        if (target)
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        if (entry) fadeFileHighlight(entry.id, "in");
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
      comments: [],
      openStages: { [data.stages[0].id]: true },
      openThreads: {},
      lastNoteMode: "personal",
      specificationOpen: {},
      coverageOpen: false,
      notesOpen: false,
      pinnedInsight: null,
      hideApproved: false,
      fileView: {},
      hideDeleted: {},
      threadCollapsed: {},
      openLineThreads: {},
      activeFiles: {},
      notesFilter: "active",
      replyDrafts: []
    };
  }
  function load() {
    try {
      const merged = { ...defaults(), ...JSON.parse(localStorage.getItem(storeKey) || "{}") };
      // Legacy state stored a single boolean; map it onto the first specification.
      if (typeof merged.specificationOpen !== "object" || merged.specificationOpen === null) {
        merged.specificationOpen = merged.specificationOpen && requirements[0]
          ? { [requirements[0].id]: true }
          : {};
      }
      // Legacy state stored a single open file in `active`; migrate to the map.
      if (typeof merged.activeFiles !== "object" || merged.activeFiles === null) merged.activeFiles = {};
      if (merged.active) { merged.activeFiles[merged.active] = true; }
      delete merged.active;
      return merged;
    }
    catch { return defaults(); }
  }
  function persist() { localStorage.setItem(storeKey, JSON.stringify(state)); }

  /* ---- helpers ---------------------------------------------------------- */
  function esc(v) {
    return String(v)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function formatCommentBody(v) {
    return esc(v).replace(/`([^`\r\n]+)`/g, "<code>$1</code>");
  }
  /* File approvals carry a fingerprint of the diff at approval time so we can
     tell when a file has changed since it was approved (stale). Stage approvals
     have no fingerprint and are always current once approved. Legacy boolean
     approvals (older stored state) are trusted as approved. */
  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  function fileFingerprint(entry) {
    const f = entry.file;
    return hashStr(JSON.stringify({
      k: f.kind, b: !!f.binary, t: !!f.truncated,
      lines: (f.lines || []).map((r) => [r.t, r.o, r.n, r.s])
    }));
  }
  function fingerprintFor(id) {
    const entry = fileById.get(id);
    return entry ? fileFingerprint(entry) : null;
  }
  function revisionFor(id) {
    return fileById.get(id)?.file.revision || null;
  }
  // A renamed file's approval was recorded under its pre-rename element id. Map
  // to that id so the sign-off is not lost when the path changes.
  function previousApprovalId(id) {
    const entry = fileById.get(id);
    if (entry && entry.file.kind === "renamed" && entry.file.previousPath)
      return fileKey(entry.stage.id, entry.file.previousPath);
    return null;
  }
  function approvalState(id) {
    const rec = state.approvals[id];
    if (rec) {
      if (rec === true) return "approved";
      if (rec.rev != null)
        return rec.rev === revisionFor(id) ? "approved" : "stale";
      if (rec.fp == null) return "approved";
      const entry = fileById.get(id);
      if (entry && !Array.isArray(entry.file.lines)) return "approved";
      return rec.fp === fingerprintFor(id) ? "approved" : "stale";
    }
    // An approval inherited from before a rename can never still match the file
    // as it stands now, so surface it as stale to prompt a fresh look.
    const prevId = previousApprovalId(id);
    if (prevId && state.approvals[prevId]) return "stale";
    return "none";
  }
  const approved = (id) => approvalState(id) === "approved";
  const approvalStale = (id) => approvalState(id) === "stale";
  function aggregateApprovalState(states) {
    if (!states.length || states.some((st) => st === "none")) return "none";
    return states.every((st) => st === "approved") ? "approved" : "stale";
  }
  function nodeApprovalState(stage, node) {
    return aggregateApprovalState(
      nodeFileList(stage, node).map((file) => approvalState(fileKey(stage.id, file.path))),
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
      // Node approvals are derived from their files now; drop any legacy
      // node-keyed entries left behind by older stored state.
      stage.nodes.forEach((node) => {
        if (node.id in state.approvals) {
          delete state.approvals[node.id];
          changed = true;
        }
      });
    });
    if (changed) persist();
  }
  function elementNotes(id) {
    return state.comments.map((c, i) => ({ c, i })).filter((x) => x.c.id === id);
  }

  /* ---- artifact feedback threads (from window.SEMANTIC_IMPLEMENTATION.feedback) -- */
  const artifactThreads = Array.isArray(data.feedback) ? data.feedback : [];
  function fileElementId(stageId, p) { return `f:${stageId}:${p}`; }
  function artifactThreadById(tid) {
    return tid ? artifactThreads.find((t) => t.id === tid) : undefined;
  }
  function artifactThreadsForElement(kind, id) {
    return artifactThreads.filter((t) => {
      const tk = t.target && t.target.kind;
      if (kind === "stage") return tk === "stage" && t.target.stageId === id;
      if (kind === "file")
        return tk === "file" && fileElementId(t.target.stageId, t.target.path) === id;
      if (kind === "line")
        return (
          tk === "line" &&
          lineKey(t.target.stageId, t.target.side, t.target.line, t.target.path) === id
        );
      return false;
    });
  }
  // Local notes still worth showing: drafts, plus exported notes whose artifact
  // thread has not been reloaded yet. Once the artifact thread is present the
  // local marker is hidden so a sent note is never rendered twice.
  function localVisibleForElement(id) {
    return elementNotes(id).filter(
      ({ c }) => !c.exported || !artifactThreadById(c.threadId),
    );
  }
  function visibleThreadCount(kind, id) {
    return (
      artifactThreadsForElement(kind, id).filter((t) => t.status !== "resolved").length +
      localVisibleForElement(id).length
    );
  }
  // Files list splits its badge into two: unresolved feedback conversations
  // (exported threads + local feedback drafts) and browser-local personal notes.
  function unresolvedThreadCount(kind, id) {
    return (
      artifactThreadsForElement(kind, id).filter((t) => t.status !== "resolved").length +
      localVisibleForElement(id).filter(({ c }) => (c.mode || "personal") === "feedback").length
    );
  }
  function personalNoteCount(id) {
    return localVisibleForElement(id).filter(({ c }) => (c.mode || "personal") !== "feedback").length;
  }
  function visibleLocalNotes() {
    return state.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.exported || !artifactThreadById(c.threadId));
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
  function acChip(ref) {
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
    return `<button class="ac-chip tag-face" type="button" data-tagpop="1"
      data-type="acceptance" data-vstat="${m.vstat}"
      data-glyph="${esc(m.glyph)}" data-label="${esc(m.label)}" data-meta="${esc(`${acId} · ${stages}`)}"
      data-title="${esc(ac ? ac.text : acId)}" data-body=""
      aria-haspopup="true"><span class="ac-chip-id">${esc(acId)}</span><span class="ac-chip-stat vstat-${m.vstat}">${esc(m.glyph)}</span></button>`;
  }
  function bubble() {
    return `<svg class="bub" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  }
  function bubblePlus() {
    return `<svg class="bub" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 8v5M9.5 10.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }
  // A personal (browser-local) note — distinct from a feedback conversation.
  function noteGlyph() {
    return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13.5 3.5V8h4.5M9.5 12.5h6M9.5 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  function arrowRight() {
    return `<svg class="tico" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  function threadTypeIcon(kind) {
    if (kind === "stage")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M12 3.5l8 4-8 4-8-4 8-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    if (kind === "node")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/></svg>`;
    if (kind === "specification")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M12 3.2l2.3 5 5.5.5-4.1 3.6 1.2 5.3L12 20.4 6.8 22.6 8 17.3 3.9 13.7l5.5-.5 2.3-5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    if (kind === "criterion")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 12.4l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (kind === "insight")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M9 18h6M10 21h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 3a6 6 0 0 0-3.4 10.9c.6.4.9 1 .9 1.6v.5h5v-.5c0-.6.3-1.2.9-1.6A6 6 0 0 0 12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13.5 3.5V8h4.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
  function threadStatusIcon(status) {
    if (status === "resolved")
      return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg>`;
  }

  function reviewable() {
    let n = 0;
    data.stages.forEach((s) => { n += 1 + s.nodes.length + s.files.length; });
    return n;
  }
  function approvedCount() {
    let n = 0;
    data.stages.forEach((s) => {
      if (stageApproved(s)) n += 1;
      s.nodes.forEach((node) => { if (nodeApprovalState(s, node) === "approved") n += 1; });
      s.files.forEach((file) => { if (approved(fileKey(s.id, file.path))) n += 1; });
    });
    return n;
  }
  const pct = () => Math.round((approvedCount() / reviewable()) * 100);

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
  // A renamed/moved file shows where it came from so reviewers can place it; the
  // full pre-rename path stays in the tooltip when the shown one is shortened.
  function renameFrom(file) {
    if (file.kind !== "renamed" || !file.previousPath) return "";
    return `<span class="fp-from" title="Renamed from ${esc(file.previousPath)}">← ${esc(shortPath(file.previousPath))}</span>`;
  }
  function caret() {
    return `<svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  function reasoningChip(stage, ins) {
    const info = INSIGHT[ins.type] || INSIGHT.decision;
    const vs = vstatus(ins);
    const glyph = vs ? vs.glyph : info.glyph;
    const label = vs ? vs.label : info.label;
    // For validation, the status is already carried by the glyph, so the free
    // meta slot instead surfaces the evidence type (automated/manual/analysis)
    // without displacing the pass/fail signal.
    const vtype = ins.type === "validation" ? validationTypeLabel(ins.validationType) : "";
    const meta = vs ? vtype : (ins.meta || "");
    const kindText = vtype ? `${info.label} · ${vtype}` : info.label;
    return `<span class="tag type-${ins.type} ${vs ? `vstat-${vs.key}` : ""}" data-insight="${esc(insightKey(stage.id, ins.collection, ins.id))}">
      <button class="tag-face" type="button" data-tagpop="1"
        data-type="${ins.type}" data-vstat="${vs ? vs.key : ""}"
        data-glyph="${esc(glyph)}" data-label="${esc(label)}" data-meta="${esc(meta)}"
        data-title="${esc(ins.title)}" data-body="${esc(ins.body || "")}"
        aria-haspopup="true">
        <b>${glyph}</b><span class="tag-kind">${esc(kindText)}</span><span class="tag-gist">${esc(ins.title)}</span>
      </button>
    </span>`;
  }
  function reasoningSummary(stage) {
    const insights = stage.insights;
    if (!insights.length) return "";
    const counts = INSIGHT_ORDER
      .map((t) => ({ t, c: insights.filter((i) => i.type === t).length }))
      .filter((x) => x.c);
    const legend = counts.map((x) => `<span class="rk type-${x.t}"><b>${INSIGHT[x.t].glyph}</b>${x.c}</span>`).join("");
    const failed = insights.filter((i) => { const v = vstatus(i); return v && v.key !== "passed"; }).length;
    const alert = failed ? `<span class="rk rk-alert" title="${failed} check${failed === 1 ? "" : "s"} not passed"><b>✕</b>${failed}</span>` : "";
    return `<div class="reasoning-summary"><span class="eyebrow">Reasoning</span><div class="reasoning-key">${legend}${alert}</div></div>`;
  }
  function nodeReasoning(stage, node) {
    const list = insightSort(stage.insights.filter((i) => (i.nodeRefs || []).includes(node.id)));
    if (!list.length) return "";
    return `<div class="node-reasoning">
      <span class="eyebrow">Reasoning</span>
      <div class="tag-row">${list.map((ins) => reasoningChip(stage, ins)).join("")}</div>
    </div>`;
  }

  /* ---- approvals / comments UI ----------------------------------------- */
  function approveBtn(kind, id, size = "") {
    const stage = kind === "stage" ? stageById.get(id) : null;
    const blocked = stage && !stageNodesApproved(stage);
    const st = stage ? stageApprovalState(stage) : approvalState(id);
    if (blocked) {
      return `<button class="approve ${size}" data-action="approve" data-kind="${kind}" data-id="${id}" type="button" aria-pressed="false" disabled title="Approve every step before approving the stage">
        <span class="check"></span>Approve</button>`;
    }
    if (st === "stale") {
      return `<button class="approve ${size} is-stale" data-action="approve" data-kind="${kind}" data-id="${id}" type="button" aria-pressed="false" title="Changed since you approved it — click to re-approve">
        <span class="check">!</span>Re-approve</button>`;
    }
    const on = st === "approved";
    return `<button class="approve ${size} ${on ? "is-on" : ""}" data-action="approve" data-kind="${kind}" data-id="${id}" type="button" aria-pressed="${on}">
      <span class="check">${on ? "✓" : ""}</span>${on ? "Approved" : "Approve"}</button>`;
  }
  function commentBtn(kind, id, stageId) {
    return `<button class="comment" data-action="comment" data-kind="${kind}" data-id="${id}" data-stage="${stageId || ""}" type="button">＋ Add note</button>`;
  }
  function notesToggle(kind, id) {
    const count = visibleThreadCount(kind, id);
    if (!count) return "";
    const open = Boolean(state.openThreads[id]);
    return `<button class="notes-toggle ${open ? "is-open" : ""}" data-action="toggle-thread" data-id="${id}" type="button" aria-expanded="${open}" title="${count} thread${count === 1 ? "" : "s"}">
      ${bubble()}<b>${count}</b></button>`;
  }
  function noteCluster(kind, id, stageId) {
    return `<div class="note-cluster">${commentBtn(kind, id, stageId)}${notesToggle(kind, id)}</div>`;
  }
  function stageNoteCluster(id) {
    return `<div class="note-cluster">${notesToggle("stage", id)}${commentBtn("stage", id)}</div>`;
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
  // notes list can offer a "show" jump. Only file and stage targets map cleanly.
  // File and line targets resolve against the file that currently holds the
  // path (following a rename); a target whose file no longer exists yields no
  // ref so the jump control can be withheld.
  function threadElementRef(t) {
    const tgt = (t && t.target) || {};
    if (tgt.kind === "file" && tgt.path && tgt.stageId) {
      const entry = currentFileEntry(tgt.stageId, tgt.path);
      return entry ? { kind: "file", id: entry.id } : null;
    }
    if (tgt.kind === "line" && tgt.path && tgt.stageId && tgt.line) {
      const entry = currentFileEntry(tgt.stageId, tgt.path);
      if (!entry) return null;
      // A later stage head can remove or move the saved line. Only offer an
      // exact jump while that side and line still exist in the rendered diff.
      if (entry.file.path === tgt.path && !Array.isArray(entry.file.lines))
        return { kind: "line", id: lineKey(tgt.stageId, tgt.side, tgt.line, tgt.path) };
      if (entry.file.path === tgt.path && fileHasLine(entry.file, tgt.side, tgt.line))
        return { kind: "line", id: lineKey(tgt.stageId, tgt.side, tgt.line, tgt.path) };
      return { kind: "file", id: entry.id };
    }
    if (tgt.kind === "stage" && tgt.stageId)
      return data.stages.some((s) => s.id === tgt.stageId) ? { kind: "stage", id: tgt.stageId } : null;
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
        : { kind: "stage", id: tgt.stageId };
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
  // An exported feedback thread: a reviewer <-> agent conversation the reviewer
  // can continue, mark resolved, or reopen. Only the reviewer controls closure.
  function renderArtifactThread(t, withLabel, collapsedOverride) {
    const collapsed = collapsedOverride !== undefined ? collapsedOverride : threadCollapsed(t);
    const msgs = (t.comments || [])
      .map((cm) => {
        const agent = cm.author === "agent";
        const stamp = fmtTime(cm.createdAt);
        return `<div class="tmsg tmsg-${agent ? "agent" : "user"}">
          <div class="tmsg-h"><span class="tmsg-who">${agent ? "Implementation agent" : "You"}</span>${stamp ? `<time>${esc(stamp)}</time>` : ""}</div>
          <p class="comment-body">${formatCommentBody(cm.body)}</p>
        </div>`;
      })
      .join("");
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
    const assignedTag = showAssigned
      ? `<span class="tthread-stage" title="Assigned to stage: ${esc(assignedStage.title)}">${esc(assignedStage.title)}</span>`
      : "";
    const jump = !withLabel
      ? ""
      : ref
        ? `<button class="tthread-jump" data-action="jump-to" data-kind="${ref.kind}" data-id="${esc(ref.id)}" type="button" title="Show what this thread is about" aria-label="Show what this thread is about">${arrowRight()}</button>`
        : tstate.state === "deleted"
          ? `<button class="tthread-jump" type="button" disabled title="This file no longer exists" aria-label="This file no longer exists">${arrowRight()}</button>`
          : "";
    const title =
      withLabel && t.target && t.target.label
        ? `<strong class="tthread-title" title="${esc(disp.title)}">${esc(disp.text)}</strong>`
        : `<span class="tthread-title tthread-title-empty" aria-hidden="true"></span>`;
    const busy = threadBusy(t.id);
    let staleMsg = "";
    if (tstate.state === "deleted")
      staleMsg = `This file was deleted after the feedback was sent.`;
    else if (tstate.state === "renamed")
      staleMsg = `This file was renamed to ${esc(splitPath(tstate.to).name)} after the feedback was sent.`;
    else if (tstate.state === "not-in-stage")
      staleMsg = `This file is no longer changed in this stage.`;
    else if (t.anchorStale && !(t.comments || []).some((cm) => cm.author === "agent"))
      staleMsg = `Stage changed since this feedback was sent.`;
    const stale = staleMsg
      ? `<p class="tthread-stale">${staleMsg}</p>`
      : "";
    const err = threadError(t.id)
      ? `<p class="tthread-err">${esc(threadError(t.id))}</p>`
      : "";
    // Pending reply drafts render as unsent messages the reviewer can revise or
    // remove before preparing feedback; the one being edited is shown as a form.
    const draftReplies = repliesForThread(t.id)
      .filter((r) => r.id !== replyEditId)
      .map((r) => `<div class="tmsg tmsg-user tmsg-draft" data-reply-id="${esc(r.id)}">
          <div class="tmsg-h"><span class="tmsg-who">You</span><span class="tmsg-draft-tag">Draft</span>
            <span class="tmsg-act">
              <button data-action="reply-edit" data-id="${esc(t.id)}" data-reply-id="${esc(r.id)}" type="button">Edit</button>
              <button class="tmsg-del" data-action="reply-del" data-reply-id="${esc(r.id)}" type="button" aria-label="Delete draft reply">×</button>
            </span>
          </div>
          <p class="comment-body">${formatCommentBody(r.body)}</p>
        </div>`)
      .join("");
    const actionable = t.status === "open" || t.status === "resolved";
    const actions = actionable
      ? `<div class="tthread-act">
          ${t.status === "resolved"
            ? `<button data-action="thread-reopen" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>${busy ? `<span class="tspin" aria-hidden="true"></span>Reopening…` : "Unresolve"}</button>`
            : `<button class="tthread-resolve" data-action="thread-resolve" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>${busy ? `<span class="tspin" aria-hidden="true"></span>Resolving…` : "Mark resolved"}</button>`}
          ${replyTo === t.id ? "" : `<button data-action="thread-reply" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>Reply</button>`}
        </div>`
      : "";
    const editing = replyTo === t.id && replyEditId != null;
    const replyForm = replyTo === t.id
      ? `<form class="tthread-reply" data-reply-form data-id="${esc(t.id)}">
          <textarea name="reply-body" rows="3" required placeholder="Continue the conversation…">${esc(replyDraft)}</textarea>
          <div class="nc-actions"><button type="button" data-action="reply-cancel">Cancel</button><button class="nc-save" type="submit">${editing ? "Update reply" : "Save reply"}</button></div>
        </form>`
      : "";
    return `<article class="tthread status-${t.status} ${collapsed ? "is-collapsed" : ""}" data-thread-id="${esc(t.id)}">
      <div class="tthread-h" data-action="toggle-thread-collapse" data-id="${esc(t.id)}" role="button" tabindex="0" aria-expanded="${String(!collapsed)}" title="${collapsed ? "Expand thread" : "Collapse thread"}">
        <span class="tthread-caret">${caret()}</span>
        <span class="tthread-type" title="${esc(threadTypeLabel(kind))}" aria-label="${esc(threadTypeLabel(kind))}">${threadTypeIcon(kind)}</span>
        ${title}
        ${assignedTag}
        <span class="tthread-status-ic s-${t.status}" title="${esc(t.status)}" aria-label="${esc(t.status)}">${threadStatusIcon(t.status)}</span>
        ${jump}
      </div>
      <div class="tthread-body">
        <div class="tthread-body-inner">
          ${stale}
          <div class="tthread-msgs">${msgs}${draftReplies}</div>
          ${err}
          ${actions}
          ${replyForm}
        </div>
      </div>
    </article>`;
  }
  // A browser-local note. Drafts can be edited/deleted; a sent note awaiting its
  // artifact thread is shown read-only.
  function renderLocalNote({ c, i }) {
    if (compose && compose.editIndex === i) return renderComposer(compose);
    const sent = Boolean(c.exported);
    const mode = c.mode || "personal";
    const acts = sent
      ? ""
      : `<div class="tnote-act">
          <button data-action="edit-note" data-index="${i}" type="button">Edit</button>
          <button class="tnote-del" data-action="del-note" data-index="${i}" type="button" aria-label="Delete note">×</button>
        </div>`;
    return `<article class="tnote mode-${mode} ${sent ? "is-sent" : "is-draft"}">
        <div class="tnote-h">
          <span class="tnote-mode">${mode === "feedback" ? "Feedback" : "Personal"}</span>
          ${mode === "feedback" ? `<span class="tnote-state">${sent ? "Sent" : "Draft"}</span>` : ""}
          ${acts}
        </div>
        <p class="comment-body">${formatCommentBody(c.body)}</p>
      </article>`;
  }
  // Inline note composer, rendered directly in the element's own thread so the
  // reviewer can keep looking at what they are commenting on while they write.
  function renderComposer(ctx) {
    const mode = ctx.mode === "feedback" ? "feedback" : "personal";
    return `<form class="note-compose mode-${mode}" data-note-form>
      <div class="nc-mode" role="radiogroup" aria-label="Note type">
        <label class="nc-opt"><input type="radio" name="nc-mode" value="personal" ${mode !== "feedback" ? "checked" : ""}><span><b>Personal</b><small>Just for you.</small></span></label>
        <label class="nc-opt"><input type="radio" name="nc-mode" value="feedback" ${mode === "feedback" ? "checked" : ""}><span><b>Feedback</b><small>For the author.</small></span></label>
      </div>
      <textarea name="nc-body" rows="3" required placeholder="A concise observation for your review…">${esc(ctx.body || "")}</textarea>
      <div class="nc-actions">
        <button type="button" data-action="compose-cancel">Cancel</button>
        <button class="nc-save" type="submit">${ctx.editIndex != null ? "Save note" : "Add note"}</button>
      </div>
    </form>`;
  }
  function threadInline(id, kind) {
    const composingNew = compose && compose.id === id && compose.editIndex == null;
    const arts = artifactThreadsForElement(kind, id);
    const locals = localVisibleForElement(id);
    const hasContent = arts.length || locals.length;
    if (!state.openThreads[id] && !composingNew) return "";
    if (!hasContent && !composingNew) return "";
    const rows =
      arts.map((t) => renderArtifactThread(t, false)).join("") +
      locals.map((ln) => renderLocalNote(ln)).join("");
    const footer = composingNew
      ? renderComposer(compose)
      : `<button class="thread-add" data-action="comment" data-kind="${kind}" data-id="${id}" type="button">＋ Add note</button>`;
    return `<div class="thread" data-thread="${id}">${rows}${footer}</div>`;
  }

  /* ---- file rows -------------------------------------------------------- */
  function classBadge(cls) {
    return `<span class="cls cls-${cls}">${CLASS_LABEL[cls] || cls}</span>`;
  }
  function fileMetrics(file) {
    return `<span class="metrics"><i class="add">+${file.additions}</i><i class="del">−${file.deletions}</i></span>`;
  }
  function fileRow(stage, node, file) {
    const id = fileKey(stage.id, file.path);
    const cls = classificationFor(file, node.id);
    const { name } = splitPath(file.path);
    const dir = dirShort(splitPath(file.path).dir);
    const shared = (file.memberships || []).length > 1;
    const hint = shared ? ownershipHint(file, node.id) : "";
    const sharedChip = hint
      ? `<span class="cls cls-shared" title="Split across steps — this step owns ${esc(hint)}.">shared</span>`
      : "";
    const st = approvalState(id);
    const isOn = st === "approved";
    const isStale = st === "stale";
    const isActive = Boolean(state.activeFiles[id]);
    const threadN = unresolvedThreadCount("file", id);
    const noteN = personalNoteCount(id);
    const openAttrs = `data-action="open-file" data-id="${id}" type="button" aria-expanded="${isActive}"`;
    const threadBadge = threadN
      ? `<button class="mini-count mini-threads ${isActive ? "is-open" : ""}" ${openAttrs} title="${threadN} unresolved thread${threadN === 1 ? "" : "s"}" aria-label="${threadN} unresolved thread${threadN === 1 ? "" : "s"}">${bubble()}<b>${threadN}</b></button>`
      : "";
    const noteBadge = noteN
      ? `<button class="mini-count mini-notes ${isActive ? "is-open" : ""}" ${openAttrs} title="${noteN} personal note${noteN === 1 ? "" : "s"}" aria-label="${noteN} personal note${noteN === 1 ? "" : "s"}">${noteGlyph()}<b>${noteN}</b></button>`
      : "";
    // A file's diff and its notes open and close together as one unit, so the
    // thread badge opens the file just like the filename does.
    return `<div class="frow-wrap ${isActive ? "is-open-wrap" : ""}">
      <div class="frow ${isOn ? "is-approved" : ""} ${isStale ? "is-stale" : ""} ${isActive ? "is-active" : ""}" data-file="${id}">
        <div class="frow-open" data-action="open-file" data-id="${id}" role="button" tabindex="0" title="${esc(file.path)}">
          <span class="kind k-${file.kind}" title="${kindLabel(file.kind)}">${kindGlyph(file.kind)}</span>
          <span class="fp"><small>${esc(dir)}</small><strong class="fp-name">${esc(name)}</strong>${renameFrom(file)}</span>
          ${classBadge(cls)}${sharedChip}
          ${fileMetrics(file)}
        </div>
        <div class="frow-act">
          ${threadBadge}${noteBadge}
          <button class="mini-approve ${isOn ? "is-on" : ""} ${isStale ? "is-stale" : ""}" data-action="approve" data-id="${id}" type="button" aria-pressed="${isOn}" title="${isStale ? "Changed since approval — re-approve" : isOn ? "Approved" : "Approve file"}"><span>${isStale ? "!" : isOn ? "✓" : ""}</span></button>
        </div>
      </div>
    </div>`;
  }
  // The notes block shown inside an open file's diff unit — always present while
  // the file is open so content and notes collapse/expand together.
  function fileNotesBlock(id) {
    const composingNew = compose && compose.id === id && compose.editIndex == null;
    const arts = artifactThreadsForElement("file", id);
    const locals = localVisibleForElement(id);
    const rows =
      arts.map((t) => renderArtifactThread(t, false)).join("") +
      locals.map((ln) => renderLocalNote(ln)).join("");
    const footer = composingNew
      ? renderComposer(compose)
      : `<button class="thread-add" data-action="comment" data-kind="file" data-id="${id}" type="button">＋ Add note</button>`;
    return `<div class="thread file-notes" data-thread="${id}">${rows}${footer}</div>`;
  }
  function nodeFilesPanel(stage, node) {
    const files = nodeFileList(stage, node);
    const total = files.length;
    const done = files.filter((f) => approved(fileKey(stage.id, f.path))).length;

    // Group by owning .NET project (convention-based) for a quick overview.
    const groups = new Map();
    files.forEach((f) => {
      const k = f.project || "Other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    });
    const groupHtml = [...groups.entries()].map(([proj, gfiles]) => {
      const gd = gfiles.filter((f) => approved(fileKey(stage.id, f.path))).length;
      const rows = gfiles.map((f) => fileRow(stage, node, f)).join("");
      return `<div class="fgroup ${gd === gfiles.length ? "all-done" : ""}">
        <div class="fgroup-h">
          <span class="fg-name">${esc(proj)}</span>
          <span class="fg-done">${gd === gfiles.length ? "✓ all" : `${gd}/${gfiles.length}`}</span>
        </div>
        <div class="flist">${rows}</div>
      </div>`;
    }).join("");

    // Files are always visible — there are very few cases where a node is
    // worth opening without also inspecting its files.
    return `<div class="payload ${done === total ? "all-done" : ""}" data-node-files="${node.id}">
      <div class="fgroups">${groupHtml}</div>
    </div>`;
  }

  /* ---- diff renderer (shared, big view) --------------------------------- */
  function fileViewMode(id) { return state.fileView[id] === "full" ? "full" : "hunk"; }

  /* ---- lightweight per-line syntax highlighting ------------------------- */
  const HL_KEYWORDS = new Set(
    ("abstract as async await base bool break byte case catch char checked class const continue " +
     "decimal default delegate do double else enum event explicit extern false finally fixed float " +
     "for foreach function get goto if implicit in int interface internal is let lock long namespace " +
     "new null object operator out override params private protected public readonly record ref return " +
     "sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof " +
     "uint ulong unchecked unsafe ushort using var virtual void volatile while yield await async " +
     "export import extends implements instanceof of with from type keyof readonly never unknown any " +
     "boolean number undefined def elif except lambda pass raise global nonlocal None True False and " +
     "or not in").split(/\s+/),
  );
  const HL_HASH = new Set(["py", "rb", "sh", "bash", "yml", "yaml", "toml", "ps1", "r", "pl", "ini", "cfg"]);
  function langFor(path) {
    return String(path || "").split(".").pop().toLowerCase();
  }
  function highlightCode(src, lang) {
    const s = String(src);
    const n = s.length;
    const hash = HL_HASH.has(lang);
    const isIdStart = (c) => /[A-Za-z_$@#]/.test(c);
    const isId = (c) => /[A-Za-z0-9_$]/.test(c);
    let out = "";
    let i = 0;
    while (i < n) {
      const c = s[i];
      if (!hash && c === "/" && s[i + 1] === "/") { out += `<span class="tok-com">${esc(s.slice(i))}</span>`; break; }
      if (hash && c === "#") { out += `<span class="tok-com">${esc(s.slice(i))}</span>`; break; }
      if (c === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        out += `<span class="tok-com">${esc(s.slice(i, stop))}</span>`; i = stop; continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < n && s[j] !== c) { if (s[j] === "\\") j++; j++; }
        j = Math.min(j + 1, n);
        out += `<span class="tok-str">${esc(s.slice(i, j))}</span>`; i = j; continue;
      }
      if (/[0-9]/.test(c) && (i === 0 || !isId(s[i - 1]))) {
        let j = i + 1;
        while (j < n && /[0-9a-fA-FxXbBoO._]/.test(s[j])) j++;
        out += `<span class="tok-num">${esc(s.slice(i, j))}</span>`; i = j; continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isId(s[j])) j++;
        const word = s.slice(i, j);
        out += HL_KEYWORDS.has(word) ? `<span class="tok-key">${esc(word)}</span>` : esc(word);
        i = j; continue;
      }
      out += esc(c); i++;
    }
    return out || esc(" ");
  }

  // The diff sign column doubles as each line's note affordance: on hover it
  // reveals a faint "+" to start a note, and a line that already has notes shows
  // a comment bubble that toggles its thread in and out of view. This keeps the
  // code itself untouched — the gutter carries the whole interaction.
  function lineActionCell(lineId, count, sign, resolved) {
    const has = count > 0;
    const open = Boolean(state.openLineThreads[lineId]);
    const label = has
      ? `${count} note${count === 1 ? "" : "s"} on this line — click to ${open ? "hide" : "show"}`
      : resolved
        ? `Resolved note on this line — click to ${open ? "hide" : "show"}`
        : "Add a note on this line";
    return `<button class="lact${has ? " has-note" : ""}${resolved ? " has-resolved" : ""}${open ? " is-open" : ""}" type="button" data-action="line-note" data-id="${esc(lineId)}" title="${esc(label)}" aria-label="${esc(label)}"><span class="lact-sign" aria-hidden="true">${sign}</span><span class="lact-add" aria-hidden="true">${bubblePlus()}</span>${has ? `<span class="lact-bub" aria-hidden="true">${bubble()}${count > 1 ? `<b>${count}</b>` : ""}</span>` : resolved ? `<span class="lact-bub lact-bub-resolved" aria-hidden="true">${bubble()}</span>` : ""}</button>`;
  }
  // A collapsible conversation attached to a single diff line. It renders as a
  // full-width row directly beneath its line and stays hidden until the line's
  // gutter bubble is toggled open, so notes never crowd the surrounding code.
  function lineThreadRow(lineId) {
    const composingNew =
      compose && compose.kind === "line" && compose.id === lineId && compose.editIndex == null;
    const open = Boolean(state.openLineThreads[lineId]);
    const arts = artifactThreadsForElement("line", lineId);
    const locals = localVisibleForElement(lineId);
    const hasContent = arts.length || locals.length;
    if ((!open && !composingNew) || (!hasContent && !composingNew)) return "";
    const rows =
      arts.map((t) => renderArtifactThread(t, false)).join("") +
      locals.map((ln) => renderLocalNote(ln)).join("");
    const footer = composingNew
      ? renderComposer(compose)
      : `<button class="thread-add" data-action="comment" data-kind="line" data-id="${esc(lineId)}" type="button">＋ Add note</button>`;
    const hide = hasContent
      ? `<button class="line-thread-hide" data-action="line-note" data-id="${esc(lineId)}" type="button" title="Hide these notes">Hide</button>`
      : "";
    return `<div class="drow drow-thread"><div class="line-thread" data-thread="${esc(lineId)}"><div class="line-thread-h"><span class="line-thread-where">Line notes</span>${hide}</div>${rows}${footer}</div></div>`;
  }
  // Render one code row plus, when the file is diff-anchored (ctx present) and
  // the row maps to a real line, its gutter affordance and any attached thread.
  function codeRow(rowClass, gutterOld, gutterNew, sign, code, ctx, side, lineNo) {
    if (!ctx || !ctx.stageId || !lineNo) {
      return `<div class="${rowClass}"><span class="ln">${gutterOld}</span><span class="ln">${gutterNew}</span><i>${sign}</i><code>${code}</code></div>`;
    }
    const lineId = lineKey(ctx.stageId, side, lineNo, ctx.path);
    const count = visibleThreadCount("line", lineId);
    const has = count > 0;
    const resolved =
      !has &&
      artifactThreadsForElement("line", lineId).some((t) => t.status === "resolved");
    const act = lineActionCell(lineId, count, sign, resolved);
    // For a file split across steps, dim the lines owned by other steps so the
    // step currently in focus reads as this node's slice of the shared diff.
    let ownClass = "";
    let ownAttr = "";
    if (ctx.ownership && (side === "old" || side === "new")) {
      const owner = ctx.ownership.get(`${side}:${lineNo}`);
      if (owner) {
        ownClass = ctx.focusNodeId
          ? owner === ctx.focusNodeId ? " own-focus" : " own-other"
          : " own-mark";
        ownAttr = ` title="Part of step: ${esc(nodeTitleById.get(owner) || owner)}"`;
      }
    }
    const row = `<div class="${rowClass}${has ? " has-line-note" : resolved ? " has-line-note-resolved" : ""}${ownClass}"${ownAttr}><span class="ln">${gutterOld}</span><span class="ln">${gutterNew}</span>${act}<code>${code}</code></div>`;
    return row + lineThreadRow(lineId);
  }
  function drowHtml(r, lang, ctx) {
    const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : "";
    const code = highlightCode(r.s || " ", lang);
    const side = r.t === "del" ? "old" : "new";
    const lineNo = r.t === "del" ? r.o : r.n;
    return codeRow(`drow d-${r.t}`, r.o || "", r.n || "", sign, code, ctx, side, lineNo);
  }
  function newFileRowHtml(r, lang, ctx, side) {
    const num = r.n || r.o || "";
    const code = highlightCode(r.s || " ", lang);
    const lineNo = side === "old" ? r.o || r.n : r.n || r.o;
    return codeRow("drow d-newline", "", num, "", code, ctx, side, lineNo);
  }
  function gapHtml(count) {
    return `<div class="drow d-gap"><span class="ln"></span><span class="ln"></span><i></i><code>⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋯</code></div>`;
  }
  function diffBody(file, mode, hideDel, ctx) {
    if (file._diffError)
      return `<div class="diff-empty">Could not load diff: ${esc(file._diffError)}</div>`;
    if (!Array.isArray(file.lines))
      return `<div class="diff-empty">Loading diff…</div>`;
    if (file.binary) return `<div class="diff-empty">Binary file — not shown.</div>`;
    const lines = file.lines;
    if (!lines.length) return `<div class="diff-empty">No line changes recorded for this file.</div>`;
    const lang = langFor(file.path);
    const out = [];
    if (file.kind === "added") {
      // Added file: content is identical in both views, so render the full file
      // once as neutral lines (not an all-green wall) with a clear "new file" banner.
      out.push(`<div class="drow d-newfile"><span class="ln"></span><span class="ln"></span><i>＋</i><code>New file — full contents</code></div>`);
      lines.forEach((r) => out.push(newFileRowHtml(r, lang, ctx, "new")));
    } else if (file.kind === "deleted") {
      // Deleted file: mirror the added-file presentation — the full previous
      // contents once as neutral lines with a clear "deleted file" banner.
      out.push(`<div class="drow d-oldfile"><span class="ln"></span><span class="ln"></span><i>－</i><code>Deleted file — previous contents</code></div>`);
      lines.forEach((r) => out.push(newFileRowHtml(r, lang, ctx, "old")));
    } else if (mode === "full") {
      lines.forEach((r) => { if (!(hideDel && r.t === "del")) out.push(drowHtml(r, lang, ctx)); });
    } else {
      const CTX = 3;
      const n = lines.length;
      const keep = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        if (lines[i].t !== "ctx") {
          for (let j = Math.max(0, i - CTX); j <= Math.min(n - 1, i + CTX); j++) keep[j] = true;
        }
      }
      let i = 0;
      while (i < n) {
        if (keep[i]) { if (!(hideDel && lines[i].t === "del")) out.push(drowHtml(lines[i], lang, ctx)); i++; }
        else { let j = i; while (j < n && !keep[j]) j++; out.push(gapHtml(j - i)); i = j; }
      }
    }
    if (file.truncated) out.push(`<div class="drow d-cut"><span class="ln"></span><span class="ln"></span><i></i><code>⋯ diff truncated for this large generated file ⋯</code></div>`);
    return `<div class="diff-scroll"><div class="diff-grid">${out.join("")}</div></div>`;
  }
  function viewToggle(id) {
    const mode = fileViewMode(id);
    return `<div class="view-toggle" role="group" aria-label="Diff view">
      <button class="vt ${mode === "hunk" ? "is-on" : ""}" data-action="set-view" data-id="${id}" data-mode="hunk" type="button" aria-pressed="${mode === "hunk"}">Changes</button>
      <button class="vt ${mode === "full" ? "is-on" : ""}" data-action="set-view" data-id="${id}" data-mode="full" type="button" aria-pressed="${mode === "full"}">Full file</button>
    </div>`;
  }
  function hideRemovedToggle(id) {
    const on = Boolean(state.hideDeleted[id]);
    return `<div class="view-toggle" role="group" aria-label="Removed lines">
      <button class="vt ${on ? "is-on" : ""}" data-action="toggle-hide-removed" data-id="${id}" type="button" aria-pressed="${on}" title="Hide removed lines to preview the resulting file">Hide removed</button>
    </div>`;
  }
  // Diff view controls: mode toggle + hide-removed. Added/deleted files render
  // their full contents once, so neither control applies to them.
  function diffControls(entry) {
    const k = entry.file.kind;
    if (k === "added" || k === "deleted") return "";
    return `${viewToggle(entry.id)}${hideRemovedToggle(entry.id)}`;
  }
  function diffHeader(entry, opts = {}) {
    const { file, stage } = entry;
    const { dir, name } = splitPath(file.path);
    const id = entry.id;
    return `<header class="diff-head">
      <div class="diff-id">
        <span class="kind k-${file.kind}" title="${kindLabel(file.kind)}">${kindGlyph(file.kind)}</span>
        <span class="diff-path"><small>${esc(dir)}</small><strong>${esc(name)}</strong>${renameFrom(file)}</span>
      </div>
      <div class="diff-facts">
        <span class="metrics"><i class="add">+${file.additions}</i><i class="del">−${file.deletions}</i></span>
        <span class="diff-stage">${esc(stage.title)}</span>
      </div>
      <div class="diff-actions">
        ${diffControls(entry)}
        ${opts.nav ? `<span class="diff-nav"><button data-action="file-prev" type="button" aria-label="Previous file">‹</button><button data-action="file-next" type="button" aria-label="Next file">›</button></span>` : ""}
        ${approveBtn("file", id, "sm")}
        ${commentBtn("file", id)}
        ${opts.close ? `<button class="diff-close" data-action="${opts.close}" type="button" aria-label="Close">×</button>` : ""}
      </div>
    </header>`;
  }
  function diffPanel(entry, opts = {}) {
    if (!entry) return `<div class="diff-panel is-empty"><p>Select a file to inspect its diff.</p></div>`;
    const ctx = {
      stageId: entry.stage.id,
      path: entry.file.path,
      ownership: membershipOwnership(entry.file),
      focusNodeId: opts.focusNodeId || null,
    };
    return `<section class="diff-panel ${opts.compact ? "is-compact" : ""}" aria-label="Diff for ${esc(entry.file.path)}">
      ${opts.compact ? diffToolbar(entry, opts) : diffHeader(entry, opts)}
      ${diffBody(entry.file, fileViewMode(entry.id), Boolean(state.hideDeleted[entry.id]), ctx)}
    </section>`;
  }
  function diffToolbar(entry) {
    const k = entry.file.kind;
    const hint = k === "added" ? "New file" : k === "deleted" ? "Deleted file" : "Inline diff";
    return `<header class="diff-bar">
      <span class="diff-bar-hint">${hint}</span>
      ${diffControls(entry)}
    </header>`;
  }

  /* ---- chrome ----------------------------------------------------------- */
  function topbar() {
    return `<div class="topbar-wrap">
      <header class="topbar">
        <div class="lockup">
          <span class="vindex">◆</span>
          <div><strong>Implementation</strong><span>${esc(data.implementationId)}</span></div>
        </div>
        <div class="tb-actions">
          <button class="tb-btn ${state.coverageOpen ? "is-on" : ""}" data-action="toggle-coverage" type="button" aria-expanded="${state.coverageOpen}">Coverage <b>${approvedCount()}/${reviewable()}</b></button>
          <button class="tb-btn ${state.notesOpen ? "is-on" : ""}" data-action="toggle-notes" type="button" aria-expanded="${state.notesOpen}">Notes <b>${activeNoteCount()}</b></button>
        </div>
      </header>
      <div class="progressbar" aria-hidden="true"><span style="width:${pct()}%"></span></div>
    </div>`;
  }

  function hero() {
    const totalFiles = data.stages.reduce((a, s) => a + s.files.length, 0);
    const totalNodes = data.stages.reduce((a, s) => a + s.nodes.length, 0);
    return `<section class="hero">
      <h1>${esc(data.title)}</h1>
      <p class="hero-sum">${esc(data.summary)}</p>
      <div class="hero-line">
        <span><b>${data.stages.length}</b> stages</span>
        <span><b>${totalNodes}</b> steps</span>
        <span><b>${totalFiles}</b> files</span>
        <span class="hero-target">${esc(data.targetBranch)} ← ${data.baseRevision.slice(0, 7)}</span>
      </div>
    </section>`;
  }

  function specificationPanel() {
    return requirements.map(renderSpecification).join("");
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
  function renderSource(source) {
    if (!source || !source.kind) return "";
    const label = SOURCE_LABEL[source.kind] || source.kind;
    const ref = source.reference || "";
    const href = safeHref(source.url);
    const text = ref || label;
    const inner = href
      ? `<a class="req-src-ref" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href)}">${esc(text)}</a>`
      : `<span class="req-src-ref" title="${esc(text)}">${esc(text)}</span>`;
    return `<p class="req-source"><span class="req-src-kind">${esc(label)}</span>${inner}</p>`;
  }
  function renderSpecification(req) {
    const open = Boolean(state.specificationOpen && state.specificationOpen[req.id]);
    return `<details class="specification" ${open ? "open" : ""} data-req data-req-id="${esc(req.id)}">
      <summary>
        <span class="req-mark">✦</span>
        <div><span class="eyebrow">Specification · ${esc(req.id)}</span><h2>${esc(req.title)}</h2></div>
        <span class="req-more">${req.acceptance.length} acceptance criteria</span>
      </summary>
      <div class="req-body">
        <p>${esc(req.summary)}</p>
        ${renderSource(req.source)}
        <ol class="ac-list">${req.acceptance.map((a) => {
      const st = acceptanceStatus(`${req.id}#${a.id}`);
      const label = st.key === "approved" ? "Approved" : st.key === "uncovered" ? "Not covered" : "In review";
      const meta = st.stages.length ? `Stage ${st.stages.map((n) => String(n).padStart(2, "0")).join(" · ")}` : "no stage";
      return `<li class="ac-item ac-${st.key}" data-ac="${esc(`${req.id}#${a.id}`)}"><span class="ac-id">${esc(a.id)}</span><span class="ac-text">${esc(a.text)}</span><span class="ac-status" title="${esc(meta)}">${label}</span></li>`;
    }).join("")}</ol>
      </div>
    </details>`;
  }

  function stageNode(stage, node, nodeIndex, stageIndex) {
    const approval = nodeApprovalState(stage, node);
    const done = approval === "approved";
    const stale = approval === "stale";
    return `<details class="node ${done ? "is-approved" : ""} ${stale ? "is-stale" : ""}" data-node="${node.id}">
      <summary>
        <span class="node-check" title="${stale ? "One or more file approvals are stale" : ""}">${stale ? "!" : done ? "✓" : ""}</span>
        <span class="node-ix">${stageIndex + 1}.${nodeIndex + 1}</span>
        <div class="node-head">
          <h3>${esc(node.title)}</h3>
          <p>${esc(node.description)}</p>
        </div>
        <span class="node-caret">${caret()}</span>
      </summary>
      <div class="node-body">
        ${nodeReasoning(stage, node)}
        ${nodeFilesPanel(stage, node)}
        <div class="node-foot">${noteCluster("node", node.id, stage.id)}</div>
        ${threadInline(node.id, "node")}
      </div>
    </details>`;
  }

  function stageSection(stage, i) {
    const open = Boolean(state.openStages[stage.id]);
    const filesDone = stage.files.filter((f) => approved(fileKey(stage.id, f.path))).length;
    const nodesDone = stage.nodes.filter((n) => nodeApprovalState(stage, n) === "approved").length;
    const done = stageApproved(stage);
    const acIds = stageAcceptanceRefs(stage);
    const deps = (stage.dependsOn || []).map((depId) => {
      const s = stageById.get(depId);
      return {
        id: depId,
        number: stageNumberById.get(depId),
        title: s ? s.title : depId,
      };
    });
    const depsMeta = deps.length
      ? `<span class="sm-deps" title="Depends on ${esc(deps.map((d) => d.number ? `Stage ${String(d.number).padStart(2, "0")}: ${d.title}` : d.title).join(", "))}"><span class="sm-deps-label">Depends on</span>${deps.map((d) => `<span class="dep-chip" title="${esc(d.title)}">${d.number ? String(d.number).padStart(2, "0") : esc(d.id)}</span>`).join("")}</span>`
      : "";
    return `<section class="stage ${done ? "is-approved" : ""} ${open ? "is-open" : ""}" data-stage="${stage.id}">
      <div class="stage-bar">
        <button class="stop ${done ? "is-approved" : ""}" data-action="toggle-stage" data-id="${stage.id}" type="button" aria-expanded="${open}">
          <span class="stop-num">${done ? "✓" : String(i + 1).padStart(2, "0")}</span>
        </button>
        <div class="stage-head">
          <button class="stage-title" data-action="toggle-stage" data-id="${stage.id}" type="button">
            <h2>${esc(stage.title)}</h2>
          </button>
          <p class="stage-sum">${esc(stage.summary)}</p>
          <p class="rationale"><span class="rationale-label">Why this stage</span>${esc(stage.rationale)}</p>
          <div class="stage-meta">
            <span>${nodesDone}/${stage.nodes.length} steps</span>
            <span>${filesDone}/${stage.files.length} files</span>
            ${depsMeta}
            ${acIds.length ? `<span class="sm-ac"><span class="sm-ac-label" aria-label="Acceptance criteria">✦</span>${acIds.map(acChip).join("")}</span>` : ""}
          </div>
        </div>
        <div class="stage-approve">${stageNoteCluster(stage.id)}${approveBtn("stage", stage.id, "sm")}</div>
      </div>
      ${threadInline(stage.id, "stage")}
      <div class="stage-body">
        ${reasoningSummary(stage)}
        <div class="nodes">${stage.nodes.map((n, ni) => stageNode(stage, n, ni, i)).join("")}</div>
      </div>
    </section>`;
  }

  function storyColumn() {
    return `<div class="story">
      ${hero()}
      ${specificationPanel()}
      <div class="spine">
        ${data.stages.map((s, i) => stageSection(s, i)).join("")}
      </div>
      <footer class="story-end">
        <span class="eyebrow">End of review</span>
        <p>${approvedCount() === reviewable() ? "Every stage, step, and file has your approval." : `${reviewable() - approvedCount()} of ${reviewable()} items still await your review.`}</p>
      </footer>
    </div>`;
  }

  /* ---- side panels ------------------------------------------------------ */
  function coveragePanel() {
    const rows = data.stages.map((s, i) => {
      const nd = s.nodes.filter((n) => nodeApprovalState(s, n) === "approved").length;
      const fd = s.files.filter((f) => approved(fileKey(s.id, f.path))).length;
      const stageDone = stageApproved(s);
      return `<div class="cov-stage ${stageDone ? "is-approved" : ""}">
        <div class="cov-h"><span>${stageDone ? "✓" : String(i + 1).padStart(2, "0")}</span><strong>${esc(s.title)}</strong></div>
        <div class="cov-bars">
          <span class="cov-bar" title="${nd}/${s.nodes.length} steps"><i style="width:${Math.round(nd / s.nodes.length * 100)}%"></i></span>
          <span class="cov-bar files" title="${fd}/${s.files.length} files"><i style="width:${Math.round(fd / s.files.length * 100)}%"></i></span>
        </div>
        <small>${stageDone ? "Stage approved" : "Stage approval pending"} · ${nd}/${s.nodes.length} steps · ${fd}/${s.files.length} files</small>
      </div>`;
    }).join("");
    return `<aside class="side coverage ${state.coverageOpen ? "is-open" : ""}" aria-hidden="${!state.coverageOpen}" ${state.coverageOpen ? "" : "inert"}>
      <div class="side-head"><div><span class="eyebrow">At a glance</span><h2>Review coverage</h2></div><button data-action="toggle-coverage" aria-label="Close" type="button">×</button></div>
      <div class="cov-score"><strong>${pct()}%</strong><span>${approvedCount()} of ${reviewable()} approved</span><div class="mini-bar"><i style="width:${pct()}%"></i></div></div>
      <div class="cov-list">${rows}</div>
      <div class="cov-key"><span><i class="steps"></i>Steps</span><span><i class="files"></i>Files</span></div>
    </aside>`;
  }
  function noteGroupKey(c) {
    if (c.kind === "stage") {
      const si = data.stages.findIndex((s) => s.id === c.id);
      const s = data.stages[si];
      return { si: si < 0 ? 900 : si, stageTitle: s ? s.title : c.id,
        ni: -1, nodeKey: `${c.id}::__stage__`, nodeTitle: "Stage overview" };
    }
    if (c.kind === "node") {
      for (let si = 0; si < data.stages.length; si++) {
        const s = data.stages[si];
        const ni = s.nodes.findIndex((n) => n.id === c.id);
        if (ni >= 0) return { si, stageTitle: s.title, ni, nodeKey: `${s.id}::${c.id}`, nodeTitle: s.nodes[ni].title };
      }
      return { si: 900, stageTitle: "Unknown stage", ni: 900, nodeKey: `::${c.id}`, nodeTitle: c.id };
    }
    const entry = fileById.get(c.id);
    if (entry) {
      const s = entry.stage;
      const si = data.stages.findIndex((x) => x.id === s.id);
      const membership = (entry.file.memberships || [])[0];
      const nodeId = membership && membership.nodeId;
      const ni = nodeId ? s.nodes.findIndex((n) => n.id === nodeId) : -1;
      if (ni >= 0) return { si, stageTitle: s.title, ni, nodeKey: `${s.id}::${nodeId}`, nodeTitle: s.nodes[ni].title };
      return { si, stageTitle: s.title, ni: 800, nodeKey: `${s.id}::__files__`, nodeTitle: "Files" };
    }
    if (c.kind === "line") {
      const p = parseLineId(c.id);
      const lineEntry = p && fileById.get(fileKey(p.stageId, p.path));
      if (lineEntry) {
        const s = lineEntry.stage;
        const si = data.stages.findIndex((x) => x.id === s.id);
        const membership = (lineEntry.file.memberships || [])[0];
        const nodeId = membership && membership.nodeId;
        const ni = nodeId ? s.nodes.findIndex((n) => n.id === nodeId) : -1;
        if (ni >= 0) return { si, stageTitle: s.title, ni, nodeKey: `${s.id}::${nodeId}`, nodeTitle: s.nodes[ni].title };
        return { si, stageTitle: s.title, ni: 800, nodeKey: `${s.id}::__files__`, nodeTitle: "Files" };
      }
    }
    return { si: 900, stageTitle: "Unknown stage", ni: 900, nodeKey: "::__other__", nodeTitle: "Other" };
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
    entries.forEach(({ c, i }) => {
      const g = noteGroupKey(c);
      const d = noteDayKey(c);
      if (!stageMap.has(g.si)) stageMap.set(g.si, { si: g.si, title: g.stageTitle, nodes: new Map() });
      const st = stageMap.get(g.si);
      if (!st.nodes.has(g.nodeKey)) st.nodes.set(g.nodeKey, { ni: g.ni, title: g.nodeTitle, days: new Map() });
      const nd = st.nodes.get(g.nodeKey);
      if (!nd.days.has(d.key)) nd.days.set(d.key, { key: d.key, label: d.label, items: [] });
      nd.days.get(d.key).items.push({ c, i });
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
  function notesPanel() {
    const noteCard = ({ c, i }) => {
      const sent = Boolean(c.exported);
      const mode = c.mode || "personal";
      const lbl = noteTargetLabel(c);
      if (compose && compose.editIndex === i)
        return `<article class="note mode-${mode}">${renderComposer(compose)}</article>`;
      return `<article class="note mode-${mode} ${sent ? "is-sent" : ""}">
        <header>
          <span class="note-mode">${mode === "feedback" ? "Feedback" : "Personal"}</span>
          ${mode === "feedback" ? `<span class="note-state">${sent ? "Sent" : "Draft"}</span>` : ""}
          <span class="note-kind">${esc(c.kind)}</span>
          ${sent ? "" : `<div class="note-act">
            <button data-action="edit-note" data-index="${i}" type="button">Edit</button>
            <button class="note-del" data-action="del-note" data-index="${i}" aria-label="Delete" type="button">×</button>
          </div>`}
        </header>
        <strong title="${esc(lbl.title)}">${esc(lbl.text)}</strong>
        <p class="comment-body">${formatCommentBody(c.body)}</p>
      </article>`;
    };
    const localEntries = visibleLocalNotes();
    const activeThreads = artifactThreads.filter((t) => t.status !== "resolved");
    const resolvedThreads = artifactThreads.filter((t) => t.status === "resolved");
    const activeConvos = `<section class="note-convos">${activeThreads.map((t) => renderArtifactThread(t, true)).join("")}</section>`;
    const resolvedConvos = `<section class="note-convos">${resolvedThreads.map((t) => renderArtifactThread(t, true)).join("")}</section>`;
    const localBody = localEntries.length
      ? groupedNotes(localEntries).map((st) => `<section class="note-stage">
          <h3 class="note-stage-h">${esc(st.title)}</h3>
          ${st.nodesArr.map((nd) => `<div class="note-node">
            <h4 class="note-node-h">${esc(nd.title)}</h4>
            ${nd.daysArr.map((day) => `<div class="note-day">${esc(day.label)}</div>${day.items.map(noteCard).join("")}`).join("")}
          </div>`).join("")}
        </section>`).join("")
      : (activeThreads.length
          ? `<div class="notes-empty small"><small>No local drafts. Leave a note on any stage, step, or file.</small></div>`
          : `<div class="notes-empty"><span>✎</span><p>No notes yet.</p><small>Leave a note on any stage, step, or file.</small></div>`);
    const resolvedEmpty = `<div class="notes-empty small"><small>No resolved threads yet.</small></div>`;
    const filter = state.notesFilter === "resolved" ? "resolved" : "active";
    const activeCount = activeNoteCount();
    const resolvedCount = resolvedThreads.length;
    const toggle = `<div class="notes-switch" role="tablist">
      <button class="notes-switch-btn ${filter === "active" ? "is-on" : ""}" data-action="notes-filter" data-filter="active" type="button" role="tab" aria-selected="${filter === "active"}">Active${activeCount ? `<b>${activeCount}</b>` : ""}</button>
      <button class="notes-switch-btn ${filter === "resolved" ? "is-on" : ""}" data-action="notes-filter" data-filter="resolved" type="button" role="tab" aria-selected="${filter === "resolved"}">Resolved${resolvedCount ? `<b>${resolvedCount}</b>` : ""}</button>
    </div>`;
    const track = `<div class="notes-track is-${filter}">
      <div class="notes-col notes-col-active">${activeConvos}${localBody}</div>
      <div class="notes-col notes-col-resolved">${resolvedConvos}${resolvedThreads.length ? "" : resolvedEmpty}</div>
    </div>`;
    const body = `${toggle}${track}`;
    const pending = pendingFeedbackCount();
    const working = exportState.phase === "working";
    const statusClass = exportState.phase === "error" ? "is-error" : exportState.phase === "done" ? "is-done" : "";
    const foot = `<div class="notes-foot">
        <button class="notes-export" data-action="export-feedback" type="button" ${pending && !working ? "" : "disabled"}>
          ${working ? "Sending…" : `Prepare feedback${pending ? ` (${pending})` : ""}`}
        </button>
        ${exportState.message ? `<p class="notes-export-msg ${statusClass}">${esc(exportState.message)}</p>`
          : `<p class="notes-export-hint">${pending ? "Feedback notes are sent to the semantic-flow artifact as threads your implementation agent can reply to." : "Only unsent “Feedback” notes are sent. Personal notes stay local. Agent replies reload this viewer automatically."}</p>`}
        ${exportState.skips && exportState.skips.length ? `<ul class="notes-export-skips">${exportState.skips.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      </div>`;
    return `<aside class="side notes ${state.notesOpen ? "is-open" : ""}" aria-hidden="${!state.notesOpen}" ${state.notesOpen ? "" : "inert"}>
      <div class="side-head"><div><span class="eyebrow">Your review notes</span><h2>Notes &amp; feedback</h2></div><button data-action="toggle-notes" aria-label="Close" type="button">×</button></div>
      <div class="notes-list">${body}</div>
      ${foot}
    </aside>`;
  }
  function labelFor(kind, id) {
    if (kind === "file") return fileById.get(id)?.file.path || id;
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
      const full = fileById.get(c.id)?.file.path || c.id;
      return { text: splitPath(full).name, title: full };
    }
    if (c.kind === "line") {
      const p = parseLineId(c.id);
      if (p) return { text: `${splitPath(p.path).name}:${p.line}`, title: `${p.path}:${p.line}` };
    }
    const t = labelFor(c.kind, c.id);
    return { text: t, title: t };
  }
  /* ---- render ----------------------------------------------------------- */
  function render() {
    app.innerHTML = `${topbar()}
      <main class="shell v-cinema">
        ${storyColumn()}
      </main>
      ${coveragePanel()}${notesPanel()}
      <div class="scrim ${state.coverageOpen || state.notesOpen ? "is-on" : ""}" data-action="close-panels"></div>`;
    enhance();
  }

  function enhance() {
    animateDetails();
    if (pendingHighlight) {
      const id = pendingHighlight;
      pendingHighlight = null;
      requestAnimationFrame(() => fadeFileHighlight(id, "in"));
    }
  }

  /* ---- animated <details> ---------------------------------------------- */
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function animateDetails() {
    app.querySelectorAll("details > summary").forEach((summary) => {
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
    if (det.matches(".specification")) {
      if (!state.specificationOpen || typeof state.specificationOpen !== "object") state.specificationOpen = {};
      state.specificationOpen[det.dataset.reqId] = det.open;
      persist();
    }
  }

  function cssEsc(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"); }

  /* ---- reasoning popover (portal, escapes clipped containers) ----------- */
  let popEl = null, popSticky = false, popOwner = null, popTimer = null;
  function ensurePop() {
    if (popEl) return popEl;
    popEl = document.createElement("div");
    popEl.className = "tag-pop-float";
    popEl.setAttribute("role", "tooltip");
    document.body.appendChild(popEl);
    popEl.addEventListener("pointerenter", () => clearTimeout(popTimer));
    popEl.addEventListener("pointerleave", () => { if (!popSticky) scheduleHide(); });
    return popEl;
  }
  function fillPop(btn) {
    const d = btn.dataset;
    const kindLine = `${d.glyph} ${d.label}${d.meta ? ` · ${d.meta}` : ""}`;
    const el = ensurePop();
    el.className = `tag-pop-float type-${d.type}${d.vstat ? ` vstat-${d.vstat}` : ""}`;
    el.innerHTML = `<span class="tag-pop-kind">${esc(kindLine)}</span>
      <strong>${esc(d.title)}</strong>
      ${d.body ? `<p>${esc(d.body)}</p>` : ""}`;
  }
  function positionPop(btn) {
    const r = btn.getBoundingClientRect();
    const p = popEl.getBoundingClientRect();
    const margin = 12, gap = 9;
    let left = Math.max(margin, Math.min(r.left, window.innerWidth - p.width - margin));
    let top = r.bottom + gap;
    if (top + p.height > window.innerHeight - margin && r.top - gap - p.height > margin) {
      top = r.top - gap - p.height; popEl.classList.add("is-above");
    } else popEl.classList.remove("is-above");
    popEl.style.left = `${left}px`;
    popEl.style.top = `${top}px`;
  }
  function showPop(btn) {
    clearTimeout(popTimer);
    popOwner = btn;
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
    popOwner = null;
  }
  function forceHidePop() {
    popSticky = false;
    if (popEl) popEl.classList.remove("is-shown", "is-above");
    popOwner = null;
  }
  document.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".tag-face[data-tagpop]");
    if (!b) return;
    if (popSticky && popOwner !== b) return;
    showPop(b);
  });
  document.addEventListener("pointerout", (e) => {
    const b = e.target.closest(".tag-face[data-tagpop]");
    if (b && !popSticky) scheduleHide();
  });
  document.addEventListener("focusin", (e) => {
    const b = e.target.closest(".tag-face[data-tagpop]");
    if (b) showPop(b);
  });
  document.addEventListener("focusout", (e) => {
    const b = e.target.closest(".tag-face[data-tagpop]");
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
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const a = btn.dataset.action;

    if (a === "approve") {
      const id = btn.dataset.id;
      const stage = btn.dataset.kind === "stage" ? stageById.get(id) : null;
      if (stage && !stageNodesApproved(stage)) return;
      const st = approvalState(id);
      // A rename carried its old approval forward as stale; clear that orphaned
      // record so acting on the file now writes a single canonical entry.
      const prevId = previousApprovalId(id);
      if (prevId) delete state.approvals[prevId];
      if (st === "approved") delete state.approvals[id];
      else {
        state.approvals[id] = { rev: revisionFor(id), at: Date.now() };
        // Approving a file means you're done with it — close its open diff.
        if (state.activeFiles[id]) delete state.activeFiles[id];
      }
      persist(); render();
    } else if (a === "toggle-stage") {
      animateStageToggle(btn.dataset.id);
    } else if (a === "toggle-coverage") {
      state.coverageOpen = !state.coverageOpen; state.notesOpen = false; persist(); applyPanelState();
    } else if (a === "toggle-notes") {
      state.notesOpen = !state.notesOpen; state.coverageOpen = false; persist(); applyPanelState();
    } else if (a === "close-panels") {
      state.coverageOpen = false; state.notesOpen = false; persist(); applyPanelState();
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
    } else if (a === "toggle-thread") {
      const id = btn.dataset.id;
      const opening = !state.openThreads[id];
      state.openThreads[id] = opening;
      persist();
      if (opening) { render(); }
      else { collapseThenRender(app.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)); }
    } else if (a === "edit-note") {
      openNoteEdit(Number(btn.dataset.index));
    } else if (a === "set-view") {
      state.fileView[btn.dataset.id] = btn.dataset.mode;
      persist(); render();
    } else if (a === "toggle-hide-removed") {
      const id = btn.dataset.id;
      state.hideDeleted[id] = !state.hideDeleted[id];
      persist(); render();
    } else if (a === "del-note") {
      const idx = Number(btn.dataset.index);
      const c = state.comments[idx];
      if (c && !c.exported) { state.comments.splice(idx, 1); persist(); render(); }
    } else if (a === "open-file") {
      // Let the reviewer select the filename text without toggling the diff:
      // a click that completes a selection over the name is not a toggle.
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && e.target.closest && e.target.closest(".fp-name")) return;
      toggleCinema(btn.dataset.id);
    } else if (a === "cinema-close") {
      const holder = btn.closest(".cinema-diff");
      const row = holder && holder.previousElementSibling;
      const fid = row && row.dataset ? row.dataset.file : null;
      closeCinema(fid);
    }
    else if (a === "export-feedback") {
      exportFeedback();
    } else if (a === "compose-cancel") {
      compose = null; render();
    } else if (a === "jump-to") {
      jumpToElement(btn.dataset.kind, btn.dataset.id);
    } else if (a === "thread-reply") {
      compose = null;
      replyTo = btn.dataset.id;
      replyDraft = "";
      replyEditId = null;
      replyDirty = false;
      if (threadOps[replyTo]) threadOps[replyTo].error = "";
      render(); focusComposer();
    } else if (a === "reply-edit") {
      compose = null;
      const draft = pendingReplies().find((r) => r.id === btn.dataset.replyId);
      if (!draft) return;
      replyTo = btn.dataset.id;
      replyEditId = draft.id;
      replyDraft = draft.body;
      replyDirty = false;
      render(); focusComposer();
    } else if (a === "reply-del") {
      state.replyDrafts = pendingReplies().filter((r) => r.id !== btn.dataset.replyId);
      if (replyEditId === btn.dataset.replyId) { replyEditId = null; replyTo = null; replyDraft = ""; replyDirty = false; }
      persist(); render();
    } else if (a === "reply-cancel") {
      replyTo = null; replyDraft = ""; replyEditId = null; replyDirty = false; render();
    } else if (a === "thread-resolve") {
      threadAction(btn.dataset.id, "resolve");
    } else if (a === "thread-reopen") {
      threadAction(btn.dataset.id, "reopen");
    } else if (a === "toggle-thread-collapse") {
      toggleThreadCollapse(btn.dataset.id);
    } else if (a === "notes-filter") {
      const f = btn.dataset.filter === "resolved" ? "resolved" : "active";
      if (state.notesFilter !== f) { state.notesFilter = f; persist(); applyNotesFilter(); }
    }
  });

  // Open the reviewable element an artifact thread points at, close the notes
  // panel, and scroll its conversation into view (targeting the comments so a
  // tall file body cannot push them off-screen).
  function jumpToElement(kind, id) {
    pendingLazyJump = null;
    state.notesOpen = false;
    state.coverageOpen = false;
    if (kind === "line") state.openLineThreads[id] = true;
    else state.openThreads[id] = true;
    let lineFileId = null;
    let lineMembership = null;
    let lineEntry = null;
    if (kind === "file") {
      const entry = fileById.get(id);
      if (entry) {
        state.openStages[entry.stage.id] = true;
        state.activeFiles[id] = true;
      }
    } else if (kind === "line") {
      const p = parseLineId(id);
      const entry = p && fileById.get(fileKey(p.stageId, p.path));
      if (entry) {
        lineEntry = entry;
        lineFileId = entry.id;
        lineMembership = (entry.file.memberships || [])[0];
        state.openStages[entry.stage.id] = true;
        state.activeFiles[entry.id] = true;
      }
    } else if (kind === "stage") {
      state.openStages[id] = true;
    } else if (kind === "specification") {
      if (!state.specificationOpen || typeof state.specificationOpen !== "object") state.specificationOpen = {};
      state.specificationOpen[id] = true;
    } else if (kind === "criterion") {
      if (!state.specificationOpen || typeof state.specificationOpen !== "object") state.specificationOpen = {};
      state.specificationOpen[String(id).split("#")[0]] = true;
    } else if (kind === "insight") {
      const ref = artifactThreads
        .map(threadElementRef)
        .find((item) => item?.kind === "insight" && item.id === id);
      if (ref?.stageId) state.openStages[ref.stageId] = true;
    }
    persist();
    const waitForLazyLine =
      kind === "line" && lineEntry && !Array.isArray(lineEntry.file.lines);
    if (waitForLazyLine) {
      pendingLazyJump = { id, fileId: lineEntry.id, membership: lineMembership };
    }
    render();
    if (waitForLazyLine) return;
    // Expand the owning node <details> for file/line targets, then scroll.
    requestAnimationFrame(() => {
      if (kind === "file") {
        const entry = fileById.get(id);
        const membership = entry && (entry.file.memberships || [])[0];
        if (membership && membership.nodeId) {
          const nodeEl = app.querySelector(`details.node[data-node="${cssEsc(membership.nodeId)}"]`);
          if (nodeEl) nodeEl.open = true;
        }
      } else if (kind === "line" && lineMembership && lineMembership.nodeId) {
        const nodeEl = app.querySelector(`details.node[data-node="${cssEsc(lineMembership.nodeId)}"]`);
        if (nodeEl) nodeEl.open = true;
      }
      requestAnimationFrame(() => {
        const thread = app.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
          || app.querySelector(`.line-thread[data-thread="${cssEsc(id)}"]`)
          || app.querySelector(`.frow[data-file="${cssEsc(id)}"]`)
          || app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`)
          || app.querySelector(`.ac-item[data-ac="${cssEsc(id)}"]`)
          || app.querySelector(`.specification[data-req-id="${cssEsc(id)}"]`)
          || app.querySelector(`[data-insight="${cssEsc(id)}"]`);
        if (thread) {
          const node = kind === "insight" ? thread.closest("details.node") : null;
          if (node) node.open = true;
          thread.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (kind === "file") fadeFileHighlight(id, "in");
        else if (kind === "line" && lineFileId) fadeFileHighlight(lineFileId, "in");
      });
    });
  }

  // Continue an artifact thread with a reviewer reply (server-backed).
  // Save (or update) a reviewer reply as a local draft. Drafts are revisable
  // and only sent to the artifact when the reviewer prepares feedback.
  function saveReplyDraft(threadId, body) {
    if (!artifactThreadById(threadId)) return;
    if (!Array.isArray(state.replyDrafts)) state.replyDrafts = [];
    if (replyEditId != null) {
      const draft = state.replyDrafts.find((r) => r.id === replyEditId);
      if (draft) draft.body = body;
    } else {
      state.replyDrafts.push({
        id: `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        threadId,
        body,
        createdAt: Date.now(),
      });
    }
    replyTo = null;
    replyDraft = "";
    replyEditId = null;
    replyDirty = false;
    persist();
    render();
  }

  // Send all pending reviewer replies as one feedback mutation.
  async function submitReplyDrafts(drafts) {
    const sendable = drafts.filter((draft) => artifactThreadById(draft.threadId));
    const skips = drafts
      .filter((draft) => !artifactThreadById(draft.threadId))
      .map(() => "reply — thread no longer exists");
    if (!sendable.length) return { sentIds: [], skips };
    try {
      const res = await fetch("/api/feedback/reply-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          implementationId: data.implementationId,
          replies: sendable.map((draft) => ({
            ref: draft.id,
            threadId: draft.threadId,
            body: draft.body,
          })),
        }),
      });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Replies failed (HTTP ${res.status}).`);
      adoptViewerSnapshot(out);
      (out.replied || []).forEach((entry) => {
        const thread = artifactThreadById(entry.threadId);
        if (!thread) return;
        if (entry.comment) thread.comments.push(entry.comment);
        if (entry.status) thread.status = entry.status;
        if ("resolvedAt" in entry) thread.resolvedAt = entry.resolvedAt;
      });
      return {
        sentIds: (out.replied || []).map((entry) => entry.ref),
        skips: skips.concat((out.skipped || []).map((entry) => `reply — ${entry.reason}`)),
      };
    } catch (err) {
      return {
        sentIds: [],
        skips: skips.concat(sendable.map(() => `reply — ${err.message || "reply failed"}`)),
      };
    }
  }

  // Mark a thread resolved / reopen it. Only the reviewer controls closure.
  // Updates happen in place — never a full re-render — so the reviewer's scroll
  // position is untouched; the thread's own UI is the only thing that moves,
  // animating collapsed on resolve (or open again on reopen).
  async function threadAction(threadId, kind) {
    const thread = artifactThreadById(threadId);
    if (!thread) return;
    const wasCollapsed = threadCollapsed(thread);
    threadOps[threadId] = { busy: true, error: "" };
    updateThreadEls(thread, wasCollapsed);
    try {
      const res = await fetch(`/api/feedback/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ implementationId: data.implementationId, threadId }),
      });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Action failed (HTTP ${res.status}).`);
      adoptViewerSnapshot(out);
      if (out.status) thread.status = out.status;
      if ("resolvedAt" in out) thread.resolvedAt = out.resolvedAt;
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
      // Move the thread between the notes-list Active/Resolved columns: fade the
      // old copy out, drop a fresh copy into the destination column. Inline file
      // copies are updated in place (they always show, resolved or not).
      relocateThreadInNotes(thread, kind);
      refreshThreadCounts();
      refreshNotesFilterCounts();
    } catch (err) {
      threadOps[threadId] = { busy: false, error: err.message || "Action failed." };
      updateThreadEls(thread, threadCollapsed(thread));
    }
  }

  // Animate a thread between the Active/Resolved columns of the notes list.
  function relocateThreadInNotes(thread, kind) {
    const collapsed = threadCollapsed(thread);
    const freshFor = (withLabel) => {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderArtifactThread(thread, withLabel, collapsed);
      return tmp.firstElementChild;
    };
    const destSel = kind === "resolve" ? ".notes-col-resolved" : ".notes-col-active";
    document.querySelectorAll(`.tthread[data-thread-id="${cssEsc(thread.id)}"]`).forEach((el) => {
      if (!el.closest(".notes-col")) { el.replaceWith(freshFor(false)); return; }
      const dest = app.querySelector(`${destSel} .note-convos`);
      el.classList.add("is-leaving");
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (dest) {
          const destCol = dest.closest(".notes-col");
          const empty = destCol && destCol.querySelector(".notes-empty");
          if (empty) empty.remove();
          dest.appendChild(freshFor(true));
        }
        el.remove();
      };
      el.addEventListener("transitionend", (e) => { if (e.target === el) finish(); });
      setTimeout(finish, 380);
    });
  }

  // Keep the Active/Resolved toggle counts in sync after an in-place move.
  function refreshNotesFilterCounts() {
    const resolvedThreads = artifactThreads.filter((t) => t.status === "resolved");
    const activeCount = activeNoteCount();
    const set = (filter, n) => {
      const btn = app.querySelector(`.notes-switch-btn[data-filter="${filter}"]`);
      if (!btn) return;
      let b = btn.querySelector("b");
      if (n) { if (!b) { b = document.createElement("b"); btn.appendChild(b); } b.textContent = String(n); }
      else if (b) b.remove();
    };
    set("active", activeCount);
    set("resolved", resolvedThreads.length);
  }

  // Replace every rendered instance of a thread in place (notes panel + any
  // inline copy) without touching the rest of the DOM.
  function updateThreadEls(t, collapsed) {
    document.querySelectorAll(`.tthread[data-thread-id="${cssEsc(t.id)}"]`).forEach((el) => {
      const withLabel = Boolean(el.closest(".note-convos"));
      const tmp = document.createElement("div");
      tmp.innerHTML = renderArtifactThread(t, withLabel, collapsed);
      const fresh = tmp.firstElementChild;
      if (fresh) el.replaceWith(fresh);
    });
  }
  function setThreadCollapsed(id, collapsed) {
    document.querySelectorAll(`.tthread[data-thread-id="${cssEsc(id)}"]`).forEach((el) => {
      el.classList.toggle("is-collapsed", collapsed);
      const h = el.querySelector(".tthread-h");
      if (h) h.setAttribute("aria-expanded", String(!collapsed));
    });
  }
  function toggleThreadCollapse(id) {
    const t = artifactThreadById(id);
    if (!t) return;
    if (!state.threadCollapsed) state.threadCollapsed = {};
    const collapsed = !threadCollapsed(t);
    state.threadCollapsed[id] = collapsed;
    persist();
    setThreadCollapsed(id, collapsed);
  }
  // Keep the file/stage thread-count badges in sync after an in-place resolve
  // (resolved threads no longer count) without disturbing scroll position.
  function refreshThreadCounts() {
    app.querySelectorAll(".notes-toggle[data-id]").forEach((btn) => {
      const id = btn.dataset.id;
      const kind = id.startsWith("f:") ? "file" : "stage";
      const count = visibleThreadCount(kind, id);
      if (!count) { btn.remove(); return; }
      const b = btn.querySelector("b");
      if (b) b.textContent = String(count);
      btn.setAttribute("title", `${count} thread${count === 1 ? "" : "s"}`);
    });
    app.querySelectorAll(".mini-threads[data-id]").forEach((btn) => {
      const id = btn.dataset.id;
      const kind = id.startsWith("f:") ? "file" : "stage";
      const count = unresolvedThreadCount(kind, id);
      if (!count) { btn.remove(); return; }
      const b = btn.querySelector("b");
      if (b) b.textContent = String(count);
      const lbl = `${count} unresolved thread${count === 1 ? "" : "s"}`;
      btn.setAttribute("title", lbl);
      btn.setAttribute("aria-label", lbl);
    });
    app.querySelectorAll(".mini-notes[data-id]").forEach((btn) => {
      const id = btn.dataset.id;
      const count = personalNoteCount(id);
      if (!count) { btn.remove(); return; }
      const b = btn.querySelector("b");
      if (b) b.textContent = String(count);
      const lbl = `${count} personal note${count === 1 ? "" : "s"}`;
      btn.setAttribute("title", lbl);
      btn.setAttribute("aria-label", lbl);
    });
  }

  async function exportFeedback() {
    if (exportState.phase === "working") return;
    const pending = pendingFeedback();
    const replies = pendingReplies().slice();
    if (!pending.length && !replies.length) return;
    exportState = { phase: "working", message: "" };
    render();
    const skips = [];
    let notesSent = 0;
    if (pending.length) {
      try {
        const res = await fetch("/api/feedback/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            implementationId: data.implementationId,
            notes: pending.map(({ c, i }) => ({ ref: i, kind: c.kind, id: c.id, stageId: c.stageId, body: c.body }))
          })
        });
        let out = {};
        try { out = await res.json(); } catch { /* non-JSON error body */ }
        if (!res.ok || !out.ok) throw new Error(out.error || `Export failed (HTTP ${res.status}).`);
        adoptViewerSnapshot(out);
        const byRef = new Map(pending.map(({ c, i }) => [i, c]));
        (out.exported || []).forEach((entry) => {
          const ref = typeof entry === "number" ? entry : entry && entry.ref;
          const note = byRef.get(ref);
          if (note) {
            note.exported = true;
            if (entry && entry.threadId) note.threadId = entry.threadId;
          }
        });
        notesSent = (out.exported || []).length;
        (out.skipped || []).forEach((s) => {
          const c = state.comments[s.ref];
          const label = c ? labelFor(c.kind, c.id) : `note ${s.ref}`;
          skips.push(`${label} — ${s.reason}`);
        });
      } catch (err) {
        persist();
        exportState = { phase: "error", message: err.message || "Export failed.", skips: [] };
        render();
        return;
      }
    }
    let repliesSent = 0;
    if (replies.length) {
      const result = await submitReplyDrafts(replies);
      const sentIds = new Set(result.sentIds);
      repliesSent = sentIds.size;
      state.replyDrafts = pendingReplies().filter((draft) => !sentIds.has(draft.id));
      skips.push(...result.skips);
    }
    persist();
    const parts = [];
    if (notesSent || !repliesSent) parts.push(`${notesSent} feedback thread${notesSent === 1 ? "" : "s"}`);
    if (repliesSent) parts.push(`${repliesSent} repl${repliesSent === 1 ? "y" : "ies"}`);
    exportState = {
      phase: "done",
      message: `Sent ${parts.join(" and ")} to the artifact${skips.length ? `, ${skips.length} skipped` : ""}. Run “/semantic-flow feedback” in your agent. Replies and edits appear here when it finishes.`,
      skips
    };
    render();
  }

  const ANIM_EASE = "cubic-bezier(.22,.7,.2,1)";
  const motionReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A file id whose row should fade its orange highlight in on the next render.
  // Set when a file is opened/jumped to; consumed once in enhance().
  let pendingHighlight = null;

  // Fade the file-row highlight (orange background + inset border) in or out.
  // The app re-renders wholesale, so a freshly rendered .is-active row starts
  // already-orange and a CSS transition never fires — animate it explicitly.
  function fadeFileHighlight(id, dir) {
    if (id == null || motionReduced()) return;
    const row = app.querySelector(`.frow[data-file="${cssEsc(id)}"]`);
    if (!row) return;
    const on = { background: "rgba(255, 106, 69, .13)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, .35)" };
    const off = { background: "rgba(255, 106, 69, 0)", boxShadow: "inset 0 0 0 1px rgba(255, 106, 69, 0)" };
    const frames = dir === "in" ? [off, on] : [on, off];
    row.animate(frames, {
      duration: dir === "in" ? 260 : 200,
      easing: ANIM_EASE,
      fill: dir === "in" ? "none" : "forwards",
    });
  }

  // Run `cb` once when the animation ends, with a safety timeout so a stuck or
  // non-resolving `finished` promise can never leave the UI mid-animation.
  function afterAnim(anim, ms, cb) {
    let done = false;
    const run = () => { if (done) return; done = true; cb(); };
    anim.finished.catch(() => {}).then(run);
    setTimeout(run, (ms || 0) + 80);
  }

  // Slide the side panels via CSS transition on the persistent DOM (a full
  // re-render would recreate them already-open and skip the transition).
  function applyPanelState() {
    forceHidePop();
    const cov = app.querySelector(".side.coverage");
    const notes = app.querySelector(".side.notes");
    const scrim = app.querySelector(".scrim");
    const covBtn = app.querySelector('.tb-btn[data-action="toggle-coverage"]');
    const notesBtn = app.querySelector('.tb-btn[data-action="toggle-notes"]');
    const setSide = (el, open) => {
      if (!el) return;
      el.classList.toggle("is-open", open);
      el.setAttribute("aria-hidden", String(!open));
      if (open) el.removeAttribute("inert"); else el.setAttribute("inert", "");
    };
    setSide(cov, state.coverageOpen);
    setSide(notes, state.notesOpen);
    // Lock page scroll behind the notes panel so only its list scrolls.
    document.body.classList.toggle("no-scroll", state.notesOpen);
    if (scrim) scrim.classList.toggle("is-on", state.coverageOpen || state.notesOpen);
    if (covBtn) { covBtn.classList.toggle("is-on", state.coverageOpen); covBtn.setAttribute("aria-expanded", String(state.coverageOpen)); }
    if (notesBtn) { notesBtn.classList.toggle("is-on", state.notesOpen); notesBtn.setAttribute("aria-expanded", String(state.notesOpen)); }
  }

  // Slide the notes list between its Active and Resolved columns without a full
  // re-render, so the persistent track transitions instead of snapping.
  function applyNotesFilter() {
    const filter = state.notesFilter === "resolved" ? "resolved" : "active";
    const track = app.querySelector(".notes-track");
    if (track) {
      track.classList.toggle("is-resolved", filter === "resolved");
      track.classList.toggle("is-active", filter === "active");
    }
    app.querySelectorAll(".notes-switch-btn").forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  // Animate a stage body open/closed in place so both directions transition.
  function animateStageToggle(id) {
    const open = !state.openStages[id];
    state.openStages[id] = open;
    persist();
    const stageEl = app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`);
    const body = stageEl && stageEl.querySelector(".stage-body");
    if (!stageEl) { render(); return; }
    stageEl.querySelectorAll('[data-action="toggle-stage"]').forEach((b) => b.setAttribute("aria-expanded", String(open)));
    if (motionReduced() || !body) { stageEl.classList.toggle("is-open", open); return; }
    const start = body.getBoundingClientRect().height;
    stageEl.classList.toggle("is-open", open);
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
    afterAnim(anim, dur || 200, () => render());
  }

  function toggleCinema(id) {
    if (state.activeFiles[id]) { closeCinema(id); return; }
    // Open in place — never auto-scroll, so the file stays where the reviewer
    // clicked it (jumping from the notes list handles its own scrolling).
    const entry = fileById.get(id);
    if (entry) delete entry.file._diffError;
    state.activeFiles[id] = true; persist(); pendingHighlight = id; render();
  }
  function cinemaHolder(id) {
    const row = app.querySelector(`.frow[data-file="${cssEsc(id)}"]`);
    const next = row && row.nextElementSibling;
    return next && next.classList.contains("cinema-diff") ? next : null;
  }
  function closeCinema(id) {
    // No id → close every open file (used by the Escape shortcut).
    if (id == null) { state.activeFiles = {}; persist(); render(); return; }
    const holder = cinemaHolder(id);
    delete state.activeFiles[id]; persist();
    if (!holder || motionReduced()) { render(); return; }
    fadeFileHighlight(id, "out");
    const start = holder.getBoundingClientRect().height;
    holder.style.overflow = "hidden";
    const anim = holder.animate([{ height: `${start}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: 210, easing: ANIM_EASE });
    afterAnim(anim, 210, () => render());
  }

  function openComment(kind, id, stageId) {
    const target = { kind, id };
    if (kind === "node" && stageId) target.stageId = stageId;
    replyTo = null;
    compose = {
      ...target,
      editIndex: null,
      mode: state.lastNoteMode === "feedback" ? "feedback" : "personal",
      body: "",
      dirty: false,
    };
    if (kind === "line") state.openLineThreads[id] = true;
    else state.openThreads[id] = true;
    // File notes live inside the file's open diff unit, so adding one opens it.
    if (kind === "file") { state.activeFiles[id] = true; pendingHighlight = id; }
    persist();
    render();
    focusComposer();
  }

  // Edit a browser-local draft note in place. Exported notes are immutable.
  function openNoteEdit(index) {
    const c = state.comments[index];
    if (!c || c.exported) return;
    replyTo = null;
    compose = {
      kind: c.kind,
      id: c.id,
      stageId: c.stageId,
      editIndex: index,
      mode: c.mode || "personal",
      body: c.body,
      dirty: false,
    };
    if (c.kind === "line") state.openLineThreads[c.id] = true;
    else state.openThreads[c.id] = true;
    if (c.kind === "file") { state.activeFiles[c.id] = true; pendingHighlight = c.id; }
    persist();
    render();
    focusComposer();
  }

  function focusComposer() {
    requestAnimationFrame(() => {
      const ta = app.querySelector(".note-compose textarea, .tthread-reply textarea");
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
  }

  // Keep unsent editor text in state so a re-render (which fully rebuilds the
  // DOM) never drops what the reviewer is typing.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (compose && t.matches('.note-compose textarea[name="nc-body"]')) {
      compose.body = t.value;
      compose.dirty = true;
    } else if (t.matches('.tthread-reply textarea[name="reply-body"]')) {
      replyDraft = t.value;
      replyDirty = true;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (compose && t.matches('.note-compose input[name="nc-mode"]') && t.checked) {
      compose.mode = t.value;
      compose.dirty = true;
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.matches("[data-note-form]")) {
      e.preventDefault();
      const body = e.target.querySelector("textarea").value.trim();
      const mode = e.target.querySelector('input[name="nc-mode"]:checked')?.value || "personal";
      if (body && compose) {
        if (compose.editIndex != null) {
          const c = state.comments[compose.editIndex];
          if (c && !c.exported) { c.body = body; c.mode = mode; }
        } else {
          const note = { kind: compose.kind, id: compose.id, body, mode, createdAt: Date.now() };
          if (compose.stageId) note.stageId = compose.stageId;
          state.comments.push(note);
        }
        state.lastNoteMode = mode;
      }
      compose = null;
      persist();
      render();
      return;
    }
    if (e.target.matches("[data-reply-form]")) {
      e.preventDefault();
      const body = e.target.querySelector("textarea").value.trim();
      if (body) saveReplyDraft(e.target.dataset.id, body);
      return;
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches('[data-action="open-file"]')) {
      e.preventDefault(); toggleCinema(e.target.dataset.id); return;
    }
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element) {
      const h = e.target.closest('[data-action="toggle-thread-collapse"]');
      if (h && !e.target.closest("button, a")) { e.preventDefault(); toggleThreadCollapse(h.dataset.id); return; }
    }
    if (e.key === "Escape") {
      if (compose) { compose = null; render(); return; }
      if (replyTo) { replyTo = null; replyDraft = ""; replyEditId = null; replyDirty = false; render(); return; }
      if (state.coverageOpen || state.notesOpen) { state.coverageOpen = false; state.notesOpen = false; persist(); applyPanelState(); return; }
      if (Object.keys(state.activeFiles).length) { closeCinema(); return; }
    }
  });

  /* ---- diff selection highlighting -------------------------------------
     When the reviewer selects a token inside a diff, highlight every other
     occurrence of that exact text within the same file view. */
  function clearSelHits(root) {
    const hits = root.querySelectorAll("mark.sel-hit");
    if (!hits.length) return;
    hits.forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    root.normalize();
  }
  function applySelHits(root, term, skipRange) {
    clearSelHits(root);
    const needle = term.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      // Never mutate the nodes the reviewer is actively selecting — replacing
      // them would collapse the selection and make the text impossible to copy.
      if (skipRange && skipRange.intersectsNode(node)) continue;
      if (node.nodeValue.toLowerCase().includes(needle)) targets.push(node);
    }
    targets.forEach((textNode) => {
      const text = textNode.nodeValue;
      const lc = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0, idx;
      while ((idx = lc.indexOf(needle, i)) !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
        const mark = document.createElement("mark");
        mark.className = "sel-hit";
        mark.textContent = text.slice(idx, idx + term.length);
        frag.appendChild(mark);
        i = idx + term.length;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      textNode.replaceWith(frag);
    });
  }
  function refreshDiffSelection() {
    // Capture the selection *before* mutating the DOM: clearing marks first
    // could normalize away the range the reviewer just made.
    const sel = document.getSelection();
    let grid = null;
    let term = "";
    let range = null;
    if (sel && !sel.isCollapsed && sel.anchorNode) {
      const host = sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(".diff-grid");
      const t = String(sel).trim();
      if (host && t && t.length >= 2 && !/\n/.test(t)) {
        grid = host; term = t;
        range = sel.rangeCount ? sel.getRangeAt(0) : null;
      }
    }
    app.querySelectorAll(".diff-grid").forEach(clearSelHits);
    if (grid) applySelHits(grid, term, range);
  }
  // Run after the browser finishes the selection so we never mutate mid-drag.
  document.addEventListener("mouseup", (e) => {
    if (!e.target.closest || !e.target.closest(".diff-scroll")) {
      app.querySelectorAll(".diff-grid mark.sel-hit").length && app.querySelectorAll(".diff-grid").forEach(clearSelHits);
      return;
    }
    setTimeout(refreshDiffSelection, 0);
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest && e.target.closest(".diff-scroll")) return;
    app.querySelectorAll(".diff-grid").forEach(clearSelHits);
  });

  // cinema inline diff injection + open-disclosure preservation across renders.
  function captureOpen() {
    const keys = new Set();
    app.querySelectorAll("details.node[open]").forEach((d) => keys.add(`node:${d.dataset.node}`));
    return keys;
  }
  function restoreOpen(keys) {
    if (!keys || !keys.size) return;
    app.querySelectorAll("details.node").forEach((d) => { if (keys.has(`node:${d.dataset.node}`)) d.open = true; });
  }
  function restoreWindowScroll(left, top) {
    const root = document.documentElement;
    const previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(left, top);
    root.style.scrollBehavior = previousBehavior;
  }

  const _render = render;
  render = function () {
    forceHidePop();
    revokeInvalidStageApprovals();
    const open = captureOpen();
    // Preserve scroll so a re-render never yanks the reviewer's position.
    const notesEl = app.querySelector(".notes-list");
    const notesScroll = notesEl ? notesEl.scrollTop : 0;
    const winScroll = { left: window.scrollX, top: window.scrollY };
    // Each open file's diff has its own inner scroll; capture it per file so
    // adding a line note (or any re-render) never resets where the reviewer is
    // looking within the diff.
    const diffScrolls = {};
    const pendingDiffs = [];
    Object.keys(state.activeFiles).forEach((fid) => {
      if (!state.activeFiles[fid]) return;
      const holder = app.querySelector(`.frow[data-file="${cssEsc(fid)}"]`)?.nextElementSibling;
      const scroller = holder && holder.classList.contains("cinema-diff")
        ? holder.querySelector(".diff-scroll")
        : null;
      if (scroller) diffScrolls[fid] = { top: scroller.scrollTop, left: scroller.scrollLeft };
    });
    _render();
    restoreOpen(open);
    Object.keys(state.activeFiles).forEach((fid) => {
      if (!state.activeFiles[fid]) return;
      const row = app.querySelector(`.frow[data-file="${cssEsc(fid)}"]`);
      const entry = fileById.get(fid);
      if (row && entry) {
        row.classList.add("is-open");
        const holder = document.createElement("div");
        holder.className = "cinema-diff";
        const focusNodeId = row.closest("[data-node]")?.getAttribute("data-node") || null;
        holder.innerHTML = diffPanel(entry, { compact: true, close: "cinema-close", focusNodeId }) + fileNotesBlock(fid);
        row.after(holder);
        if (!Array.isArray(entry.file.lines) && !entry.file._diffLoading && !entry.file._diffError)
          pendingDiffs.push(entry);
        const saved = diffScrolls[fid];
        if (saved) {
          const scroller = holder.querySelector(".diff-scroll");
          if (scroller) { scroller.scrollTop = saved.top; scroller.scrollLeft = saved.left; }
        }
      }
    });
    const newNotes = app.querySelector(".notes-list");
    if (newNotes) newNotes.scrollTop = notesScroll;
    document.body.classList.toggle("no-scroll", state.notesOpen);
    if (window.scrollX !== winScroll.left || window.scrollY !== winScroll.top)
      restoreWindowScroll(winScroll.left, winScroll.top);
    pendingDiffs.forEach(ensureFileDiff);
    resumePendingLazyJump();
  };

  render();
  window.setInterval(pollViewerRevision, 1000);
})();
