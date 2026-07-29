const workspace = document.querySelector("#workspace");
const statusElement = document.querySelector("#connection-status");
const reloadButton = document.querySelector("#reload-button");
const errorTemplate = document.querySelector("#error-template");
const feedbackPanel = document.querySelector("#feedback-panel");
const reviewToggle = document.querySelector("#review-toggle");
const reviewCount = document.querySelector("#review-count");
const commentDialog = document.querySelector("#comment-dialog");
const commentForm = document.querySelector("#comment-form");
const commentTarget = document.querySelector("#comment-target");
const commentBody = document.querySelector("#comment-body");
const commentError = document.querySelector("#comment-error");

let review;
let validation;
let feedback;
let selectedStageId;
let selectedBatchId;
let pendingCommentTarget;
let editingFeedbackItem;

reloadButton.addEventListener("click", () => loadReview());
reviewToggle.addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("feedback-open");
  feedbackPanel.setAttribute("aria-hidden", String(!isOpen));
  if (isOpen) feedbackPanel.focus();
});
document.querySelector("#comment-close").addEventListener("click", closeComment);
document.querySelector("#comment-cancel").addEventListener("click", closeComment);
commentForm.addEventListener("submit", submitComment);
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
    const [reviewResponse, validationResponse, feedbackResponse] =
      await Promise.all([
      fetch("/api/review", {
        headers: { accept: "application/json" },
      }),
      fetch("/api/validation", {
        headers: { accept: "application/json" },
      }),
      fetch("/api/feedback", {
        headers: { accept: "application/json" },
      }),
    ]);
    const [reviewBody, validationBody, feedbackBody] = await Promise.all([
      reviewResponse.json(),
      validationResponse.json(),
      feedbackResponse.json(),
    ]);
    if (!reviewResponse.ok) {
      throw new Error(
        reviewBody.error?.message ?? "Review API request failed.",
      );
    }
    review = reviewBody;
    validation = validationResponse.ok
      ? validationBody
      : {
          status: "failed",
          summary:
            validationBody.error?.details ||
            validationBody.error?.message ||
            "Artifact validation failed.",
        };
    feedback = feedbackResponse.ok
      ? feedbackBody
      : { initialized: false, batches: [] };
    selectedBatchId =
      feedback.batches.find((batch) => batch.id === selectedBatchId)?.id ??
      feedback.batches.find((batch) => batch.status === "draft")?.id ??
      feedback.batches.at(-1)?.id;
    const stages = allStages(review);
    const requested = decodeURIComponent(window.location.hash.slice(1));
    selectedStageId = stages.some(({ stage }) => stage.id === requested)
      ? requested
      : stages.at(-1)?.stage.id;
    statusElement.textContent = `${validation.status === "passed" ? "Valid" : "Invalid"} · ${review.stages.length} finalized · ${review.workingStages.length} working`;
    renderReview();
    renderFeedbackPanel();
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
    renderValidationBanner(),
    renderRequirementStrip(),
    renderStageWorkspace(),
  );
}

async function apiPost(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.details || result.error?.message || "Request failed.");
  }
  return result;
}

function feedbackItems() {
  return feedback?.batches.flatMap((batch) => batch.feedbackItems) ?? [];
}

function activeDraftBatch() {
  return feedback?.batches.find(
    (batch) => batch.id === selectedBatchId && batch.status === "draft",
  );
}

function commentAction(target, label = "Comment") {
  const button = element("button", "comment-action", label);
  button.type = "button";
  if (!activeDraftBatch()) {
    button.title = "Open the review queue to create or select a draft batch.";
  }
  button.addEventListener("click", () => openComment(target));
  return button;
}

function openComment(target) {
  const batch = activeDraftBatch();
  if (!batch) {
    document.body.classList.add("feedback-open");
    feedbackPanel.setAttribute("aria-hidden", "false");
    return;
  }
  pendingCommentTarget = target;
  editingFeedbackItem = undefined;
  commentTarget.textContent = target.label;
  commentBody.value = "";
  commentError.textContent = "";
  commentDialog.showModal();
  commentBody.focus();
}

function closeComment() {
  pendingCommentTarget = undefined;
  editingFeedbackItem = undefined;
  commentDialog.close();
}

async function submitComment(event) {
  event.preventDefault();
  const batch = activeDraftBatch();
  if (!batch || (!pendingCommentTarget && !editingFeedbackItem)) return;
  commentError.textContent = "";
  try {
    if (editingFeedbackItem) {
      feedback = await apiRequest(
        `/api/feedback/items/${editingFeedbackItem.id}`,
        "PATCH",
        { body: commentBody.value },
      );
    } else {
      feedback = await apiPost("/api/feedback/comments", {
        batchId: batch.id,
        body: commentBody.value,
        target: pendingCommentTarget,
      });
    }
    closeComment();
    renderFeedbackPanel();
    renderReview();
  } catch (error) {
    commentError.textContent = error.message;
  }
}

