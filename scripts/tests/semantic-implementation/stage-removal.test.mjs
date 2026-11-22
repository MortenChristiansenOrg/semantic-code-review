import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  finalizeStage,
  implementationFromScript,
  initializeImplementation,
  semanticCli,
} from "../helpers/repository.mjs";
import { createViewerDataSource } from "../../src/semantic-view.ts";
import { reviewFeedback } from "../../src/review-feedback.ts";
import { listActiveImplementations, readingActiveRefsOnce } from "../../src/shared/artifact-store.ts";
import { readReview, reviewHome, withReviewLock } from "../../src/shared/review-store.ts";

const branchOf = (id) => `semantic-flow/test-implementation/stages/${id}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** Everything about a commit but its parent: tree, authors, dates and message. */
function commitIdentity(repository, commit) {
  return repository.git("show", "-s", "--format=%T%n%an <%ae> %aI%n%cn <%ce> %cI%n%B", commit);
}

/** Stages a, x (on a), b (on a) and y (on x and b); the target then takes in
 * x's change, so restacking empties x. x keeps a decision and a captured
 * screenshot, and addresses a criterion no other stage does. */
function emptiedStack(t) {
  const repository = createRepository(t);
  initializeImplementation(repository, { criteria: [["works", "The implementation works."], ["documented", "It is documented."]] });
  beginStage(repository, { id: "a" });
  finalizeStage(repository, { id: "a" });
  beginStage(repository, { id: "x", dependencies: ["a"], specificationRefs: ["story#works", "story#documented"] });
  finalizeStage(repository, { id: "x" });
  beginStage(repository, { id: "b", dependencies: ["a"] });
  finalizeStage(repository, { id: "b" });
  beginStage(repository, { id: "y", dependencies: ["x", "b"] });
  finalizeStage(repository, { id: "y" });
  const x = repository.git("rev-parse", branchOf("x"));

  const captures = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-removal-"));
  t.after(() => fs.rmSync(captures, { recursive: true, force: true }));
  fs.writeFileSync(path.join(captures, "shot.png"), PNG);
  repository.git("switch", branchOf("x"));
  repository.semantic("stage", "record", "--stage", "x", "--finalized", "--kind", "decision", "--item-id", "keep-x",
    "--category", "engineering", "--summary", "Keep x apart.", "--rationale", "It is reviewed alone.", "--node-ref", "implementation-change");
  repository.semantic("stage", "evidence", "--stage", "x", "--finalized", "--item-id", "shot", "--kind", "screenshot",
    "--summary", "x shows.", "--file", path.join(captures, "shot.png"), "--node-ref", "implementation-change");

  repository.git("switch", "main");
  repository.commitFile("x.txt", "x\n", "Land x elsewhere");
  const restacked = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.deepEqual(restacked.stages.map(({ id, emptied }) => [id, emptied]), [["a", false], ["x", true], ["b", false], ["y", false]]);
  return { repository, replaced: x };
}

/** A hooks directory of the fixture's own, so no test writes to a hook Git would otherwise run. */
function fixtureHooks(repository) {
  const hooks = path.join(path.resolve(repository.root, repository.git("rev-parse", "--git-common-dir")), "fixture-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  repository.git("config", "core.hooksPath", hooks);
  return hooks;
}

/** The stage branch heads and the artifact's version, which a refused removal leaves as they were. */
function stackState(repository) {
  return repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/semantic-review");
}

test("an empty stage is removed in one transaction and the stages above keep their content", (t) => {
  const { repository, replaced } = emptiedStack(t);
  const before = Object.fromEntries(["a", "x", "b", "y"].map((id) => [id, repository.git("rev-parse", branchOf(id))]));

  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "on-x", "--comment-id", "on-x-1", "--body", "Why x?",
    "--label", "x", "--target-kind", "stage", "--stage", "x");
  repository.feedback("thread", "add", "--id", "assigned-x", "--comment-id", "assigned-x-1", "--body", "Fix b in x.",
    "--label", "b", "--target-kind", "node", "--stage", "b", "--node", "implementation-change", "--assigned-stage", "x");
  repository.feedback("thread", "add", "--id", "on-b", "--comment-id", "on-b-1", "--body", "Check b.",
    "--label", "b", "--target-kind", "stage", "--stage", "b");
  // The inventory names the empty stage and what keeps it.
  const preflight = JSON.parse(repository.flow("feedback", "--json"));
  assert.deepEqual(preflight.emptyStageThreads, [{ stageId: "x", openThreadIds: ["on-x", "assigned-x"] }]);
  assert.deepEqual(JSON.parse(repository.flow("status", "--json")).emptyStageThreads, [{ stageId: "x", openThreadIds: ["on-x", "assigned-x"] }]);

  const state = stackState(repository);
  repository.expectSemanticFailure("Stage x has feedback threads that are not resolved: on-x, assigned-x.", "stage", "remove", "--id", "x");
  assert.equal(stackState(repository), state);
  repository.feedback("thread", "resolve", "--id", "on-x");
  repository.feedback("thread", "resolve", "--id", "assigned-x");
  assert.deepEqual(JSON.parse(repository.flow("status", "--json")).emptyStageThreads, [{ stageId: "x", openThreadIds: [] }]);

  // The branch deletion, the moves above and the snapshot are one transaction: refusing one refuses all.
  const hooks = fixtureHooks(repository);
  const hook = path.join(hooks, "reference-transaction");
  fs.writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/${branchOf("x")} ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\n`, { mode: 0o755 });
  repository.git("switch", branchOf("x"));
  repository.expectSemanticFailure(/./, "stage", "remove", "--id", "x");
  assert.equal(stackState(repository), state);
  // The checkout detached for the removal is restored.
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), branchOf("x"));
  fs.rmSync(hook);

  // Detaching needs no checkout, so a failing checkout hook does not stop it.
  const postCheckout = path.join(hooks, "post-checkout");
  fs.writeFileSync(postCheckout, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const removal = JSON.parse(repository.semantic("stage", "remove", "--id", "x", "--json"));
  fs.rmSync(postCheckout);
  const after = Object.fromEntries(["a", "b", "y"].map((id) => [id, repository.git("rev-parse", branchOf(id))]));
  assert.deepEqual(removal.rebuiltStages, [
    { id: "b", branch: branchOf("b"), previousBaseRevision: before.x, previousHeadRevision: before.b, baseBranch: branchOf("a"), baseRevision: before.a, headRevision: after.b },
    { id: "y", branch: branchOf("y"), previousBaseRevision: before.b, previousHeadRevision: before.y, baseBranch: branchOf("b"), baseRevision: after.b, headRevision: after.y },
  ]);
  assert.equal(after.a, before.a);
  assert.equal(repository.result("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchOf("x")}`]).status, 1);
  // Only the parent changes: tree, authors, dates and message stay, and so does every diff.
  for (const id of ["b", "y"]) {
    assert.notEqual(after[id], before[id]);
    assert.equal(commitIdentity(repository, after[id]), commitIdentity(repository, before[id]));
    assert.equal(repository.git("diff", `${after[id]}^`, after[id]), repository.git("diff", `${before[id]}^`, before[id]));
  }
  assert.equal(repository.git("rev-parse", `${after.b}^`), before.a);
  assert.equal(removal.replacedCommit, replaced);
  assert.deepEqual(removal.dependsOn, [{ stageId: "y", previous: ["x", "b"], next: ["b"] }]);
  assert.deepEqual(removal.uncoveredCriteria, ["story#documented"]);
  assert.deepEqual(removal.resolvedThreadIds, ["on-x", "assigned-x"]);
  assert.deepEqual(removal.keptItems, [{ collection: "decisions", id: "keep-x" }, { collection: "evidence", id: "shot" }]);
  assert.equal(removal.removedStageFile, "removed-stages/x.json");
  // The removed branch was checked out here: the worktree is detached at the stage below, with the same tree.
  assert.equal(removal.detachedAt, before.a);
  assert.equal(repository.result("git", ["symbolic-ref", "--quiet", "HEAD"]).status, 1);
  assert.equal(repository.git("rev-parse", "HEAD"), before.a);

  // The stage leaves the stack; its full document and its captures are kept.
  const manifest = repository.artifact.readJson("manifest.json");
  assert.deepEqual(manifest.stages.map(({ id }) => id), ["a", "b", "y"]);
  assert.deepEqual(manifest.removedStages, [{ id: "x", headRevision: before.x }]);
  assert.equal(repository.artifact.exists("stages/x.json"), false);
  const kept = repository.artifact.readJson("removed-stages/x.json");
  assert.equal(kept.change.headRevision, before.x);
  assert.deepEqual(kept.change.files, []);
  assert.deepEqual(kept.decisions.map(({ id }) => id), ["keep-x"]);
  const [attachment] = kept.evidence[0].attachments;
  assert.ok(repository.artifact.exists(attachment.path));
  assert.deepEqual(repository.artifact.stage("y").dependsOn, ["b"]);
  assert.deepEqual(repository.artifact.implementation().removedStages.x, kept);
  repository.semantic("validate", "--publish");
  repository.feedback("validate");
  assert.match(repository.flow("validate", "--stack"), /3 finalized stage\(s\), 0 working stage\(s\)/);
  assert.deepEqual(JSON.parse(repository.flow("status", "--json")).emptyStageThreads, []);
  // A removed stage's evidence is validated like any other.
  const evidence = repository.artifact.readJson("removed-stages/x.json");
  evidence.evidence[0].attachments[0].sha256 = "0".repeat(64);
  const original = repository.artifact.read("removed-stages/x.json");
  repository.artifact.write("removed-stages/x.json", evidence);
  repository.expectSemanticFailure("Stage x evidence shot attachment", "validate");
  repository.artifact.write("removed-stages/x.json", original);

  // Its ID stays taken.
  repository.git("switch", branchOf("y"));
  repository.expectSemanticFailure("Stage x was removed from this implementation", "stage", "begin", "--id", "x",
    "--title", "Again", "--summary", "Again.", "--rationale", "Again.", "--specification-ref", "story#works");
  repository.expectSemanticFailure("Stage x was already removed.", "stage", "remove", "--id", "x");

  // Publication carries the removed stage; the viewer leaves it out of the stack and names it.
  repository.semantic("publish");
  const published = JSON.parse(repository.git("show", "semantic-flow/test-implementation/metadata:.semantic-review/removed-stages/x.json"));
  assert.equal(published.id, "x");
  assert.deepEqual(JSON.parse(repository.git("show", "semantic-flow/test-implementation/metadata:.semantic-review/manifest.json")).removedStages, [{ id: "x", headRevision: before.x }]);
  const viewed = implementationFromScript(createViewerDataSource(repository.root).implementationDataScript());
  assert.deepEqual(viewed.stages.map(({ id }) => id), ["a", "b", "y"]);
  assert.deepEqual(viewed.removedStages, [{ id: "x", title: "Implement behavior" }]);
  assert.deepEqual(viewed.feedback.map(({ id, status }) => [id, status]), [["on-x", "resolved"], ["assigned-x", "resolved"], ["on-b", "open"]]);
  // A later restack works on the shorter stack.
  repository.git("switch", "main");
  repository.commitFile("other.txt", "other\n", "Other work");
  repository.semantic("restack", "--base", "main");
  repository.semantic("validate", "--publish");
});

test("removing the lowest stage rebuilds the stages above on the target, and a detached checkout follows", (t) => {
  const { repository, commits } = createImplementationWithStages(t, ["policy", "api"]);
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", commits.get("policy"));
  repository.semantic("restack", "--base", "main");
  const api = repository.git("rev-parse", branchOf("api"));
  // A checkout of a branch above may stay: it moves to a commit with the same tree.
  repository.git("switch", "--detach", api);
  const text = repository.semantic("stage", "remove", "--id", "policy");
  const rebuilt = repository.git("rev-parse", branchOf("api"));
  assert.match(text, new RegExp(`^Removed empty stage policy \\(Implement behavior\\) and deleted its branch ${branchOf("policy")}; rebuilt 1 stage\\(s\\) above on main, their content unchanged\\.$`, "m"));
  assert.match(text, /^Stage api now depends on no stage instead of policy\.$/m);
  assert.match(text, new RegExp(`stood in for ${commits.get("policy")}; its changes no longer come back if the target drops them`));
  assert.match(text, new RegExp(`^HEAD is detached at ${rebuilt}\\.$`, "m"));
  assert.equal(repository.git("rev-parse", `${rebuilt}^`), repository.git("rev-parse", "main"));
  assert.equal(repository.git("rev-parse", "HEAD"), rebuilt);
  assert.deepEqual(repository.artifact.stage("api").dependsOn, []);
  repository.semantic("validate", "--publish");
  repository.semantic("prepare-branch", "--branch", "review/api");
  assert.equal(repository.git("rev-parse", "review/api"), rebuilt);
});

test("stage remove refuses stages that change files, the only stage, and an unsettled stack", (t) => {
  const { repository } = emptiedStack(t);
  repository.expectSemanticFailure("Stage a changes files; only an empty stage can be removed.", "stage", "remove", "--id", "a");
  repository.expectSemanticFailure("Finalized stage missing does not exist.", "stage", "remove", "--id", "missing");

  // A branch checked out in another worktree cannot be deleted.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-removal-worktree-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  repository.git("worktree", "add", "--quiet", path.join(other, "x"), branchOf("x"));
  const state = stackState(repository);
  repository.expectSemanticFailure(`Stage branch ${branchOf("x")} is checked out in another worktree.`, "stage", "remove", "--id", "x");
  assert.equal(stackState(repository), state);
  repository.git("worktree", "remove", "--force", path.join(other, "x"));
  // Also when this worktree has it checked out too.
  repository.git("switch", branchOf("x"));
  repository.git("worktree", "add", "--quiet", "--force", path.join(other, "shared"), branchOf("x"));
  repository.expectSemanticFailure(`Stage branch ${branchOf("x")} is checked out in another worktree.`, "stage", "remove", "--id", "x");
  assert.equal(stackState(repository), state);
  repository.git("worktree", "remove", "--force", path.join(other, "shared"));

  // A working stage blocks the removal.
  repository.git("switch", branchOf("y"));
  beginStage(repository, { id: "later", dependencies: ["y"] });
  repository.expectSemanticFailure("Removing a stage requires every stage to be finalized; finish or discard working stage later first.", "stage", "remove", "--id", "x");
  repository.semantic("stage", "discard", "--id", "later");

  // So does a pending restack.
  repository.git("switch", branchOf("a"));
  repository.commitFile("y.txt", "conflict\n", "Conflict with y");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "a");
  repository.expectSemanticFailure("A restack stopped at a conflict", "stage", "remove", "--id", "x");
  repository.semantic("restack", "--abort");
});

