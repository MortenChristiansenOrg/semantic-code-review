import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  createImplementationWithStages,
  finalizeStage,
  flowCli,
  initializeImplementation,
  organizeStage,
} from "../helpers/repository.mjs";

/** Records a new head for a stage, as if the stage branch had been revised;
 * Git derives the stage's inventory from it. */
function recordStageHead(repository, id, headRevision) {
  const manifest = repository.artifact.readJson("manifest.json");
  manifest.stages = manifest.stages.map((entry) => (entry.id === id ? { ...entry, headRevision } : entry));
  repository.artifact.write("manifest.json", manifest);
}

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
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "first-comment");
  addThread(repository, "second-comment");

  repository.expectFeedbackFailure(
    "Unresolved feedback threads",
    "validate",
    "--require-resolved",
  );
  const blockedPublication = repository.result(process.execPath, [
    flowCli,
    "validate",
    "--publish",
  ]);
  assert.notEqual(blockedPublication.status, 0);
  assert.match(
    `${blockedPublication.stdout}\n${blockedPublication.stderr}`,
    /Unresolved feedback threads/,
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
    "agent",
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
  repository.feedback("validate", "--require-resolved");
  repository.flow("validate", "--publish");
  assert.equal(repository.feedback("next"), "No open feedback remains.");
  const thread = repository.readAbsoluteJson(
    repository.feedbackPath("threads/second-comment.json"),
  );
  assert.equal(thread.status, "resolved");
  assert.match(thread.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(thread.resolution, undefined);
  assert.deepEqual(
    thread.comments.map(({ author }) => author),
    ["user", "agent"],
  );
});

test("answer-only threads use the same resolution flow", (t) => {
  const { repository } = createImplementationWithStages(t);
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
    "agent",
  );
  repository.feedback("thread", "resolve", "--id", "why-this-way");

  const thread = repository.readAbsoluteJson(
    repository.feedbackPath("threads/why-this-way.json"),
  );
  assert.equal(thread.status, "resolved");
  assert.equal(thread.comments[1].author, "agent");
  repository.feedback("validate");
});

test("thread reply-batch validates and writes one atomic batch", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "batch-first");
  addThread(repository, "batch-second");
  repository.write(
    "reply-batch.json",
    `${JSON.stringify({
      replies: [
        {
          id: "batch-first",
          "comment-id": "batch-first-reply",
          body: "First reply.",
          author: "agent",
        },
        {
          id: "batch-second",
          "comment-id": "batch-second-reply",
          body: "Second reply.",
          author: "agent",
        },
      ],
    })}\n`,
  );

  repository.feedback(
    "thread",
    "reply-batch",
    "--input",
    "reply-batch.json",
  );
  assert.equal(
    repository.readAbsoluteJson(
      repository.feedbackPath("threads/batch-first.json"),
    ).comments.at(-1).body,
    "First reply.",
  );
  assert.equal(
    repository.readAbsoluteJson(
      repository.feedbackPath("threads/batch-second.json"),
    ).comments.at(-1).body,
    "Second reply.",
  );

  repository.write(
    "invalid-reply-batch.json",
    `${JSON.stringify({
      replies: [
        {
          id: "batch-first",
          "comment-id": "batch-first-not-kept",
          body: "Must roll back.",
        },
        {
          id: "missing-thread",
          "comment-id": "missing-thread-reply",
          body: "Invalid.",
        },
      ],
    })}\n`,
  );
  repository.expectFeedbackFailure(
    "Feedback thread missing-thread does not exist",
    "thread",
    "reply-batch",
    "--input",
    "invalid-reply-batch.json",
  );
  assert.equal(
    repository.readAbsoluteJson(
      repository.feedbackPath("threads/batch-first.json"),
    ).comments.some((comment) => comment.id === "batch-first-not-kept"),
    false,
  );
});

