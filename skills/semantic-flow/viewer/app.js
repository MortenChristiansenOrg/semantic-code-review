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
  let commentTarget = null;
  let exportState = { phase: "idle", message: "" };

  function defaults() {
    return {
      approvals: {},
      comments: [],
      openStages: { [data.stages[0].id]: true },
      openThreads: {},
      lastNoteMode: "personal",
      requirementOpen: false,
      coverageOpen: false,
      notesOpen: false,
      pinnedInsight: null,
      hideApproved: false,
      fileView: {},
      active: null
    };
  }
  function load() {
    try { return { ...defaults(), ...JSON.parse(localStorage.getItem(storeKey) || "{}") }; }
    catch { return defaults(); }
  }
  function persist() { localStorage.setItem(storeKey, JSON.stringify(state)); }

  /* ---- helpers ---------------------------------------------------------- */
  function esc(v) {
    return String(v)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  const approved = (id) => Boolean(state.approvals[id]);
  const commentCount = (id) => state.comments.filter((c) => c.id === id).length;
  function elementNotes(id) {
    return state.comments.map((c, i) => ({ c, i })).filter((x) => x.c.id === id);
  }
  function acceptanceStatus(acId) {
    const ref = `#${acId}`;
    const stages = data.stages
      .map((s, i) => ({ s, i }))
      .filter((x) => (x.s.requirementRefs || []).some((r) => r.endsWith(ref)));
    if (!stages.length) return { key: "uncovered", stages: [] };
    const allApproved = stages.every((x) => approved(x.s.id));
    return { key: allApproved ? "approved" : "pending", stages: stages.map((x) => x.i + 1) };
  }
  function stageAcceptanceIds(stage) {
    return (stage.requirementRefs || []).map((r) => r.split("#").pop()).filter(Boolean);
  }
  function acChip(acId) {
    const ac = data.requirement.acceptance.find((a) => a.id === acId);
    const st = acceptanceStatus(acId);
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
      aria-haspopup="true">${esc(acId)}</button>`;
  }
  function bubble() {
    return `<svg class="bub" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
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
    const on = approved(id);
    return `<button class="approve ${size} ${on ? "is-on" : ""}" data-action="approve" data-id="${id}" type="button" aria-pressed="${on}">
      <span class="check">${on ? "✓" : ""}</span>${on ? "Approved" : "Approve"}</button>`;
  }
  function commentBtn(kind, id, stageId) {
    return `<button class="comment" data-action="comment" data-kind="${kind}" data-id="${id}" data-stage="${stageId || ""}" type="button">＋ Note</button>`;
  }
  function notesToggle(id) {
    const notes = elementNotes(id);
    if (!notes.length) return "";
    const open = Boolean(state.openThreads[id]);
    const openCount = notes.filter((x) => !x.c.resolved).length;
    return `<button class="notes-toggle ${open ? "is-open" : ""} ${openCount ? "" : "all-resolved"}" data-action="toggle-thread" data-id="${id}" type="button" aria-expanded="${open}" title="${notes.length} note${notes.length === 1 ? "" : "s"}${openCount ? `, ${openCount} open` : ", all resolved"}">
      ${bubble()}<b>${notes.length}</b>${openCount ? '<i class="nt-dot"></i>' : ""}</button>`;
  }
  function noteCluster(kind, id, stageId) {
    return `<div class="note-cluster">${commentBtn(kind, id, stageId)}${notesToggle(id)}</div>`;
  }
  function threadInline(id, kind) {
    if (!state.openThreads[id]) return "";
    const notes = elementNotes(id);
    if (!notes.length) return "";
    const rows = notes.map(({ c, i }) => `
      <article class="tnote mode-${c.mode || "personal"} ${c.resolved ? "is-resolved" : ""}">
        <div class="tnote-h">
          <span class="tnote-mode">${(c.mode || "personal") === "feedback" ? "Feedback" : "Personal"}</span>
          ${c.resolved ? '<span class="tnote-res">Resolved</span>' : ""}
          <div class="tnote-act">
            <button data-action="resolve-note" data-index="${i}" type="button">${c.resolved ? "Reopen" : "Resolve"}</button>
            <button class="tnote-del" data-action="del-note" data-index="${i}" type="button" aria-label="Delete note">×</button>
          </div>
        </div>
        <p>${esc(c.body)}</p>
      </article>`).join("");
    return `<div class="thread">${rows}
      <button class="thread-add" data-action="comment" data-kind="${kind}" data-id="${id}" type="button">＋ Add note</button>
    </div>`;
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
    const isOn = approved(id);
    const isActive = state.active === id;
    const notes = elementNotes(id);
    const threadOpen = Boolean(state.openThreads[id]);
    return `<div class="frow-wrap ${threadOpen ? "thread-open" : ""}">
      <div class="frow ${isOn ? "is-approved" : ""} ${isActive ? "is-active" : ""}" data-file="${id}">
        <button class="frow-open" data-action="open-file" data-id="${id}" type="button" title="Inspect diff">
          <span class="kind k-${file.kind}">${kindGlyph(file.kind)}</span>
          <span class="fp"><small>${esc(dir)}</small><strong>${esc(name)}</strong></span>
          ${classBadge(cls)}
          ${fileMetrics(file)}
        </button>
        <div class="frow-act">
          ${notes.length ? `<button class="mini-thread ${threadOpen ? "is-open" : ""}" data-action="toggle-thread" data-id="${id}" type="button" aria-expanded="${threadOpen}" title="${notes.length} note${notes.length === 1 ? "" : "s"}">${bubble()}<b>${notes.length}</b></button>` : ""}
          <button class="mini-approve ${isOn ? "is-on" : ""}" data-action="approve" data-id="${id}" type="button" aria-pressed="${isOn}" title="${isOn ? "Approved" : "Approve file"}"><span>${isOn ? "✓" : ""}</span></button>
          <button class="mini-note" data-action="comment" data-kind="file" data-id="${id}" type="button" title="Add note">✎</button>
        </div>
      </div>
      ${threadInline(id, "file")}
    </div>`;
  }
  function nodeFilesPanel(stage, node) {
    const files = nodeFileList(stage, node);
    const total = files.length;
    const done = files.filter((f) => approved(fileKey(stage.id, f.path))).length;
    const byCls = {};
    files.forEach((f) => { const c = classificationFor(f, node.id); byCls[c] = (byCls[c] || 0) + 1; });
    const clsSummary = Object.entries(byCls)
      .map(([c, n]) => `<span class="cls cls-${c}">${n} ${CLASS_LABEL[c] || c}</span>`).join("");

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
          <span class="fg-count">${gfiles.length}</span>
          <span class="fg-done">${gd === gfiles.length ? "✓ all" : `${gd}/${gfiles.length}`}</span>
        </div>
        <div class="flist">${rows}</div>
      </div>`;
    }).join("");

    return `<details class="payload ${done === total ? "all-done" : ""}" data-node-files="${node.id}">
      <summary>
        <span class="pl-caret">${caret()}</span>
        <span class="pl-count">${total} file${total === 1 ? "" : "s"}</span>
        <span class="pl-groups">${groups.size} project${groups.size === 1 ? "" : "s"}</span>
        <span class="pl-cls">${clsSummary}</span>
        <span class="pl-progress" title="${done}/${total} approved"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span>
      </summary>
      <div class="fgroups">${groupHtml}</div>
    </details>`;
  }

  /* ---- diff renderer (shared, big view) --------------------------------- */
  function fileViewMode(id) { return state.fileView[id] === "full" ? "full" : "hunk"; }
  function drowHtml(r) {
    const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : "";
    return `<div class="drow d-${r.t}"><span class="ln">${r.o || ""}</span><span class="ln">${r.n || ""}</span><i>${sign}</i><code>${esc(r.s || " ")}</code></div>`;
  }
  function gapHtml(count) {
    return `<div class="drow d-gap"><span class="ln"></span><span class="ln"></span><i></i><code>⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋯</code></div>`;
  }
  function diffBody(file, mode) {
    if (file.binary) return `<div class="diff-empty">Binary file — not shown.</div>`;
    const lines = file.lines || [];
    if (!lines.length) return `<div class="diff-empty">No line changes recorded for this file.</div>`;
    const out = [];
    if (mode === "full") {
      lines.forEach((r) => out.push(drowHtml(r)));
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
        if (keep[i]) { out.push(drowHtml(lines[i])); i++; }
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
        ${viewToggle(id)}
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
    return `<header class="diff-bar">
      <span class="diff-bar-hint">Inline diff</span>
      ${viewToggle(entry.id)}
    </header>`;
  }

  /* ---- chrome ----------------------------------------------------------- */
  function topbar() {
    return `<header class="topbar">
      <div class="lockup">
        <span class="vindex">◆</span>
        <div><strong>Semantic review</strong><span>${esc(data.reviewId)}</span></div>
      </div>
      <div class="tb-actions">
        <button class="tb-btn ${state.coverageOpen ? "is-on" : ""}" data-action="toggle-coverage" type="button" aria-expanded="${state.coverageOpen}">Coverage <b>${approvedCount()}/${reviewable()}</b></button>
        <button class="tb-btn ${state.notesOpen ? "is-on" : ""}" data-action="toggle-notes" type="button" aria-expanded="${state.notesOpen}">Notes <b>${state.comments.length}</b></button>
      </div>
    </header>
    <div class="progressbar" aria-hidden="true"><span style="width:${pct()}%"></span></div>`;
  }

  function hero() {
    const totalFiles = data.stages.reduce((a, s) => a + s.files.length, 0);
    const totalNodes = data.stages.reduce((a, s) => a + s.nodes.length, 0);
    return `<section class="hero">
      <span class="eyebrow">Semantic review · ${esc(data.reviewId)}</span>
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
    return `<details class="requirement" ${state.requirementOpen ? "open" : ""} data-req>
      <summary>
        <span class="req-mark">✦</span>
        <div><span class="eyebrow">Requirement · ${esc(data.requirement.id)}</span><h2>${esc(data.requirement.title)}</h2></div>
        <span class="req-more">${data.requirement.acceptance.length} acceptance criteria</span>
      </summary>
      <div class="req-body">
        <p>${esc(data.requirement.summary)}</p>
        <ol class="ac-list">${data.requirement.acceptance.map((a) => {
      const st = acceptanceStatus(a.id);
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
    const acIds = stageAcceptanceIds(stage);
    return `<section class="stage ${done ? "is-approved" : ""} ${open ? "is-open" : ""}" data-stage="${stage.id}">
      <div class="stage-bar">
        <button class="stop ${done ? "is-approved" : ""}" data-action="toggle-stage" data-id="${stage.id}" type="button" aria-expanded="${open}">
          <span class="stop-num">${done ? "✓" : String(i + 1).padStart(2, "0")}</span>
        </button>
        <div class="stage-head">
          <button class="stage-title" data-action="toggle-stage" data-id="${stage.id}" type="button">
            <span class="eyebrow">Stage ${i + 1} · ${i === 0 ? "foundation" : `stacked on ${String(i).padStart(2, "0")}`}</span>
            <h2>${esc(stage.title)}</h2>
          </button>
          <p class="stage-sum">${esc(stage.summary)}</p>
          <div class="stage-meta">
            <span>${nodesDone}/${stage.nodes.length} steps</span>
            <span>${filesDone}/${stage.files.length} files</span>
            ${acIds.length ? `<span class="sm-ac"><span class="sm-ac-label">AC</span>${acIds.map(acChip).join("")}</span>` : ""}
          </div>
        </div>
        <div class="stage-approve">${approveBtn("stage", stage.id, "sm")}${noteCluster("stage", stage.id)}</div>
      </div>
      ${threadInline(stage.id, "stage")}
      <div class="stage-body">
        <p class="rationale"><span class="eyebrow">Why this stage</span>${esc(stage.rationale)}</p>
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
  function groupedNotes() {
    const stageMap = new Map();
    state.comments.forEach((c, i) => {
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
      .filter(({ c }) => (c.mode === "feedback") && !c.resolved && !c.exported);
  }
  function notesPanel() {
    const noteCard = ({ c, i }) => `<article class="note mode-${c.mode || "personal"} ${c.resolved ? "is-resolved" : ""}">
        <header>
          <span class="note-mode">${(c.mode || "personal") === "feedback" ? "Feedback" : "Personal"}</span>
          ${c.exported ? '<span class="note-sent" title="Sent to the semantic-flow artifact">Sent</span>' : ""}
          <span class="note-kind">${esc(c.kind)}</span>
          <div class="note-act">
            <button data-action="resolve-note" data-index="${i}" type="button">${c.resolved ? "Reopen" : "Resolve"}</button>
            <button class="note-del" data-action="del-note" data-index="${i}" aria-label="Delete" type="button">×</button>
          </div>
        </header>
        <strong>${esc(labelFor(c.kind, c.id))}</strong>
        <p>${esc(c.body)}</p>
      </article>`;
    const body = state.comments.length
      ? groupedNotes().map((st) => `<section class="note-stage">
          <h3 class="note-stage-h">${esc(st.title)}</h3>
          ${st.nodesArr.map((nd) => `<div class="note-node">
            <h4 class="note-node-h">${esc(nd.title)}</h4>
            ${nd.daysArr.map((day) => `<div class="note-day">${esc(day.label)}</div>${day.items.map(noteCard).join("")}`).join("")}
          </div>`).join("")}
        </section>`).join("")
      : `<div class="notes-empty"><span>✎</span><p>No notes yet.</p><small>Leave a note on any stage, step, or file.</small></div>`;
    const pending = pendingFeedback().length;
    const working = exportState.phase === "working";
    const statusClass = exportState.phase === "error" ? "is-error" : exportState.phase === "done" ? "is-done" : "";
    const foot = `<div class="notes-foot">
        <button class="notes-export" data-action="export-feedback" type="button" ${pending && !working ? "" : "disabled"}>
          ${working ? "Sending…" : `Send feedback to artifact${pending ? ` (${pending})` : ""}`}
        </button>
        ${exportState.message ? `<p class="notes-export-msg ${statusClass}">${esc(exportState.message)}</p>`
          : `<p class="notes-export-hint">${pending ? "Feedback notes are written to the semantic-flow artifact so your agent can address them." : "Only unsent “Feedback” notes are exported. Personal notes stay local."}</p>`}
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
  function dialog() {
    return `<dialog class="note-dialog"><form method="dialog" data-note-form>
      <div class="nd-top"><div><span class="eyebrow" id="nd-kind">New note</span><h2>Leave a note</h2></div><button value="cancel" aria-label="Close" type="submit" formnovalidate>×</button></div>
      <p class="nd-target" id="nd-target"></p>
      <div class="nd-mode" role="radiogroup" aria-label="Note type">
        <label class="nd-opt"><input type="radio" name="nd-mode" value="personal" checked><span class="nd-opt-face"><b>Personal note</b><small>Just for you — thoughts while reviewing.</small></span></label>
        <label class="nd-opt"><input type="radio" name="nd-mode" value="feedback"><span class="nd-opt-face"><b>Feedback</b><small>A request or comment for the author.</small></span></label>
      </div>
      <textarea id="nd-body" rows="5" required placeholder="A concise observation for your review…"></textarea>
      <div class="nd-actions"><button value="cancel" type="submit" formnovalidate>Cancel</button><button class="nd-save" value="save" type="submit">Save note</button></div>
    </form></dialog>`;
  }

  /* ---- render ----------------------------------------------------------- */
  function render() {
    app.innerHTML = `${topbar()}
      <main class="shell v-cinema">
        ${storyColumn()}
      </main>
      ${coveragePanel()}${notesPanel()}
      <div class="scrim ${state.coverageOpen || state.notesOpen ? "is-on" : ""}" data-action="close-panels"></div>
      ${dialog()}`;
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
    if (det.matches(".requirement")) { state.requirementOpen = det.open; persist(); }
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
      state.approvals[id] = !approved(id);
      persist(); render();
    } else if (a === "toggle-stage") {
      const id = btn.dataset.id;
      state.openStages[id] = !state.openStages[id];
      persist(); render();
    } else if (a === "toggle-coverage") {
      state.coverageOpen = !state.coverageOpen; state.notesOpen = false; persist(); render();
    } else if (a === "toggle-notes") {
      state.notesOpen = !state.notesOpen; state.coverageOpen = false; persist(); render();
    } else if (a === "close-panels") {
      state.coverageOpen = false; state.notesOpen = false; persist(); render();
    } else if (a === "comment") {
      openComment(btn.dataset.kind, btn.dataset.id, btn.dataset.stage);
    } else if (a === "toggle-thread") {
      const id = btn.dataset.id;
      state.openThreads[id] = !state.openThreads[id];
      persist(); render();
    } else if (a === "resolve-note") {
      const c = state.comments[Number(btn.dataset.index)];
      if (c) { c.resolved = !c.resolved; persist(); render(); }
    } else if (a === "set-view") {
      state.fileView[btn.dataset.id] = btn.dataset.mode;
      persist(); render();
    } else if (a === "del-note") {
      state.comments.splice(Number(btn.dataset.index), 1); persist(); render();
    } else if (a === "open-file") {
      toggleCinema(btn.dataset.id);
    } else if (a === "cinema-close") { state.active = null; persist(); render(); }
    else if (a === "export-feedback") {
      exportFeedback();
    }
  });

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
      (out.exported || []).forEach((ref) => {
        const note = byRef.get(ref);
        if (note) note.exported = true;
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
        message: `Sent ${n} feedback note${n === 1 ? "" : "s"} to the artifact${skipped.length ? `, ${skipped.length} skipped` : ""}. Run “/semantic-flow feedback” in your agent to address them.`,
        skips
      };
    } catch (err) {
      exportState = { phase: "error", message: err.message || "Export failed.", skips: [] };
    }
    render();
  }

  function toggleCinema(id) {
    state.active = state.active === id ? null : id;
    persist(); render();
    if (state.active) requestAnimationFrame(() => {
      document.querySelector(`.frow[data-file="${cssEsc(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function openComment(kind, id, stageId) {
    commentTarget = { kind, id };
    if (kind === "node" && stageId) commentTarget.stageId = stageId;
    const d = app.querySelector(".note-dialog");
    d.querySelector("#nd-kind").textContent = kind === "file" ? "File note" : kind === "stage" ? "Stage note" : "Step note";
    d.querySelector("#nd-target").textContent = labelFor(kind, id);
    d.querySelector("textarea").value = "";
    const mode = state.lastNoteMode === "feedback" ? "feedback" : "personal";
    const radio = d.querySelector(`input[name="nd-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    d.showModal();
    d.querySelector("textarea").focus();
  }

  document.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-note-form]")) return;
    e.preventDefault();
    if (e.submitter?.value === "save" && commentTarget) {
      const body = e.target.querySelector("textarea").value.trim();
      const mode = e.target.querySelector('input[name="nd-mode"]:checked')?.value || "personal";
      if (body) {
        state.comments.push({ ...commentTarget, body, mode, resolved: false, createdAt: Date.now() });
        state.openThreads[commentTarget.id] = true;
        state.lastNoteMode = mode;
        persist();
      }
    }
    commentTarget = null;
    e.target.closest("dialog").close();
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.coverageOpen || state.notesOpen) { state.coverageOpen = state.notesOpen = false; persist(); render(); return; }
      if (state.active) { state.active = null; persist(); render(); return; }
    }
  });

  // cinema inline diff injection + open-disclosure preservation across renders.
  function captureOpen() {
    const keys = new Set();
    app.querySelectorAll("details.node[open]").forEach((d) => keys.add(`node:${d.dataset.node}`));
    app.querySelectorAll("details.payload[open]").forEach((d) => keys.add(`pl:${d.dataset.nodeFiles}`));
    return keys;
  }
  function restoreOpen(keys) {
    if (!keys || !keys.size) return;
    app.querySelectorAll("details.node").forEach((d) => { if (keys.has(`node:${d.dataset.node}`)) d.open = true; });
    app.querySelectorAll("details.payload").forEach((d) => { if (keys.has(`pl:${d.dataset.nodeFiles}`)) d.open = true; });
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
        // ensure the ancestor payload is open so the diff is visible
        row.closest("details.payload") && (row.closest("details.payload").open = true);
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