test("stage remove refuses the only stage, since nothing would remain to prepare", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  const head = finalizeStage(repository, { id: "policy" });
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", head);
  repository.semantic("restack", "--base", "main");
  repository.expectSemanticFailure("Stage policy is the only stage of test-implementation, so nothing would remain to prepare.", "stage", "remove", "--id", "policy");
});

/** policy and api, with policy landed on the target, so restacking empties it. */
function emptiedPolicy(t) {
  const { repository, commits } = createImplementationWithStages(t, ["policy", "api"]);
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", commits.get("policy"));
  repository.semantic("restack", "--base", "main");
  return repository;
}

test("stage remove refuses while threads cannot be read, and completes when only the round's heartbeat fails", (t) => {
  const repository = emptiedPolicy(t);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "on-policy", "--comment-id", "on-policy-1", "--body", "Why policy?",
    "--label", "Policy", "--target-kind", "stage", "--stage", "policy");
  // Threads without their manifest are unknown, not none.
  const manifest = repository.feedbackPath("manifest.json");
  const stored = fs.readFileSync(manifest);
  fs.rmSync(manifest);
  const state = stackState(repository);
  repository.expectSemanticFailure("manifest.json is missing", "stage", "remove", "--id", "policy");
  assert.equal(stackState(repository), state);
  fs.writeFileSync(manifest, stored);
  repository.feedback("thread", "resolve", "--id", "on-policy");

  // A running round's heartbeat cannot be written once the stage is removed.
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  if (process.platform === "win32") return t.skip("Windows ignores read-only directory modes");
  const review = path.dirname(repository.feedbackPath());
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(review, "agent.json"), JSON.stringify({ session: { id: "round", startedAt: now, heartbeatAt: now, feedbackAt: now } }));
  fs.chmodSync(review, 0o500);
  t.after(() => fs.chmodSync(review, 0o700));
  repository.git("switch", branchOf("policy"));
  const execution = repository.result(process.execPath, [...semanticCli, "stage", "remove", "--id", "policy", "--json"]);
  fs.chmodSync(review, 0o700);
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stderr, /the change was saved, but its feedback round was not renewed/);
  const removal = JSON.parse(execution.stdout);
  assert.equal(removal.stageId, "policy");
  assert.equal(removal.detachedAt, repository.git("rev-parse", "main"));
  assert.equal(repository.result("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchOf("policy")}`]).status, 1);
  repository.semantic("validate");
});

