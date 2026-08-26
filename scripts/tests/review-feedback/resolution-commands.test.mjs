import assert from "node:assert/strict";
import test from "node:test";
import { createReviewWithStages } from "../helpers/repository.mjs";

function addThread(repository, id, body = `Resolve ${id}.`) {
  repository.feedback(
    "thread",
    "add",
    "--id",
    id,
    "--comment-id",
    `${id}-note`,
    "--body",
    body,
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );
}

test("reviewers resolve threads without rewrite bookkeeping", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  addThread(repository, "first-comment");
  addThread(repository, "second-comment");

  repository.expectFeedbackFailure(
    "Cannot approve stack; unresolved threads",
    "approve-stack",
  );

  repository.commitFile(
    "implementation.txt",
    "implementation v2\n",
    "Address feedback",
  );
  repository.semantic("restack", "--from", "implementation");

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
    repository.feedback("thread", "resolve", "--id", id);
  }

  repository.commitFile(
    "implementation.txt",
    "implementation v3\n",
    "Harden feedback fix",
  );
  repository.semantic("restack", "--from", "implementation");

  repository.feedback("validate");
  assert.equal(repository.feedback("next"), "No open feedback remains.");

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
  const thread = repository.readJson(
    ".semantic-review-feedback/threads/second-comment.json",
  );
  assert.equal(thread.status, "resolved");
  assert.match(thread.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(thread.resolution, undefined);
  assert.deepEqual(
    thread.comments.map(({ author }) => author),
    ["user", "assistant"],
  );
});

test("answer-only threads use the same resolution flow", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  addThread(
    repository,
    "why-this-way",
    "Why is this implemented in the domain layer?",
  );
  repository.expectFeedbackFailure(
    "must be provided together",
    "thread",
    "resolve",
    "--id",
    "why-this-way",
    "--comment-id",
    "partial-answer",
  );
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
  assert.equal(thread.comments[1].author, "assistant");
  repository.feedback("validate");
});

test("next lists only open threads awaiting an agent reply", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  addThread(repository, "needs-reply");
  addThread(repository, "already-answered");

  let groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.flatMap((g) => g.threads.map((thread) => thread.id)).sort(),
    ["already-answered", "needs-reply"],
  );

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
    "open",
  );

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
});

test("reviewers reopen and continue resolved threads", (t) => {
  const { repository } = createReviewWithStages(t);
  repository.feedback("init");
  addThread(repository, "chat", "Question?");
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

  repository.feedback("thread", "reopen", "--id", "chat");
  let thread = repository.readJson(threadPath);
  assert.equal(thread.status, "open");
  assert.equal(thread.resolvedAt, undefined);

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
  assert.equal(thread.status, "open");
  assert.equal(thread.resolvedAt, undefined);
  assert.equal(thread.comments.at(-1).author, "user");

  repository.expectFeedbackFailure(
    "is not resolved",
    "thread",
    "reopen",
    "--id",
    "chat",
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
