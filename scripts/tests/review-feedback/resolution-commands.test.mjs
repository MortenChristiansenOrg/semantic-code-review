import assert from "node:assert/strict";
import fs from "node:fs";
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
import { createViewerDataSource } from "../../src/semantic-view.ts";

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

test("a line thread stays on its line until the line changes, for the agent and the viewer alike", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { contents: "a\nb\nc\nd\n" });
  repository.feedback("init");
  const addLineThread = (id, line) => repository.feedback(
    "thread", "add", "--id", id, "--comment-id", `${id}-note`, "--body", `About line ${line}.`,
    "--label", `implementation.txt:${line}`, "--target-kind", "line", "--stage", "implementation",
    "--path", "implementation.txt", "--side", "new", "--line", String(line),
  );
  addLineThread("on-b", 2);
  addLineThread("on-d", 4);
  const agentView = () => Object.fromEntries(JSON.parse(repository.feedback("next", "--json", "--compact"))
    .flatMap((group) => group.threads).map(({ id, stale, currentLine }) => [id, { stale, currentLine }]));
  const reviewerView = () => Object.fromEntries(createViewerDataSource(repository.root).implementationData().feedback
    .map(({ id, anchorStale, currentLine }) => [id, { stale: anchorStale, currentLine: currentLine ?? undefined }]));
  const head = () => repository.artifact.stage("implementation").change.headRevision;

  // A fold that leaves the file as it was gives the stage a new head only.
  const written = head();
  repository.commitFile("notes.txt", "unrelated\n", "Add notes");
  repository.semantic("restack", "--from", "implementation");
  assert.notEqual(head(), written);
  const unchanged = { "on-b": { stale: false, currentLine: 2 }, "on-d": { stale: false, currentLine: 4 } };
  assert.deepEqual(agentView(), unchanged);
  assert.deepEqual(reviewerView(), unchanged);

  // Lines added above move "d"; "b" itself changes.
  repository.commitFile("implementation.txt", "x\ny\na\nB\nc\nd\n", "Move and change lines");
  repository.semantic("restack", "--from", "implementation");
  const moved = { "on-b": { stale: true, currentLine: undefined }, "on-d": { stale: false, currentLine: 6 } };
  assert.deepEqual(agentView(), moved);
  assert.deepEqual(reviewerView(), moved);
  // The stored anchors are not moved.
  const stored = repository.readAbsoluteJson(repository.feedbackPath("threads/on-d.json"));
  assert.equal(stored.target.line, 4);
  assert.equal(stored.target.stageHead, written);
});

