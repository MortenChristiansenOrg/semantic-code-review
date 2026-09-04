import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  createImplementationWithStages,
  finalizeStage,
  initializeImplementation,
} from "../helpers/repository.mjs";

test("feedback IDs may start with digits", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    implementationId: "1-implementation",
    specificationId: "2-specification",
    criteria: [["3-criterion", "Numeric-leading IDs work."]],
  });
  beginStage(repository, {
    id: "4-stage",
    specificationRefs: ["2-specification#3-criterion"],
  });
  finalizeStage(repository, { id: "4-stage" });

  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "6-thread",
    "--comment-id",
    "7-comment",
    "--body",
    "Numeric-leading IDs work.",
    "--label",
    "Criterion",
    "--target-kind",
    "criterion",
    "--specification",
    "2-specification",
    "--criterion",
    "3-criterion",
    "--assigned-stage",
    "4-stage",
  );
});

test("thread add-batch validates and writes one atomic batch", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.write(
    "feedback-batch.json",
    `${JSON.stringify({
      threads: [
        {
          id: "batch-one",
          "comment-id": "batch-one-comment",
          body: "First batch comment.",
          label: "Implementation",
          "target-kind": "stage",
          stage: "implementation",
        },
        {
          id: "batch-two",
          "comment-id": "batch-two-comment",
          body: "Second batch comment.",
          label: "implementation.txt",
          "target-kind": "file",
          stage: "implementation",
          path: "implementation.txt",
        },
      ],
    })}\n`,
  );

  repository.feedback(
    "thread",
    "add-batch",
    "--input",
    "feedback-batch.json",
  );
  const manifest = repository.readJson(
    ".semantic-review-feedback/manifest.json",
  );
  assert.deepEqual(manifest.threads, ["batch-one", "batch-two"]);

  repository.write(
    "invalid-feedback-batch.json",
    `${JSON.stringify({
      threads: [
        {
          id: "batch-not-kept",
          "comment-id": "batch-not-kept-comment",
          body: "Must roll back.",
          label: "Implementation",
          "target-kind": "stage",
          stage: "implementation",
        },
        {
          id: "batch-invalid",
          "comment-id": "batch-invalid-comment",
          label: "Implementation",
          "target-kind": "stage",
          stage: "implementation",
        },
      ],
    })}\n`,
  );
  repository.expectFeedbackFailure(
    "Missing required option --body",
    "thread",
    "add-batch",
    "--input",
    "invalid-feedback-batch.json",
  );
  assert.equal(
    repository.exists(
      ".semantic-review-feedback/threads/batch-not-kept.json",
    ),
    false,
  );
  assert.deepEqual(
    repository.readJson(".semantic-review-feedback/manifest.json").threads,
    ["batch-one", "batch-two"],
  );
});

test("Windows-reserved feedback identifiers are rejected before mutation", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");

  repository.expectFeedbackFailure(
    "must match pattern",
    "thread",
    "add",
    "--id",
    "lpt1",
    "--comment-id",
    "valid-comment",
    "--body",
    "Invalid on Windows.",
    "--label",
    "Invalid",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );
  assert.equal(
    repository.exists(".semantic-review-feedback/threads/lpt1.json"),
    false,
  );
});

test("feedback init does not strand a manifest among pre-existing files", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.write(
    ".semantic-review-feedback/threads/orphan.json",
    "{}\n",
  );

  repository.expectFeedbackFailure(
    "already contains files but has no manifest",
    "init",
  );
  assert.equal(
    repository.exists(".semantic-review-feedback/manifest.json"),
    false,
  );

  repository.remove(".semantic-review-feedback");
  repository.feedback("init");
  repository.feedback("validate");
});