test("a viewer request that read the refs before the removal cannot reopen a thread of the removed stage", (t) => {
  const repository = emptiedPolicy(t);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "on-policy", "--comment-id", "on-policy-1", "--body", "Why policy?",
    "--label", "Policy", "--target-kind", "stage", "--stage", "policy");
  repository.feedback("thread", "resolve", "--id", "on-policy");
  // The viewer reads the refs once per request, before it waits for the review lock.
  const reads = new Map();
  readingActiveRefsOnce(reads, () => listActiveImplementations(repository.root));
  repository.semantic("stage", "remove", "--id", "policy");
  const reviewId = path.basename(path.dirname(repository.feedbackPath()));
  const feedback = readingActiveRefsOnce(reads, () => reviewFeedback(repository.root, { reviewId, generation: readReview(reviewId).generation }));
  assert.throws(() => readingActiveRefsOnce(reads, () => feedback.reopenThread("on-policy")), /stage policy was removed, so its threads are read-only/);
  assert.equal(repository.readAbsoluteJson(repository.feedbackPath("threads", "on-policy.json")).status, "resolved");
});

test("stage remove refuses while a Git operation is in progress in a checkout it would move", (t) => {
  const repository = emptiedPolicy(t);
  const state = stackState(repository);
  // HEAD on the removed branch would be detached under a stopped cherry-pick.
  repository.git("switch", branchOf("policy"));
  const cherryPick = path.resolve(repository.root, repository.git("rev-parse", "--git-path", "CHERRY_PICK_HEAD"));
  fs.writeFileSync(cherryPick, `${repository.git("rev-parse", "HEAD")}\n`);
  repository.expectSemanticFailure("A Git operation is in progress", "stage", "remove", "--id", "policy");
  assert.equal(stackState(repository), state);
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), branchOf("policy"));
  fs.rmSync(cherryPick);

  // A detached HEAD that would follow a rebuilt head is not moved under a bisect.
  const api = repository.git("rev-parse", branchOf("api"));
  repository.git("switch", "--detach", api);
  const bisect = path.resolve(repository.root, repository.git("rev-parse", "--git-path", "BISECT_LOG"));
  fs.writeFileSync(bisect, "git bisect start\n");
  repository.expectSemanticFailure("A Git operation is in progress", "stage", "remove", "--id", "policy");
  assert.equal(stackState(repository), state);
  assert.equal(repository.git("rev-parse", "HEAD"), api);
  fs.rmSync(bisect);
  repository.semantic("stage", "remove", "--id", "policy");
  assert.equal(repository.git("rev-parse", "HEAD"), repository.git("rev-parse", branchOf("api")));
});

