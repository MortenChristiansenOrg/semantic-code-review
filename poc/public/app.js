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
let approvals;
let selectedStageId;
let selectedBatchId;
let pendingCommentTarget;
let editingFeedbackItem;
const fileDiffCache = new Map();
const expandedStageFiles = new Map();
const stageFileModes = new Map();

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
    const [
      reviewResponse,
      validationResponse,
      feedbackResponse,
      approvalsResponse,
    ] =
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
      fetch("/api/approvals", {
        headers: { accept: "application/json" },
      }),
    ]);
    const [reviewBody, validationBody, feedbackBody, approvalsBody] =
      await Promise.all([
        reviewResponse.json(),
        validationResponse.json(),
        feedbackResponse.json(),
        approvalsResponse.json(),
      ]);
    if (!reviewResponse.ok) {
      throw new Error(
        reviewBody.error?.message ?? "Review API request failed.",
      );
    }
    review = reviewBody;
    fileDiffCache.clear();
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
    if (!approvalsResponse.ok) {
      throw new Error(
        approvalsBody.error?.details ||
          approvalsBody.error?.message ||
          "Approval state could not be loaded.",
      );
    }
    approvals = approvalsBody;
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
  ledgerEntry(ledger, "Branch folder", review.manifest.branchPrefix);
  ledgerEntry(ledger, "Requirements", String(review.requirements.length));
  ledgerEntry(ledger, "Stages", String(allStages(review).length));
  ledgerEntry(
    ledger,
    "Base",
    review.manifest.baseRevision.slice(0, 9),
    true,
  );
  const reviewStatus = element("div", "review-status-rail");
  reviewStatus.append(
    ledger,
    approvalControl(
      { kind: "changeSet" },
      {
        label: "Entire change set",
        unavailable:
          review.workingStages.length > 0
            ? "Finalize the working stage before approving the full change set."
            : undefined,
      },
    ),
  );
  header.append(copy, reviewStatus);
  return header;
}

function directApprovalStatus(resource) {
  if (resource.kind === "changeSet") return approvals.changeSet;
  if (resource.kind === "stage") {
    return approvals.stages[resource.stageId];
  }
  if (resource.kind === "node") {
    return approvals.nodes[resource.stageId]?.[resource.nodeId];
  }
  return approvals.files[resource.stageId]?.[resource.path];
}

function inheritedApproval(resource) {
  if (resource.kind !== "changeSet" && approvals.changeSet.approved) {
    return "entire change set";
  }
  if (
    ["node", "file"].includes(resource.kind) &&
    approvals.stages[resource.stageId]?.approved
  ) {
    return "stage";
  }
  if (
    resource.kind === "file" &&
    resource.nodeId &&
    approvals.nodes[resource.stageId]?.[resource.nodeId]?.approved
  ) {
    return "change node";
  }
  return undefined;
}

function approvalControl(resource, { label, unavailable } = {}) {
  const direct = directApprovalStatus(resource) ?? {
    available: false,
    approved: false,
    previouslyApproved: false,
  };
  const inherited = inheritedApproval(resource);
  const control = element(
    "div",
    `approval-control${
      direct.approved || inherited ? " is-approved" : ""
    }${direct.previouslyApproved ? " was-approved" : ""}`,
  );
  const copy = element("span", "approval-copy");
  appendText(
    copy,
    "span",
    "approval-label",
    label ?? resource.kind,
  );
  const state = inherited
    ? `Approved with ${inherited}`
    : direct.approved
      ? "Reviewed"
      : direct.previouslyApproved
        ? "Changed since approval"
        : direct.available
          ? "Not reviewed"
          : "Not available";
  appendText(copy, "span", "approval-state code-text", state);

  const button = element(
    "button",
    "approval-button",
    inherited
      ? "Inherited"
      : direct.approved
        ? "Unapprove"
        : direct.previouslyApproved
          ? "Approve again"
          : "Approve",
  );
  button.type = "button";
  button.disabled = Boolean(inherited || unavailable || !direct.available);
  if (inherited) {
    button.title = `Read-only while the ${inherited} is approved.`;
  } else if (unavailable || !direct.available) {
    button.title = unavailable ?? "This resource cannot be approved yet.";
  } else {
    button.setAttribute("aria-pressed", String(direct.approved));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        approvals = await apiPost("/api/approvals", {
          resource:
            resource.kind === "file"
              ? {
                  kind: "file",
                  stageId: resource.stageId,
                  path: resource.path,
                }
              : resource,
          approved: !direct.approved,
        });
        renderReview();
      } catch (error) {
        button.disabled = false;
        button.title = error.message;
        button.textContent = "Try again";
      }
    });
  }
  control.append(copy, button);
  return control;
}

