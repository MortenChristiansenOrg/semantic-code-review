import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { feedbackDirectory } from "../../src/shared/review-store.ts";
import { agentStatus, endSession, readAgentState, updateAgentState } from "../../src/shared/agent-session.ts";
import { createImplementationWithStages, flowCli } from "../helpers/repository.mjs";

const reviewDirectory = (repository) => path.dirname(feedbackDirectory(repository.root));
const reviewIdOf = (repository) => path.basename(reviewDirectory(repository));
const threadIds = (result) => result.stages.flatMap((stage) => stage.threads.map((thread) => thread.id)).sort();
const stageBranch = (repository, id) => repository.git("branch", "--list", "--format=%(refname:short)", `*/stages/${id}`);
const recordedHead = (repository, id) => repository.artifact.stage(id).change.headRevision;
const pendingRestack = (repository) => repository.artifact.exists(".work/restack.json");

function addThread(repository, id, stage = "implementation") {
  repository.feedback("thread", "add", "--id", id, "--comment-id", `${id}-note`, "--body", `Change ${id}.`,
    "--label", "Stage", "--target-kind", "stage", "--stage", stage);
}

/** Runs node with argv, resolving with its exit status and output. */
function run(argv, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { cwd, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
}
const waitRun = (repository, ...args) => run([flowCli, "feedback", "--json", "--wait", ...(args.includes("--timeout") ? [] : ["--timeout", "5"]), ...args], repository.root);
async function wait(repository, ...args) {
  const result = await waitRun(repository, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** The listening session and its round, as the viewer reads them. */
function assertListening(repository, round) {
  const state = readAgentState(reviewIdOf(repository));
  assert.equal(state.session?.id, round.session);
  assert.equal(state.session.endedAt, undefined);
  assert.deepEqual(state.claims.map((claim) => claim.id), [round.claim]);
  const status = agentStatus(state, Date.now());
  assert.equal(status.listening, true);
  assert.deepEqual(status.working?.threads.map((thread) => thread.id), threadIds(round));
}

/** A round's stage commit that no restack recorded. */
function leaveStageCommit(repository) {
  const head = repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  return { branch: stageBranch(repository, "implementation"), head };
}

/** A round's correction to stage base whose restack stopped at a conflict in upper. */
function leaveConflict(repository, claim) {
  repository.git("switch", stageBranch(repository, "base"));
  const head = repository.commitFile("upper.txt", "base wants this\n", "Conflicting correction");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "base", ...(claim ? ["--claim", claim] : []));
  assert.ok(pendingRestack(repository));
  return { branch: stageBranch(repository, "base"), head };
}

const leftoverStates = {
  "an unrecorded stage commit": {
    stages: ["implementation"],
    threadStage: "implementation",
    leave: (repository) => leaveStageCommit(repository),
    expected: (repository, recorded, left) => ({
      movedStages: [{ stageId: "implementation", branch: left.branch, recordedHead: recorded.implementation, head: left.head }],
      pendingRestack: null,
    }),
  },
  "a pending restack": {
    stages: ["base", "upper"],
    threadStage: "base",
    leave: (repository, claim) => leaveConflict(repository, claim),
    expected: (repository, recorded, left) => ({
      movedStages: [{ stageId: "base", branch: left.branch, recordedHead: recorded.base, head: left.head }],
      pendingRestack: { stageId: "upper", worktree: JSON.parse(repository.artifact.read(".work/restack.json")).worktree },
    }),
  },
};

for (const [state, { stages, threadStage, leave, expected }] of Object.entries(leftoverStates)) {
  test(`a takeover's first wait returns the round with ${state} instead of ending its session`, async (t) => {
    const { repository } = createImplementationWithStages(t, stages);
    repository.feedback("init");
    addThread(repository, "change", threadStage);
    const recorded = Object.fromEntries(stages.map((id) => [id, recordedHead(repository, id)]));
    const replaced = await wait(repository);
    const left = leave(repository, replaced.claim);

    const takeover = await wait(repository);
    assert.notEqual(takeover.session, replaced.session);
    assert.ok(takeover.claim);
    assert.deepEqual(threadIds(takeover), ["change"]);
    assert.deepEqual(takeover.leftoverWork, expected(repository, recorded, left));
    // The round works against the recorded stage until it records what was left.
    assert.equal(takeover.stages[0].stageHead, recorded[threadStage]);
    assertListening(repository, takeover);
    repository.expectFeedbackFailure("was replaced", "agent", "progress", "--claim", replaced.claim, "--body", "Still working");
  });

  test(`after an interrupted round, the first wait returns the round with ${state}`, async (t) => {
    const { repository } = createImplementationWithStages(t, stages);
    repository.feedback("init");
    addThread(repository, "change", threadStage);
    const recorded = Object.fromEntries(stages.map((id) => [id, recordedHead(repository, id)]));
    const interrupted = await wait(repository);
    const left = leave(repository, interrupted.claim);
    // The agent's process ended mid-round; its session ended and its threads returned to the queue.
    updateAgentState(reviewIdOf(repository), (agent, now) => endSession(agent, now, "idle"));

    const round = await wait(repository);
    assert.deepEqual(threadIds(round), ["change"]);
    assert.deepEqual(round.leftoverWork, expected(repository, recorded, left));
    assertListening(repository, round);
  });
}

test("a first wait with nothing left reports leftoverWork as null", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "change");
  const round = await wait(repository);
  assert.equal(round.leftoverWork, null);
  // A preflight outside listening has no leftover work to report.
  assert.equal("leftoverWork" in JSON.parse(repository.flow("feedback", "--json")), false);
});

