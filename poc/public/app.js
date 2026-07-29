const workspace = document.querySelector("#workspace");
const statusElement = document.querySelector("#connection-status");
const reloadButton = document.querySelector("#reload-button");
const errorTemplate = document.querySelector("#error-template");

let review;
let selectedStageId;

reloadButton.addEventListener("click", () => loadReview());
window.addEventListener("hashchange", () => {
  if (!review) return;
  const requested = decodeURIComponent(window.location.hash.slice(1));
  if (allStages(review).some(({ stage }) => stage.id === requested)) {
    selectedStageId = requested;
    renderReview();
  }
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendText(parent, tag, className, text) {
  const node = element(tag, className, text);
  parent.append(node);
  return node;
}

function allStages(value) {
  return [
    ...value.stages.map((stage, index) => ({
      stage,
      status: "finalized",
      order: index + 1,
    })),
    ...value.workingStages.map((stage) => ({
      stage,
      status: "working",
      order: value.stages.length + 1,
    })),
  ];
}

async function loadReview() {
  statusElement.textContent = "Loading artifact";
  reloadButton.disabled = true;
  try {
    const response = await fetch("/api/review", {
      headers: { accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Review API request failed.");
    }
    review = body;
    const stages = allStages(review);
    const requested = decodeURIComponent(window.location.hash.slice(1));
    selectedStageId = stages.some(({ stage }) => stage.id === requested)
      ? requested
      : stages.at(-1)?.stage.id;
    statusElement.textContent = `${review.stages.length} finalized · ${review.workingStages.length} working`;
    renderReview();
  } catch (error) {
    review = undefined;
    renderError(error);
    statusElement.textContent = "Artifact error";
  } finally {
    reloadButton.disabled = false;
  }
}

function renderReview() {
  workspace.replaceChildren();
  workspace.append(
    renderReviewHeader(),
    renderRequirementStrip(),
    renderStageWorkspace(),
  );
}

function renderReviewHeader() {
  const header = element("section", "review-header");
  const copy = element("div", "review-header-copy");
  appendText(copy, "p", "eyebrow", review.manifest.reviewId);
  appendText(copy, "h1", "", review.manifest.title);
  appendText(copy, "p", "review-summary", review.manifest.summary);

  const ledger = element("dl", "review-ledger");
  ledgerEntry(ledger, "Target", review.manifest.targetBranch);
  ledgerEntry(ledger, "Requirements", String(review.requirements.length));
  ledgerEntry(ledger, "Stages", String(allStages(review).length));
  ledgerEntry(
    ledger,
    "Base",
    review.manifest.baseRevision.slice(0, 9),
    true,
  );
  header.append(copy, ledger);
  return header;
}

function ledgerEntry(list, label, value, code = false) {
  const group = element("div", "ledger-entry");
  appendText(group, "dt", "", label);
  appendText(group, "dd", code ? "code-text" : "", value);
  list.append(group);
}

function renderRequirementStrip() {
  const section = element("section", "requirement-strip");
  const heading = element("div", "section-heading");
  appendText(heading, "p", "eyebrow", "Source intent");
  appendText(heading, "h2", "", "Requirements");
  section.append(heading);

  const list = element("div", "requirement-list");
  for (const requirement of review.requirements) {
    const article = element("article", "requirement-card");
    const titleRow = element("div", "requirement-title-row");
    appendText(titleRow, "h3", "", requirement.title);
    appendText(titleRow, "span", "code-pill", requirement.source.reference);
    appendText(article, "p", "requirement-summary", requirement.summary);
    const criteria = element("ul", "criteria-list");
    for (const criterion of requirement.acceptanceCriteria) {
      const item = element("li");
      appendText(
        item,
        "span",
        "criterion-id code-text",
        criterion.id,
      );
      appendText(item, "span", "", criterion.text);
      criteria.append(item);
    }
    article.prepend(titleRow);
    article.append(criteria);
    list.append(article);
  }
  section.append(list);
  return section;
}

function renderStageWorkspace() {
  const section = element("section", "stage-workspace");
  const navigation = element("nav", "stage-spine");
  navigation.setAttribute("aria-label", "Semantic stages");

  const heading = element("div", "section-heading spine-heading");
  appendText(heading, "p", "eyebrow", "Implementation narrative");
  appendText(heading, "h2", "", "Stage stack");
  navigation.append(heading);

  const stages = allStages(review);
  const list = element("ol", "stage-list");
  for (const entry of stages) {
    list.append(renderStageNavigation(entry));
  }
  if (stages.length === 0) {
    appendText(
      navigation,
      "p",
      "empty-copy",
      "No stages have been started.",
    );
  } else {
    navigation.append(list);
  }

  const selected = stages.find(
    ({ stage }) => stage.id === selectedStageId,
  );
  section.append(
    navigation,
    selected
      ? renderStageDetail(selected)
      : renderNoStageSelected(),
  );
  return section;
}

function renderStageNavigation({ stage, status, order }) {
  const item = element("li", "stage-node");
  const button = element(
    "button",
    `stage-button${stage.id === selectedStageId ? " is-selected" : ""}`,
  );
  button.type = "button";
  button.addEventListener("click", () => {
    selectedStageId = stage.id;
    window.history.replaceState(
      null,
      "",
      `#${encodeURIComponent(stage.id)}`,
    );
    renderReview();
  });
  button.setAttribute(
    "aria-current",
    stage.id === selectedStageId ? "step" : "false",
  );

  appendText(
    button,
    "span",
    "stage-number code-text",
    String(order).padStart(2, "0"),
  );
  const copy = element("span", "stage-button-copy");
  appendText(copy, "strong", "", stage.title);
  appendText(copy, "span", "code-text stage-id", stage.id);
  button.append(copy, statusBadge(status));
  item.append(button);
  return item;
}

function statusBadge(status) {
  return element(
    "span",
    `status-badge status-${status}`,
    status === "working" ? "Working" : "Finalized",
  );
}

function renderNoStageSelected() {
  const section = element("section", "stage-detail empty-stage");
  section.id = "stage-detail";
  appendText(section, "p", "eyebrow", "No stage selected");
  appendText(section, "h2", "", "Begin a stage to build the narrative.");
  return section;
}

function renderStageDetail({ stage, status, order }) {
  const article = element("article", "stage-detail");
  article.id = "stage-detail";
  article.tabIndex = -1;

  const header = element("header", "stage-detail-header");
  const titleGroup = element("div");
  appendText(
    titleGroup,
    "p",
    "eyebrow",
    `Stage ${String(order).padStart(2, "0")} · ${stage.id}`,
  );
  appendText(titleGroup, "h2", "", stage.title);
  appendText(titleGroup, "p", "stage-summary", stage.summary);
  header.append(titleGroup, statusBadge(status));
  article.append(header);

  article.append(
    renderReferenceBand(stage),
    renderRationale(stage),
    renderContextGrid(stage),
  );
  return article;
}

function renderReferenceBand(stage) {
  const band = element("dl", "reference-band");
  detailListEntry(
    band,
    "Depends on",
    stage.dependsOn.length ? stage.dependsOn.join(", ") : "Base revision",
  );
  detailListEntry(
    band,
    "Criteria",
    stage.requirementRefs.join(", "),
  );
  if (stage.change) {
    detailListEntry(band, "Commit", stage.change.commit.slice(0, 12));
    detailListEntry(
      band,
      "Files",
      `${stage.change.files.length} changed`,
    );
  } else {
    detailListEntry(band, "Commit", "Awaiting finalization");
  }
  return band;
}

function detailListEntry(list, label, value) {
  const group = element("div");
  appendText(group, "dt", "", label);
  appendText(group, "dd", "code-text", value);
  list.append(group);
}

function renderRationale(stage) {
  const section = element("section", "rationale-panel");
  appendText(section, "p", "eyebrow", "Why this stage exists");
  appendText(section, "p", "rationale-copy", stage.rationale);
  return section;
}

function renderContextGrid(stage) {
  const grid = element("div", "context-grid");
  grid.append(
    renderCollection(
      "Decisions",
      stage.decisions,
      (item) => [item.summary, item.rationale, item.category],
    ),
    renderCollection(
      "Assumptions",
      stage.assumptions,
      (item) => [item.statement, item.riskIfWrong],
      "attention",
    ),
    renderCollection(
      "Alternatives",
      stage.alternatives,
      (item) => [item.approach, item.reasonRejected],
    ),
    renderCollection(
      "Failed attempts",
      stage.failedAttempts,
      (item) => [item.approach, item.outcome, item.lesson],
      "attention",
    ),
    renderCollection(
      "Risks",
      stage.risks,
      (item) => [item.summary, item.mitigation],
      "attention",
    ),
    renderCollection(
      "Validation",
      stage.validation,
      (item) => [
        item.summary,
        `${item.type} · ${item.status}`,
        item.command,
      ],
      "evidence",
    ),
    renderCollection(
      "Open questions",
      stage.openQuestions,
      (item) => [item.question],
      "attention",
    ),
  );
  return grid;
}

function renderCollection(title, items, linesFor, tone = "") {
  const section = element(
    "section",
    `context-section${tone ? ` tone-${tone}` : ""}`,
  );
  const heading = element("div", "context-heading");
  appendText(heading, "h3", "", title);
  appendText(heading, "span", "item-count code-text", String(items.length));
  section.append(heading);

  if (!items.length) {
    appendText(section, "p", "empty-copy", "Nothing recorded.");
    return section;
  }

  const list = element("div", "context-list");
  for (const item of items) {
    const card = element("article", "context-item");
    appendText(card, "p", "context-id code-text", item.id);
    const lines = linesFor(item).filter(Boolean);
    lines.forEach((line, index) => {
      appendText(
        card,
        "p",
        index === 0 ? "context-primary" : "context-secondary",
        line,
      );
    });
    list.append(card);
  }
  section.append(list);
  return section;
}

function renderError(error) {
  const fragment = errorTemplate.content.cloneNode(true);
  fragment.querySelector("[data-error-title]").textContent =
    "Review artifact needs attention";
  fragment.querySelector("[data-error-message]").textContent = error.message;
  workspace.replaceChildren(fragment);
}

loadReview();
