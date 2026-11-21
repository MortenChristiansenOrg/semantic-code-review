import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  finalizeStage,
  flowCli,
  initializeImplementation,
  semanticCli,
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
    artifact: repository.artifact.read("manifest.json"),
    stages: repository.artifact.readJson("manifest.json").stages.map(({ id }) =>
      repository.artifact.read(`stages/${id}.json`),
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
  const lineBefore = repository.readAbsoluteJson(repository.feedbackPath("threads/pending-line.json"));
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
  // The restack gave the stage a new head without changing the line.
  const lineThread = result.stages[0].threads.find((thread) => thread.id === "pending-line");
  assert.equal(lineThread.stale, false);
  assert.equal(lineThread.currentLine, 1);
  assert.deepEqual(repository.readAbsoluteJson(repository.feedbackPath("threads/pending-line.json")), lineBefore);
  const thread = repository.readAbsoluteJson(repository.feedbackPath("threads/pending.json"));
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.status, "open");
  repository.semantic("validate", "--publish");

  const after = snapshot(repository);
  const repeated = JSON.parse(repository.flow("sync", "--json"));
  assert.equal(repeated.targetRestack, null);
  assert.deepEqual(snapshot(repository), after);
});

test("sync refuses to restack onto a target that moved after it was verified", (t) => {
  const { repository } = createImplementationWithStages(t, ["foundation", "behavior"]);
  const upstream = addUpstream(t, repository);
  const target = upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  const stageBranch = repository.git("branch", "--show-current");
  const stageHead = repository.git("rev-parse", "HEAD");
  // Detaching the checked-out stage branch runs post-checkout after sync
  // verified the target; the hook moves the target once and removes itself.
  const hook = fixtureHook(repository, "post-checkout",
    `#!/bin/sh\nrm -f "$0"\nmoved=$(git commit-tree "refs/heads/main^{tree}" -p refs/heads/main -m Moved) && git update-ref refs/heads/main "$moved"\n`);

  expectSyncFailure(repository, /must equal target branch main head/);
  assert.equal(fs.existsSync(hook), false);
  const moved = repository.git("rev-parse", "main");
  assert.equal(repository.git("rev-parse", "main^"), target);
  assert.notEqual(moved, target);
  // No stage was restacked onto the moved target, and the checkout is back on its branch.
  assert.equal(repository.git("branch", "--show-current"), stageBranch);
  assert.equal(repository.git("rev-parse", "HEAD"), stageHead);
  assert.equal(repository.result("git", ["merge-base", "--is-ancestor", moved, stageHead]).status, 1);
});

