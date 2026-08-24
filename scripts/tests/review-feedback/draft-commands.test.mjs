import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  createReviewWithStages,
  finalizeStage,
  initializeReview,
} from "../helpers/repository.mjs";

test("feedback IDs may start with digits", (t) => {
  const repository = createRepository(t);
  initializeReview(repository, {
    reviewId: "1-review",
    requirementId: "2-requirement",
    criteria: [["3-criterion", "Numeric-leading IDs work."]],
  });
  beginStage(repository, {
    id: "4-stage",
    requirementRefs: ["2-requirement#3-criterion"],
  });
  finalizeStage(repository, { id: "4-stage" });

  repository.feedback("init");
  repository.feedback(
    "batch",
    "create",
    "--id",
    "5-batch",
    "--title",
    "Numeric IDs",
  );
  repository.feedback(
    "thread",
    "add",
    "--batch",
    "5-batch",
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
    "--requirement",
    "2-requirement",
    "--criterion",
    "3-criterion",
    "--assigned-stage",
    "4-stage",
  );
});

test("Windows-reserved feedback identifiers are rejected before mutation", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");

  repository.expectFeedbackFailure(
    "must match pattern",
    "batch",
    "create",
    "--id",
    "con",
    "--title",
    "Invalid",
  );
  assert.equal(
    repository.exists(".semantic-review-feedback/batches/con.json"),
    false,
  );

  repository.feedback(
    "batch",
    "create",
    "--id",
    "portable",
    "--title",
    "Portable IDs",
  );
  repository.expectFeedbackFailure(
    "must match pattern",
    "thread",
    "add",
    "--batch",
    "portable",
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
  const { repository } = createReviewWithStages(t);
  repository.write(
    ".semantic-review-feedback/batches/orphan.json",
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

test("draft commands support every target kind and concurrent mutation", async (t) => {
  const { repository } = createReviewWithStages(t, [
    "implementation",
    "follow-up",
  ], {
    reviewId: "42-feedback",
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
  repository.feedback("batch", "create", "--id", "empty", "--title", "Empty");
  repository.feedback("batch", "delete", "--id", "empty");
  assert.equal(
    repository.exists(".semantic-review-feedback/batches/empty.json"),
    false,
  );

  repository.feedback(
    "batch",
    "create",
    "--id",
    "review",
    "--title",
    "Command coverage",
  );
  const targets = [
    [
      "requirement-target",
      "requirement",
      "--requirement",
      "story",
      "--assigned-stage",
      "implementation",
    ],
    [
      "criterion-target",
      "criterion",
      "--requirement",
      "story",
      "--criterion",
      "works",
      "--assigned-stage",
      "implementation",
    ],
    ["stage-target", "stage", "--stage", "implementation"],
    [
      "context-target",
      "context",
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
      "--batch",
      "review",
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
    "--line must be a positive integer",
    "thread",
    "add",
    "--batch",
    "review",
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
    "--batch",
    "review",
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
      "--batch",
      "review",
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
      "--batch",
      "review",
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
  const concurrentBatch = repository.readJson(
    ".semantic-review-feedback/batches/review.json",
  );
  assert.ok(concurrentBatch.threads.includes("concurrent-one"));
  assert.ok(concurrentBatch.threads.includes("concurrent-two"));

  repository.feedback(
    "comment",
    "edit",
    "--thread",
    "requirement-target",
    "--id",
    "requirement-target-note",
    "--body",
    "Updated requirement feedback.",
  );
  repository.feedback(
    "thread",
    "assign",
    "--id",
    "requirement-target",
    "--stage",
    "follow-up",
  );
  repository.feedback("thread", "delete", "--id", "concurrent-one");
  repository.expectFeedbackFailure(
    "must be an empty draft",
    "batch",
    "delete",
    "--id",
    "review",
  );

  repository.feedback("batch", "submit", "--id", "review");
  repository.expectFeedbackFailure(
    "immutable after submission",
    "comment",
    "edit",
    "--thread",
    "requirement-target",
    "--id",
    "requirement-target-note",
    "--body",
    "Too late.",
  );
  repository.expectFeedbackFailure(
    "must be a non-empty draft",
    "batch",
    "submit",
    "--id",
    "review",
  );

  const groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.map((group) => group.stageId),
    ["implementation", "follow-up"],
  );
  assert.match(groups[0].threads[0].assignedStageHead, /^[0-9a-f]{40}$/);
  assert.equal(groups[0].threads[0].comments[0].author, "user");
  assert.match(
    repository.feedback("next"),
    /implementation \(semantic-review\/42-feedback\/01-implementation @ [0-9a-f]{40}\):/,
  );
  assert.equal(
    repository.readJson(
      ".semantic-review-feedback/threads/requirement-target.json",
    ).comments[0].body,
    "Updated requirement feedback.",
  );
  repository.feedback("validate");
});