test("stage remove refuses another implementation, and a concurrent removal leaves HEAD detached", async (t) => {
  const repository = emptiedPolicy(t);
  repository.expectSemanticFailure("This worktree works on implementation test-implementation, not other.",
    "stage", "remove", "--id", "policy", "--implementation-id", "other");
  repository.git("switch", branchOf("policy"));
  const base = repository.git("rev-parse", "main");
  const remove = () => new Promise((resolve) => {
    execFile(process.execPath, [...semanticCli, "stage", "remove", "--id", "policy", "--implementation-id", "test-implementation", "--json"],
      { cwd: repository.root, encoding: "utf8" }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
  const results = await Promise.all([remove(), remove()]);
  assert.deepEqual(results.map(({ status }) => status === 0).sort(), [false, true], results.map(({ stderr }) => stderr).join("\n"));
  // The losing removal does not point HEAD back at the deleted branch.
  assert.equal(repository.result("git", ["symbolic-ref", "--quiet", "HEAD"]).status, 1);
  assert.equal(repository.git("rev-parse", "HEAD"), base);
  assert.equal(repository.result("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchOf("policy")}`]).status, 1);
  repository.semantic("validate");
});

/** The Git directory file of a worktree, such as its CHERRY_PICK_HEAD. */
const gitPath = (repository, worktree, state) =>
  path.resolve(worktree, repository.run("git", ["-C", worktree, "rev-parse", "--git-path", state]));

test("stage remove refuses while another worktree has a Git operation in progress on a branch it moves", (t) => {
  const repository = emptiedPolicy(t);
  // Git names worktrees by their real path: /private/var rather than /var on
  // macOS, and long names rather than 8.3 short names on Windows.
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-removal-operation-")));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  // A stopped multi-commit cherry-pick on the stage branch above the removed one.
  const above = path.join(other, "above");
  repository.git("worktree", "add", "--quiet", above, branchOf("api"));
  fs.mkdirSync(gitPath(repository, above, "sequencer"));
  fs.writeFileSync(gitPath(repository, above, "CHERRY_PICK_HEAD"), `${repository.git("rev-parse", "main")}\n`);
  const state = stackState(repository);
  repository.expectSemanticFailure(`A Git operation is in progress in ${above} (CHERRY_PICK_HEAD).`, "stage", "remove", "--id", "policy");
  assert.equal(stackState(repository), state);
  fs.rmSync(gitPath(repository, above, "sequencer"), { recursive: true });
  fs.rmSync(gitPath(repository, above, "CHERRY_PICK_HEAD"));
  repository.git("worktree", "remove", "--force", above);

  // Another worktree's detached HEAD stays where it is, so its operation is not in the way.
  const api = repository.git("rev-parse", branchOf("api"));
  const detached = path.join(other, "detached");
  repository.git("worktree", "add", "--quiet", "--detach", detached, api);
  fs.writeFileSync(gitPath(repository, detached, "BISECT_LOG"), "git bisect start\n");
  repository.semantic("stage", "remove", "--id", "policy");
  assert.equal(repository.run("git", ["-C", detached, "rev-parse", "HEAD"]), api);
});

test("stage remove checks for a Git operation again once it holds the review lock", async (t) => {
  const repository = emptiedPolicy(t);
  repository.feedback("init");
  repository.git("switch", branchOf("policy"));
  const state = stackState(repository);
  const review = path.basename(path.dirname(repository.feedbackPath()));
  const locks = path.join(reviewHome(), "locks");
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let removal;
  withReviewLock(review, () => {
    removal = new Promise((resolve) => {
      execFile(process.execPath, [...semanticCli, "stage", "remove", "--id", "policy"], { cwd: repository.root, encoding: "utf8" },
        (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
    });
    // The removal has passed its first checks once it waits for the lock: a merge starts meanwhile.
    const deadline = Date.now() + 8000;
    while (!fs.readdirSync(locks).some((entry) => entry.includes(".lock.claim-"))) {
      assert.ok(Date.now() < deadline, "the removal never waited for the review lock");
      Atomics.wait(sleep, 0, 0, 20);
    }
    fs.writeFileSync(gitPath(repository, repository.root, "MERGE_HEAD"), `${repository.git("rev-parse", "main")}\n`);
  });
  const { status, stderr } = await removal;
  assert.notEqual(status, 0);
  assert.match(stderr, /A Git operation is in progress in .* \(MERGE_HEAD\)/);
  assert.equal(stackState(repository), state);
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), branchOf("policy"));
});

test("a removal that follows another moves a detached HEAD to the latest rebuilt head", async (t) => {
  const { repository, commits } = createImplementationWithStages(t, ["p", "q", "api"]);
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", commits.get("q"));
  repository.semantic("restack", "--base", "main");
  repository.git("switch", "--detach", branchOf("api"));

  // Once the first removal commits, a second one starts; the first moves HEAD
  // only once the second waits for the review lock, or else has finished.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-removal-race-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const [started, waited, out, status] = ["started", "waited", "out", "status"].map((name) => path.join(scratch, name));
  const locks = path.join(reviewHome(), "locks");
  const command = [process.execPath, ...semanticCli, "stage", "remove", "--id", "q", "--json"].map((part) => `'${part}'`).join(" ");
  fs.writeFileSync(path.join(fixtureHooks(repository), "reference-transaction"), `#!/bin/sh
input=$(cat)
case "$1 $input" in
  committed*refs/semantic-review/active/*)
    [ -e '${started}' ] && exit 0
    : > '${started}'
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
    ( cd '${repository.root}' && ${command} > '${out}' 2>&1; echo $? > '${status}' ) </dev/null >/dev/null 2>&1 &
    ;;
  "prepared "*" HEAD"*)
    [ -e '${started}' ] && [ ! -e '${waited}' ] || exit 0
    : > '${waited}'
    tries=0
    until [ -s '${status}' ] || ls '${locks}' 2>/dev/null | grep -q '[.]lock[.]claim-'; do
      tries=$((tries + 1)); [ $tries -gt 400 ] && break
      sleep 0.05
    done
    ;;
esac
exit 0
`, { mode: 0o755 });
  const first = JSON.parse(repository.semantic("stage", "remove", "--id", "p", "--json"));
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(status) || !fs.readFileSync(status, "utf8").trim()) {
    assert.ok(Date.now() < deadline, "the second removal did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.readFileSync(status, "utf8").trim(), "0", fs.readFileSync(out, "utf8"));
  const second = JSON.parse(fs.readFileSync(out, "utf8").split("\n").find((line) => line.startsWith("{")));
  const api = repository.git("rev-parse", branchOf("api"));
  assert.equal(first.detachedAt, first.rebuiltStages.find(({ id }) => id === "api").headRevision);
  assert.equal(second.detachedAt, api);
  assert.equal(repository.git("rev-parse", "HEAD"), api);
  repository.semantic("validate");
});

test("stage remove acts only on the implementation the worktree itself works on", (t) => {
  const repository = emptiedPolicy(t);
  const second = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-removal-other-")), "worktree");
  t.after(() => fs.rmSync(path.dirname(second), { recursive: true, force: true }));
  repository.git("worktree", "add", "--quiet", "--detach", second, "main");
  const run = (cwd, selection, ...args) => spawnSync(process.execPath, [...semanticCli, ...args],
    { cwd, encoding: "utf8", env: { ...process.env, SEMANTIC_FLOW_IMPLEMENTATION_ID: selection } });
  const init = run(second, "", "init", "--implementation-id", "other", "--title", "Other", "--summary", "Other work.", "--target-branch", "main",
    "--specification-id", "other", "--specification-title", "Other", "--specification-summary", "Other work.",
    "--source-kind", "local", "--source-reference", "other", "--criterion", "works=It works.");
  assert.equal(init.status, 0, init.stderr);
  const state = stackState(repository);

  // An inherited selection does not make the option pass in the other implementation's worktree.
  const inherited = run(second, "test-implementation", "stage", "remove", "--id", "policy", "--implementation-id", "test-implementation");
  assert.notEqual(inherited.status, 0);
  assert.match(inherited.stderr, /This worktree works on implementation other, not test-implementation\./);
  const selected = run(second, "test-implementation", "stage", "remove", "--id", "policy");
  assert.notEqual(selected.status, 0);
  assert.match(selected.stderr, /This worktree works on implementation other, not test-implementation, which SEMANTIC_FLOW_IMPLEMENTATION_ID selects\./);
  const option = run(repository.root, "test-implementation", "stage", "remove", "--id", "policy", "--implementation-id", "other");
  assert.notEqual(option.status, 0);
  assert.match(option.stderr, /This worktree works on implementation test-implementation, not other\./);
  assert.equal(stackState(repository), state);

  // A selection of the worktree's own implementation passes.
  const removal = run(repository.root, "test-implementation", "stage", "remove", "--id", "policy", "--implementation-id", "test-implementation");
  assert.equal(removal.status, 0, removal.stderr);
});