/** A stage that renames old.txt to new.txt and changes its second line. */
function renamingStage(t) {
  const repository = createRepository(t);
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`);
  repository.commitFile("old.txt", lines.join(""), "Add file");
  initializeImplementation(repository);
  beginStage(repository);
  repository.git("mv", "old.txt", "new.txt");
  repository.commitFile("new.txt", lines.map((line, index) => index === 1 ? "line two\n" : line).join(""), "Rename and change file");
  organizeStage(repository);
  repository.semantic("stage", "finish", "--id", "implementation");
  assert.deepEqual(repository.artifact.stage("implementation").change.files, [{ path: "new.txt", kind: "renamed", previousPath: "old.txt" }]);
  repository.feedback("init");
  return repository;
}

const addRenamedLineThread = (repository, id, filePath, side = "old") => repository.feedback(
  "thread", "add", "--id", id, "--comment-id", `${id}-note`, "--body", "About the removed line.",
  "--label", `${filePath}:2`, "--target-kind", "line", "--stage", "implementation",
  "--path", filePath, "--side", side, "--line", "2",
);

/** Each thread's stale state and current line, for the agent and the viewer. */
function lineViews(repository) {
  const agent = Object.fromEntries(JSON.parse(repository.feedback("next", "--json", "--compact"))
    .flatMap((group) => group.threads).map(({ id, stale, currentLine, target }) => [id, { stale, currentLine, path: target.path }]));
  const reviewer = Object.fromEntries(createViewerDataSource(repository.root).implementationData().feedback
    .map(({ id, anchorStale, currentLine, target }) => [id, { stale: anchorStale, currentLine: currentLine ?? undefined, path: target.path }]));
  return { agent, reviewer };
}

test("a removed line of a renamed file is named by the file's path in the stage", (t) => {
  const repository = renamingStage(t);
  addRenamedLineThread(repository, "removed-line", "new.txt");
  assert.equal(repository.readAbsoluteJson(repository.feedbackPath("threads/removed-line.json")).target.path, "new.txt");
  repository.expectFeedbackFailure(
    "Feedback line target old.txt is the previous path of new.txt, which stage implementation renames. Name a line of a renamed file by its path in the stage, new.txt",
    "thread", "add", "--id", "by-old-path", "--comment-id", "by-old-path-note", "--body", "Old path.",
    "--label", "old.txt:2", "--target-kind", "line", "--stage", "implementation",
    "--path", "old.txt", "--side", "old", "--line", "2",
  );
  repository.expectFeedbackFailure(
    "exceeds new.txt's 10 line(s) on the old side",
    "thread", "add", "--id", "past-end", "--comment-id", "past-end-note", "--body", "Past the end.",
    "--label", "new.txt:11", "--target-kind", "line", "--stage", "implementation",
    "--path", "new.txt", "--side", "old", "--line", "11",
  );

  // The thread is on its line while the stage head is the anchored one.
  const current = { stale: false, currentLine: 2, path: "new.txt" };
  assert.deepEqual(lineViews(repository), { agent: { "removed-line": current }, reviewer: { "removed-line": current } });
});

test("a removed line of a renamed file stays on its line after a fold, for the agent and the viewer alike", (t) => {
  const repository = renamingStage(t);
  addRenamedLineThread(repository, "removed-line", "new.txt");
  const head = () => repository.artifact.stage("implementation").change.headRevision;
  const written = head();

  // A fold that leaves the file as it was gives the stage a new head only.
  repository.commitFile("notes.txt", "unrelated\n", "Add notes");
  repository.semantic("restack", "--from", "implementation");
  assert.notEqual(head(), written);
  const current = { stale: false, currentLine: 2, path: "new.txt" };
  assert.deepEqual(lineViews(repository), { agent: { "removed-line": current }, reviewer: { "removed-line": current } });

  // A correction keeps the line, so the stage no longer removes it.
  repository.commitFile("new.txt", Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join("") + "line 11\n", "Keep the second line");
  repository.semantic("restack", "--from", "implementation");
  const stale = { stale: true, currentLine: undefined, path: "new.txt" };
  assert.deepEqual(lineViews(repository), { agent: { "removed-line": stale }, reviewer: { "removed-line": stale } });
});

/** Adds a thread on the removed second line as earlier versions stored it: by the file's previous path. */
function addStoredEarlier(repository, filePath, previousPath) {
  addRenamedLineThread(repository, "stored-earlier", filePath);
  const file = repository.feedbackPath("threads/stored-earlier.json");
  const stored = repository.readAbsoluteJson(file);
  stored.target.path = previousPath;
  repository.writeAbsolute(file, `${JSON.stringify(stored, null, 2)}\n`);
  repository.feedback("validate");
  return file;
}

test("a removed line stored by the previous path of a renamed file is read by the file's path", (t) => {
  const repository = renamingStage(t);
  const file = addStoredEarlier(repository, "new.txt", "old.txt");

  const current = { stale: false, currentLine: 2, path: "new.txt" };
  assert.deepEqual(lineViews(repository), { agent: { "stored-earlier": current }, reviewer: { "stored-earlier": current } });
  // The next write of the thread stores the file's path.
  repository.feedback("thread", "reply", "--id", "stored-earlier", "--comment-id", "stored-earlier-reply", "--body", "Noted.", "--author", "agent");
  assert.equal(repository.readAbsoluteJson(file).target.path, "new.txt");
});

test("a file renamed onto a path an earlier stage deleted keeps its rename for the agent and the viewer", (t) => {
  const repository = createRepository(t);
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`);
  repository.commitFile("old.txt", lines.join(""), "Add file");
  repository.commitFile("new.txt", "an unrelated file\n", "Add another file");
  initializeImplementation(repository);
  beginStage(repository, { id: "removal" });
  repository.git("rm", "--quiet", "new.txt");
  repository.git("commit", "-m", "Remove file");
  organizeStage(repository, { id: "removal" });
  repository.semantic("stage", "finish", "--id", "removal");
  beginStage(repository, { dependencies: ["removal"] });
  repository.git("mv", "old.txt", "new.txt");
  repository.commitFile("new.txt", lines.map((line, index) => index === 1 ? "line two\n" : line).join(""), "Rename and change file");
  organizeStage(repository);
  repository.semantic("stage", "finish", "--id", "implementation");
  repository.feedback("init");
  const shown = createViewerDataSource(repository.root).implementationData().stages.find((stage) => stage.id === "implementation").files;
  assert.deepEqual(shown.map(({ path, previousPath }) => ({ path, previousPath })), [{ path: "new.txt", previousPath: "old.txt" }]);

  addStoredEarlier(repository, "new.txt", "old.txt");
  const current = { stale: false, currentLine: 2, path: "new.txt" };
  assert.deepEqual(lineViews(repository), { agent: { "stored-earlier": current }, reviewer: { "stored-earlier": current } });
});

