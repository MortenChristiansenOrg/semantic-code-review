import assert from "node:assert/strict";
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
} from "../helpers/repository.mjs";
import { createViewerDataSource } from "../../src/semantic-view.ts";

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
  const hooks = path.resolve(repository.root, repository.git("rev-parse", "--git-path", "hooks"));
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "reference-transaction");
  fs.writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/${branchOf("x")} ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\n`, { mode: 0o755 });
  repository.git("switch", branchOf("x"));
  repository.expectSemanticFailure(/./, "stage", "remove", "--id", "x");
  assert.equal(stackState(repository), state);
  // The checkout detached for the removal is restored.
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), branchOf("x"));
  fs.rmSync(hook);

  const removal = JSON.parse(repository.semantic("stage", "remove", "--id", "x", "--json"));
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
