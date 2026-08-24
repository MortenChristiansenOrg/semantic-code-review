import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readSemanticReview } from "../src/artifact-reader.mjs";
import { initializeFeedback } from "../src/feedback-service.mjs";
import {
  resolveRepositoryRootArgument,
  startServer,
} from "../src/server.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

function requestWithHost({ port, host, requestPath }) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        headers: {
          host,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    request.on("error", reject);
  });
}

test("resolves optional absolute and relative project arguments", () => {
  const cwd = path.join(repositoryRoot, "fixtures");
  const absolute = path.join(repositoryRoot, "external-project");

  assert.equal(
    resolveRepositoryRootArgument([absolute], {
      cwd,
      environmentRoot: undefined,
    }),
    absolute,
  );
  assert.equal(
    resolveRepositoryRootArgument([".."], {
      cwd,
      environmentRoot: undefined,
    }),
    repositoryRoot,
  );
  assert.equal(
    resolveRepositoryRootArgument([], {
      cwd,
      environmentRoot: absolute,
    }),
    absolute,
  );
  assert.throws(
    () =>
      resolveRepositoryRootArgument(["first", "second"], {
        cwd,
        environmentRoot: undefined,
      }),
    /Usage:/,
  );
});

async function postJson(url, body = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("serves the current semantic review as JSON", async () => {
  const expected = await readSemanticReview({ repositoryRoot });
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/review`,
    );
    const body = await response.json();
    const visibleStageIds = [
      ...body.stages.map((stage) => stage.id),
      ...body.workingStages.map((stage) => stage.id),
    ];

    assert.equal(response.status, 200);
    assert.equal(body.manifest.reviewId, expected.manifest.reviewId);
    assert.ok(
      expected.manifest.stages.every((stageId) =>
        visibleStageIds.includes(stageId),
      ),
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("discovers the repository when npm changes the working directory", async () => {
  const expected = await readSemanticReview({ repositoryRoot });
  const server = await startServer({ port: 0 });
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/review`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.manifest.reviewId, expected.manifest.reviewId);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves the browser workspace assets", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    const [html, script, styles] = await Promise.all([
      htmlResponse.text(),
      scriptResponse.text(),
      styleResponse.text(),
    ]);

    assert.equal(htmlResponse.status, 200);
    assert.match(html, /Semantic Review Workspace/);
    assert.equal(scriptResponse.status, 200);
    assert.match(script, /renderStageDetail/);
    assert.equal(styleResponse.status, 200);
    assert.match(styles, /\.stage-spine/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("keeps feedback browser handlers in page scope", () => {
  const appPath = path.join(repositoryRoot, "poc", "public", "app.js");
  const source = fs
    .readFileSync(appPath, "utf8")
    .replace(
      /loadReview\(\);\s*$/,
      "globalThis.browserHandlers = { renderFeedbackPanel, openCommentEdit, apiRequest, stagesAddressingCriterion, diffModesForFile, parseFilePatch, buildFullFileRows, membershipScope, directApprovalStatus, inheritedApproval }; globalThis.setApprovals = (value) => { approvals = value; };",
    );
  const node = {
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
  };
  const context = {
    document: {
      body: node,
      querySelector() {
        return node;
      },
    },
    window: { addEventListener() {} },
  };

  vm.runInNewContext(source, context);

  assert.equal(typeof context.browserHandlers.renderFeedbackPanel, "function");
  assert.equal(typeof context.browserHandlers.openCommentEdit, "function");
  assert.equal(typeof context.browserHandlers.apiRequest, "function");
  const requirementStages =
    context.browserHandlers.stagesAddressingCriterion(
      {
        stages: [
          {
            id: "first-stage",
            requirementRefs: ["story#first"],
          },
          {
            id: "second-stage",
            requirementRefs: ["other#criterion"],
          },
        ],
        workingStages: [
          {
            id: "third-stage",
            requirementRefs: ["story#second"],
          },
        ],
      },
      "story",
      "first",
    );
  assert.equal(
    JSON.stringify(requirementStages.map(({ stage }) => stage.id)),
    JSON.stringify(["first-stage"]),
  );
  assert.equal(
    JSON.stringify(context.browserHandlers.diffModesForFile("added")),
    JSON.stringify([["file", "File"]]),
  );
  assert.equal(
    JSON.stringify(context.browserHandlers.diffModesForFile("modified")),
    JSON.stringify([
      ["patch", "Patch"],
      ["file", "File"],
    ]),
  );
  assert.equal(
    context.browserHandlers.membershipScope(
      { classification: "trivial", hunks: [1, 3] },
      { kind: "modified" },
    ),
    "modified · hunks 1, 3",
  );
  context.setApprovals({
    changeSet: {
      available: true,
      approved: false,
      previouslyApproved: false,
    },
    stages: {
      "first-stage": {
        available: true,
        approved: true,
        previouslyApproved: false,
      },
    },
    nodes: {
      "first-stage": {
        "first-node": {
          available: true,
          approved: false,
          previouslyApproved: true,
        },
      },
    },
    files: {
      "first-stage": {
        "file.txt": {
          available: true,
          approved: true,
          previouslyApproved: false,
        },
      },
    },
  });
  assert.equal(
    context.browserHandlers.inheritedApproval({
      kind: "node",
      stageId: "first-stage",
      nodeId: "first-node",
    }),
    "stage",
  );
  assert.equal(
    context.browserHandlers.directApprovalStatus({
      kind: "file",
      stageId: "first-stage",
      path: "file.txt",
    }).approved,
    true,
  );
  const hunks = context.browserHandlers.parseFilePatch(
    "@@ -1,2 +1,2 @@\n-old value\n+new value\n stable",
  );
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].rows[0].kind, "deletion");
  assert.equal(hunks[0].rows[0].oldLine, 1);
  assert.equal(hunks[0].rows[1].kind, "addition");
  assert.equal(hunks[0].rows[1].newLine, 1);
  const fullRows = context.browserHandlers.buildFullFileRows({
    kind: "modified",
    oldContent: "old value\nstable\n",
    newContent: "new value\nstable\n",
    patch: "@@ -1,2 +1,2 @@\n-old value\n+new value\n stable",
  });
  assert.equal(
    JSON.stringify(fullRows.map((row) => [row.kind, row.content])),
    JSON.stringify([
      ["deletion", "old value"],
      ["addition", "new value"],
      ["context", "stable"],
    ]),
  );
});

