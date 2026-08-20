(function () {
  "use strict";

  const data = window.REVIEW_DATA;
  const concept = document.body.dataset.concept;
  const app = document.querySelector("#app");
  const storageKey = `semantic-review-mockup:${concept}`;
  const conceptNames = {
    chronicle: "Chronicle",
    "field-notes": "Field notes",
    "focus-reader": "Focus reader",
    "foldout-map": "Foldout map",
    "review-ledger": "Review ledger",
    "milestone-ribbon": "Milestone ribbon",
    "evidence-weave": "Evidence weave",
    "pocket-cards": "Pocket cards",
    "review-board": "Review board",
    "quiet-checklist": "Quiet checklist"
  };

  const allItems = [
    { kind: "requirement", id: data.requirement.id, data: data.requirement },
    ...data.stages.flatMap((stage) => [
      { kind: "stage", id: stage.id, data: stage },
      ...stage.nodes.map((node) => ({ kind: "node", id: node.id, data: node, stage }))
    ])
  ];

  let state = loadState();
  let noteTarget = null;
  let motionMode = "initial";

  function loadState() {
    const initial = {
      approvals: {},
      notes: [],
      selectedId: concept === "field-notes" ? data.requirement.id : data.stages[0].nodes[0].id,
      focusIndex: 0,
      selectedStageId: data.stages[0].id,
      pocketIndex: 0,
      expandedStages: { [data.stages[0].id]: true },
      notesOpen: false,
      overviewOpen: false
    };
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
    } catch {
      return initial;
    }
  }

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function approved(id) {
    return Boolean(state.approvals[id]);
  }

  function approvalCount() {
    return data.stages.reduce((count, stage) => count + Number(approved(stage.id)) + stage.nodes.filter((node) => approved(node.id)).length, 0);
  }

  function reviewableCount() {
    return data.stages.reduce((count, stage) => count + 1 + stage.nodes.length, 0);
  }

  function progressPercent() {
    return Math.round((approvalCount() / reviewableCount()) * 100);
  }

  function targetLabel(kind, id) {
    if (kind === "stage") return data.stages.find((stage) => stage.id === id)?.title || id;
    if (kind === "node") return data.stages.flatMap((stage) => stage.nodes).find((node) => node.id === id)?.title || id;
    return data.title;
  }

  function noteCount(id) {
    return state.notes.filter((note) => note.id === id).length;
  }

  function topbar(subtitle) {
    return `
      <header class="topbar">
        <a class="back-link" href="index.html" aria-label="Back to all directions">← <span>All directions</span></a>
        <div class="concept-lockup"><span class="concept-index">${Object.keys(conceptNames).indexOf(concept) + 1}/10</span><strong>${conceptNames[concept]}</strong><span>${subtitle}</span></div>
        <div class="topbar-actions">
          <button class="review-toggle ${state.overviewOpen ? "is-active" : ""}" data-action="toggle-overview" type="button" aria-expanded="${state.overviewOpen}">Review <span>${approvalCount()}/${reviewableCount()}</span></button>
          <button class="notes-toggle ${state.notesOpen ? "is-active" : ""}" data-action="toggle-notes" type="button" aria-expanded="${state.notesOpen}">Notes <span>${state.notes.length}</span></button>
        </div>
      </header>`;
  }

  function progressBar() {
    return `<div class="review-progress" aria-label="${approvalCount()} of ${reviewableCount()} items approved"><span style="width:${progressPercent()}%"></span></div>`;
  }

  function actionButtons(kind, id, compact = false) {
    const isApproved = approved(id);
    const notes = noteCount(id);
    return `<div class="item-actions ${compact ? "compact" : ""}">
      <button class="approve-button ${isApproved ? "is-approved" : ""}" data-action="approve" data-kind="${kind}" data-id="${id}" type="button" aria-pressed="${isApproved}">
        <span class="checkmark">${isApproved ? "✓" : "○"}</span>${isApproved ? "Approved" : "Approve"}
      </button>
      <button class="note-button" data-action="add-note" data-kind="${kind}" data-id="${id}" type="button">＋ Note${notes ? ` <span>${notes}</span>` : ""}</button>
    </div>`;
  }

  function contextCards(context = [], compact = false) {
    if (!context.length) return "";
    return `<div class="context-list ${compact ? "compact" : ""}">${context.map((item) => `
      <article class="context-card type-${item.type}">
        <div class="context-label"><span class="context-dot"></span>${item.type}</div>
        <h4>${escapeHtml(item.title)}</h4>
        <p>${escapeHtml(item.body)}</p>
      </article>`).join("")}</div>`;
  }

  function requirementBlock() {
    return `<details class="requirement-paper" open>
      <summary><span class="fold-icon">＋</span><div><span class="eyebrow">What was asked</span><h2>${escapeHtml(data.requirement.title)}</h2></div><span class="read-more">Acceptance details</span></summary>
      <div class="requirement-body"><p>${escapeHtml(data.requirement.summary)}</p><ol>${data.requirement.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></div>
    </details>`;
  }

  function notesPanel() {
    const notes = state.notes.length
      ? state.notes.map((note, index) => `<article class="saved-note"><div><span>${escapeHtml(note.kind)}</span><button data-action="delete-note" data-index="${index}" aria-label="Delete note" type="button">×</button></div><strong>${escapeHtml(targetLabel(note.kind, note.id))}</strong><p>${escapeHtml(note.body)}</p></article>`).join("")
      : `<div class="empty-notes"><span>✎</span><p>No notes yet.</p><small>Add a thought from any stage or implementation step.</small></div>`;
    return `<aside class="notes-panel side-panel ${state.notesOpen ? "is-open" : ""}" aria-hidden="${!state.notesOpen}" ${state.notesOpen ? "" : "inert"}>
      <div class="notes-heading"><div><span class="eyebrow">Private to you</span><h2>Review notes</h2></div><button data-action="toggle-notes" aria-label="Close notes" type="button">×</button></div>
      <div class="saved-notes">${notes}</div>
      ${state.notes.length ? `<button class="clear-notes" data-action="clear-notes" type="button">Clear all notes</button>` : ""}
    </aside>`;
  }

  function approvalOverview() {
    const stages = data.stages.map((stage, stageIndex) => {
      const nodeCount = stage.nodes.filter((node) => approved(node.id)).length;
      return `<section class="overview-stage ${approved(stage.id) ? "is-approved" : ""}">
        <div class="overview-stage-heading"><span>${String(stageIndex + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(stage.title)}</strong><small>${nodeCount} of ${stage.nodes.length} steps approved</small></div><i>${approved(stage.id) ? "✓" : "○"}</i></div>
        <div class="overview-nodes">${stage.nodes.map((node) => `<div class="overview-node ${approved(node.id) ? "is-approved" : ""}" title="${escapeHtml(node.title)}"><span>${approved(node.id) ? "✓" : ""}</span><small>${escapeHtml(node.title)}</small></div>`).join("")}</div>
      </section>`;
    }).join("");
    return `<aside class="approval-overview side-panel ${state.overviewOpen ? "is-open" : ""}" aria-hidden="${!state.overviewOpen}" ${state.overviewOpen ? "" : "inert"}>
      <div class="overview-heading"><div><span class="eyebrow">At a glance</span><h2>Review coverage</h2></div><button data-action="toggle-overview" aria-label="Close review overview" type="button">×</button></div>
      <div class="overview-score"><div><strong>${progressPercent()}%</strong><span>reviewed</span></div><p>${approvalCount()} of ${reviewableCount()} stage and step decisions have your approval.</p></div>
      <div class="overview-list">${stages}</div>
      <div class="overview-key"><span><i class="stage-key"></i>Stage approval</span><span><i class="node-key"></i>Step approval</span></div>
    </aside>`;
  }

  function dialog() {
    return `<dialog class="note-dialog" id="note-dialog"><form method="dialog" data-note-form>
      <div class="dialog-top"><div><span class="eyebrow">Personal note</span><h2 id="note-title">Capture a thought</h2></div><button value="cancel" aria-label="Close" type="submit">×</button></div>
      <p class="note-target" id="note-target"></p>
      <label for="note-body">What should you remember or raise?</label>
      <textarea id="note-body" rows="5" required placeholder="Write a concise observation…"></textarea>
      <div class="dialog-actions"><button value="cancel" type="submit">Cancel</button><button class="save-note" value="default" type="submit">Save note</button></div>
    </form></dialog>`;
  }

  function chrome(content, subtitle) {
    const panelOpen = state.notesOpen || state.overviewOpen;
    return `${topbar(subtitle)}${progressBar()}${content}${approvalOverview()}${notesPanel()}<div class="panel-scrim ${panelOpen ? "is-visible" : ""}" data-action="close-panels"></div>${dialog()}`;
  }

  function renderChronicle() {
    const stages = data.stages.map((stage, stageIndex) => `
      <details class="chronicle-stage paper-layer ${approved(stage.id) ? "approved-item" : ""}" ${stageIndex === 0 ? "open" : ""}>
        <summary>
          <div class="timeline-marker"><span>${String(stageIndex + 1).padStart(2, "0")}</span></div>
          <div class="stage-heading"><span class="eyebrow">Stage ${stageIndex + 1} · ${stage.nodes.length} steps</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p></div>
          ${actionButtons("stage", stage.id, true)}<span class="expand-symbol">⌄</span>
        </summary>
        <div class="stage-inside"><p class="rationale"><span>Why this stage</span>${escapeHtml(stage.rationale)}</p>
          <div class="chronicle-nodes">${stage.nodes.map((node, nodeIndex) => `
            <details class="chronicle-node ${approved(node.id) ? "approved-item" : ""}" ${stageIndex === 0 && nodeIndex === 0 ? "open" : ""}>
              <summary><span class="node-count">${stageIndex + 1}.${nodeIndex + 1}</span><div><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><span class="expand-symbol">⌄</span></summary>
              <div class="node-inside">${contextCards(node.context)}${actionButtons("node", node.id)}</div>
            </details>`).join("")}</div>
        </div>
      </details>`).join("");

    app.innerHTML = chrome(`<main class="chronicle-shell">
      <section class="chronicle-hero"><span class="eyebrow">Review narrative</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.summary)}</p><div class="hero-status"><span>${reviewableCount()} review moments</span><span>${approvalCount()} approved</span><span>${state.notes.length} notes</span></div></section>
      ${requirementBlock()}
      <section class="chronicle-timeline" aria-label="Implementation stages">${stages}</section>
      <section class="end-paper"><span>End of review</span><h2>${approvalCount() === reviewableCount() ? "Everything has your approval." : `${reviewableCount() - approvalCount()} review moments remain.`}</h2><a href="#top" data-action="to-top">Return to the beginning ↑</a></section>
    </main>`, "Continuous narrative");
  }

  function itemForId(id) {
    return allItems.find((item) => item.id === id) || allItems[1];
  }

  function focusedContent(item) {
    if (item.kind === "requirement") {
      return `<span class="eyebrow">Requirement</span><h1>${escapeHtml(item.data.title)}</h1><p class="lead-copy">${escapeHtml(item.data.summary)}</p><div class="acceptance-stack"><span class="section-label">A complete result means</span>${item.data.acceptance.map((text, index) => `<div><span>${index + 1}</span><p>${escapeHtml(text)}</p></div>`).join("")}</div>`;
    }
    if (item.kind === "stage") {
      return `<span class="eyebrow">Stage ${data.stages.indexOf(item.data) + 1} · ${item.data.nodes.length} implementation steps</span><h1>${escapeHtml(item.data.title)}</h1><p class="lead-copy">${escapeHtml(item.data.summary)}</p><blockquote><span>Why it is separate</span>${escapeHtml(item.data.rationale)}</blockquote>${actionButtons("stage", item.id)}`;
    }
    return `<span class="eyebrow">Implementation step · ${escapeHtml(item.stage.title)}</span><h1>${escapeHtml(item.data.title)}</h1><p class="lead-copy">${escapeHtml(item.data.description)}</p>${contextCards(item.data.context)}${actionButtons("node", item.id)}`;
  }

  function renderFieldNotes() {
    const selected = itemForId(state.selectedId);
    const outline = data.stages.map((stage, stageIndex) => `<div class="outline-stage">
      <button class="outline-stage-button ${selected.id === stage.id ? "is-selected" : ""}" data-action="select" data-id="${stage.id}" type="button"><span>${String(stageIndex + 1).padStart(2, "0")}</span><span>${escapeHtml(stage.title)}</span><i>${approved(stage.id) ? "✓" : ""}</i></button>
      <div class="outline-nodes">${stage.nodes.map((node) => `<button class="outline-node-button ${selected.id === node.id ? "is-selected" : ""}" data-action="select" data-id="${node.id}" type="button"><span>${escapeHtml(node.title)}</span><i>${approved(node.id) ? "✓" : ""}</i></button>`).join("")}</div>
    </div>`).join("");
    app.innerHTML = chrome(`<main class="field-shell">
      <aside class="field-outline"><div class="field-intro"><span class="eyebrow">Implementation</span><h2>${escapeHtml(data.title)}</h2></div><button class="requirement-tab ${selected.kind === "requirement" ? "is-selected" : ""}" data-action="select" data-id="${data.requirement.id}" type="button"><span>✦</span> Read the requirement</button><nav aria-label="Review outline">${outline}</nav></aside>
      <section class="reading-desk"><div class="reading-paper">${focusedContent(selected)}</div><div class="desk-footer"><span>${allItems.indexOf(selected) + 1} of ${allItems.length}</span><div><button data-action="move-selection" data-delta="-1" type="button" ${allItems.indexOf(selected) === 0 ? "disabled" : ""}>← Previous</button><button data-action="move-selection" data-delta="1" type="button" ${allItems.indexOf(selected) === allItems.length - 1 ? "disabled" : ""}>Next →</button></div></div></section>
      <aside class="margin-guide"><span class="eyebrow">Reading key</span><ul><li><i class="key-dot decision"></i>Decision</li><li><i class="key-dot assumption"></i>Assumption</li><li><i class="key-dot risk"></i>Risk</li><li><i class="key-dot lesson"></i>Lesson</li><li><i class="key-dot evidence"></i>Evidence</li></ul><p>Use <kbd>←</kbd> <kbd>→</kbd> to move through the story.</p></aside>
    </main>`, "Outline + reading desk");
  }

  function renderFocusReader() {
    state.focusIndex = Math.max(0, Math.min(state.focusIndex, allItems.length - 1));
    const item = allItems[state.focusIndex];
    const dots = allItems.map((entry, index) => `<button data-action="focus-index" data-index="${index}" class="focus-dot ${index === state.focusIndex ? "is-current" : ""} ${entry.kind !== "requirement" && approved(entry.id) ? "is-approved" : ""}" aria-label="Go to ${escapeHtml(entry.data.title)}" type="button"><span></span></button>`).join("");
    app.innerHTML = chrome(`<main class="focus-shell">
      <div class="focus-heading"><span class="eyebrow">${escapeHtml(data.title)}</span><span>${state.focusIndex + 1} / ${allItems.length}</span></div>
      <div class="focus-track">${dots}</div>
      <section class="focus-deck"><div class="deck-shadow shadow-one"></div><div class="deck-shadow shadow-two"></div><article class="focus-paper kind-${item.kind}">${focusedContent(item)}</article></section>
      <nav class="focus-nav" aria-label="Review navigation"><button data-action="focus-move" data-delta="-1" ${state.focusIndex === 0 ? "disabled" : ""} type="button"><span>←</span><small>Previous</small></button><div><strong>${item.kind === "requirement" ? "Brief" : item.kind === "stage" ? "Stage overview" : "Implementation step"}</strong><span>${item.kind === "node" ? escapeHtml(item.stage.title) : "The review story"}</span></div><button data-action="focus-move" data-delta="1" ${state.focusIndex === allItems.length - 1 ? "disabled" : ""} type="button"><small>${state.focusIndex === allItems.length - 1 ? "Complete" : "Continue"}</small><span>→</span></button></nav>
    </main>`, "Guided review");
  }

  function renderFoldoutMap() {
    const stages = data.stages.map((stage, stageIndex) => {
      const isOpen = Boolean(state.expandedStages[stage.id]);
      return `<article class="map-stage ${isOpen ? "is-open" : ""} ${approved(stage.id) ? "approved-item" : ""}" data-stage-id="${stage.id}">
        <div class="map-stage-spine"><span class="map-number">${String(stageIndex + 1).padStart(2, "0")}</span><span class="map-status">${approved(stage.id) ? "Approved" : `${stage.nodes.length} steps`}</span></div>
        <div class="map-stage-head"><span class="eyebrow">Stage ${stageIndex + 1}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p><div class="map-actions">${actionButtons("stage", stage.id, true)}<button class="unfold-button" data-action="toggle-stage" data-id="${stage.id}" type="button" aria-expanded="${isOpen}">${isOpen ? "Fold" : "Unfold"} ${isOpen ? "−" : "+"}</button></div></div>
        <div class="map-fold"><p class="map-rationale"><span>Purpose</span>${escapeHtml(stage.rationale)}</p><div class="map-nodes">${stage.nodes.map((node, nodeIndex) => `<details class="map-node ${approved(node.id) ? "approved-item" : ""}"><summary><span>${stageIndex + 1}.${nodeIndex + 1}</span><div><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><i>＋</i></summary><div class="map-node-body">${contextCards(node.context, true)}${actionButtons("node", node.id)}</div></details>`).join("")}</div></div>
      </article>`;
    }).join("");
    app.innerHTML = chrome(`<main class="map-shell"><section class="map-header"><div><span class="eyebrow">Review map</span><h1>${escapeHtml(data.title)}</h1></div><details><summary>Read the brief <span>＋</span></summary><p>${escapeHtml(data.requirement.summary)}</p><ul>${data.requirement.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details></section><div class="map-hint">Scroll the map <span>→</span> · unfold a stage to inspect its steps</div><section class="map-scroll" aria-label="Implementation map"><div class="map-line"></div>${stages}</section></main>`, "Spatial overview");
  }

  function renderLedger() {
    let selected = itemForId(state.selectedId);
    let stage = selected.kind === "node" ? selected.stage : selected.kind === "stage" ? selected.data : data.stages[0];
    if (selected.kind === "requirement") selected = { kind: "stage", id: stage.id, data: stage };
    const selectedNode = selected.kind === "node" ? selected.data : null;
    const stageNav = data.stages.map((entry, index) => `<button data-action="ledger-stage" data-id="${entry.id}" class="${entry.id === stage.id ? "is-selected" : ""}" type="button"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(entry.title)}</strong><small>${entry.nodes.length} steps · ${entry.nodes.filter((node) => approved(node.id)).length} approved</small></div><i>${approved(entry.id) ? "✓" : ""}</i></button>`).join("");
    const nodes = stage.nodes.map((node, index) => `<button data-action="select" data-id="${node.id}" class="${selectedNode?.id === node.id ? "is-selected" : ""}" type="button"><span>${index + 1}</span><div><strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(node.description)}</small></div><i>${approved(node.id) ? "✓" : ""}</i></button>`).join("");
    const detail = selectedNode
      ? `<span class="eyebrow">Selected implementation step</span><h2>${escapeHtml(selectedNode.title)}</h2><p class="ledger-lead">${escapeHtml(selectedNode.description)}</p>${contextCards(selectedNode.context)}${actionButtons("node", selectedNode.id)}`
      : `<span class="eyebrow">Stage overview</span><h2>${escapeHtml(stage.title)}</h2><p class="ledger-lead">${escapeHtml(stage.summary)}</p><blockquote><span>Reason for this stage</span>${escapeHtml(stage.rationale)}</blockquote>${actionButtons("stage", stage.id)}`;
    app.innerHTML = chrome(`<main class="ledger-shell"><header class="ledger-title"><div><span class="eyebrow">Review ledger</span><h1>${escapeHtml(data.title)}</h1></div><details><summary>Requirement</summary><p>${escapeHtml(data.requirement.summary)}</p></details></header><div class="ledger-grid"><nav class="ledger-stages" aria-label="Stages"><div class="pane-label"><span>Stages</span><small>${data.stages.length}</small></div>${stageNav}</nav><nav class="ledger-nodes" aria-label="Implementation steps"><div class="pane-heading"><button data-action="ledger-stage" data-id="${stage.id}" type="button"><span class="eyebrow">Stage ${data.stages.indexOf(stage) + 1}</span><strong>${escapeHtml(stage.title)}</strong></button>${actionButtons("stage", stage.id, true)}</div><div class="pane-label"><span>Implementation steps</span><small>${stage.nodes.length}</small></div>${nodes}</nav><section class="ledger-detail">${detail}</section></div></main>`, "Three-pane workspace");
  }

  function renderMilestoneRibbon() {
    const stage = data.stages.find((entry) => entry.id === state.selectedStageId) || data.stages[0];
    const stageIndex = data.stages.indexOf(stage);
    const ribbon = data.stages.map((entry, index) => {
      const approvedNodes = entry.nodes.filter((node) => approved(node.id)).length;
      return `<button class="ribbon-stop ${entry.id === stage.id ? "is-current" : ""} ${approved(entry.id) ? "is-approved" : ""}" data-action="select-stage" data-id="${entry.id}" type="button">
        <span class="ribbon-marker">${approved(entry.id) ? "✓" : String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(entry.title)}</strong><small>${approvedNodes}/${entry.nodes.length} steps approved</small></div>
      </button>`;
    }).join("");
    const nodes = stage.nodes.map((node, nodeIndex) => `<details class="ribbon-node ${approved(node.id) ? "approved-item" : ""}" ${nodeIndex === 0 ? "open" : ""}>
      <summary><span>${stageIndex + 1}.${nodeIndex + 1}</span><div><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><i>${approved(node.id) ? "✓" : "⌄"}</i></summary>
      <div class="ribbon-node-body">${contextCards(node.context)}${actionButtons("node", node.id)}</div>
    </details>`).join("");
    app.innerHTML = chrome(`<main class="ribbon-shell">
      <header class="ribbon-hero"><div><span class="eyebrow">Milestone review</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.summary)}</p></div>${requirementBlock()}</header>
      <nav class="ribbon-track" aria-label="Choose a stage">${ribbon}</nav>
      <section class="ribbon-paper"><header><div><span class="eyebrow">Stage ${stageIndex + 1} of ${data.stages.length}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p></div>${actionButtons("stage", stage.id)}</header><blockquote><span>Purpose</span>${escapeHtml(stage.rationale)}</blockquote><div class="ribbon-node-list">${nodes}</div></section>
    </main>`, "Milestones + chapters");
  }

  function renderEvidenceWeave() {
    let alternatingIndex = 0;
    const stages = data.stages.map((stage, stageIndex) => `<section class="weave-stage">
      <header class="weave-stage-head ${approved(stage.id) ? "approved-item" : ""}"><span class="weave-stage-number">${String(stageIndex + 1).padStart(2, "0")}</span><div><span class="eyebrow">Stage ${stageIndex + 1}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p></div>${actionButtons("stage", stage.id, true)}</header>
      <p class="weave-rationale"><span>Why here</span>${escapeHtml(stage.rationale)}</p>
      <div class="weave-nodes">${stage.nodes.map((node, nodeIndex) => {
        const side = alternatingIndex++ % 2 ? "right" : "left";
        return `<details class="weave-node side-${side} ${approved(node.id) ? "approved-item" : ""}">
          <summary><span class="weave-pin">${approved(node.id) ? "✓" : ""}</span><div><small>${stageIndex + 1}.${nodeIndex + 1} · implementation step</small><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><i>⌄</i></summary>
          <div class="weave-node-body">${contextCards(node.context)}${actionButtons("node", node.id)}</div>
        </details>`;
      }).join("")}</div>
    </section>`).join("");
    app.innerHTML = chrome(`<main class="weave-shell"><header class="weave-hero"><span class="eyebrow">Connected review story</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.summary)}</p></header>${requirementBlock()}<div class="weave-thread">${stages}</div></main>`, "Alternating evidence thread");
  }

  function renderPocketCards() {
    const pocketItems = allItems.slice(1);
    state.pocketIndex = Math.max(0, Math.min(state.pocketIndex, pocketItems.length - 1));
    const item = pocketItems[state.pocketIndex];
    const itemStage = item.kind === "stage" ? item.data : item.stage;
    const stageIndex = data.stages.indexOf(itemStage);
    const stageFilters = data.stages.map((stage, index) => {
      const firstIndex = pocketItems.findIndex((entry) => entry.id === stage.id);
      const lastIndex = firstIndex + stage.nodes.length;
      const isCurrent = state.pocketIndex >= firstIndex && state.pocketIndex <= lastIndex;
      return `<button data-action="pocket-stage" data-index="${firstIndex}" class="${isCurrent ? "is-current" : ""}" type="button"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(stage.title)}</strong><i>${approved(stage.id) ? "✓" : ""}</i></button>`;
    }).join("");
    const cardContent = item.kind === "stage"
      ? `<span class="eyebrow">Stage ${stageIndex + 1} · ${item.data.nodes.length} steps</span><h2>${escapeHtml(item.data.title)}</h2><p class="pocket-lead">${escapeHtml(item.data.summary)}</p><blockquote><span>Purpose</span>${escapeHtml(item.data.rationale)}</blockquote>${actionButtons("stage", item.id)}`
      : `<span class="eyebrow">Stage ${stageIndex + 1} · implementation step</span><h2>${escapeHtml(item.data.title)}</h2><p class="pocket-lead">${escapeHtml(item.data.description)}</p><details class="pocket-context"><summary>Decisions, risks &amp; evidence <span>${item.data.context.length}</span><i>⌄</i></summary><div>${contextCards(item.data.context)}</div></details>${actionButtons("node", item.id)}`;
    app.innerHTML = chrome(`<main class="pocket-shell"><header class="pocket-heading"><div><span class="eyebrow">Pocket review</span><h1>${escapeHtml(data.title)}</h1></div><details><summary>Read requirement <i>＋</i></summary><p>${escapeHtml(data.requirement.summary)}</p></details></header><nav class="pocket-stages" aria-label="Jump to stage">${stageFilters}</nav><section class="pocket-deck"><div class="pocket-shadow shadow-a"></div><div class="pocket-shadow shadow-b"></div><article class="pocket-card">${cardContent}</article></section><footer class="pocket-nav"><button data-action="pocket-move" data-delta="-1" ${state.pocketIndex === 0 ? "disabled" : ""} type="button">← Previous</button><div><strong>${state.pocketIndex + 1}</strong><span>of ${pocketItems.length}</span></div><button data-action="pocket-move" data-delta="1" ${state.pocketIndex === pocketItems.length - 1 ? "disabled" : ""} type="button">Next →</button></footer></main>`, "Tactile card deck");
  }

  function renderReviewBoard() {
    const lanes = data.stages.map((stage, stageIndex) => `<section class="board-lane ${approved(stage.id) ? "is-approved" : ""}">
      <header><span class="board-number">${String(stageIndex + 1).padStart(2, "0")}</span><div><span class="eyebrow">Stage ${stageIndex + 1}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p></div></header>
      <div class="board-stage-actions">${actionButtons("stage", stage.id, true)}<small>${stage.nodes.filter((node) => approved(node.id)).length}/${stage.nodes.length} steps</small></div>
      <div class="board-node-list">${stage.nodes.map((node, nodeIndex) => `<details class="board-node ${approved(node.id) ? "approved-item" : ""}">
        <summary><span>${stageIndex + 1}.${nodeIndex + 1}</span><div><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><i>${approved(node.id) ? "✓" : "＋"}</i></summary>
        <div class="board-node-body">${contextCards(node.context, true)}${actionButtons("node", node.id)}</div>
      </details>`).join("")}</div>
      <details class="board-rationale"><summary>Why this stage <i>⌄</i></summary><p>${escapeHtml(stage.rationale)}</p></details>
    </section>`).join("");
    app.innerHTML = chrome(`<main class="board-shell"><header class="board-hero"><div><span class="eyebrow">Whole-story board</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.summary)}</p></div><details><summary>Requirement &amp; acceptance <span>＋</span></summary><p>${escapeHtml(data.requirement.summary)}</p><ol>${data.requirement.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></details></header><section class="board-grid" aria-label="Review stages">${lanes}</section></main>`, "Stage comparison board");
  }

  function renderQuietChecklist() {
    const stages = data.stages.map((stage, stageIndex) => `<details class="quiet-stage ${approved(stage.id) ? "approved-item" : ""}" ${stageIndex === 0 ? "open" : ""}>
      <summary><span class="quiet-check">${approved(stage.id) ? "✓" : String(stageIndex + 1).padStart(2, "0")}</span><div><small>Stage ${stageIndex + 1}</small><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary)}</p></div><i>⌄</i></summary>
      <div class="quiet-stage-body"><div class="quiet-stage-meta"><p><span>Purpose</span>${escapeHtml(stage.rationale)}</p>${actionButtons("stage", stage.id)}</div><div class="quiet-node-list">${stage.nodes.map((node, nodeIndex) => `<details class="quiet-node ${approved(node.id) ? "approved-item" : ""}">
        <summary><span class="quiet-checkbox">${approved(node.id) ? "✓" : ""}</span><div><small>${stageIndex + 1}.${nodeIndex + 1}</small><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.description)}</p></div><i>⌄</i></summary>
        <div class="quiet-node-body">${contextCards(node.context)}${actionButtons("node", node.id)}</div>
      </details>`).join("")}</div></div>
    </details>`).join("");
    const compactOverview = data.stages.map((stage, stageIndex) => `<div class="quiet-overview-stage"><span>${approved(stage.id) ? "✓" : stageIndex + 1}</span><div><strong>${escapeHtml(stage.title)}</strong><div>${stage.nodes.map((node) => `<i class="${approved(node.id) ? "is-approved" : ""}" title="${escapeHtml(node.title)}"></i>`).join("")}</div></div><small>${stage.nodes.filter((node) => approved(node.id)).length}/${stage.nodes.length}</small></div>`).join("");
    app.innerHTML = chrome(`<main class="quiet-shell"><section class="quiet-main"><header class="quiet-hero"><span class="eyebrow">Calm review checklist</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.summary)}</p></header>${requirementBlock()}<div class="quiet-list">${stages}</div></section><aside class="quiet-summary"><span class="eyebrow">Review at a glance</span><div class="quiet-score"><strong>${approvalCount()}</strong><span>of ${reviewableCount()} approved</span></div><div class="quiet-overview">${compactOverview}</div><p>Stage marks and step dots update as you review.</p></aside></main>`, "Minimal review checklist");
  }

  function render() {
    const openDetails = new Set([...app.querySelectorAll("details[open]")].map((detail, index) => disclosureKey(detail, index)));
    if (concept === "chronicle") renderChronicle();
    if (concept === "field-notes") renderFieldNotes();
    if (concept === "focus-reader") renderFocusReader();
    if (concept === "foldout-map") renderFoldoutMap();
    if (concept === "review-ledger") renderLedger();
    if (concept === "milestone-ribbon") renderMilestoneRibbon();
    if (concept === "evidence-weave") renderEvidenceWeave();
    if (concept === "pocket-cards") renderPocketCards();
    if (concept === "review-board") renderReviewBoard();
    if (concept === "quiet-checklist") renderQuietChecklist();
    if (openDetails.size) {
      [...app.querySelectorAll("details")].forEach((detail, index) => {
        detail.open = openDetails.has(disclosureKey(detail, index));
      });
    }
    enhanceRenderedView();
  }

  function disclosureKey(detail, index) {
    const label = detail.querySelector(":scope > summary")?.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
    return `${detail.className}:${label || index}`;
  }

  function enhanceRenderedView() {
    setupAnimatedDetails();
    const movingSurface = app.querySelector(".reading-paper, .focus-paper, .ledger-detail, .ribbon-paper, .pocket-card");
    if (movingSurface && motionMode) {
      movingSurface.classList.add("motion-enter", `motion-${motionMode}`);
    }
    motionMode = "";
  }

  function setupAnimatedDetails() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    app.querySelectorAll("details > summary").forEach((summary) => {
      summary.addEventListener("click", (event) => {
        if (event.target.closest("button, a, [data-action]") || reduced) return;
        event.preventDefault();
        const detail = summary.parentElement;
        if (detail.dataset.animating === "true") return;
        detail.dataset.animating = "true";
        const startHeight = detail.getBoundingClientRect().height;
        const closing = detail.open;
        if (!detail.open) detail.open = true;
        const endHeight = closing ? summary.getBoundingClientRect().height : detail.scrollHeight;
        detail.style.overflow = "clip";
        const animation = detail.animate(
          [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
          { duration: closing ? 210 : 280, easing: "cubic-bezier(.22,.75,.2,1)" }
        );
        animation.finished.catch(() => {}).then(() => {
          if (closing) detail.open = false;
          detail.style.removeProperty("height");
          detail.style.removeProperty("overflow");
          delete detail.dataset.animating;
        });
      });
    });
  }

  function syncPanels() {
    const notes = document.querySelector(".notes-panel");
    const overview = document.querySelector(".approval-overview");
    const scrim = document.querySelector(".panel-scrim");
    const notesButton = document.querySelector(".notes-toggle");
    const reviewButton = document.querySelector(".review-toggle");
    notes?.classList.toggle("is-open", state.notesOpen);
    notes?.setAttribute("aria-hidden", String(!state.notesOpen));
    if (notes) notes.inert = !state.notesOpen;
    overview?.classList.toggle("is-open", state.overviewOpen);
    overview?.setAttribute("aria-hidden", String(!state.overviewOpen));
    if (overview) overview.inert = !state.overviewOpen;
    scrim?.classList.toggle("is-visible", state.notesOpen || state.overviewOpen);
    notesButton?.classList.toggle("is-active", state.notesOpen);
    notesButton?.setAttribute("aria-expanded", String(state.notesOpen));
    reviewButton?.classList.toggle("is-active", state.overviewOpen);
    reviewButton?.setAttribute("aria-expanded", String(state.overviewOpen));
  }

  function openNote(kind, id) {
    noteTarget = { kind, id };
    const modal = document.querySelector("#note-dialog");
    modal.querySelector("#note-target").textContent = targetLabel(kind, id);
    modal.querySelector("textarea").value = "";
    modal.showModal();
    modal.querySelector("textarea").focus();
  }

  function closeNoteDialog(dialogElement, afterClose) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialogElement.close();
      afterClose();
      return;
    }
    dialogElement.classList.add("is-closing");
    const animation = dialogElement.animate(
      [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(12px) scale(.98)" }],
      { duration: 150, easing: "ease-in" }
    );
    animation.finished.catch(() => {}).then(() => {
      dialogElement.classList.remove("is-closing");
      dialogElement.close();
      afterClose();
    });
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (button.closest("summary")) event.stopPropagation();

    if (action === "approve") {
      const id = button.dataset.id;
      state.approvals[id] = !approved(id);
      persist();
      render();
    } else if (action === "add-note") {
      openNote(button.dataset.kind, button.dataset.id);
    } else if (action === "toggle-notes") {
      state.notesOpen = !state.notesOpen;
      state.overviewOpen = false;
      persist();
      syncPanels();
      window.requestAnimationFrame(() => document.querySelector(state.notesOpen ? ".notes-heading button" : ".notes-toggle")?.focus());
    } else if (action === "toggle-overview") {
      state.overviewOpen = !state.overviewOpen;
      state.notesOpen = false;
      persist();
      syncPanels();
      window.requestAnimationFrame(() => document.querySelector(state.overviewOpen ? ".overview-heading button" : ".review-toggle")?.focus());
    } else if (action === "close-panels") {
      state.notesOpen = false;
      state.overviewOpen = false;
      persist();
      syncPanels();
    } else if (action === "delete-note") {
      const noteElement = button.closest(".saved-note");
      if (noteElement && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const height = noteElement.getBoundingClientRect().height;
        await noteElement.animate(
          [{ height: `${height}px`, opacity: 1, transform: "translateX(0)" }, { height: "0px", opacity: 0, transform: "translateX(12px)", paddingTop: 0, paddingBottom: 0 }],
          { duration: 190, easing: "ease-in" }
        ).finished.catch(() => {});
      }
      state.notes.splice(Number(button.dataset.index), 1);
      persist();
      render();
    } else if (action === "clear-notes") {
      if (window.confirm("Clear every personal note in this prototype?")) {
        const notesContainer = document.querySelector(".saved-notes");
        if (notesContainer && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          await notesContainer.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(7px)" }], { duration: 150, easing: "ease-in" }).finished.catch(() => {});
        }
        state.notes = [];
        persist();
        render();
      }
    } else if (action === "select") {
      motionMode = "forward";
      state.selectedId = button.dataset.id;
      persist();
      render();
    } else if (action === "move-selection") {
      motionMode = Number(button.dataset.delta) < 0 ? "back" : "forward";
      const current = allItems.findIndex((item) => item.id === state.selectedId);
      state.selectedId = allItems[Math.max(0, Math.min(allItems.length - 1, current + Number(button.dataset.delta)))].id;
      persist();
      render();
    } else if (action === "focus-move") {
      motionMode = Number(button.dataset.delta) < 0 ? "back" : "forward";
      state.focusIndex = Math.max(0, Math.min(allItems.length - 1, state.focusIndex + Number(button.dataset.delta)));
      persist();
      render();
    } else if (action === "focus-index") {
      motionMode = Number(button.dataset.index) < state.focusIndex ? "back" : "forward";
      state.focusIndex = Number(button.dataset.index);
      persist();
      render();
    } else if (action === "toggle-stage") {
      const id = button.dataset.id;
      state.expandedStages[id] = !state.expandedStages[id];
      persist();
      const stage = document.querySelector(`.map-stage[data-stage-id="${id}"]`);
      stage?.classList.toggle("is-open", state.expandedStages[id]);
      button.textContent = `${state.expandedStages[id] ? "Fold" : "Unfold"} ${state.expandedStages[id] ? "−" : "+"}`;
      button.setAttribute("aria-expanded", String(state.expandedStages[id]));
      window.setTimeout(() => stage?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }), 120);
    } else if (action === "ledger-stage") {
      motionMode = "forward";
      state.selectedId = button.dataset.id;
      persist();
      render();
    } else if (action === "select-stage") {
      motionMode = data.stages.findIndex((entry) => entry.id === button.dataset.id) < data.stages.findIndex((entry) => entry.id === state.selectedStageId) ? "back" : "forward";
      state.selectedStageId = button.dataset.id;
      persist();
      render();
    } else if (action === "pocket-stage") {
      motionMode = Number(button.dataset.index) < state.pocketIndex ? "back" : "forward";
      state.pocketIndex = Number(button.dataset.index);
      persist();
      render();
    } else if (action === "pocket-move") {
      const delta = Number(button.dataset.delta);
      motionMode = delta < 0 ? "back" : "forward";
      state.pocketIndex = Math.max(0, Math.min(allItems.length - 2, state.pocketIndex + delta));
      persist();
      render();
    } else if (action === "to-top") {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  document.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-note-form]")) return;
    event.preventDefault();
    const submitter = event.submitter;
    const dialogElement = event.target.closest("dialog");
    if (submitter?.value === "default" && noteTarget) {
      const body = event.target.querySelector("textarea").value.trim();
      if (!body) return;
      state.notes.push({ ...noteTarget, body });
      persist();
    }
    noteTarget = null;
    closeNoteDialog(dialogElement, render);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (state.notesOpen || state.overviewOpen)) {
      state.notesOpen = false;
      state.overviewOpen = false;
      persist();
      syncPanels();
      document.querySelector(".review-toggle")?.focus();
      return;
    }
    if (concept !== "field-notes" || event.target.matches("textarea, input")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const current = allItems.findIndex((item) => item.id === state.selectedId);
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      motionMode = delta < 0 ? "back" : "forward";
      state.selectedId = allItems[Math.max(0, Math.min(allItems.length - 1, current + delta))].id;
      persist();
      render();
    }
  });

  document.addEventListener("cancel", (event) => {
    if (!event.target.matches(".note-dialog")) return;
    event.preventDefault();
    noteTarget = null;
    closeNoteDialog(event.target, () => {});
  });

  render();
})();