async function apiRequest(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.details || result.error?.message || "Request failed.");
  }
  return result;
}

function openCommentEdit(item) {
  editingFeedbackItem = item;
  pendingCommentTarget = undefined;
  commentTarget.textContent = item.target.label;
  commentBody.value = item.body;
  commentError.textContent = "";
  commentDialog.showModal();
  commentBody.focus();
}

function parseUnifiedDiffPath(value) {
  const raw = value.trimEnd();
  if (raw === "/dev/null") return undefined;
  const decoded =
    raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw;
  return decoded.startsWith("a/") || decoded.startsWith("b/")
    ? decoded.slice(2)
    : decoded;
}

function renderValidationBanner() {
  const banner = element(
    "section",
    `validation-banner validation-${validation.status}`,
  );
  const copy = element("div");
  appendText(
    copy,
    "p",
    "eyebrow",
    validation.status === "passed"
      ? "Artifact integrity confirmed"
      : "Artifact integrity failed",
  );
  appendText(copy, "p", "validation-summary", validation.summary);
  banner.append(copy);
  return banner;
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
    titleRow.append(
      commentAction({
        kind: "requirement",
        label: `Requirement: ${requirement.title}`,
        requirementId: requirement.id,
        assignedStageId: selectedStageId,
      }),
    );
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
      item.append(
        commentAction(
          {
            kind: "criterion",
            label: `Criterion: ${criterion.text}`,
            requirementId: requirement.id,
            criterionId: criterion.id,
            assignedStageId: selectedStageId,
          },
          "Comment",
        ),
      );
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
  header.append(
    commentAction({
      kind: "stage",
      label: `Stage: ${stage.title}`,
      stageId: stage.id,
    }),
  );
  article.append(header);

  article.append(
    renderReferenceBand(stage),
    renderRationale(stage),
    renderChangePanel(stage),
    renderContextGrid(stage),
  );
  return article;
}

function renderChangePanel(stage) {
  const section = element("section", "change-panel");
  const heading = element("div", "change-heading");
  const title = element("div");
  appendText(title, "p", "eyebrow", "Git evidence");
  appendText(title, "h3", "", "Files and patch");
  heading.append(title);
  section.append(heading);

  if (!stage.change) {
    appendText(
      section,
      "p",
      "empty-copy",
      "This stage is still working. Its commit and exact patch are created during finalization.",
    );
    return section;
  }

  const fileList = element("ul", "file-list");
  for (const file of stage.change.files) {
    const item = element("li");
    appendText(item, "span", `file-kind kind-${file.kind}`, file.kind);
    const pathCopy = file.previousPath
      ? `${file.previousPath} → ${file.path}`
      : file.path;
    appendText(item, "span", "code-text file-path", pathCopy);
    item.append(
      commentAction(
        {
          kind: "file",
          label: `File: ${pathCopy}`,
          stageId: stage.id,
          path: file.path,
        },
        "Comment",
      ),
    );
    fileList.append(item);
  }

  const button = element("button", "diff-button", "Load unified diff");
  button.type = "button";
  const output = element("div", "diff-output");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Loading diff";
    output.replaceChildren(
      element("p", "empty-copy", "Reading patch from Git…"),
    );
    try {
      const response = await fetch(
        `/api/stages/${encodeURIComponent(stage.id)}/diff`,
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Diff request failed.");
      }
      renderUnifiedDiff(output, body.diff, stage);
      button.textContent = "Reload unified diff";
    } catch (error) {
      output.replaceChildren(
        element("p", "inline-error", error.message),
      );
      button.textContent = "Retry unified diff";
    } finally {
      button.disabled = false;
    }
  });

  heading.append(button);
  section.append(fileList, output);
  return section;
}

function renderUnifiedDiff(container, diff, stage) {
  const pre = element("pre", "unified-diff");
  const code = element("code");
  for (const parsed of parseUnifiedDiffRows(diff)) {
    const row = element("span", `diff-row ${parsed.kind}`);
    appendText(row, "span", "diff-line-copy", parsed.line || " ");
    if (parsed.target) {
      row.append(
        commentAction(
          {
            kind: "line",
            label: `${parsed.target.path}:${parsed.target.line} (${parsed.target.side})`,
            stageId: stage.id,
            path: parsed.target.path,
            side: parsed.target.side,
            line: parsed.target.line,
          },
          "+",
        ),
      );
    }
    code.append(row);
  }
  pre.append(code);
  container.replaceChildren(pre);
}