test("thread add supports every target kind and concurrent mutation", async (t) => {
  const { repository } = createImplementationWithStages(t, [
    "implementation",
    "follow-up",
  ], {
    implementationId: "42-feedback",
  });
  repository.semantic(
    "stage",
    "record",
    "--stage",
    "implementation",
    "--finalized",
    "--kind",
    "decision",
    "--item-id",
    "fixture-shape",
    "--category",
    "engineering",
    "--summary",
    "Use a text fixture.",
    "--rationale",
    "The diff remains readable.",
    "--node-ref",
    "implementation-change",
  );

  repository.feedback("init");
  repository.expectFeedbackFailure("Feedback state already exists.", "init");

  const targets = [
    [
      "specification-target",
      "specification",
      "--specification",
      "story",
      "--assigned-stage",
      "follow-up",
    ],
    [
      "criterion-target",
      "criterion",
      "--specification",
      "story",
      "--criterion",
      "works",
      "--assigned-stage",
      "implementation",
    ],
    ["stage-target", "stage", "--stage", "implementation"],
    [
      "node-target",
      "node",
      "--stage",
      "implementation",
      "--node",
      "implementation-change",
    ],
    [
      "insight-target",
      "insight",
      "--stage",
      "implementation",
      "--collection",
      "decisions",
      "--item",
      "fixture-shape",
    ],
    [
      "file-target",
      "file",
      "--stage",
      "implementation",
      "--path",
      "implementation.txt",
    ],
    [
      "line-target",
      "line",
      "--stage",
      "implementation",
      "--path",
      "implementation.txt",
      "--side",
      "new",
      "--line",
      "1",
    ],
  ];
  for (const [id, kind, ...options] of targets) {
    repository.feedback(
      "thread",
      "add",
      "--id",
      id,
      "--comment-id",
      `${id}-note`,
      "--body",
      `Feedback for ${kind}.`,
      "--label",
      `${kind} target`,
      "--target-kind",
      kind,
      ...options,
    );
  }

  repository.expectFeedbackFailure(
    "Feedback node implementation/missing-node does not exist.",
    "thread",
    "add",
    "--id",
    "missing-node",
    "--comment-id",
    "missing-node-note",
    "--body",
    "Invalid.",
    "--label",
    "Missing node",
    "--target-kind",
    "node",
    "--stage",
    "implementation",
    "--node",
    "missing-node",
  );
  repository.expectFeedbackFailure(
    "--line must be a positive integer",
    "thread",
    "add",
    "--id",
    "invalid-line",
    "--comment-id",
    "invalid-line-note",
    "--body",
    "Invalid.",
    "--label",
    "Invalid line",
    "--target-kind",
    "line",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
    "--side",
    "new",
    "--line",
    "0",
  );
  repository.expectFeedbackFailure(
    "exceeds implementation.txt's 1 line(s)",
    "thread",
    "add",
    "--id",
    "missing-line",
    "--comment-id",
    "missing-line-note",
    "--body",
    "The anchor must exist.",
    "--label",
    "Missing line",
    "--target-kind",
    "line",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
    "--side",
    "new",
    "--line",
    "999999",
  );
  await Promise.all([
    repository.feedbackAsync(
      "thread",
      "add",
      "--id",
      "concurrent-one",
      "--comment-id",
      "concurrent-one-note",
      "--body",
      "First concurrent comment.",
      "--label",
      "Implementation",
      "--target-kind",
      "stage",
      "--stage",
      "implementation",
    ),
    repository.feedbackAsync(
      "thread",
      "add",
      "--id",
      "concurrent-two",
      "--comment-id",
      "concurrent-two-note",
      "--body",
      "Second concurrent comment.",
      "--label",
      "Implementation",
      "--target-kind",
      "stage",
      "--stage",
      "implementation",
    ),
  ]);

  const manifest = repository.readJson(
    ".semantic-review-feedback/manifest.json",
  );
  assert.ok(manifest.threads.includes("concurrent-one"));
  assert.ok(manifest.threads.includes("concurrent-two"));

  const groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.map((group) => group.stageId),
    ["implementation", "follow-up"],
  );
  assert.match(groups[0].threads[0].stageHead, /^[0-9a-f]{40}$/);
  assert.equal(groups[0].threads[0].comments[0].author, "user");
  assert.match(
    repository.feedback("next"),
    /implementation \(semantic-flow\/42-feedback\/01-implementation @ [0-9a-f]{40}\):/,
  );
  repository.feedback("validate");
});