test("next lists only open threads awaiting an agent reply", (t) => {
  const { repository } = createImplementationWithStages(t);
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
    "agent",
  );
  groups = JSON.parse(repository.feedback("next", "--json"));
  assert.deepEqual(
    groups.flatMap((g) => g.threads.map((thread) => thread.id)),
    ["needs-reply"],
  );
  assert.equal(
    repository.readAbsoluteJson(
      repository.feedbackPath("threads/already-answered.json"),
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

  const compactOutput = repository.feedback("next", "--json", "--compact");
  const compact = JSON.parse(compactOutput);
  const compactThread = compact
    .flatMap((group) => group.threads)
    .find((thread) => thread.id === "already-answered");
  assert.equal(compactOutput.includes("\n"), false);
  assert.equal(compactThread.stale, false);
  assert.match(compact[0].stageHead, /^[a-f0-9]{40}$/);
  assert.match(compact[0].stageBase, /^[a-f0-9]{40}$/);
  assert.equal("stageHead" in compactThread, false);
  assert.equal("stageBranch" in compactThread.target, false);
  assert.equal("stageHead" in compactThread.target, false);
  assert.deepEqual(compactThread.comments[0], {
    author: "user",
    body: "Resolve already-answered.",
  });
  assert.equal("createdAt" in compactThread.comments[0], false);
  repository.expectFeedbackFailure(
    "--compact requires --json",
    "next",
    "--compact",
  );

  repository.feedback(
    "thread",
    "add",
    "--id",
    "line-anchor",
    "--comment-id",
    "line-anchor-note",
    "--body",
    "Keep this line-specific.",
    "--label",
    "Implementation line",
    "--target-kind",
    "line",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
    "--side",
    "new",
    "--line",
    "1",
  );
  repository.commitFile(
    "implementation.txt",
    "implementation changed after feedback\n",
    "Change reviewed stage",
  );
  repository.semantic("restack", "--from", "implementation");
  const stale = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  );
  const stageThread = stale[0].threads.find(
    (thread) => thread.id === "already-answered",
  );
  const lineThread = stale[0].threads.find(
    (thread) => thread.id === "line-anchor",
  );
  assert.equal(stageThread.stale, false);
  assert.equal(stageThread.reanchored, true);
  assert.equal(lineThread.stale, true);
  assert.equal("reanchored" in lineThread, false);
  const storedStageThread = repository.readAbsoluteJson(
    repository.feedbackPath("threads/already-answered.json"),
  );
  const currentStage = repository.artifact.stage("implementation");
  assert.equal(storedStageThread.stageHead, currentStage.change.headRevision);
  assert.equal(
    storedStageThread.target.stageHead,
    currentStage.change.headRevision,
  );
});

test("reviewers reopen and continue resolved threads", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "chat", "Question?");
  const threadPath = repository.feedbackPath("threads/chat.json");

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
    "agent",
  );
  repository.feedback("thread", "resolve", "--id", "chat");
  assert.equal(repository.readAbsoluteJson(threadPath).status, "resolved");

  repository.feedback("thread", "reopen", "--id", "chat");
  let thread = repository.readAbsoluteJson(threadPath);
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
  thread = repository.readAbsoluteJson(threadPath);
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

test("pending node anchors refresh only while the node exists", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "node-anchor",
    "--comment-id",
    "node-anchor-note",
    "--body",
    "Keep this step focused.",
    "--label",
    "Implementation change",
    "--target-kind",
    "node",
    "--stage",
    "implementation",
    "--node",
    "implementation-change",
  );

  recordStageHead(repository, "implementation", repository.commitFile(
    "implementation.txt",
    "implementation changed\n",
    "Change node implementation",
  ));

  let pending = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  )[0].threads[0];
  assert.equal(pending.stale, false);
  assert.equal(pending.reanchored, true);
  assert.equal(pending.target.kind, "node");
  assert.equal(pending.target.nodeId, "implementation-change");

  const stagePath = "stages/implementation.json";
  const refreshedStage = repository.artifact.readJson(stagePath);
  refreshedStage.nodes = refreshedStage.nodes.map((node) => ({
    ...node,
    id: "replacement-change",
  }));
  repository.artifact.write(stagePath, refreshedStage);
  recordStageHead(repository, "implementation", repository.commitFile(
    "implementation.txt",
    "replacement implementation\n",
    "Replace node implementation",
  ));

  pending = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  )[0].threads[0];
  assert.equal(pending.stale, true);
  assert.equal("reanchored" in pending, false);
  assert.equal(pending.target.nodeId, "implementation-change");
});