function ledgerEntry(list, label, value, code = false) {
  const group = element("div", "ledger-entry");
  appendText(group, "dt", "", label);
  appendText(group, "dd", code ? "code-text" : "", value);
  list.append(group);
}

function stagesAddressingCriterion(value, requirementId, criterionId) {
  const reference = `${requirementId}#${criterionId}`;
  return allStages(value).filter(({ stage }) =>
    stage.requirementRefs.includes(reference),
  );
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
      const criterionCopy = element("span", "criterion-copy");
      criterionCopy.append(document.createTextNode(criterion.text));
      const addressedStages = stagesAddressingCriterion(
        review,
        requirement.id,
        criterion.id,
      );
      const stageList = element(
        "span",
        `criterion-stage-list code-text${
          addressedStages.length ? "" : " criterion-stage-unaddressed"
        }`,
        addressedStages.length
          ? `[Addressed in ${addressedStages
              .map(({ order }) => order)
              .join(", ")}]`
          : "[Not yet addressed]",
      );
      criterionCopy.append(stageList);
      item.append(criterionCopy);
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
  button.append(copy, stageApprovalMark(stage), statusBadge(status));
  item.append(button);
  return item;
}

function stageApprovalMark(stage) {
  const resource = { kind: "stage", stageId: stage.id };
  const direct = directApprovalStatus(resource);
  const inherited = inheritedApproval(resource);
  const mark = element(
    "span",
    `stage-approval-mark${
      direct?.approved || inherited ? " is-approved" : ""
    }${direct?.previouslyApproved ? " was-approved" : ""}`,
    direct?.approved || inherited ? "✓" : direct?.previouslyApproved ? "!" : "",
  );
  mark.setAttribute(
    "aria-label",
    direct?.approved || inherited
      ? "Approved"
      : direct?.previouslyApproved
        ? "Changed since approval"
        : "Not approved",
  );
  return mark;
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
  const actions = element("div", "stage-detail-actions");
  actions.append(
    statusBadge(status),
    approvalControl(
      { kind: "stage", stageId: stage.id },
      {
        label: "Stage",
        unavailable:
          status === "working"
            ? "Finalize this stage before approving it."
            : undefined,
      },
    ),
    commentAction({
      kind: "stage",
      label: `Stage: ${stage.title}`,
      stageId: stage.id,
    }),
  );
  header.append(titleGroup, actions);
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
  appendText(title, "h3", "", "Change nodes");
  heading.append(title);
  section.append(heading);

  if (!stage.change) {
    appendText(
      section,
      "p",
      "empty-copy",
      "This stage is still working. Its branch head and exact patch are captured during finalization.",
    );
    return section;
  }

  appendText(
    heading,
    "p",
    "change-instruction",
    `${stage.nodes.length} nodes · ${stage.change.files.length} files · Select a file to inspect its stage diff`,
  );
  section.append(renderNodeLedger(stage));
  return section;
}