test("a stage that renames a file and adds one at its old path changes the file at that path", (t) => {
  const repository = createRepository(t);
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`);
  repository.commitFile("a.txt", lines.join(""), "Add file");
  initializeImplementation(repository);
  beginStage(repository);
  repository.git("mv", "a.txt", "b.txt");
  repository.commitFile("a.txt", "a new file\nat the old path\n", "Rename and replace file");
  organizeStage(repository);
  repository.semantic("stage", "finish", "--id", "implementation");
  // Git reports a.txt as changed in place and b.txt as added, so a.txt names
  // one file on both sides.
  assert.deepEqual(repository.artifact.stage("implementation").change.files, [
    { path: "a.txt", kind: "modified" },
    { path: "b.txt", kind: "added" },
  ]);
  repository.feedback("init");
  addRenamedLineThread(repository, "a-old", "a.txt", "old");
  addRenamedLineThread(repository, "a-new", "a.txt", "new");
  addRenamedLineThread(repository, "b-new", "b.txt", "new");
  repository.expectFeedbackFailure(
    "Feedback old line target b.txt does not exist on that diff side.",
    "thread", "add", "--id", "b-old", "--comment-id", "b-old-note", "--body", "Old side of b.",
    "--label", "b.txt:2", "--target-kind", "line", "--stage", "implementation",
    "--path", "b.txt", "--side", "old", "--line", "2",
  );
});

test("threads of a removed stage stay valid and read-only", (t) => {
  const { repository, commits } = createImplementationWithStages(t, ["policy", "api"]);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "on-policy", "--comment-id", "on-policy-1", "--body", "Why policy?",
    "--label", "Policy", "--target-kind", "stage", "--stage", "policy");
  repository.feedback("thread", "add", "--id", "api-in-policy", "--comment-id", "api-in-policy-1", "--body", "Change api in policy.",
    "--label", "API", "--target-kind", "node", "--stage", "api", "--node", "implementation-change", "--assigned-stage", "policy");
  repository.feedback("thread", "add", "--id", "on-api", "--comment-id", "on-api-1", "--body", "Check api.",
    "--label", "API", "--target-kind", "stage", "--stage", "api");
  repository.feedback("thread", "resolve", "--id", "on-policy");
  repository.feedback("thread", "resolve", "--id", "api-in-policy");
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", commits.get("policy"));
  repository.semantic("restack", "--base", "main");
  repository.semantic("stage", "remove", "--id", "policy");
  // A resolved thread on a removed stage keeps its target and assignment, and a target on a remaining stage is still checked.
  assert.match(repository.feedback("validate"), /Feedback validation passed: 3 thread\(s\)\./);

  const threadFile = (id) => repository.feedbackPath("threads", `${id}.json`);
  const stored = () => ["on-policy", "api-in-policy", "on-api"].map((id) => fs.readFileSync(threadFile(id), "utf8"));
  const before = stored();
  const readOnly = /stage policy was removed, so its threads are read-only/;
  for (const id of ["on-policy", "api-in-policy"]) {
    repository.expectFeedbackFailure(readOnly, "thread", "reply", "--id", id, "--comment-id", `${id}-2`, "--body", "More.");
    repository.expectFeedbackFailure(readOnly, "thread", "reopen", "--id", id);
  }
  // A batch with one such reply writes nothing.
  repository.expectFeedbackFailure(readOnly, "thread", "reply-batch", "--replies", JSON.stringify([
    { id: "on-api", "comment-id": "on-api-2", body: "Done.", author: "agent" },
    { id: "on-policy", "comment-id": "on-policy-2", body: "Done.", author: "agent" },
  ]));
  assert.deepEqual(stored(), before);
  const partial = JSON.parse(repository.feedback("thread", "reply-batch", "--partial", "--replies", JSON.stringify([
    { id: "on-policy", "comment-id": "on-policy-2", body: "Done.", author: "agent" },
    { id: "on-api", "comment-id": "on-api-2", body: "Done.", author: "agent" },
  ])));
  assert.deepEqual(partial.accepted.map(({ id }) => id), ["on-api"]);
  assert.deepEqual(partial.rejected.map(({ index }) => index), [0]);
  assert.match(partial.rejected[0].error, readOnly);
  assert.deepEqual(stored().slice(0, 2), before.slice(0, 2));
  // No new thread can be put on it.
  repository.expectFeedbackFailure("policy", "thread", "add", "--id", "late", "--comment-id", "late-1", "--body", "Late.",
    "--label", "Policy", "--target-kind", "stage", "--stage", "policy");
  repository.expectFeedbackFailure("valid assigned stage", "thread", "add", "--id", "late", "--comment-id", "late-1", "--body", "Late.",
    "--label", "API", "--target-kind", "stage", "--stage", "api", "--assigned-stage", "policy");
  // Only a resolved thread may stay on a removed stage.
  const open = JSON.parse(before[0]);
  delete open.resolvedAt;
  open.status = "open";
  fs.writeFileSync(threadFile("on-policy"), JSON.stringify(open));
  repository.expectFeedbackFailure("Feedback thread on-policy is open on removed stage policy", "validate");
  fs.writeFileSync(threadFile("on-policy"), before[0]);
  repository.feedback("validate");
});