function parseUnifiedDiffRows(diff) {
  const rows = [];
  let oldPath;
  let newPath;
  let oldLine;
  let newLine;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    let kind = "diff-context";
    let lineTarget;
    if (line.startsWith("diff --git ")) {
      oldPath = undefined;
      newPath = undefined;
      oldLine = undefined;
      newLine = undefined;
      inHunk = false;
      kind = "diff-file";
    } else if (
      !inHunk &&
      (line.startsWith("+++ ") || line.startsWith("--- "))
    ) {
      kind = "diff-file";
      const normalized = parseUnifiedDiffPath(line.slice(4));
      if (line.startsWith("+++ ")) newPath = normalized;
      if (line.startsWith("--- ")) oldPath = normalized;
    } else if (line.startsWith("@@")) {
      kind = "diff-hunk";
      inHunk = true;
      const match = line.match(
        /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
      );
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
    } else if (line.startsWith("+")) {
      kind = "diff-addition";
      lineTarget = { path: newPath, side: "new", line: newLine };
      newLine += 1;
    } else if (line.startsWith("-")) {
      kind = "diff-deletion";
      lineTarget = { path: oldPath, side: "old", line: oldLine };
      oldLine += 1;
    } else if (
      oldLine !== undefined &&
      newLine !== undefined &&
      !line.startsWith("\\")
    ) {
      lineTarget = {
        path: newPath ?? oldPath,
        side: "new",
        line: newLine,
      };
      oldLine += 1;
      newLine += 1;
    }
    rows.push({
      line,
      kind,
      target: lineTarget?.path ? lineTarget : undefined,
    });
  }
  return rows;
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
    if (selectedStageId) {
      const selectedStage = allStages(review).find(
        ({ stage }) => stage.id === selectedStageId,
      )?.stage;
      if (selectedStage) {
        const collectionNames = new Map([
          ["Decisions", "decisions"],
          ["Assumptions", "assumptions"],
          ["Alternatives", "alternatives"],
          ["Failed attempts", "failedAttempts"],
          ["Risks", "risks"],
          ["Validation", "validation"],
          ["Open questions", "openQuestions"],
        ]);
        card.append(
          commentAction(
            {
              kind: "context",
              label: `${title}: ${lines[0]}`,
              stageId: selectedStage.id,
              collection: collectionNames.get(title),
              itemId: item.id,
            },
            "Comment",
          ),
        );
      }
    }
    list.append(card);
  }
  section.append(list);
  return section;
}

function renderFeedbackPanel() {
  feedbackPanel.replaceChildren();
  const header = element("div", "feedback-panel-header");
  const copy = element("div");
  appendText(copy, "p", "eyebrow", "Cross-stage review");
  appendText(copy, "h2", "", "Review queue");
  const close = element("button", "icon-button", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close review queue");
  close.addEventListener("click", () => {
    document.body.classList.remove("feedback-open");
    feedbackPanel.setAttribute("aria-hidden", "true");
  });
  header.append(copy, close);
  feedbackPanel.append(header);

  reviewCount.textContent = String(
    feedbackItems().filter((item) => item.status !== "approved").length,
  );

  if (!feedback.initialized) {
    appendText(
      feedbackPanel,
      "p",
      "feedback-help",
      "Start a feedback workspace to comment, or approve now if no changes are needed.",
    );
    const start = element("button", "primary-button", "Start review");
    start.type = "button";
    start.addEventListener("click", async () => {
      feedback = await apiPost("/api/feedback/init");
      renderFeedbackPanel();
      renderReview();
    });
    feedbackPanel.append(start);
    feedbackPanel.append(renderStackApproval());
    return;
  }

  feedbackPanel.append(renderBatchCreator());
  if (!activeDraftBatch()) {
    appendText(
      feedbackPanel,
      "p",
      "feedback-help",
      "Create or select a draft batch before adding comments.",
    );
  }
  const batchList = element("div", "feedback-batches");
  for (const batch of feedback.batches) {
    batchList.append(renderFeedbackBatch(batch));
  }
  feedbackPanel.append(batchList);
  if (
    feedback.batches.length === 0 ||
    feedback.batches.every((batch) => batch.status === "approved")
  ) {
    feedbackPanel.append(renderStackApproval());
  }
}

function renderBatchCreator() {
    const form = element("form", "batch-creator");
    const input = element("input");
    input.name = "title";
    input.placeholder = "New review batch title";
    input.required = true;
    input.setAttribute("aria-label", "New review batch title");
    const button = element("button", "secondary-button", "Create batch");
    button.type = "submit";
    form.append(input, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        feedback = await apiPost("/api/feedback/batches", {
          title: input.value,
        });
        selectedBatchId = feedback.batches.at(-1)?.id;
        renderFeedbackPanel();
        renderReview();
      } catch (error) {
        input.setCustomValidity(error.message);
        input.reportValidity();
      }
    });
    return form;
}

