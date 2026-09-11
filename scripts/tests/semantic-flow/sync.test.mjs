import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  finalizeStage,
  flowCli,
  initializeImplementation,
} from "../helpers/repository.mjs";

function addUpstream(t, repository) {
  const upstream = createRepository(t, "semantic-sync-upstream-");
  upstream.git("fetch", repository.root, "main");
  upstream.git("reset", "--hard", "FETCH_HEAD");
  repository.git("remote", "add", "upstream", upstream.root);
  repository.git("config", "branch.main.remote", "upstream");
  repository.git("config", "branch.main.merge", "refs/heads/main");
  repository.git("fetch", "upstream");
  return upstream;
}

function snapshot(repository) {
  return {
    refs: repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"),
    artifact: repository.read(".semantic-review/manifest.json"),
    stages: repository.readJson(".semantic-review/manifest.json").stages.map((id) =>
      repository.read(`.semantic-review/stages/${id}.json`),
    ),
    head: repository.git("rev-parse", "HEAD"),
    branch: repository.git("branch", "--show-current"),
  };
}

function expectSyncFailure(repository, pattern, ...args) {
  const result = repository.result(process.execPath, [flowCli, "sync", "--json", ...args]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  return result;
}

test("sync fetches the target upstream, restacks all stages, and refreshes feedback without replying", (t) => {
  const { repository } = createImplementationWithStages(t, ["foundation", "behavior"]);
  const upstream = addUpstream(t, repository);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "pending", "--comment-id", "note",
    "--body", "Review behavior", "--label", "Behavior", "--target-kind", "stage", "--stage", "behavior");
  repository.feedback("thread", "add", "--id", "pending-line", "--comment-id", "line-note",
    "--body", "Review this line", "--label", "Behavior line", "--target-kind", "line", "--stage", "behavior",
    "--path", "behavior.txt", "--side", "new", "--line", "1");
  const lineBefore = repository.readJson(repository.feedbackPath("threads/pending-line.json"));
  const before = snapshot(repository);
  const target = upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  assert.notEqual(repository.git("rev-parse", "upstream/main"), target);

  const result = JSON.parse(repository.flow("sync", "--json"));
  assert.equal(result.targetRevision, target);
  assert.equal(result.upstream.remote, "upstream");
  assert.equal(result.upstream.revision, target);
  assert.equal(repository.git("rev-parse", "main"), target);
  assert.equal(repository.git("rev-parse", "upstream/main"), target);
  assert.equal(result.targetRestack.rewrittenBranches, 2);
  assert.equal(result.currentBranch, before.branch);
  assert.equal(repository.read("trunk.txt"), "new upstream\n");
  assert.equal(repository.read("foundation.txt"), "foundation\n");
  assert.equal(repository.read("behavior.txt"), "behavior\n");
  const stageThread = result.stages[0].threads.find((thread) => thread.id === "pending");
  assert.equal(stageThread.reanchored, true);
  assert.equal(stageThread.stale, false);
  assert.equal(result.stages[0].threads.find((thread) => thread.id === "pending-line").stale, true);
  assert.deepEqual(repository.readJson(repository.feedbackPath("threads/pending-line.json")), lineBefore);
  const thread = repository.readJson(repository.feedbackPath("threads/pending.json"));
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.status, "open");
  repository.semantic("validate", "--publish");

  const after = snapshot(repository);
  const repeated = JSON.parse(repository.flow("sync", "--json"));
  assert.equal(repeated.targetRestack, null);
  assert.deepEqual(snapshot(repository), after);
});