test("pending file anchors follow renames", (t) => {
  // Inventories are derived from Git, so the stage edits a file its base
  // already has; renaming it later is then a rename within the stage.
  const repository = createRepository(t);
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index}\n`);
  repository.commitFile("implementation.txt", lines.join(""), "Add implementation file");
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { contents: [...lines, "stage line\n"].join("") });
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "file-anchor",
    "--comment-id",
    "file-anchor-note",
    "--body",
    "Keep the file-level behavior.",
    "--label",
    "implementation.txt",
    "--target-kind",
    "file",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
  );

  repository.git("mv", "implementation.txt", "renamed.txt");
  repository.git("commit", "-m", "Rename implementation file");
  recordStageHead(repository, "implementation", repository.git("rev-parse", "HEAD"));
  assert.deepEqual(repository.artifact.stage("implementation").change.files, [{
    path: "renamed.txt",
    kind: "renamed",
    previousPath: "implementation.txt",
  }]);

  const pending = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  )[0].threads[0];
  assert.equal(pending.stale, false);
  assert.equal(pending.reanchored, true);
  assert.equal(pending.target.path, "renamed.txt");
  assert.equal(pending.target.label, "renamed.txt");
});

test("file anchors stay stale when the file leaves the stage", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "moved-file",
    "--comment-id",
    "moved-file-note",
    "--body",
    "Move this work elsewhere.",
    "--label",
    "implementation.txt",
    "--target-kind",
    "file",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
  );

  // The revised stage no longer changes implementation.txt.
  repository.git("rm", "--quiet", "implementation.txt");
  recordStageHead(repository, "implementation", repository.commitFile(
    "other.txt",
    "other change\n",
    "Move work out of stage",
  ));
  assert.deepEqual(repository.artifact.stage("implementation").change.files, [{ path: "other.txt", kind: "added" }]);

  const pending = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  )[0].threads[0];
  assert.equal(pending.stale, true);
  assert.equal("reanchored" in pending, false);
  repository.feedback("validate");
});

test("deleted file anchors refresh while the deletion remains in the stage", (t) => {
  const repository = createRepository(t);
  repository.commitFile("removed.txt", "remove me\n", "Add removable file");
  initializeImplementation(repository);
  beginStage(repository);
  repository.git("rm", "removed.txt");
  repository.git("commit", "-m", "Delete file");
  organizeStage(repository);
  repository.semantic("stage", "finish", "--id", "implementation");
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "deleted-file",
    "--comment-id",
    "deleted-file-note",
    "--body",
    "Keep this deletion intentional.",
    "--label",
    "removed.txt",
    "--target-kind",
    "file",
    "--stage",
    "implementation",
    "--path",
    "removed.txt",
  );

  recordStageHead(repository, "implementation", repository.commitFile(
    "other.txt",
    "other change\n",
    "Extend deletion stage",
  ));
  assert.deepEqual(
    repository.artifact.stage("implementation").change.files,
    [{ path: "other.txt", kind: "added" }, { path: "removed.txt", kind: "deleted" }],
  );

  const pending = JSON.parse(
    repository.feedback("next", "--json", "--compact"),
  )[0].threads[0];
  assert.equal(pending.stale, false);
  assert.equal(pending.reanchored, true);
  assert.equal(pending.target.path, "removed.txt");
});

test("feedback validation sees every stored property, including __proto__", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "proto-key");
  const file = repository.feedbackPath("threads", "proto-key.json");
  const text = JSON.stringify(repository.readAbsoluteJson(file));
  repository.writeAbsolute(file, `{"__proto__":null,${text.slice(1)}`);

  repository.expectFeedbackFailure("must NOT have additional properties", "validate");
});