test("serves authoritative validation and a finalized stage diff", async () => {
  const expected = await readSemanticReview({ repositoryRoot });
  const firstStage = expected.stages[0];
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [validationResponse, diffResponse] = await Promise.all([
      fetch(`${baseUrl}/api/validation`),
      fetch(`${baseUrl}/api/stages/${firstStage.id}/diff`),
    ]);
    const [validation, diff] = await Promise.all([
      validationResponse.json(),
      diffResponse.json(),
    ]);

    assert.equal(validationResponse.status, 200);
    assert.equal(validation.status, "passed");
    assert.match(validation.summary, /full validation passed/i);
    assert.equal(diffResponse.status, 200);
    assert.equal(diff.stageId, firstStage.id);
    assert.ok(diff.diff.length > 0);
    assert.ok(diff.diff.includes(firstStage.change.files[0].path));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves project-grouped files and a focused stage file diff", async () => {
  const expected = await readSemanticReview({ repositoryRoot });
  const firstStage = expected.stages[0];
  const firstFile = firstStage.change.files[0];
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [reviewResponse, fileResponse, approvalsResponse] = await Promise.all([
      fetch(`${baseUrl}/api/review`),
      fetch(
        `${baseUrl}/api/stages/${firstStage.id}/file-diff?path=${encodeURIComponent(firstFile.path)}`,
      ),
      fetch(`${baseUrl}/api/approvals`),
    ]);
    const [reviewBody, fileDiff, approvalState] = await Promise.all([
      reviewResponse.json(),
      fileResponse.json(),
      approvalsResponse.json(),
    ]);

    assert.equal(reviewResponse.status, 200);
    assert.ok(reviewBody.stages[0].change.files[0].project.name);
    assert.equal(fileResponse.status, 200);
    assert.equal(fileDiff.path, firstFile.path);
    assert.ok(fileDiff.patch.includes(firstFile.path));
    assert.ok(fileDiff.oldContent !== undefined || fileDiff.newContent !== undefined);
    assert.equal(approvalsResponse.status, 200);
    assert.equal(approvalState.reviewId, expected.manifest.reviewId);
    assert.ok(approvalState.stages[firstStage.id]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects non-local Host headers before serving repository data", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const response = await requestWithHost({
      port: address.port,
      host: "attacker.example",
      requestPath: "/api/review",
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "invalid-host");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects cross-origin and non-JSON mutations", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/api/feedback/init`;
    const crossOrigin = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    const simpleRequest = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "{}",
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(simpleRequest.status, 415);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("validates threaded feedback mutation requests", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingTarget = await postJson(`${baseUrl}/api/feedback/threads`, {
      batchId: "review-batch",
      body: "Needs a target.",
    });
    const missingTargetBody = await missingTarget.json();
    assert.equal(missingTarget.status, 400);
    assert.equal(missingTargetBody.error.code, "invalid-request");

    const missingBatch = await postJson(`${baseUrl}/api/feedback/threads`, {
      body: "No batch id.",
      target: { kind: "requirement", label: "Requirement" },
    });
    assert.equal(missingBatch.status, 400);

    const emptyComment = await fetch(
      `${baseUrl}/api/feedback/threads/thread-one/comments/comment-one`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "   " }),
      },
    );
    const emptyCommentBody = await emptyComment.json();
    assert.equal(emptyComment.status, 400);
    assert.equal(emptyCommentBody.error.code, "invalid-request");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves and mutates schema-validated feedback state", async () => {
  const feedbackRoot = path.join(
    repositoryRoot,
    ".semantic-review-feedback",
  );
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-review-feedback-api-"),
  );
  const backup = path.join(backupRoot, ".semantic-review-feedback");
  const hadFeedback = fs.existsSync(feedbackRoot);
  if (hadFeedback) {
    fs.cpSync(feedbackRoot, backup, { recursive: true });
  }
  fs.rmSync(feedbackRoot, { recursive: true, force: true });
  await initializeFeedback({ repositoryRoot });
  const activeReview = await readSemanticReview({ repositoryRoot });
  const requirement = activeReview.requirements[0];
  const criterion = requirement.acceptanceCriteria[0];
  const stage = activeReview.stages[0];
  const decision = stage.decisions[0];
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await fetch(`${baseUrl}/api/feedback`);
    const initialBody = await initial.json();

    assert.equal(initial.status, 200);
    assert.equal(initialBody.initialized, true);

    const batchResponse = await postJson(`${baseUrl}/api/feedback/batches`, {
      title: "API test batch",
    });
    const batchState = await batchResponse.json();
    const batch = batchState.batches.at(-1);
    assert.equal(batchResponse.status, 201);
    assert.equal(batch.status, "draft");

    const criterionResponse = await postJson(
      `${baseUrl}/api/feedback/threads`,
      {
        batchId: batch.id,
        body: "Clarify this criterion.",
        target: {
          kind: "criterion",
          label: "Criterion: publication works",
          requirementId: requirement.id,
          criterionId: criterion.id,
          assignedStageId: stage.id,
        },
      },
    );
    const criterionState = await criterionResponse.json();
    const criterionThread = criterionState.batches
      .find((candidate) => candidate.id === batch.id)
      .feedbackThreads.at(-1);
    assert.equal(criterionResponse.status, 201);
    assert.equal(criterionThread.status, "draft");
    assert.equal(criterionThread.assignedStageId, stage.id);
    assert.equal(criterionThread.comments.length, 1);
    assert.equal(criterionThread.comments[0].author, "user");
    await fetch(`${baseUrl}/api/feedback/threads/${criterionThread.id}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },
    });

    const commentResponse = await postJson(
      `${baseUrl}/api/feedback/threads`,
      {
        batchId: batch.id,
        body: "Clarify the lifecycle decision.",
        target: {
          kind: "context",
          label: "Decision: metadata-only publication",
          stageId: stage.id,
          collection: "decisions",
          itemId: decision.id,
        },
      },
    );
    const commentState = await commentResponse.json();
    assert.equal(
      commentResponse.status,
      201,
      JSON.stringify(commentState),
    );
    const updatedBatch = commentState.batches.find(
      (candidate) => candidate.id === batch.id,
    );
    assert.equal(updatedBatch.feedbackThreads.length, 1);
    assert.equal(updatedBatch.feedbackThreads[0].status, "draft");

    const thread = updatedBatch.feedbackThreads[0];
    const openingComment = thread.comments[0];
    assert.equal(openingComment.author, "user");
    const editResponse = await fetch(
      `${baseUrl}/api/feedback/threads/${thread.id}/comments/${openingComment.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body: "Clarify the lifecycle decision and its tradeoff.",
        }),
      },
    );
    const editState = await editResponse.json();
    const edited = editState.batches
      .find((candidate) => candidate.id === batch.id)
      .feedbackThreads.find((candidate) => candidate.id === thread.id);
    assert.equal(editResponse.status, 200);
    assert.match(edited.comments[0].body, /tradeoff/);

    const deleteResponse = await fetch(
      `${baseUrl}/api/feedback/threads/${thread.id}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
      },
    );
    const deleteState = await deleteResponse.json();
    const afterDelete = deleteState.batches.find(
      (candidate) => candidate.id === batch.id,
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(afterDelete.feedbackThreads.length, 0);

    const deleteBatchResponse = await fetch(
      `${baseUrl}/api/feedback/batches/${batch.id}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
      },
    );
    const afterBatchDelete = await deleteBatchResponse.json();
    assert.equal(deleteBatchResponse.status, 200);
    assert.equal(
      afterBatchDelete.batches.some((candidate) => candidate.id === batch.id),
      false,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(feedbackRoot, { recursive: true, force: true });
    if (hadFeedback) {
      fs.cpSync(backup, feedbackRoot, { recursive: true });
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
});