test("sync --local restacks a stage whose patch exceeds the default 1 MiB subprocess buffer", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "large" });
  // Random base64 lines do not compress, so the stage patch is about 2.7 MB.
  const contents = `${randomBytes(2 * 1024 * 1024).toString("base64").match(/.{1,76}/g).join("\n")}\n`;
  finalizeStage(repository, { id: "large", file: "large.txt", contents });
  const stage = repository.artifact.stage("large");
  const patch = spawnSync("git", ["diff", "--binary", "--full-index", stage.change.baseRevision, stage.change.headRevision], {
    cwd: repository.root, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(patch.status, 0);
  assert.ok(patch.stdout.length > 2 * 1024 * 1024, "The fixture patch must exceed the default buffer");

  const branch = repository.git("branch", "--show-current");
  repository.git("switch", "main");
  const target = repository.commitFile("trunk.txt", "local\n", "Advance local target");
  repository.git("switch", branch);
  const result = JSON.parse(repository.flow("sync", "--local", "--json"));
  assert.equal(result.targetRevision, target);
  assert.equal(result.targetRestack.rewrittenBranches, 1);
  assert.equal(repository.read("large.txt"), contents);
  assert.equal(repository.read("trunk.txt"), "local\n");
  repository.semantic("validate");
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
  // The recorded base has the target's tree but is not an ancestor of the
  // first stage head, so only the range check can tell.
  const unrelated = repository.git("commit-tree", "main^{tree}", "-m", "Unrelated base");
  const manifest = repository.artifact.readJson("manifest.json");
  repository.artifact.write("manifest.json", { ...manifest, baseRevision: unrelated });
  const before = snapshot(repository);
  const remoteBefore = repository.git("rev-parse", "upstream/main");
  expectSyncFailure(repository, /Stage foundation head [0-9a-f]{40} must descend from/);
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
      const branch = problem === "dirty target" ? "main" : repository.artifact.stage("foundation").change.branch;
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

test("sync conflict recovery continues the pending restack before re-entering preflight", (t) => {
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
  const stage = repository.artifact.stage("behavior");
  const selection = repository.git("rev-parse", "--path-format=absolute", "--git-path", "semantic-review-implementation");
  fs.rmSync(selection, { force: true });

  const failure = expectSyncFailure(repository, /stopped at a conflict in shared\.txt/);
  assert.match(failure.stderr, /resolve it in the reported worktree and run semantic-flow\.mjs implementation restack --continue/);
  assert.equal(repository.git("rev-parse", "main"), target);
  assert.equal(repository.artifact.read("manifest.json"), before.artifact);
  assert.deepEqual(snapshot(repository).stages, before.stages);
  // The stage branch stays detached, so restack --continue can move it.
  assert.match(failure.stderr, new RegExp(`stays detached until then, so the restack can move ${before.branch}`));
  assert.equal(repository.git("branch", "--show-current"), "");
  assert.equal(repository.git("rev-parse", "HEAD"), before.head);
  assert.equal(repository.git("status", "--porcelain"), "");
  // Detached, the worktree still names the implementation restack --continue completes.
  assert.equal(fs.readFileSync(selection, "utf8").trim(), "test-implementation");

  const worktree = /Resolve the conflict in (.+?): edit the files/.exec(failure.stderr)?.[1];
  assert.ok(worktree, failure.stderr);
  fs.writeFileSync(path.join(worktree, "shared.txt"), "upstream and stage\n");
  assert.equal(spawnSync("git", ["add", "shared.txt"], { cwd: worktree }).status, 0);
  expectSyncFailure(repository, /restack stopped at a conflict in stage behavior/, "--local");
  // Completing the restack switches the worktree back to the stage branch sync detached.
  const continued = repository.result(process.execPath, [...semanticCli, "restack", "--continue", "--json"]);
  assert.equal(continued.status, 0, continued.stderr);
  // The note goes to stderr, so the JSON summary stays parseable.
  assert.ok(JSON.parse(continued.stdout).stages.length > 0);
  assert.match(continued.stderr, new RegExp(`back to ${before.branch}\\.`));
  assert.equal(repository.git("branch", "--show-current"), before.branch);
  assert.equal(repository.git("status", "--porcelain"), "");
  const result = JSON.parse(repository.flow("sync", "--local", "--json"));
  assert.equal(result.targetRevision, target);
  assert.equal(repository.read("shared.txt"), "upstream and stage\n");
  assert.equal(repository.read("later.txt"), "later\n");
  repository.semantic("validate", "--publish");
  assert.equal(stage.change.branch, "semantic-flow/test-implementation/stages/behavior");
});

test("restack --abort after a sync conflict switches the worktree back to the stage branch sync detached", (t) => {
  const repository = createRepository(t);
  repository.commitFile("shared.txt", "base\n", "Base shared file");
  initializeImplementation(repository);
  beginStage(repository, { id: "behavior" });
  finalizeStage(repository, { id: "behavior", file: "shared.txt", contents: "stage\n" });
  const upstream = addUpstream(t, repository);
  upstream.commitFile("shared.txt", "upstream\n", "Conflicting upstream");
  const branch = repository.git("branch", "--show-current");
  const head = repository.git("rev-parse", "HEAD");

  expectSyncFailure(repository, /stopped at a conflict in shared\.txt/);
  assert.equal(repository.git("branch", "--show-current"), "");
  const restored = repository.result(process.execPath, [...semanticCli, "restack", "--abort"]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Discarded the restack/);
  assert.match(restored.stderr, new RegExp(`back to ${branch}\\.`));
  assert.equal(repository.git("branch", "--show-current"), branch);
  assert.equal(repository.git("rev-parse", "HEAD"), head);
  assert.equal(repository.git("status", "--porcelain"), "");

  // A worktree that no longer sits where sync left it is not switched.
  expectSyncFailure(repository, /stopped at a conflict in shared\.txt/);
  repository.git("switch", "main");
  const aborted = repository.result(process.execPath, [...semanticCli, "restack", "--abort"]);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.match(aborted.stderr, new RegExp(`was left as it is, because it is no longer detached at ${head}; check out ${branch} there`));
  assert.equal(repository.git("branch", "--show-current"), "main");

  // A branch renamed meanwhile leaves the worktree detached with a warning; the restack is still discarded.
  repository.git("switch", branch);
  expectSyncFailure(repository, /stopped at a conflict in shared\.txt/);
  repository.git("branch", "-m", branch, `${branch}-renamed`);
  const renamed = repository.result(process.execPath, [...semanticCli, "restack", "--abort"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.match(renamed.stderr, new RegExp(`because ${branch} no longer exists`));
  assert.equal(repository.git("branch", "--show-current"), "");
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
});

test("a sync conflict from a detached stage checkout remembers the implementation to continue", (t) => {
  const repository = createRepository(t);
  repository.commitFile("shared.txt", "base\n", "Base shared file");
  initializeImplementation(repository);
  beginStage(repository, { id: "behavior" });
  finalizeStage(repository, { id: "behavior", file: "shared.txt", contents: "stage\n" });
  addUpstream(t, repository).commitFile("shared.txt", "upstream\n", "Conflicting upstream");
  repository.git("switch", "--detach");
  const selection = repository.git("rev-parse", "--path-format=absolute", "--git-path", "semantic-review-implementation");
  fs.rmSync(selection, { force: true });

  expectSyncFailure(repository, /stopped at a conflict in shared\.txt/);
  assert.equal(fs.readFileSync(selection, "utf8").trim(), "test-implementation");
});

test("refresh-target fast-forwards a target before new work and keeps local-only states", (t) => {
  const repository = createRepository(t, "semantic-refresh-");
  const refresh = (...args) => JSON.parse(repository.flow("refresh-target", "--json", "--target-branch", "main", ...args));
  const initial = repository.git("rev-parse", "main");
  assert.deepEqual(refresh(), { targetBranch: "main", previousRevision: initial, revision: initial, upstream: null, ahead: false });

  const upstream = addUpstream(t, repository);
  const advanced = upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  const checkedOut = refresh();
  assert.deepEqual(checkedOut, { targetBranch: "main", previousRevision: initial, revision: advanced, ahead: false,
    upstream: { remote: "upstream", branch: "refs/heads/main", revision: advanced } });
  assert.equal(repository.read("trunk.txt"), "new upstream\n");
  assert.equal(repository.git("status", "--porcelain=v1", "--untracked-files=all"), "");

  // A target checked out nowhere moves by ref; one checked out dirty is never moved.
  const next = upstream.commitFile("trunk.txt", "newer upstream\n", "Advance again");
  repository.git("switch", "-c", "elsewhere");
  assert.equal(refresh().revision, next);
  assert.equal(repository.git("rev-parse", "main"), next);
  repository.git("switch", "main");
  const dirty = upstream.commitFile("trunk.txt", "newest upstream\n", "Advance once more");
  repository.write("README.md", "Local edit\n");
  const failed = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /requires a clean worktree/);
  assert.equal(repository.git("rev-parse", "main"), next);
  repository.git("checkout", "--", "README.md");
  assert.equal(refresh().revision, dirty);

  const local = repository.commitFile("local.txt", "local\n", "Local work");
  assert.deepEqual(refresh(), { targetBranch: "main", previousRevision: local, revision: local, ahead: true,
    upstream: { remote: "upstream", branch: "refs/heads/main", revision: dirty } });
  upstream.commitFile("other.txt", "other\n", "Diverge");
  const diverged = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(diverged.status, 0);
  assert.match(diverged.stderr, /diverged\. No refs were changed/);
  assert.equal(repository.git("rev-parse", "main"), local);
});

/** A hooks directory of the fixture's own, so no test writes to a hook Git would otherwise run. */
function fixtureHook(repository, name, script) {
  const hooks = path.join(path.resolve(repository.root, repository.git("rev-parse", "--git-common-dir")), "fixture-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  repository.git("config", "core.hooksPath", hooks);
  const hook = path.join(hooks, name);
  fs.writeFileSync(hook, script, { mode: 0o755 });
  return hook;
}

test("refresh-target refuses a target that is a symbolic ref to another branch", (t) => {
  const repository = createRepository(t, "semantic-refresh-symbolic-");
  const upstream = addUpstream(t, repository);
  const initial = repository.git("rev-parse", "main");
  repository.git("switch", "-c", "trunk");
  repository.git("symbolic-ref", "refs/heads/main", "refs/heads/trunk");
  upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  const result = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refs\/heads\/main is a symbolic ref to refs\/heads\/trunk/);
  assert.equal(repository.git("rev-parse", "trunk"), initial);
  assert.equal(repository.git("status", "--porcelain=v1", "--untracked-files=all"), "");
});

test("refresh-target reports a fast-forward it could not undo", (t) => {
  const repository = createRepository(t, "semantic-refresh-undo-");
  const upstream = addUpstream(t, repository);
  const initial = repository.git("rev-parse", "main");
  const advanced = upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  // Once main moves, an untracked file blocks the checkout's update and the
  // move back is refused, as when another Git process holds the ref.
  fixtureHook(repository, "reference-transaction", `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then
    if [ "$1" = committed ] && [ "$new" = ${advanced} ]; then echo blocker > "${repository.root}/trunk.txt"; fi
    if [ "$1" = prepared ] && [ "$new" = ${initial} ]; then exit 1; fi
  fi
done
exit 0
`);
  const result = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Could not update the files of .*; refs/heads/main could not be moved back from ${advanced} to ${initial}\\.`));
  assert.equal(repository.git("rev-parse", "main"), advanced);
});

test("refresh-target never lets the fetch or the upstream configuration move other refs", (t) => {
  const repository = createRepository(t, "semantic-refresh-refs-");
  const upstream = addUpstream(t, repository);
  const local = repository.commitFile("local.txt", "local\n", "Local work");
  upstream.commitFile("other.txt", "other\n", "Diverge");
  repository.git("switch", "-c", "elsewhere");
  // A mirror-style refspec would force the target to the upstream during a plain fetch.
  repository.git("config", "remote.upstream.fetch", "+refs/heads/*:refs/heads/*");
  const diverged = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(diverged.status, 0);
  assert.match(diverged.stderr, /diverged\. No refs were changed/);
  assert.equal(repository.git("rev-parse", "main"), local);
  assert.equal(repository.git("for-each-ref", "refs/semantic-flow/"), "");

  repository.git("config", "branch.main.merge", "refs/heads/main:refs/heads/unrelated");
  const injected = repository.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main"]);
  assert.notEqual(injected.status, 0);
  assert.match(injected.stderr, /needs exactly one configured upstream branch/);
  assert.equal(repository.git("for-each-ref", "refs/heads/unrelated"), "");
});

test("refresh-target ignores the entry of a bare repository with linked checkouts", (t) => {
  const seed = createRepository(t, "semantic-refresh-seed-");
  const upstream = createRepository(t, "semantic-refresh-bare-upstream-");
  upstream.git("fetch", seed.root, "main");
  upstream.git("reset", "--hard", "FETCH_HEAD");
  const bare = `${seed.root}-bare.git`, checkout = `${seed.root}-checkout`;
  t.after(() => { fs.rmSync(bare, { recursive: true, force: true }); fs.rmSync(checkout, { recursive: true, force: true }); });
  seed.git("clone", "--bare", seed.root, bare);
  seed.git("-C", bare, "worktree", "add", checkout, "main");
  seed.git("-C", bare, "config", "branch.main.remote", upstream.root);
  seed.git("-C", bare, "config", "branch.main.merge", "refs/heads/main");
  const advanced = upstream.commitFile("trunk.txt", "new upstream\n", "Advance upstream");
  const result = JSON.parse(seed.result(process.execPath, [flowCli, "refresh-target", "--json", "--target-branch", "main", "--project", checkout]).stdout);
  assert.equal(result.revision, advanced);
  assert.equal(fs.readFileSync(`${checkout}/trunk.txt`, "utf8"), "new upstream\n");
});
