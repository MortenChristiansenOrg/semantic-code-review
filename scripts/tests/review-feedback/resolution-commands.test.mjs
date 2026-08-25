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
  // The agent answers by replying; the reviewer alone resolves the thread.
  repository.feedback(
    "thread",
    "reply",
    "--id",
    "second-comment",
    "--comment-id",
    "second-comment-response",
    "--body",
    "Rewrote the implementation stage.",
    "--author",
    "assistant",
  );
  for (const id of ["first-comment", "second-comment"]) {
    repository.feedback(
      "thread",
      "resolve",
      "--id",
      id,
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

test("stale resolutions report the exact rebind command", (t) => {
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
  repository.feedback(
    "thread",
    "resolve",
    "--id",
    "first-comment",
    "--stage",
    "implementation",
    "--previous-head",
    originalCommit,
    "--rewritten-head",
    rewrittenHead,
  );

  repository.commitFile(
    "implementation.txt",
    "implementation v3\n",
    "Harden feedback fix",
  );
  repository.semantic("restack", "--from", "implementation");
  const finalCommit = repository.readJson(
    ".semantic-review/stages/implementation.json",
  ).change.headRevision;

  const rebindCommand = `resolution rebind --stage implementation --previous-head ${rewrittenHead} --rewritten-head ${finalCommit}`;
  const failure = repository.expectFeedbackFailure(rebindCommand, "validate");
  const combined = failure.stderr + failure.stdout;
  assert.match(combined, /points to stale rewritten head/);
  assert.ok(
    !combined.includes(`${rebindCommand}.`),
    "emitted rebind command must not end with a period",
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
  // The agent answers via a reply; the reviewer then resolves with no rewrite.
  repository.feedback(
    "thread",
    "reply",
    "--id",
    "why-this-way",
    "--comment-id",
    "answer",
    "--body",
    "The invariant must apply to every caller.",
    "--author",
    "assistant",
  );
  repository.feedback("thread", "resolve", "--id", "why-this-way");

  const thread = repository.readJson(
    ".semantic-review-feedback/threads/why-this-way.json",
  );
  assert.equal(thread.status, "resolved");
  assert.equal(thread.resolution.stageId, undefined);
  assert.equal(thread.comments[1].author, "assistant");
  repository.feedback("validate");
});

test("next lists only threads awaiting an agent reply", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  repository.feedback("batch", "create", "--id", "q", "--title", "Queue");
  for (const id of ["needs-reply", "already-answered"]) {
    repository.feedback(
      "thread",
      "add",
      "--batch",
      "q",
      "--id",
      id,
      "--comment-id",
      `${id}-note`,
      "--body",
      `Look at ${id}.`,
      "--label",
      "Implementation",
      "--target-kind",
      "stage",
      "--stage",
      "implementation",
    );
  }
  repository.feedback("batch", "submit", "--id", "q");

  // Both freshly-submitted threads await a reply.
  let groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.flatMap((g) => g.threads.map((thread) => thread.id)).sort(),
    ["already-answered", "needs-reply"],
  );

  // Once the agent replies, that thread leaves the queue but stays submitted.
  repository.feedback(
    "thread",
    "reply",
    "--id",
    "already-answered",
    "--comment-id",
    "answer",
    "--body",
    "Done.",
    "--author",
    "assistant",
  );
  groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.flatMap((g) => g.threads.map((thread) => thread.id)),
    ["needs-reply"],
  );
  assert.equal(
    repository.readJson(
      ".semantic-review-feedback/threads/already-answered.json",
    ).status,
    "submitted",
  );

  // A reviewer follow-up puts the answered thread back in the queue.
  repository.feedback(
    "thread",
    "reply",
    "--id",
    "already-answered",
    "--comment-id",
    "more",
    "--body",
    "One more thing.",
  );
  groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.flatMap((g) => g.threads.map((thread) => thread.id)).sort(),
    ["already-answered", "needs-reply"],
  );
  repository.feedback("validate");
});

test("reviewers reopen and continue resolved threads", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  repository.feedback("batch", "create", "--id", "talk", "--title", "Talk");
  repository.feedback(
    "thread",
    "add",
    "--batch",
    "talk",
    "--id",
    "chat",
    "--comment-id",
    "q",
    "--body",
    "Question?",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );
  repository.feedback("batch", "submit", "--id", "talk");
  const threadPath = ".semantic-review-feedback/threads/chat.json";

  repository.feedback(
    "thread",
    "reply",
    "--id",
    "chat",
    "--comment-id",
    "a",
    "--body",
    "Answer.",
    "--author",
    "assistant",
  );
  repository.feedback("thread", "resolve", "--id", "chat");
  assert.equal(repository.readJson(threadPath).status, "resolved");

  // Reviewers can undo a resolution.
  repository.feedback("thread", "reopen", "--id", "chat");
  let thread = repository.readJson(threadPath);
  assert.equal(thread.status, "submitted");
  assert.equal(thread.resolution, undefined);

  // Replying to a resolved thread reopens it automatically.
  repository.feedback("thread", "resolve", "--id", "chat");
  repository.feedback(
    "thread",
    "reply",
    "--id",
    "chat",
    "--comment-id",
    "more",
    "--body",
    "Follow-up.",
  );
  thread = repository.readJson(threadPath);
  assert.equal(thread.status, "submitted");
  assert.equal(thread.resolution, undefined);
  assert.equal(thread.comments.at(-1).author, "user");

  repository.expectFeedbackFailure(
    "is not resolved",
    "thread",
    "reopen",
    "--id",
    "chat",
  );
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