function groupNodeChanges(stage, changes) {
  const groups = new Map();
  for (const membership of changes) {
    const file = stage.change.files.find(
      (candidate) => candidate.path === membership.path,
    );
    if (!file) continue;
    const project = file.project ?? {
      root: ".",
      name: "Repository root",
    };
    const key = `${project.root}\0${project.name}`;
    if (!groups.has(key)) {
      groups.set(key, { project, entries: [] });
    }
    groups.get(key).entries.push({ membership, file });
  }
  return [...groups.values()];
}

function renderNodeLedger(stage) {
  const ledger = element("div", "node-ledger");
  const expandedKey = expandedStageFiles.get(stage.id);
  for (const node of stage.nodes) {
    const card = element("article", "change-node-card");
    const header = element("header", "change-node-header");
    const identity = element("div", "change-node-identity");
    appendText(identity, "p", "change-node-id code-text", node.id);
    appendText(identity, "h4", "", node.description);
    const count = appendText(
      header,
      "span",
      "change-node-count code-text",
      `${node.changes.length} ${node.changes.length === 1 ? "link" : "links"}`,
    );
    const nodeActions = element("div", "change-node-actions");
    nodeActions.append(
      count,
      approvalControl(
        { kind: "node", stageId: stage.id, nodeId: node.id },
        { label: "Node" },
      ),
    );
    header.prepend(identity);
    header.append(nodeActions);
    card.append(header);

    const files = element("div", "change-node-files");
    for (const { project, entries } of groupNodeChanges(stage, node.changes)) {
      const group = element("section", "project-file-group");
      const projectHeader = element("header", "project-file-header");
      const projectIdentity = element("div");
      appendText(projectIdentity, "h5", "", project.name);
      appendText(
        projectIdentity,
        "p",
        "code-text project-root",
        project.root === "." ? "repository root" : project.root,
      );
      appendText(
        projectHeader,
        "span",
        "project-file-count code-text",
        `${entries.length} ${entries.length === 1 ? "file" : "files"}`,
      );
      projectHeader.prepend(projectIdentity);
      group.append(projectHeader);
      for (const { membership, file } of entries) {
        const key = `${node.id}\0${file.path}`;
        group.append(
          renderFileEntry(
            stage,
            node,
            membership,
            file,
            expandedKey === key,
          ),
        );
      }
      files.append(group);
    }
    card.append(files);
    ledger.append(card);
  }
  return ledger;
}

function projectRelativePath(file) {
  const root = file.project?.root;
  return root && root !== "." && file.path.startsWith(`${root}/`)
    ? file.path.slice(root.length + 1)
    : file.path;
}

