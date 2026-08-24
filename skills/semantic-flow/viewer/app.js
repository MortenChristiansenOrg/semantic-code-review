/* Semantic Flow review viewer — Cinema.
   Renders a semantic review artifact (window.SEMANTIC_REVIEW) as a full-bleed
   inline-diff reading experience. */
(function () {
  "use strict";

  const data = window.SEMANTIC_REVIEW;
  const app = document.querySelector("#app");
  const storeKey = `semantic-view:${data.reviewId}`;

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
  const nodeTitleById = new Map();
  data.stages.forEach((s) => s.nodes.forEach((n) => nodeTitleById.set(n.id, n.title)));

  // Reviews may carry more than one requirement list; render them all. Older
  // single-requirement artifacts still expose `data.requirement`.
  const requirements = Array.isArray(data.requirements) && data.requirements.length
    ? data.requirements
    : (data.requirement ? [data.requirement] : []);
  // Criterion ids are only unique within a requirement, so every acceptance
  // criterion is keyed by its full `<requirementId>#<criterionId>` ref.
  const allAcceptance = requirements.flatMap((r) =>
    (r.acceptance || []).map((a) => ({ ...a, reqId: r.id, ref: `${r.id}#${a.id}` })));

  const flatFiles = [];
  data.stages.forEach((stage) => stage.files.forEach((file) => {
    flatFiles.push({ id: fileKey(stage.id, file.path), stage, file });
  }));
  const fileById = new Map(flatFiles.map((f) => [f.id, f]));

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

  /* ---- state ------------------------------------------------------------ */
  let state = load();
  let compose = null;              // inline note composer: {kind,id,stageId,editIndex,mode,body}
  let replyTo = null;              // artifact thread id currently being replied to
  const threadOps = {};            // thread id -> { busy, error } for server actions
  let exportState = { phase: "idle", message: "" };
  function threadBusy(id) { return Boolean(threadOps[id] && threadOps[id].busy); }
  function threadError(id) { return threadOps[id] ? threadOps[id].error : ""; }

  function defaults() {
    return {
      approvals: {},
      comments: [],
      openStages: { [data.stages[0].id]: true },
      openThreads: {},
      lastNoteMode: "personal",
      requirementOpen: {},
      coverageOpen: false,
      notesOpen: false,
      pinnedInsight: null,
      hideApproved: false,
      fileView: {},
      active: null
    };
  }
  function load() {
    try {
      const merged = { ...defaults(), ...JSON.parse(localStorage.getItem(storeKey) || "{}") };
      // Legacy state stored a single boolean; map it onto the first requirement.
      if (typeof merged.requirementOpen !== "object" || merged.requirementOpen === null) {
        merged.requirementOpen = merged.requirementOpen && requirements[0]
          ? { [requirements[0].id]: true }
          : {};
      }
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
  /* File approvals carry a fingerprint of the diff at approval time so we can
     tell when a file has changed since it was approved (stale). Stage/node
     approvals have no fingerprint and are always current once approved. Legacy
     boolean approvals (older stored state) are trusted as approved. */
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
  function approvalState(id) {
    const rec = state.approvals[id];
    if (!rec) return "none";
    if (rec === true || rec.fp == null) return "approved";
    return rec.fp === fingerprintFor(id) ? "approved" : "stale";
  }
  const approved = (id) => approvalState(id) === "approved";
  const approvalStale = (id) => approvalState(id) === "stale";
  function elementNotes(id) {
    return state.comments.map((c, i) => ({ c, i })).filter((x) => x.c.id === id);
  }

  /* ---- artifact feedback threads (from window.SEMANTIC_REVIEW.feedback) -- */
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
      artifactThreadsForElement(kind, id).length +
      localVisibleForElement(id).length
    );
  }
  function visibleLocalNotes() {
    return state.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.exported || !artifactThreadById(c.threadId));
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
      .filter((x) => (x.s.requirementRefs || []).includes(ref));
    if (!stages.length) return { key: "uncovered", stages: [] };
    const allApproved = stages.every((x) => approved(x.s.id));
    return { key: allApproved ? "approved" : "pending", stages: stages.map((x) => x.i + 1) };
  }
  function stageAcceptanceRefs(stage) {
    return (stage.requirementRefs || []).filter(Boolean);
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

  function reviewable() {
    let n = 0;
    data.stages.forEach((s) => { n += 1 + s.nodes.length + s.files.length; });
    return n;
  }
  function approvedCount() {
    let n = 0;
    data.stages.forEach((s) => {
      if (approved(s.id)) n += 1;
      s.nodes.forEach((node) => { if (approved(node.id)) n += 1; });
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
    return kind === "added" ? "A" : kind === "deleted" ? "D" : "M";
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
  function reasoningChip(ins) {
    const info = INSIGHT[ins.type] || INSIGHT.decision;
    const vs = vstatus(ins);
    const glyph = vs ? vs.glyph : info.glyph;
    const label = vs ? vs.label : info.label;
    return `<span class="tag type-${ins.type} ${vs ? `vstat-${vs.key}` : ""}">
      <button class="tag-face" type="button" data-tagpop="1"
        data-type="${ins.type}" data-vstat="${vs ? vs.key : ""}"
        data-glyph="${esc(glyph)}" data-label="${esc(label)}" data-meta="${esc(vs ? "" : (ins.meta || ""))}"
        data-title="${esc(ins.title)}" data-body="${esc(ins.body || "")}"
        aria-haspopup="true">
        <b>${glyph}</b><span class="tag-kind">${esc(info.label)}</span><span class="tag-gist">${esc(ins.title)}</span>
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
      <div class="tag-row">${list.map(reasoningChip).join("")}</div>
    </div>`;
  }

  /* ---- approvals / comments UI ----------------------------------------- */
  function approveBtn(kind, id, size = "") {
    const st = approvalState(id);
    if (st === "stale") {
      return `<button class="approve ${size} is-stale" data-action="approve" data-id="${id}" type="button" aria-pressed="false" title="Changed since you approved it — click to re-approve">
        <span class="check">!</span>Re-approve</button>`;
    }
    const on = st === "approved";
    return `<button class="approve ${size} ${on ? "is-on" : ""}" data-action="approve" data-id="${id}" type="button" aria-pressed="${on}">
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
  function threadElementRef(t) {
    const tgt = (t && t.target) || {};
    if (tgt.kind === "file" && tgt.path && tgt.stageId)
      return { kind: "file", id: fileElementId(tgt.stageId, tgt.path) };
    if (tgt.kind === "stage" && tgt.stageId) return { kind: "stage", id: tgt.stageId };
    return null;
  }
  // An exported feedback thread: a reviewer <-> agent conversation the reviewer
  // can continue, mark resolved, or reopen. Only the reviewer controls closure.
  function renderArtifactThread(t, withLabel) {
    const msgs = (t.comments || [])
      .map((cm) => {
        const agent = cm.author === "assistant";
        const stamp = fmtTime(cm.createdAt);
        return `<div class="tmsg tmsg-${agent ? "agent" : "user"}">
          <div class="tmsg-h"><span class="tmsg-who">${agent ? "Implementation agent" : "You"}</span>${stamp ? `<time>${esc(stamp)}</time>` : ""}</div>
          <p>${esc(cm.body)}</p>
        </div>`;
      })
      .join("");
    const res =
      t.resolution && t.resolution.previousHead && t.resolution.rewrittenHead
        ? `<p class="tthread-rewrite">${esc(t.resolution.previousHead.slice(0, 9))} → ${esc(t.resolution.rewrittenHead.slice(0, 9))}</p>`
        : "";
    const disp = threadTargetDisplay(t);
    const ref = threadElementRef(t);
    const jump = withLabel && ref
      ? `<button class="tthread-jump" data-action="jump-to" data-kind="${ref.kind}" data-id="${esc(ref.id)}" type="button" title="Show what this thread is about">${bubble()}<span>Show</span></button>`
      : "";
    const label =
      withLabel && t.target && t.target.label
        ? `<strong class="tthread-label" title="${esc(disp.title)}">${esc(disp.text)}</strong>`
        : "";
    const busy = threadBusy(t.id);
    const err = threadError(t.id)
      ? `<p class="tthread-err">${esc(threadError(t.id))}</p>`
      : "";
    const actionable = t.status === "submitted" || t.status === "resolved";
    const actions = actionable
      ? `<div class="tthread-act">
          ${t.status === "resolved"
            ? `<button data-action="thread-reopen" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>Unresolve</button>`
            : `<button class="tthread-resolve" data-action="thread-resolve" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>Mark resolved</button>`}
          ${replyTo === t.id ? "" : `<button data-action="thread-reply" data-id="${esc(t.id)}" type="button" ${busy ? "disabled" : ""}>Reply</button>`}
        </div>`
      : "";
    const replyForm = replyTo === t.id
      ? `<form class="tthread-reply" data-reply-form data-id="${esc(t.id)}">
          <textarea name="reply-body" rows="3" required placeholder="Continue the conversation…"></textarea>
          <div class="nc-actions"><button type="button" data-action="reply-cancel">Cancel</button><button class="nc-save" type="submit" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Send reply"}</button></div>
        </form>`
      : "";
    return `<article class="tthread status-${t.status}">
      <div class="tthread-h">
        <span class="tthread-kind">${esc((t.target && t.target.kind) || "thread")}</span>
        <span class="tthread-status s-${t.status}">${esc(t.status)}</span>
        ${jump}
      </div>
      ${label}
      <div class="tthread-msgs">${msgs}</div>
      ${res}
      ${err}
      ${actions}
      ${replyForm}
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
        <p>${esc(c.body)}</p>
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
    const st = approvalState(id);
    const isOn = st === "approved";
    const isStale = st === "stale";
    const isActive = state.active === id;
    const threadCount = visibleThreadCount("file", id);
    const threadOpen = Boolean(state.openThreads[id]);
    return `<div class="frow-wrap ${threadOpen ? "thread-open" : ""}">
      <div class="frow ${isOn ? "is-approved" : ""} ${isStale ? "is-stale" : ""} ${isActive ? "is-active" : ""}" data-file="${id}">
        <div class="frow-open" data-action="open-file" data-id="${id}" role="button" tabindex="0" title="Inspect diff (click filename to select it)">
          <span class="kind k-${file.kind}">${kindGlyph(file.kind)}</span>
          <span class="fp"><small>${esc(dir)}</small><strong>${esc(name)}</strong></span>
          ${classBadge(cls)}
          ${fileMetrics(file)}
        </div>
        <div class="frow-act">
          ${threadCount ? `<button class="mini-thread ${threadOpen ? "is-open" : ""}" data-action="toggle-thread" data-id="${id}" type="button" aria-expanded="${threadOpen}" title="${threadCount} thread${threadCount === 1 ? "" : "s"}">${bubble()}<b>${threadCount}</b></button>` : ""}
          <button class="mini-approve ${isOn ? "is-on" : ""} ${isStale ? "is-stale" : ""}" data-action="approve" data-id="${id}" type="button" aria-pressed="${isOn}" title="${isStale ? "Changed since approval — re-approve" : isOn ? "Approved" : "Approve file"}"><span>${isStale ? "!" : isOn ? "✓" : ""}</span></button>
          <button class="mini-note" data-action="comment" data-kind="file" data-id="${id}" type="button" title="Add note" aria-label="Add note">${bubblePlus()}</button>
        </div>
      </div>
      ${threadInline(id, "file")}
    </div>`;
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

  function drowHtml(r, lang) {
    const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : "";
    const code = highlightCode(r.s || " ", lang);
    return `<div class="drow d-${r.t}"><span class="ln">${r.o || ""}</span><span class="ln">${r.n || ""}</span><i>${sign}</i><code>${code}</code></div>`;
  }
  function newFileRowHtml(r, lang) {
    const num = r.n || r.o || "";
    const code = highlightCode(r.s || " ", lang);
    return `<div class="drow d-newline"><span class="ln"></span><span class="ln">${num}</span><i></i><code>${code}</code></div>`;
  }
  function gapHtml(count) {
    return `<div class="drow d-gap"><span class="ln"></span><span class="ln"></span><i></i><code>⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋯</code></div>`;
  }
  function diffBody(file, mode) {
    if (file.binary) return `<div class="diff-empty">Binary file — not shown.</div>`;
    const lines = file.lines || [];
    if (!lines.length) return `<div class="diff-empty">No line changes recorded for this file.</div>`;
    const lang = langFor(file.path);
    const out = [];
    if (file.kind === "added") {
      // Added file: content is identical in both views, so render the full file
      // once as neutral lines (not an all-green wall) with a clear "new file" banner.
      out.push(`<div class="drow d-newfile"><span class="ln"></span><span class="ln"></span><i>＋</i><code>New file — full contents</code></div>`);
      lines.forEach((r) => out.push(newFileRowHtml(r, lang)));
    } else if (mode === "full") {
      lines.forEach((r) => out.push(drowHtml(r, lang)));
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
        if (keep[i]) { out.push(drowHtml(lines[i], lang)); i++; }
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
  function diffHeader(entry, opts = {}) {
    const { file, stage } = entry;
    const { dir, name } = splitPath(file.path);
    const id = entry.id;
    return `<header class="diff-head">
      <div class="diff-id">
        <span class="kind k-${file.kind}">${kindGlyph(file.kind)}</span>
        <span class="diff-path"><small>${esc(dir)}</small><strong>${esc(name)}</strong></span>
      </div>
      <div class="diff-facts">
        <span class="metrics"><i class="add">+${file.additions}</i><i class="del">−${file.deletions}</i></span>
        <span class="diff-stage">${esc(stage.title)}</span>
      </div>
      <div class="diff-actions">
        ${file.kind === "added" ? "" : viewToggle(id)}
        ${opts.nav ? `<span class="diff-nav"><button data-action="file-prev" type="button" aria-label="Previous file">‹</button><button data-action="file-next" type="button" aria-label="Next file">›</button></span>` : ""}
        ${approveBtn("file", id, "sm")}
        ${commentBtn("file", id)}
        ${opts.close ? `<button class="diff-close" data-action="${opts.close}" type="button" aria-label="Close">×</button>` : ""}
      </div>
    </header>`;
  }
  function diffPanel(entry, opts = {}) {
    if (!entry) return `<div class="diff-panel is-empty"><p>Select a file to inspect its diff.</p></div>`;
    return `<section class="diff-panel ${opts.compact ? "is-compact" : ""}" aria-label="Diff for ${esc(entry.file.path)}">
      ${opts.compact ? diffToolbar(entry, opts) : diffHeader(entry, opts)}
      ${diffBody(entry.file, fileViewMode(entry.id))}
    </section>`;
  }
  function diffToolbar(entry) {
    const added = entry.file.kind === "added";
    return `<header class="diff-bar">
      <span class="diff-bar-hint">${added ? "New file" : "Inline diff"}</span>
      ${added ? "" : viewToggle(entry.id)}
    </header>`;
  }

  /* ---- chrome ----------------------------------------------------------- */
  function topbar() {
    return `<div class="topbar-wrap">
      <header class="topbar">
        <div class="lockup">
          <span class="vindex">◆</span>
          <div><strong>Semantic review</strong><span>${esc(data.reviewId)}</span></div>
        </div>
        <div class="tb-actions">
          <button class="tb-btn ${state.coverageOpen ? "is-on" : ""}" data-action="toggle-coverage" type="button" aria-expanded="${state.coverageOpen}">Coverage <b>${approvedCount()}/${reviewable()}</b></button>
          <button class="tb-btn ${state.notesOpen ? "is-on" : ""}" data-action="toggle-notes" type="button" aria-expanded="${state.notesOpen}">Notes <b>${artifactThreads.length + visibleLocalNotes().length}</b></button>
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

  function requirementPanel() {
    return requirements.map(renderRequirement).join("");
  }
  function renderRequirement(req) {
    const open = Boolean(state.requirementOpen && state.requirementOpen[req.id]);
    return `<details class="requirement" ${open ? "open" : ""} data-req data-req-id="${esc(req.id)}">
      <summary>
        <span class="req-mark">✦</span>
        <div><span class="eyebrow">Requirement · ${esc(req.id)}</span><h2>${esc(req.title)}</h2></div>
        <span class="req-more">${req.acceptance.length} acceptance criteria</span>
      </summary>
      <div class="req-body">
        <p>${esc(req.summary)}</p>
        <ol class="ac-list">${req.acceptance.map((a) => {
      const st = acceptanceStatus(`${req.id}#${a.id}`);
      const label = st.key === "approved" ? "Approved" : st.key === "uncovered" ? "Not covered" : "In review";
      const meta = st.stages.length ? `Stage ${st.stages.map((n) => String(n).padStart(2, "0")).join(" · ")}` : "no stage";
      return `<li class="ac-item ac-${st.key}"><span class="ac-id">${esc(a.id)}</span><span class="ac-text">${esc(a.text)}</span><span class="ac-status" title="${esc(meta)}">${label}</span></li>`;
    }).join("")}</ol>
      </div>
    </details>`;
  }

  function stageNode(stage, node, nodeIndex, stageIndex) {
    const done = approved(node.id);
    return `<details class="node ${done ? "is-approved" : ""}" data-node="${node.id}">
      <summary>
        <span class="node-check">${done ? "✓" : ""}</span>
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
        <div class="node-foot">${approveBtn("node", node.id)}${noteCluster("node", node.id, stage.id)}</div>
        ${threadInline(node.id, "node")}
      </div>
    </details>`;
  }

  function stageSection(stage, i) {
    const open = Boolean(state.openStages[stage.id]);
    const filesDone = stage.files.filter((f) => approved(fileKey(stage.id, f.path))).length;
    const nodesDone = stage.nodes.filter((n) => approved(n.id)).length;
    const done = approved(stage.id);
    const acIds = stageAcceptanceRefs(stage);
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
            ${acIds.length ? `<span class="sm-ac"><span class="sm-ac-label" aria-label="Acceptance criteria">✦</span>${acIds.map(acChip).join("")}</span>` : ""}
          </div>
        </div>
        <div class="stage-approve">${approveBtn("stage", stage.id, "sm")}${noteCluster("stage", stage.id)}</div>
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
      ${requirementPanel()}
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
      const nd = s.nodes.filter((n) => approved(n.id)).length;
      const fd = s.files.filter((f) => approved(fileKey(s.id, f.path))).length;
      return `<div class="cov-stage ${approved(s.id) ? "is-approved" : ""}">
        <div class="cov-h"><span>${approved(s.id) ? "✓" : String(i + 1).padStart(2, "0")}</span><strong>${esc(s.title)}</strong></div>
        <div class="cov-bars">
          <span class="cov-bar" title="${nd}/${s.nodes.length} steps"><i style="width:${Math.round(nd / s.nodes.length * 100)}%"></i></span>
          <span class="cov-bar files" title="${fd}/${s.files.length} files"><i style="width:${Math.round(fd / s.files.length * 100)}%"></i></span>
        </div>
        <small>${nd}/${s.nodes.length} steps · ${fd}/${s.files.length} files</small>
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
        <p>${esc(c.body)}</p>
      </article>`;
    };
    const localEntries = visibleLocalNotes();
    const convos = artifactThreads.length
      ? `<section class="note-convos">
          <h3 class="note-stage-h">Feedback conversations</h3>
          ${artifactThreads.map((t) => renderArtifactThread(t, true)).join("")}
        </section>`
      : "";
    const localBody = localEntries.length
      ? groupedNotes(localEntries).map((st) => `<section class="note-stage">
          <h3 class="note-stage-h">${esc(st.title)}</h3>
          ${st.nodesArr.map((nd) => `<div class="note-node">
            <h4 class="note-node-h">${esc(nd.title)}</h4>
            ${nd.daysArr.map((day) => `<div class="note-day">${esc(day.label)}</div>${day.items.map(noteCard).join("")}`).join("")}
          </div>`).join("")}
        </section>`).join("")
      : (artifactThreads.length
          ? `<div class="notes-empty small"><small>No local drafts. Leave a note on any stage, step, or file.</small></div>`
          : `<div class="notes-empty"><span>✎</span><p>No notes yet.</p><small>Leave a note on any stage, step, or file.</small></div>`);
    const body = `${convos}${localBody}`;
    const pending = pendingFeedback().length;
    const working = exportState.phase === "working";
    const statusClass = exportState.phase === "error" ? "is-error" : exportState.phase === "done" ? "is-done" : "";
    const foot = `<div class="notes-foot">
        <button class="notes-export" data-action="export-feedback" type="button" ${pending && !working ? "" : "disabled"}>
          ${working ? "Sending…" : `Prepare feedback${pending ? ` (${pending})` : ""}`}
        </button>
        ${exportState.message ? `<p class="notes-export-msg ${statusClass}">${esc(exportState.message)}</p>`
          : `<p class="notes-export-hint">${pending ? "Feedback notes are sent to the semantic-flow artifact as threads your implementation agent can reply to." : "Only unsent “Feedback” notes are sent. Personal notes stay local. Reload to see agent replies."}</p>`}
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
    if (det.matches(".requirement")) {
      if (!state.requirementOpen || typeof state.requirementOpen !== "object") state.requirementOpen = {};
      state.requirementOpen[det.dataset.reqId] = det.open;
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
      const st = approvalState(id);
      if (st === "approved") delete state.approvals[id];
      else {
        state.approvals[id] = { fp: fingerprintFor(id), at: Date.now() };
        // Approving a file means you're done with it — close its open diff.
        if (state.active === id) state.active = null;
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
    } else if (a === "del-note") {
      const idx = Number(btn.dataset.index);
      const c = state.comments[idx];
      if (c && !c.exported) { state.comments.splice(idx, 1); persist(); render(); }
    } else if (a === "open-file") {
      toggleCinema(btn.dataset.id);
    } else if (a === "cinema-close") { closeCinema(); }
    else if (a === "export-feedback") {
      exportFeedback();
    } else if (a === "compose-cancel") {
      compose = null; render();
    } else if (a === "jump-to") {
      jumpToElement(btn.dataset.kind, btn.dataset.id);
    } else if (a === "thread-reply") {
      compose = null;
      replyTo = btn.dataset.id;
      if (threadOps[replyTo]) threadOps[replyTo].error = "";
      render(); focusComposer();
    } else if (a === "reply-cancel") {
      replyTo = null; render();
    } else if (a === "thread-resolve") {
      threadAction(btn.dataset.id, "resolve");
    } else if (a === "thread-reopen") {
      threadAction(btn.dataset.id, "reopen");
    }
  });

  // Open the reviewable element an artifact thread points at, close the notes
  // panel, and scroll its conversation into view (targeting the comments so a
  // tall file body cannot push them off-screen).
  function jumpToElement(kind, id) {
    state.notesOpen = false;
    state.coverageOpen = false;
    state.openThreads[id] = true;
    if (kind === "file") {
      const entry = fileById.get(id);
      if (entry) {
        state.openStages[entry.stage.id] = true;
        state.active = id;
      }
    } else if (kind === "stage") {
      state.openStages[id] = true;
    }
    persist();
    render();
    // Expand the owning node <details> for file targets, then scroll.
    requestAnimationFrame(() => {
      if (kind === "file") {
        const entry = fileById.get(id);
        const membership = entry && (entry.file.memberships || [])[0];
        if (membership && membership.nodeId) {
          const nodeEl = app.querySelector(`details.node[data-node="${cssEsc(membership.nodeId)}"]`);
          if (nodeEl) nodeEl.open = true;
        }
      }
      requestAnimationFrame(() => {
        const thread = app.querySelector(`.thread[data-thread="${cssEsc(id)}"]`)
          || app.querySelector(`.frow[data-file="${cssEsc(id)}"]`)
          || app.querySelector(`.stage[data-stage="${cssEsc(id)}"]`);
        if (thread) thread.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  // Continue an artifact thread with a reviewer reply (server-backed).
  async function sendThreadReply(threadId, body) {
    const thread = artifactThreadById(threadId);
    if (!thread) return;
    threadOps[threadId] = { busy: true, error: "" };
    render();
    try {
      const res = await fetch("/api/feedback/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: data.reviewId, threadId, body }),
      });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Reply failed (HTTP ${res.status}).`);
      if (out.comment) thread.comments.push(out.comment);
      if (out.status) thread.status = out.status;
      if ("resolution" in out) thread.resolution = out.resolution;
      threadOps[threadId] = { busy: false, error: "" };
      replyTo = null;
    } catch (err) {
      threadOps[threadId] = { busy: false, error: err.message || "Reply failed." };
    }
    render();
  }

  // Mark a thread resolved / reopen it. Only the reviewer controls closure.
  async function threadAction(threadId, kind) {
    const thread = artifactThreadById(threadId);
    if (!thread) return;
    threadOps[threadId] = { busy: true, error: "" };
    render();
    try {
      const res = await fetch(`/api/feedback/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: data.reviewId, threadId }),
      });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Action failed (HTTP ${res.status}).`);
      if (out.status) thread.status = out.status;
      if ("resolution" in out) thread.resolution = out.resolution;
      threadOps[threadId] = { busy: false, error: "" };
    } catch (err) {
      threadOps[threadId] = { busy: false, error: err.message || "Action failed." };
    }
    render();
  }

  async function exportFeedback() {
    if (exportState.phase === "working") return;
    const pending = pendingFeedback();
    if (!pending.length) return;
    exportState = { phase: "working", message: "" };
    render();
    try {
      const res = await fetch("/api/feedback/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewId: data.reviewId,
          notes: pending.map(({ c, i }) => ({ ref: i, kind: c.kind, id: c.id, stageId: c.stageId, body: c.body }))
        })
      });
      let out = {};
      try { out = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok || !out.ok) throw new Error(out.error || `Export failed (HTTP ${res.status}).`);
      const byRef = new Map(pending.map(({ c, i }) => [i, c]));
      (out.exported || []).forEach((entry) => {
        const ref = typeof entry === "number" ? entry : entry && entry.ref;
        const note = byRef.get(ref);
        if (note) {
          note.exported = true;
          if (entry && entry.threadId) note.threadId = entry.threadId;
          if (out.batchId) note.batchId = out.batchId;
        }
      });
      persist();
      const n = (out.exported || []).length;
      const skipped = out.skipped || [];
      const skips = skipped.map((s) => {
        const c = state.comments[s.ref];
        const label = c ? labelFor(c.kind, c.id) : `note ${s.ref}`;
        return `${label} — ${s.reason}`;
      });
      exportState = {
        phase: "done",
        message: `Sent ${n} feedback thread${n === 1 ? "" : "s"} to the artifact${skipped.length ? `, ${skipped.length} skipped` : ""}. Run “/semantic-flow feedback” in your agent, then reload to see replies.`,
        skips
      };
    } catch (err) {
      exportState = { phase: "error", message: err.message || "Export failed.", skips: [] };
    }
    render();
  }

  const ANIM_EASE = "cubic-bezier(.22,.7,.2,1)";
  const motionReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    if (scrim) scrim.classList.toggle("is-on", state.coverageOpen || state.notesOpen);
    if (covBtn) { covBtn.classList.toggle("is-on", state.coverageOpen); covBtn.setAttribute("aria-expanded", String(state.coverageOpen)); }
    if (notesBtn) { notesBtn.classList.toggle("is-on", state.notesOpen); notesBtn.setAttribute("aria-expanded", String(state.notesOpen)); }
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
    // Let the user select the filename text without toggling the diff.
    if (window.getSelection && String(window.getSelection()).trim().length) return;
    if (state.active === id) { closeCinema(); return; }
    state.active = id; persist(); render();
    requestAnimationFrame(() => {
      document.querySelector(`.frow[data-file="${cssEsc(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  function closeCinema() {
    const holder = app.querySelector(".cinema-diff");
    state.active = null; persist();
    if (!holder || motionReduced()) { render(); return; }
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
    };
    state.openThreads[id] = true;
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
    };
    state.openThreads[c.id] = true;
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
      if (body) sendThreadReply(e.target.dataset.id, body);
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches('[data-action="open-file"]')) {
      e.preventDefault(); toggleCinema(e.target.dataset.id); return;
    }
    if (e.key === "Escape") {
      if (compose) { compose = null; render(); return; }
      if (replyTo) { replyTo = null; render(); return; }
      if (state.coverageOpen || state.notesOpen) { state.coverageOpen = false; state.notesOpen = false; persist(); applyPanelState(); return; }
      if (state.active) { closeCinema(); return; }
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
  function applySelHits(root, term) {
    clearSelHits(root);
    const needle = term.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
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
    if (sel && !sel.isCollapsed && sel.anchorNode) {
      const host = sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(".diff-grid");
      const t = String(sel).trim();
      if (host && t && t.length >= 2 && !/\n/.test(t)) { grid = host; term = t; }
    }
    app.querySelectorAll(".diff-grid").forEach(clearSelHits);
    if (grid) applySelHits(grid, term);
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

  const _render = render;
  render = function () {
    forceHidePop();
    const open = captureOpen();
    _render();
    restoreOpen(open);
    if (state.active) {
      const row = app.querySelector(`.frow[data-file="${cssEsc(state.active)}"]`);
      const entry = fileById.get(state.active);
      if (row && entry) {
        row.classList.add("is-open");
        const holder = document.createElement("div");
        holder.className = "cinema-diff";
        holder.innerHTML = diffPanel(entry, { compact: true, close: "cinema-close" });
        row.after(holder);
      }
    }
  };

  render();
})();