test("sync fast-forwards a target checked out in the operational worktree", (t) => {
  const { repository } = createImplementationWithStages(t);
  const upstream = addUpstream(t, repository);
  const target = upstream.commitFile("trunk.txt", "updated\n", "Advance upstream");
  const operational = repository.path("operational");
  repository.git("worktree", "add", operational, "main");
  // Ignore the nested test checkout; production worktrees are usually siblings.
  fs.appendFileSync(repository.path(".git/info/exclude"), "operational/\n");
  const result = JSON.parse(repository.run(process.execPath, [flowCli, "sync", "--project", operational, "--json"]));
  assert.equal(result.worktree, repository.root);
  assert.equal(result.targetRevision, target);
  assert.equal(repository.git("-C", operational, "rev-parse", "HEAD"), target);
  assert.equal(repository.git("-C", operational, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(`${operational}/trunk.txt`, "utf8"), "updated\n");
});

test("sync preserves a target checkout in the artifact worktree", (t) => {
  const { repository } = createImplementationWithStages(t);
  const upstream = addUpstream(t, repository);
  const target = upstream.commitFile("trunk.txt", "updated\n", "Advance upstream");
  repository.git("switch", "main");
  const result = JSON.parse(repository.flow("sync", "--json"));
  assert.equal(result.currentBranch, "main");
  assert.equal(repository.git("rev-parse", "HEAD"), target);
  repository.semantic("validate");
});

for (const at of ["stage", "base"]) {
  test(`sync --local advances an originally detached ${at} checkout`, (t) => {
    const { repository } = createImplementationWithStages(t);
    const original = at === "stage" ? repository.git("rev-parse", "HEAD") : repository.git("rev-parse", "main");
    repository.git("switch", "main");
    const target = repository.commitFile("trunk.txt", "local\n", "Advance local target");
    repository.git("switch", "--detach", original);
    const result = JSON.parse(repository.flow("sync", "--local", "--json"));
    assert.equal(result.upstream, null);
    assert.equal(result.currentBranch, null);
    assert.equal(repository.git("rev-parse", "HEAD"), at === "base" ? target : result.targetRestack.stages[0].nextHead);
    repository.semantic("validate");
  });
}

test("sync --local does not fetch a configured upstream", (t) => {
  const { repository } = createImplementationWithStages(t);
  const upstream = addUpstream(t, repository);
  const oldRemote = repository.git("rev-parse", "upstream/main");
  upstream.commitFile("trunk.txt", "remote\n", "Advance upstream");
  const before = snapshot(repository);
  const result = JSON.parse(repository.flow("sync", "--local", "--json"));
  assert.equal(result.upstream, null);
  assert.equal(result.targetRestack, null);
  assert.equal(repository.git("rev-parse", "upstream/main"), oldRemote);
  assert.deepEqual(snapshot(repository), before);
});

test("sync preserves local target commits ahead of upstream", (t) => {
  const { repository } = createImplementationWithStages(t);
  addUpstream(t, repository);
  const branch = repository.git("branch", "--show-current");
  repository.git("switch", "main");
  const target = repository.commitFile("local.txt", "local\n", "Local target commit");
  repository.git("switch", branch);
  const result = JSON.parse(repository.flow("sync", "--json"));
  assert.equal(result.targetRevision, target);
  assert.notEqual(result.upstream.revision, target);
  assert.equal(repository.read("local.txt"), "local\n");
  repository.semantic("validate");
});

test("sync rejects missing upstream configuration without changing the stack", (t) => {
  const { repository } = createImplementationWithStages(t);
  const before = snapshot(repository);
  expectSyncFailure(repository, /needs one configured upstream/);
  assert.deepEqual(snapshot(repository), before);
});

test("sync rejects target/upstream divergence without moving local refs", (t) => {
  const { repository } = createImplementationWithStages(t);
  const upstream = addUpstream(t, repository);
  upstream.commitFile("remote.txt", "remote\n", "Remote change");
  repository.git("switch", "main");
  repository.commitFile("local.txt", "local\n", "Local change");
  const before = snapshot(repository);
  expectSyncFailure(repository, /upstream.*diverged/);
  assert.deepEqual(snapshot(repository), before);
});

test("sync leaves local state unchanged when fetching fails", (t) => {
  const { repository } = createImplementationWithStages(t);
  addUpstream(t, repository);
  repository.git("remote", "set-url", "upstream", repository.path("missing-remote"));
  const before = snapshot(repository);
  expectSyncFailure(repository, /git fetch.*failed/);
  assert.deepEqual(snapshot(repository), before);
});

test("sync rejects a corrupt recorded base chain before fetching", (t) => {
  const { repository } = createImplementationWithStages(t, ["foundation", "behavior"]);
  const upstream = addUpstream(t, repository);
  upstream.commitFile("trunk.txt", "upstream\n", "Advance upstream");
  const stage = repository.readJson(".semantic-review/stages/behavior.json");
  stage.change.baseRevision = repository.git("rev-parse", "main");
  repository.write(".semantic-review/stages/behavior.json", JSON.stringify(stage));
  const before = snapshot(repository);
  const remoteBefore = repository.git("rev-parse", "upstream/main");
  expectSyncFailure(repository, /base revision.*should be/);
  assert.deepEqual(snapshot(repository), before);
  assert.equal(repository.git("rev-parse", "upstream/main"), remoteBefore);
});

for (const problem of ["dirty artifact", "unfinished stage", "edited stage", "dirty target", "occupied stage", "rewritten target"]) {
  test(`sync rejects ${problem} before advancing the target`, (t) => {
    const { repository } = createImplementationWithStages(t, ["foundation", "behavior"]);
    const upstream = addUpstream(t, repository);
    upstream.commitFile("trunk.txt", "remote\n", "Remote change");
    let expected;
    if (problem === "dirty artifact") {
      repository.write("unrelated.txt", "user work\n");
      expected = /clean worktree/;
    } else if (problem === "unfinished stage") {
      beginStage(repository, { id: "unfinished", dependencies: ["behavior"] });
      expected = /every stage finalized/;
    } else if (problem === "edited stage") {
      repository.commitFile("behavior.txt", "edited\n", "Unrecorded change");
      expected = /moved from/;
    } else if (problem === "rewritten target") {
      repository.git("switch", "--orphan", "replacement");
      repository.commitFile("replacement.txt", "different history\n", "Replace target history");
      repository.git("branch", "-f", "main", "HEAD");
      expected = /diverged from the recorded implementation base/;
    } else {
      const checkout = repository.path("other-worktree");
      const branch = problem === "dirty target" ? "main" : repository.readJson(".semantic-review/stages/foundation.json").change.branch;
      repository.git("worktree", "add", checkout, branch);
      fs.appendFileSync(repository.path(".git/info/exclude"), "other-worktree/\n");
      if (problem === "dirty target") fs.writeFileSync(`${checkout}/README.md`, "user work\n");
      expected = problem === "dirty target" ? /clean worktree/ : /is checked out in/;
    }
    const before = snapshot(repository);
    const remoteBefore = repository.git("rev-parse", "upstream/main");
    expectSyncFailure(repository, expected);
    assert.deepEqual(snapshot(repository), before);
    assert.equal(repository.git("rev-parse", "upstream/main"), remoteBefore);
  });
}

test("sync detects an implementation landed upstream before moving the local target", (t) => {
  const { repository } = createImplementationWithStages(t);
  const upstream = addUpstream(t, repository);
  upstream.git("fetch", repository.root, repository.git("branch", "--show-current"));
  upstream.git("merge", "--ff-only", "FETCH_HEAD");
  const before = snapshot(repository);
  expectSyncFailure(repository, /already contains the final semantic stage/);
  assert.deepEqual(snapshot(repository), before);
});

test("sync conflict recovery resumes the underlying restack before re-entering preflight", (t) => {
  const repository = createRepository(t);
  repository.commitFile("shared.txt", "base\n", "Base shared file");
  initializeImplementation(repository);
  beginStage(repository, { id: "behavior" });
  finalizeStage(repository, { id: "behavior", file: "shared.txt", contents: "stage\n" });
  beginStage(repository, { id: "later", dependencies: ["behavior"] });
  finalizeStage(repository, { id: "later" });
  const upstream = addUpstream(t, repository);
  const target = upstream.commitFile("shared.txt", "upstream\n", "Conflicting upstream");
  const before = snapshot(repository);
  const stage = repository.readJson(".semantic-review/stages/behavior.json");

  const failure = expectSyncFailure(repository, /Conflict context: stage base/);
  assert.match(failure.stderr, /resume semantic-implementation.mjs restack --base main directly/);
  assert.equal(repository.git("rev-parse", "main"), target);
  assert.equal(repository.read(".semantic-review/manifest.json"), before.artifact);
  assert.deepEqual(snapshot(repository).stages, before.stages);
  assert.equal(repository.git("branch", "--show-current"), before.branch);
  assert.equal(repository.git("rev-parse", "HEAD"), before.head);
  assert.equal(repository.git("status", "--porcelain"), "");

  repository.git("branch", "sync-recovery", stage.change.headRevision);
  repository.git("switch", "-c", "sync-resolution", target);
  const resolved = repository.commitFile("shared.txt", "upstream and stage\n", "Resolve stage intent");
  repository.git("update-ref", `refs/heads/${stage.change.branch}`, resolved, stage.change.headRevision);
  expectSyncFailure(repository, /moved from/, "--local");
  repository.git("switch", "--detach");
  repository.git("branch", "-D", "sync-resolution");
  repository.semantic("restack", "--base", "main");
  repository.git("switch", before.branch);
  const result = JSON.parse(repository.flow("sync", "--local", "--json"));
  assert.equal(result.targetRevision, target);
  assert.equal(repository.read("shared.txt"), "upstream and stage\n");
  assert.equal(repository.read("later.txt"), "later\n");
  repository.semantic("validate", "--publish");
  repository.git("branch", "-D", "sync-recovery");
});
