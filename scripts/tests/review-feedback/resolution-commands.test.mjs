import assert from "node:assert/strict";
import test from "node:test";
import { createReviewWithStages } from "../helpers/repository.mjs";

function createSubmittedBatch(repository, originalCommit) {
  repository.feedback("init");
  repository.feedback(
    "batch",
    "create",
    "--id",
    "review",
    "--title",
    "Resolution review",
  );
  for (const id of ["first-comment", "second-comment"]) {
    repository.feedback(
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      id,
      "--body",
      `Resolve ${id}.`,
      "--label",
      "Implementation",
      "--target-kind",
      "stage",
      "--stage",
      "implementation",
    );
  }
  repository.feedback("batch", "submit", "--id", "review");
  repository.expectFeedbackFailure(
    "Cannot approve stack; incomplete batches",
    "approve-stack",
  );
  repository.expectFeedbackFailure(
    "must show an actual stage rewrite",
    "comment",
    "resolve",
    "--id",
    "first-comment",
    "--summary",
    "No rewrite.",
    "--stage",
    "implementation",
    "--previous-head",
    originalCommit,
    "--rewritten-head",
    originalCommit,
  );
}

test("resolution commands track rewrites, rebinds, and approvals", (t) => {
  const { repository, commits } = createReviewWithStages(t);
  const originalCommit = commits.get("implementation");
  createSubmittedBatch(repository, originalCommit);

  repository.commitFile(
    "implementation.txt",
    "implementation v2\n",
    "Address feedback",
  );
  repository.semantic("restack", "--from", "implementation");
  const rewrittenHead = repository.readJson(
    ".semantic-review/stages/implementation.json",
  ).change.headRevision;
  for (const id of ["first-comment", "second-comment"]) {
    repository.feedback(
      "comment",
      "resolve",
      "--id",
      id,
      "--summary",
      "Rewrote the implementation stage.",
      "--stage",
      "implementation",
      "--previous-head",
      originalCommit,
      "--rewritten-head",
      rewrittenHead,
    );
  }

  repository.commitFile(
    "implementation.txt",
    "implementation v3\n",
    "Harden feedback fix",
  );
  repository.semantic("restack", "--from", "implementation");
  const finalCommit = repository.readJson(
    ".semantic-review/stages/implementation.json",
  ).change.headRevision;
  repository.feedback(
    "resolution",
    "rebind",
    "--stage",
    "implementation",
    "--previous-head",
    rewrittenHead,
    "--rewritten-head",
    finalCommit,
  );

  repository.feedback("comment", "approve", "--id", "first-comment");
  repository.feedback("batch", "approve-all", "--id", "review");
  repository.expectFeedbackFailure(
    "is not awaiting approval",
    "comment",
    "approve",
    "--id",
    "first-comment",
  );
  repository.feedback("validate");
  assert.equal(repository.feedback("next"), "No submitted feedback remains.");

  repository.feedback("approve-stack");
  const published = repository.git(
    "rev-parse",
    "semantic-review/test-review/metadata",
  );
  repository.feedback("approve-stack");
  assert.equal(
    repository.git("rev-parse", "semantic-review/test-review/metadata"),
    published,
  );
  assert.equal(
    repository.readJson(".semantic-review-feedback/batches/review.json").status,
    "approved",
  );
  assert.equal(
    repository.readJson(
      ".semantic-review-feedback/items/second-comment.json",
    ).resolution.rewrittenHead,
    finalCommit,
  );
});

test("approve-stack supports reviews with no feedback state", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("approve-stack");
  assert.equal(
    repository.git("rev-parse", "semantic-review/test-review/metadata^"),
    repository.readJson(".semantic-review/stages/implementation.json").change
      .headRevision,
  );
});
