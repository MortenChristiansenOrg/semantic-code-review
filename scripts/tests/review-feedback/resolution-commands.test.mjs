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
      "thread",
      "add",
      "--batch",
      "review",
      "--id",
      id,
      "--comment-id",
      `${id}-note`,
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
    "thread",
    "resolve",
    "--id",
    "first-comment",
    "--comment-id",
    "first-response",
    "--body",
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
      "thread",
      "resolve",
      "--id",
      id,
      "--comment-id",
      `${id}-response`,
      "--body",
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

  repository.feedback("thread", "approve", "--id", "first-comment");
  repository.feedback("batch", "approve-all", "--id", "review");
  repository.expectFeedbackFailure(
    "is not awaiting approval",
    "thread",
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
      ".semantic-review-feedback/threads/second-comment.json",
    ).resolution.rewrittenHead,
    finalCommit,
  );
  assert.deepEqual(
    repository
      .readJson(".semantic-review-feedback/threads/second-comment.json")
      .comments.map(({ author }) => author),
    ["user", "assistant"],
  );
});

test("answer-only threads resolve without rewriting a stage", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "batch",
    "create",
    "--id",
    "questions",
    "--title",
    "Questions",
  );
  repository.feedback(
    "thread",
    "add",
    "--batch",
    "questions",
    "--id",
    "why-this-way",
    "--comment-id",
    "question",
    "--body",
    "Why is this implemented in the domain layer?",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );
  repository.feedback("batch", "submit", "--id", "questions");
  repository.expectFeedbackFailure(
    "must be provided together",
    "thread",
    "resolve",
    "--id",
    "why-this-way",
    "--comment-id",
    "partial-answer",
    "--body",
    "Incomplete resolution metadata.",
    "--stage",
    "implementation",
  );
  repository.feedback(
    "thread",
    "resolve",
    "--id",
    "why-this-way",
    "--comment-id",
    "answer",
    "--body",
    "The invariant must apply to every caller.",
  );

  const thread = repository.readJson(
    ".semantic-review-feedback/threads/why-this-way.json",
  );
  assert.equal(thread.status, "resolved");
  assert.equal(thread.resolution.stageId, undefined);
  assert.equal(thread.comments[1].author, "assistant");
  repository.feedback("validate");
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