test("the new agent records the replaced round's stage commit under its claim and answers against it", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "change");
  await wait(repository);
  leaveStageCommit(repository);
  const round = await wait(repository);

  repository.expectSemanticFailure("pass the claim", "restack", "--from", "implementation");
  const summary = JSON.parse(repository.semantic("restack", "--from", "implementation", "--claim", round.claim, "--json"));
  const stage = summary.stages.find(({ id }) => id === "implementation");
  assert.equal(recordedHead(repository, "implementation"), stage.nextHead);
  assert.equal(repository.git("show", `${stage.nextHead}:implementation.txt`), "implementation v2");
  repository.semantic("validate");

  repository.feedback("thread", "reply", "--id", "change", "--comment-id", "done", "--author", "agent", "--claim", round.claim,
    "--body", "Finished the earlier round's change.");
  const next = await wait(repository, "--session", round.session, "--timeout", "1");
  assert.equal(next.timedOut, true);
});

test("the new agent continues the replaced round's pending restack after resolving its conflict", async (t) => {
  const { repository } = createImplementationWithStages(t, ["base", "upper"]);
  repository.feedback("init");
  addThread(repository, "change", "base");
  const replaced = await wait(repository);
  const left = leaveConflict(repository, replaced.claim);
  const round = await wait(repository);
  const { worktree } = round.leftoverWork.pendingRestack;

  repository.expectSemanticFailure("was replaced", "restack", "--continue", "--claim", replaced.claim);
  fs.writeFileSync(path.join(worktree, "upper.txt"), "base wants this\nupper\n");
  execFileSync("git", ["add", "upper.txt"], { cwd: worktree });
  repository.expectSemanticFailure("pass the claim", "restack", "--continue");
  repository.semantic("restack", "--continue", "--claim", round.claim);

  assert.equal(pendingRestack(repository), false);
  const base = recordedHead(repository, "base");
  assert.equal(repository.git("show", `${base}:upper.txt`), "base wants this");
  assert.equal(repository.git("rev-parse", stageBranch(repository, "base")), base);
  assert.equal(repository.git("show", `${recordedHead(repository, "upper")}:upper.txt`), "base wants this\nupper");
  assert.notEqual(base, left.head);
  // The correction adds a file to the stage, which the agent organizes next.
  repository.expectSemanticFailure("Stage base does not assign changed path upper.txt to a node", "validate");
  // The replaced round still cannot change anything.
  repository.expectSemanticFailure("was replaced", "restack", "--from", "base", "--claim", replaced.claim);
});

test("the new agent can abort the replaced round's pending restack and keeps its stage commit", async (t) => {
  const { repository } = createImplementationWithStages(t, ["base", "upper"]);
  repository.feedback("init");
  addThread(repository, "change", "base");
  const replaced = await wait(repository);
  const left = leaveConflict(repository, replaced.claim);
  const round = await wait(repository);

  repository.semantic("restack", "--abort", "--claim", round.claim);
  assert.equal(pendingRestack(repository), false);
  // The correction is still on the stage branch, to be restacked again.
  assert.equal(repository.git("rev-parse", left.branch), left.head);
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "base", "--claim", round.claim);
});

test("leftover work keeps an advanced target from being restacked until it is recorded", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "change");
  await wait(repository);
  const left = leaveStageCommit(repository);
  repository.git("switch", "main");
  repository.commitFile("target.txt", "target\n", "Advance the target");
  repository.git("switch", left.branch);

  const round = await wait(repository);
  assert.equal(round.targetRestack, null);
  assert.deepEqual(round.leftoverWork.movedStages.map(({ stageId }) => stageId), ["implementation"]);
  assertListening(repository, round);
});

test("other validation failures still fail a first wait, with or without leftover work", async (t) => {
  const { repository } = createImplementationWithStages(t, ["base", "upper"]);
  repository.feedback("init");
  addThread(repository, "change", "base");
  await wait(repository);
  repository.git("switch", stageBranch(repository, "base"));
  repository.commitFile("base.txt", "base v2\n", "Address feedback");
  // A target branch that was rewritten instead of advanced.
  repository.git("branch", "-f", "main", repository.git("commit-tree", "-m", "Rewritten", `${repository.git("rev-parse", "main")}^{tree}`));

  const failed = await waitRun(repository);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Target branch main moved from/);
  assert.equal(readAgentState(reviewIdOf(repository)).session.endReason, "failed");
});

test("a wait that continues its session fails on its own round's unrecorded work but keeps the session", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "change");
  const round = await wait(repository);
  leaveStageCommit(repository);
  repository.feedback("thread", "reply", "--id", "change", "--comment-id", "done", "--author", "agent", "--claim", round.claim, "--body", "Done.");

  const failed = await waitRun(repository, "--session", round.session);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Stage implementation branch .* moved from .*run restack --from implementation/);
  assert.equal(readAgentState(reviewIdOf(repository)).session.endedAt, undefined);
  repository.semantic("restack", "--from", "implementation", "--claim", round.claim);
  assert.equal((await wait(repository, "--session", round.session, "--timeout", "1")).timedOut, true);
});
