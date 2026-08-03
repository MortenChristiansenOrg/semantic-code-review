import assert from "node:assert/strict";
import test from "node:test";
import { createReviewWithStages } from "../helpers/repository.mjs";

test("draft commands support every target kind and concurrent mutation", async (t) => {
  const { repository } = createReviewWithStages(t, [
    "implementation",
    "follow-up",
  ]);
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
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      id,
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
    "comment",
    "add",
    "--batch",
    "review",
    "--id",
    "invalid-line",
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
  await Promise.all([
    repository.feedbackAsync(
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      "concurrent-one",
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
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      "concurrent-two",
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
  assert.ok(concurrentBatch.items.includes("concurrent-one"));
  assert.ok(concurrentBatch.items.includes("concurrent-two"));

  repository.feedback(
    "comment",
    "edit",
    "--id",
    "requirement-target",
    "--body",
    "Updated requirement feedback.",
  );
  repository.feedback(
    "comment",
    "assign",
    "--id",
    "requirement-target",
    "--stage",
    "follow-up",
  );
  repository.feedback("comment", "delete", "--id", "concurrent-one");
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
    "--id",
    "requirement-target",
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
  assert.match(repository.feedback("next"), /implementation \([0-9a-f]{40}\):/);
  assert.equal(
    repository.readJson(
      ".semantic-review-feedback/items/requirement-target.json",
    ).body,
    "Updated requirement feedback.",
  );
  repository.feedback("validate");
});