function renderFeedbackBatch(batch) {
    const article = element(
      "article",
      `feedback-batch${batch.id === selectedBatchId ? " is-selected" : ""}`,
    );
    const heading = element("button", "feedback-batch-heading");
    heading.type = "button";
    const copy = element("span");
    appendText(copy, "strong", "", batch.title);
    appendText(copy, "span", "code-text", batch.id);
    heading.append(copy, element("span", `batch-status status-${batch.status}`, batch.status));
    heading.addEventListener("click", () => {
      selectedBatchId = batch.id;
      renderFeedbackPanel();
      renderReview();
    });
    article.append(heading);

    if (batch.id === selectedBatchId) {
      const items = element("div", "feedback-items");
      for (const item of batch.feedbackItems) {
        items.append(renderFeedbackItem(item));
      }
      if (batch.feedbackItems.length === 0) {
        appendText(
          items,
          "p",
          "empty-copy",
          "Use Comment beside any review element to add it here.",
        );
        const remove = element("button", "secondary-button", "Delete empty batch");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          feedback = await apiRequest(
            `/api/feedback/batches/${batch.id}`,
            "DELETE",
          );
          selectedBatchId = undefined;
          renderFeedbackPanel();
          renderReview();
        });
        items.append(remove);
      }
      article.append(items);

      if (batch.status === "draft" && batch.feedbackItems.length > 0) {
        const submit = element("button", "primary-button", "Submit feedback");
        submit.type = "button";
        submit.addEventListener("click", async () => {
          feedback = await apiPost(
            `/api/feedback/batches/${batch.id}/submit`,
          );
          renderFeedbackPanel();
          renderReview();
        });
        article.append(submit);
      }
      if (batch.status === "resolved") {
        const approveAll = element(
          "button",
          "primary-button",
          "Approve all resolutions",
        );
        approveAll.type = "button";
        approveAll.addEventListener("click", async () => {
          feedback = await apiPost(
            `/api/feedback/batches/${batch.id}/approve-all`,
          );
          renderFeedbackPanel();
        });
        article.append(approveAll);
      }
    }
    return article;
}

function renderFeedbackItem(item) {
    const article = element("article", `feedback-item feedback-${item.status}`);
    const heading = element("div", "feedback-item-heading");
    appendText(heading, "span", "feedback-target-kind", item.target.kind);
    appendText(heading, "span", "code-text", item.status);
    article.append(heading);
    appendText(article, "p", "feedback-target-label", item.target.label);
    appendText(article, "p", "feedback-body", item.body);
    if (item.anchorStale) {
      appendText(
        article,
        "p",
        "stale-anchor",
        `Original anchor ${item.target.stageCommit.slice(0, 9)} has been rewritten.`,
      );
    }
    if (item.resolution) {
      const ticket = element("div", "resolution-ticket");
      appendText(ticket, "p", "eyebrow", "Agent resolution");
      appendText(ticket, "p", "", item.resolution.summary);
      appendText(
        ticket,
        "p",
        "code-text resolution-commits",
        `${item.resolution.previousCommit.slice(0, 9)} → ${item.resolution.rewrittenCommit.slice(0, 9)}`,
      );
      article.append(ticket);
    }
    if (item.status === "addressed") {
      const approve = element("button", "secondary-button", "Approve resolution");
      approve.type = "button";
      approve.addEventListener("click", async () => {
        feedback = await apiPost(
          `/api/feedback/items/${item.id}/approve`,
        );
        renderFeedbackPanel();
      });
      article.append(approve);
    }
    if (item.status === "draft") {
      const actions = element("div", "draft-comment-actions");
      const edit = element("button", "secondary-button", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => openCommentEdit(item));
      const remove = element("button", "secondary-button", "Delete");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        feedback = await apiRequest(
          `/api/feedback/items/${item.id}`,
          "DELETE",
        );
        renderFeedbackPanel();
        renderReview();
      });
      actions.append(edit, remove);
      article.append(actions);
    }
    return article;
}

function renderStackApproval() {
    const section = element("section", "stack-approval");
    appendText(
      section,
      "p",
      "eyebrow",
      feedback?.batches.length ? "All feedback approved" : "No changes requested",
    );
    appendText(
      section,
      "p",
      "",
      "Prepare a stable branch for pull request creation.",
    );
    const form = element("form");
    const input = element("input");
    input.required = true;
    input.value = `review/${review.manifest.reviewId}`;
    input.setAttribute("aria-label", "PR branch name");
    const button = element("button", "primary-button", "Approve changes");
    button.type = "submit";
    form.append(input, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = await apiPost("/api/feedback/approve-stack", {
        branch: input.value,
      });
      appendText(section, "p", "approval-result", result.summary);
    });
    section.append(form);
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
