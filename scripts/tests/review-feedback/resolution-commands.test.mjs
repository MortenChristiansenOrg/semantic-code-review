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
    "--branch",
    "review/incomplete",
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
    "--previous",
    originalCommit,
    "--rewritten",
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
  repository.semantic(
    "rewrite-stage",
    "--stage",
    "implementation",
    "--fix",
    "HEAD",
  );
  const rewrittenCommit = repository.readJson(
    ".semantic-review/stages/implementation.json",
  ).change.commit;
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
      "--previous",
      originalCommit,
      "--rewritten",
      rewrittenCommit,
    );
  }

  repository.commitFile(
    "implementation.txt",
    "implementation v3\n",
    "Harden feedback fix",
  );
  repository.semantic(
    "rewrite-stage",
    "--stage",
    "implementation",
    "--fix",
    "HEAD",
  );
  const finalCommit = repository.readJson(
    ".semantic-review/stages/implementation.json",
  ).change.commit;
  repository.feedback(
    "resolution",
    "rebind",
    "--stage",
    "implementation",
    "--previous",
    rewrittenCommit,
    "--rewritten",
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

  repository.git("branch", "review/conflict", "HEAD");
  repository.expectFeedbackFailure(
    "already points to",
    "approve-stack",
    "--branch",
    "review/conflict",
  );
  assert.equal(repository.git("rev-parse", "HEAD"), finalCommit);
  repository.git("branch", "-D", "review/conflict");

  repository.feedback(
    "approve-stack",
    "--branch",
    "review/approved",
  );
  const published = repository.git("rev-parse", "HEAD");
  repository.feedback(
    "approve-stack",
    "--branch",
    "review/approved",
  );
  assert.equal(repository.git("rev-parse", "review/approved"), published);
  assert.equal(
    repository.readJson(".semantic-review-feedback/batches/review.json").status,
    "approved",
  );
  assert.equal(
    repository.readJson(
      ".semantic-review-feedback/items/second-comment.json",
    ).resolution.rewrittenCommit,
    finalCommit,
  );
});

test("approve-stack supports reviews with no feedback state", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback(
    "approve-stack",
    "--branch",
    "review/no-feedback",
  );
  assert.equal(
    repository.git("rev-parse", "review/no-feedback"),
    repository.git("rev-parse", "HEAD"),
  );
});