function membershipScope(membership, file) {
  if (membership.hunks) {
    return `${file.kind} · hunks ${membership.hunks.join(", ")}`;
  }
  if (membership.lineRanges) {
    return `${file.kind} · ${membership.lineRanges
      .map((range) =>
        [
          range.old
            ? `old ${range.old.start}-${range.old.end}`
            : undefined,
          range.new
            ? `new ${range.new.start}-${range.new.end}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" / "),
      )
      .join(", ")}`;
  }
  return `${file.kind} · whole file`;
}

function renderFileEntry(stage, node, membership, file, expanded) {
  const article = element(
    "article",
    `file-entry${expanded ? " is-expanded" : ""}`,
  );
  const row = element("div", "file-row");
  const toggle = element("button", "file-row-toggle node-file-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute(
    "aria-label",
    `${expanded ? "Collapse" : "Expand"} diff for ${file.path}`,
  );
  appendText(toggle, "span", "file-disclosure", expanded ? "−" : "+");
  const classification = element(
    "span",
    `change-classification classification-${membership.classification}`,
    membership.classification,
  );
  const pathGroup = element("span", "file-path-group");
  const pathLine = element("span", "file-path-line");
  const relativePath = projectRelativePath(file);
  const slash = relativePath.lastIndexOf("/");
  if (slash >= 0) {
    appendText(
      pathLine,
      "span",
      "code-text file-directory",
      relativePath.slice(0, slash + 1),
    );
  }
  appendText(
    pathLine,
    "span",
    "code-text file-name",
    relativePath.slice(slash + 1),
  );
  pathGroup.append(pathLine);
  if (file.previousPath) {
    appendText(
      pathGroup,
      "span",
      "code-text previous-file-path",
      `from ${file.previousPath}`,
    );
  }
  const scope = element(
    "span",
    "code-text membership-scope",
    membershipScope(membership, file),
  );
  toggle.append(classification, pathGroup, scope);
  toggle.addEventListener("click", () => {
    const key = `${node.id}\0${file.path}`;
    if (expandedStageFiles.get(stage.id) === key) {
      expandedStageFiles.delete(stage.id);
    } else {
      expandedStageFiles.set(stage.id, key);
    }
    const ledger = article.closest(".node-ledger");
    const replacement = renderNodeLedger(stage);
    ledger.replaceWith(replacement);
    if (expandedStageFiles.get(stage.id)) {
      requestAnimationFrame(() => {
        replacement
          .querySelector(".file-entry.is-expanded")
          ?.scrollIntoView({
            behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
              .matches
              ? "auto"
              : "smooth",
            block: "nearest",
          });
      });
    }
  });
  const pathCopy = file.previousPath
    ? `${file.previousPath} → ${file.path}`
    : file.path;
  const fileComment = commentAction(
    {
      kind: "file",
      label: `File: ${pathCopy}`,
      stageId: stage.id,
      path: file.path,
    },
    "Comment",
  );
  const fileActions = element("div", "file-actions");
  fileActions.append(
    approvalControl(
      {
        kind: "file",
        stageId: stage.id,
        nodeId: node.id,
        path: file.path,
      },
      { label: "File" },
    ),
    fileComment,
  );
  row.append(toggle, fileActions);
  article.append(row);

  if (expanded) {
    const viewer = element("section", "file-diff-viewer");
    viewer.setAttribute("aria-label", `Diff for ${file.path}`);
    viewer.append(renderDiffLoading(file.path));
    article.append(viewer);
    queueMicrotask(() => loadFileDiff(viewer, stage, file, membership));
  }
  return article;
}

function renderDiffLoading(filePath) {
  const state = element("div", "diff-loading");
  appendText(state, "span", "diff-loading-mark", "");
  appendText(state, "p", "code-text", `Reading ${filePath} from Git…`);
  return state;
}

function fileDiffKey(stage, file) {
  return `${stage.id}\0${file.path}`;
}

async function loadFileDiff(viewer, stage, file, membership) {
  const key = fileDiffKey(stage, file);
  if (!fileDiffCache.has(key)) {
    fileDiffCache.set(
      key,
      fetch(
        `/api/stages/${encodeURIComponent(stage.id)}/file-diff?path=${encodeURIComponent(file.path)}`,
        { headers: { accept: "application/json" } },
      ).then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.details || body.error?.message);
        }
        return body;
      }),
    );
  }
  try {
    const data = await fileDiffCache.get(key);
    if (viewer.isConnected) {
      renderFileDiffViewer(viewer, stage, file, membership, data);
    }
  } catch (error) {
    fileDiffCache.delete(key);
    if (!viewer.isConnected) return;
    const retry = element("button", "secondary-button", "Retry file diff");
    retry.type = "button";
    retry.addEventListener("click", () => {
      viewer.replaceChildren(renderDiffLoading(file.path));
      loadFileDiff(viewer, stage, file, membership);
    });
    const failure = element("div", "diff-failure");
    appendText(failure, "p", "inline-error", error.message);
    failure.append(retry);
    viewer.replaceChildren(failure);
  }
}

function renderFileDiffViewer(viewer, stage, file, membership, data) {
  const key = fileDiffKey(stage, file);
  const availableModes = diffModesForFile(data.kind);
  const preferredMode = stageFileModes.get(key);
  const mode = availableModes.some(([value]) => value === preferredMode)
    ? preferredMode
    : availableModes[0][0];
  const header = element("header", "diff-viewer-header");
  const title = element("div", "diff-viewer-title");
  appendText(title, "p", "eyebrow", mode === "patch" ? "Stage patch" : "Full file");
  appendText(title, "h5", "code-text", file.path);
  const metrics = element("p", "diff-metrics code-text");
  if (data.binary) {
    metrics.textContent = "Binary file";
  } else {
    appendText(metrics, "span", "metric-addition", `+${data.additions}`);
    appendText(metrics, "span", "metric-deletion", `−${data.deletions}`);
    metrics.append(
      document.createTextNode(
        mode === "patch" ? " · changed lines" : " · changes inline",
      ),
    );
  }
  title.append(metrics);

  header.append(title);
  if (availableModes.length > 1) {
    const switcher = element("div", "diff-mode-switch");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Diff view");
    for (const [value, label] of availableModes) {
      const button = element(
        "button",
        `diff-mode-button${mode === value ? " is-active" : ""}`,
        label,
      );
      button.type = "button";
      button.setAttribute("aria-pressed", String(mode === value));
      button.addEventListener("click", () => {
        stageFileModes.set(key, value);
        renderFileDiffViewer(viewer, stage, file, membership, data);
      });
      switcher.append(button);
    }
    header.append(switcher);
  }

  const body = element("div", "diff-code-shell");
  if (data.binary) {
    appendText(
      body,
      "p",
      "binary-notice",
      "This binary change cannot be displayed as text.",
    );
  } else if (mode === "patch") {
    body.append(renderPatchView(stage, file, membership, data));
  } else {
    body.append(renderFullFileView(stage, file, data));
  }
  viewer.replaceChildren(header, body);
}

function diffModesForFile(kind) {
  return kind === "added"
    ? [["file", "File"]]
    : [
        ["patch", "Patch"],
        ["file", "File"],
      ];
}

function parseFilePatch(patch) {
  const hunks = [];
  let hunk;
  let oldLine;
  let newLine;
  for (const line of patch.split("\n")) {
    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );
    if (match) {
      hunk = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        context: match[5].trim(),
        rows: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      hunk.rows.push({
        kind: "addition",
        content: line.slice(1),
        newLine,
      });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.rows.push({
        kind: "deletion",
        content: line.slice(1),
        oldLine,
      });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      hunk.rows.push({
        kind: "context",
        content: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

function contentLines(content) {
  if (content === undefined || content === "") return [];
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function buildFullFileRows(data) {
  const oldLines = contentLines(data.oldContent);
  const newLines = contentLines(data.newContent);
  if (data.kind === "deleted") {
    return oldLines.map((content, index) => ({
      kind: "deletion",
      content,
      oldLine: index + 1,
    }));
  }
  if (data.kind === "added") {
    return newLines.map((content, index) => ({
      kind: "addition",
      content,
      newLine: index + 1,
    }));
  }

  const rows = [];
  let newCursor = 1;
  let oldOffset = 0;
  for (const hunk of parseFilePatch(data.patch)) {
    while (newCursor < hunk.newStart) {
      rows.push({
        kind: "context",
        content: newLines[newCursor - 1] ?? "",
        oldLine: newCursor + oldOffset,
        newLine: newCursor,
      });
      newCursor += 1;
    }
    for (const row of hunk.rows) {
      if (row.kind === "deletion") {
        rows.push(row);
      } else {
        rows.push({
          ...row,
          content: newLines[row.newLine - 1] ?? row.content,
        });
        newCursor = row.newLine + 1;
      }
    }
    oldOffset += hunk.oldCount - hunk.newCount;
  }
  while (newCursor <= newLines.length) {
    rows.push({
      kind: "context",
      content: newLines[newCursor - 1],
      oldLine: newCursor + oldOffset,
      newLine: newCursor,
    });
    newCursor += 1;
  }
  return rows;
}

function renderPatchView(stage, file, membership, data) {
  const code = element("div", "diff-code");
  const allHunks = parseFilePatch(data.patch);
  const hunks = membership.hunks
    ? allHunks.filter((_, index) => membership.hunks.includes(index + 1))
    : allHunks;
  if (!hunks.length) {
    appendText(
      code,
      "p",
      "diff-empty",
      "No textual hunks were recorded for this file.",
    );
    return code;
  }
  hunks.forEach((hunk, index) => {
    if (index > 0) {
      const previous = hunks[index - 1];
      const skipped = Math.max(
        0,
        hunk.newStart - (previous.newStart + previous.newCount),
      );
      if (skipped > 0) code.append(renderDiffGap(skipped));
    }
    code.append(renderHunkHeader(hunk));
    for (const row of hunk.rows) {
      code.append(renderCodeRow(stage, file, data.language, row));
    }
  });
  return code;
}

function renderFullFileView(stage, file, data) {
  const code = element("div", "diff-code full-file-code");
  const rows = buildFullFileRows(data);
  if (!rows.length) {
    appendText(code, "p", "diff-empty", "This file has no text content.");
    return code;
  }
  for (const row of rows) {
    code.append(renderCodeRow(stage, file, data.language, row));
  }
  return code;
}

function renderHunkHeader(hunk) {
  const row = element("div", "code-row hunk-row");
  appendText(row, "span", "line-comment-space", "");
  appendText(row, "span", "line-number", "···");
  appendText(row, "span", "line-number", "···");
  appendText(row, "span", "change-marker", "@@");
  appendText(
    row,
    "span",
    "hunk-label code-text",
    hunk.context || `${hunk.oldStart} → ${hunk.newStart}`,
  );
  return row;
}

function renderDiffGap(skipped) {
  const row = element("div", "code-row diff-gap-row");
  appendText(row, "span", "line-comment-space", "");
  appendText(row, "span", "diff-gap-rule", "");
  appendText(
    row,
    "span",
    "diff-gap-label code-text",
    `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}`,
  );
  appendText(row, "span", "diff-gap-rule", "");
  return row;
}

function renderCodeRow(stage, file, language, row) {
  const line = element("div", `code-row code-${row.kind}`);
  const target =
    row.kind === "deletion"
      ? {
          path: file.previousPath ?? file.path,
          side: "old",
          line: row.oldLine,
        }
      : {
          path: file.path,
          side: "new",
          line: row.newLine,
        };
  if (target.line) {
    const action = commentAction(
      {
        kind: "line",
        label: `${target.path}:${target.line} (${target.side})`,
        stageId: stage.id,
        path: target.path,
        side: target.side,
        line: target.line,
      },
      "+",
    );
    action.classList.add("line-comment-action");
    action.setAttribute(
      "aria-label",
      `Comment on ${target.path} line ${target.line}`,
    );
    line.append(action);
  } else {
    appendText(line, "span", "line-comment-space", "");
  }
  appendText(
    line,
    "span",
    "line-number old-line-number",
    row.oldLine ? String(row.oldLine) : "",
  );
  appendText(
    line,
    "span",
    "line-number new-line-number",
    row.newLine ? String(row.newLine) : "",
  );
  appendText(
    line,
    "span",
    "change-marker",
    row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : "",
  );
  const source = element("span", "source-line");
  appendHighlightedCode(source, row.content, language);
  line.append(source);
  return line;
}

const LANGUAGE_KEYWORDS = {
  csharp: new Set(
    "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while yield var dynamic required init".split(
      " ",
    ),
  ),
  javascript: new Set(
    "async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield".split(
      " ",
    ),
  ),
  typescript: new Set(
    "abstract any as async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield".split(
      " ",
    ),
  ),
  python: new Set(
    "and as assert async await break class continue def del elif else except false finally for from global if import in is lambda none nonlocal not or pass raise return true try while with yield".split(
      " ",
    ),
  ),
  sql: new Set(
    "add alter and as asc begin between by case check column commit constraint create database default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary references right rollback select set table then union unique update values view when where".split(
      " ",
    ),
  ),
};

function syntaxTokenClass(token, source, index, language) {
  if (
    token.startsWith("//") ||
    token.startsWith("<!--") ||
    (token.startsWith("#") && language !== "csharp")
  ) {
    return "syntax-comment";
  }
  if (/^["'`]/.test(token)) {
    const tail = source.slice(index + token.length);
    return language === "json" && /^\s*:/.test(tail)
      ? "syntax-property"
      : "syntax-string";
  }
  if (/^\d/.test(token)) return "syntax-number";
  const normalized = token.toLowerCase();
  const keywords =
    LANGUAGE_KEYWORDS[language] ??
    (language === "typescript"
      ? LANGUAGE_KEYWORDS.javascript
      : LANGUAGE_KEYWORDS.csharp);
  if (keywords?.has(normalized)) {
    return ["true", "false", "null", "undefined", "none"].includes(normalized)
      ? "syntax-literal"
      : "syntax-keyword";
  }
  if (
    ["xml", "html"].includes(language) &&
    source.lastIndexOf("<", index) > source.lastIndexOf(">", index)
  ) {
    return "syntax-tag";
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return "syntax-type";
  return "";
}

function appendHighlightedCode(container, source, language) {
  const pattern =
    /(\/\/.*$|#[^\n]*$|<!--.*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) {
      container.append(document.createTextNode(source.slice(cursor, match.index)));
    }
    const className = syntaxTokenClass(
      match[0],
      source,
      match.index,
      language,
    );
    if (className) {
      appendText(container, "span", className, match[0]);
    } else {
      container.append(document.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    container.append(document.createTextNode(source.slice(cursor)));
  }
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
    detailListEntry(band, "Branch", stage.change.branch);
    detailListEntry(band, "Base", stage.change.baseBranch);
    detailListEntry(band, "Head", stage.change.headRevision.slice(0, 12));
    detailListEntry(
      band,
      "Files",
      `${stage.change.files.length} changed`,
    );
  } else {
    detailListEntry(band, "Branch", stage.branch);
    detailListEntry(band, "Head", "Awaiting finalization");
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
      const classNames = [
        index === 0 ? "context-primary" : "context-secondary",
      ];
      if (title === "Validation" && index === 1) {
        classNames.push("validation-status", `validation-${item.status}`);
      }
      if (title === "Validation" && index === 2) {
        classNames.push("context-command", "code-text");
      }
      appendText(
        card,
        "p",
        classNames.join(" "),
        line,
      );
    });
    if (item.nodeRefs?.length) {
      const refs = element("div", "context-node-refs");
      for (const nodeRef of item.nodeRefs) {
        const node = allStages(review)
          .find(({ stage }) => stage.id === selectedStageId)
          ?.stage.nodes.find((candidate) => candidate.id === nodeRef);
        appendText(
          refs,
          "span",
          "context-node-ref code-text",
          node ? node.description : nodeRef,
        ).title = nodeRef;
      }
      card.append(refs);
    }
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
        `Original anchor ${item.target.stageHead.slice(0, 9)} has been rewritten.`,
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
        `${item.resolution.previousHead.slice(0, 9)} → ${item.resolution.rewrittenHead.slice(0, 9)}`,
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
      "Publish review metadata and finalize the local reviewed branch stack.",
    );
    const button = element(
      "button",
      "primary-button",
      "Publish reviewed stack",
    );
    button.type = "button";
    button.addEventListener("click", async () => {
      const result = await apiPost("/api/feedback/approve-stack");
      appendText(section, "p", "approval-result", result.summary);
    });
    section.append(button);
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
