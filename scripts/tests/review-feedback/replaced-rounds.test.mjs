import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { semanticImplementationApi } from "../../src/command-api.ts";
import { feedbackDirectory, reviewHome } from "../../src/shared/review-store.ts";
import { createClaim, endSession, releaseClaims, startSession, updateAgentState } from "../../src/shared/agent-session.ts";
import { createImplementationWithStages, flowCli, semanticCli, sourceLoader } from "../helpers/repository.mjs";

const reviewDirectory = (repository) => path.dirname(feedbackDirectory(repository.root));
const reviewIdOf = (repository) => path.basename(reviewDirectory(repository));
const agentState = (repository) => JSON.parse(fs.readFileSync(path.join(reviewDirectory(repository), "agent.json"), "utf8"));
const threadIds = (result) => result.stages.flatMap((stage) => stage.threads.map((thread) => thread.id)).sort();

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
async function waitAsync(repository, ...args) {
  const result = await run([flowCli, "feedback", "--json", "--wait", ...args], repository.root);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Everything a refused command must leave as it was: every ref (stage
 * branches, the active artifact's snapshot), HEAD, and the worktree. */
function implementationState(repository) {
  return {
    refs: repository.git("for-each-ref", "--format=%(refname) %(objectname)"),
    head: repository.git("rev-parse", "HEAD"),
    branch: repository.git("branch", "--show-current"),
    worktree: repository.git("status", "--porcelain=v1", "--untracked-files=all"),
    // A scratch restack worktree is registered here while a restack is pending.
    worktrees: repository.git("worktree", "list", "--porcelain"),
  };
}
const stageBranch = (repository, id) => repository.git("branch", "--list", "--format=%(refname:short)", `*/stages/${id}`);

/** The commands that can change the implementation for a round; each takes --claim. */
const changingCommands = semanticImplementationApi.commands
  .filter(({ options = [] }) => options.some(({ name }) => name === "claim"))
  .map(({ command }) => command.split(" "));

test("every command that changes the implementation refuses a replaced round before it changes anything", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const replaced = await waitAsync(repository, "--timeout", "5");
  const takeover = await waitAsync(repository, "--timeout", "5");
  assert.deepEqual(threadIds(takeover), ["rename"]);
  // The CLI cannot see a plain commit; the restack that would record it is refused.
  repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  const before = implementationState(repository);

  // Every command is listed by hand as reading, changing nothing a round works on, or
  // changing it for a round, so a new command that changes it without a claim is noticed.
  const noRound = ["init", "export", "validate", "validate-stack", "publish", "prepare-branch", "stage plan", "archive", "archive landing", "archive share"];
  const all = semanticImplementationApi.commands.map(({ command }) => command);
  assert.deepEqual(all.filter((command) => !noRound.includes(command)).sort(), changingCommands.map((words) => words.join(" ")).sort());
  assert.deepEqual(changingCommands.map((words) => words.join(" ")).sort(), [
    "restack", "specification add", "stage begin", "stage discard", "stage evidence", "stage evidence-remove",
    "stage finish", "stage no-evidence", "stage organize", "stage record", "stage record-batch", "stage remove",
    "stage set", "stage target", "stage validation",
  ]);
  for (const words of changingCommands) {
    const refusal = repository.expectSemanticFailure("was replaced", ...words, "--claim", replaced.claim);
    assert.match(refusal.stderr, /Make no further changes for this round.*End with one short line/s, words.join(" "));
  }
  repository.expectSemanticFailure("was replaced", "restack", "--from", "implementation", "--claim", replaced.claim);
  assert.deepEqual(implementationState(repository), before);

  // The new round's agent changes the implementation with its own claim.
  repository.semantic("restack", "--from", "implementation", "--claim", takeover.claim);
  assert.notDeepEqual(implementationState(repository).refs, before.refs);
});

test("while a listening agent answers a round, a change that names no round is refused", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const round = await waitAsync(repository, "--timeout", "5");
  repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  const before = implementationState(repository);
  repository.expectSemanticFailure("pass the claim your feedback preflight or wait returned with --claim", "restack", "--from", "implementation");
  repository.expectSemanticFailure("is not a feedback round of this review", "restack", "--from", "implementation", "--claim", "unknown-round");
  assert.deepEqual(implementationState(repository), before);

  // Once the round is answered, a change outside any round is accepted again.
  repository.feedback("thread", "reply", "--id", "rename", "--comment-id", "done", "--author", "agent", "--claim", round.claim, "--body", "Done.");
  repository.semantic("restack", "--from", "implementation");
});

test("a replaced round cannot continue its pending restack but can still abort it", async (t) => {
  const { repository } = createImplementationWithStages(t, ["base", "upper"]);
  repository.feedback("init");
  addThread(repository, "conflict", "base");
  const replaced = await waitAsync(repository, "--timeout", "5");
  repository.git("switch", stageBranch(repository, "base"));
  repository.commitFile("upper.txt", "base wants this\n", "Conflicting correction");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "base", "--claim", replaced.claim);
  assert.ok(repository.artifact.exists(".work/restack.json"));
  // The new agent's round may be resolving the restack itself, so it is not aborted meanwhile.
  const review = reviewIdOf(repository);
  const session = updateAgentState(review, (state, now) => {
    const started = startSession(state, now);
    createClaim(state, now, started.id, [{ id: "conflict", through: "conflict-note" }]);
    return started.id;
  });

  const before = implementationState(repository);
  repository.expectSemanticFailure("was replaced", "restack", "--continue", "--claim", replaced.claim);
  repository.expectSemanticFailure("was replaced", "restack", "--abort", "--claim", replaced.claim);
  assert.deepEqual(implementationState(repository), before);
  // Not while the session that took over listens, even before it claims anything.
  updateAgentState(review, (state) => releaseClaims(state, session));
  repository.expectSemanticFailure("was replaced", "restack", "--abort", "--claim", replaced.claim);
  updateAgentState(review, (state, now) => endSession(state, now, "stopped"));
  repository.semantic("restack", "--abort", "--claim", replaced.claim);
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
});

test("a replaced round cannot abort the restack the new round left pending", async (t) => {
  const { repository } = createImplementationWithStages(t, ["base", "upper"]);
  repository.feedback("init");
  addThread(repository, "conflict", "base");
  const replaced = await waitAsync(repository, "--timeout", "5");
  const takeover = await waitAsync(repository, "--timeout", "5");
  repository.git("switch", stageBranch(repository, "base"));
  repository.commitFile("upper.txt", "base wants this\n", "Conflicting correction");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "base", "--claim", takeover.claim);

  const before = implementationState(repository);
  repository.expectSemanticFailure("was replaced", "restack", "--abort", "--claim", replaced.claim);
  repository.expectSemanticFailure("pass the claim", "restack", "--abort");
  assert.deepEqual(implementationState(repository), before);
  repository.semantic("restack", "--abort", "--claim", takeover.claim);
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
});

test("a takeover between a command's check and its write does not let the write through", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const round = await waitAsync(repository, "--timeout", "5");
  repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  const before = implementationState(repository);

  // A second process holds the review lock. The restack passes its first check,
  // replays the stage, then waits for the lock to write; only then does the
  // holder take the review over and release the lock.
  const review = reviewIdOf(repository);
  const locks = path.join(reviewHome(), "locks");
  const ready = path.join(repository.root, "..", `${path.basename(repository.root)}-holding`);
  t.after(() => fs.rmSync(ready, { force: true }));
  const holder = `
    import fs from "node:fs";
    import { withReviewLock } from ${JSON.stringify(new URL("../../src/shared/review-store.ts", import.meta.url).href)};
    import { startSession, updateAgentState } from ${JSON.stringify(new URL("../../src/shared/agent-session.ts", import.meta.url).href)};
    const [review, locks, ready] = process.argv.slice(-3);
    const deadline = Date.now() + 60_000;
    withReviewLock(review, () => {
      fs.writeFileSync(ready, "");
      const waiting = () => fs.readdirSync(locks).some((name) => name.startsWith(review + ".lock.claim-"));
      while (!waiting()) {
        if (Date.now() > deadline) throw new Error("The restack never waited for the review lock.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      updateAgentState(review, (state, now) => { startSession(state, now); });
    });
  `;
  let holderDone = false;
  const holding = run([...sourceLoader, "--input-type=module", "-e", holder, "--", review, locks, ready], repository.root)
    .finally(() => { holderDone = true; });
  while (!fs.existsSync(ready)) {
    if (holderDone) assert.fail(`The lock holder ended early: ${(await holding).stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const restack = await run([...semanticCli, "restack", "--from", "implementation", "--claim", round.claim], repository.root);
  const held = await holding;
  assert.equal(held.status, 0, held.stderr);
  assert.notEqual(restack.status, 0, restack.stdout);
  assert.match(restack.stderr, /was replaced/);
  assert.deepEqual(implementationState(repository), before);
});

test("a replaced round's progress and questions never show as the new agent's", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const replaced = await waitAsync(repository, "--timeout", "5");
  repository.feedback("agent", "progress", "--claim", replaced.claim, "--body", "Renaming");
  const takeover = await waitAsync(repository, "--timeout", "5");

  repository.expectFeedbackFailure("was replaced", "agent", "progress", "--claim", replaced.claim, "--body", "Still renaming");
  repository.expectFeedbackFailure("was replaced", "agent", "ask", "--id", "which-name", "--claim", replaced.claim, "--body", "Which name?");
  // Forgetting the claim does not attach them to the new agent's round either.
  repository.expectFeedbackFailure("Pass the claim", "agent", "progress", "--body", "Still renaming");
  repository.expectFeedbackFailure("Pass the claim", "agent", "ask", "--id", "which-name", "--body", "Which name?");
  let state = agentState(repository);
  assert.deepEqual(state.claims.map((claim) => [claim.id, claim.note]), [[takeover.claim, undefined]]);
  assert.deepEqual(state.requests, []);

  repository.feedback("agent", "progress", "--claim", takeover.claim, "--body", "Renaming again");
  repository.feedback("agent", "ask", "--id", "which-name", "--claim", takeover.claim, "--body", "Which name?");
  state = agentState(repository);
  assert.equal(state.claims[0].note, "Renaming again");
  assert.deepEqual(state.requests.map((request) => [request.id, request.sessionId]), [["which-name", takeover.session]]);
});

test("a standalone round's open question goes when a listening agent takes the round over", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const standalone = JSON.parse(repository.flow("feedback", "--json"));
  repository.feedback("agent", "ask", "--id", "which-name", "--claim", standalone.claim, "--body", "Which name?");
  assert.equal(agentState(repository).requests.length, 1);
  const takeover = await waitAsync(repository, "--timeout", "5");
  assert.deepEqual(threadIds(takeover), ["rename"]);
  assert.deepEqual(agentState(repository).requests, []);
});

test("a round whose lease ran out may still check itself, and feedback names why it does not restack meanwhile", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  addThread(repository, "later");
  const round = await waitAsync(repository, "--timeout", "5");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.claims[0].activityAt = new Date(Date.now() - 31 * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  assert.match(repository.feedback("agent", "progress", "--claim", round.claim, "--body", "Committing"), /no longer running.*may continue/s);

  // A running listener's round keeps feedback without listening from restacking onto an advanced target.
  const listening = await waitAsync(repository, "--session", round.session, "--timeout", "5");
  assert.ok(listening.claim);
  const main = repository.git("rev-parse", "main");
  repository.git("update-ref", "refs/heads/main", repository.git("commit-tree", `${main}^{tree}`, "-p", main, "-m", "Advance target"));
  const refused = repository.result(process.execPath, [flowCli, "feedback", "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /restacked onto it only once the round is finished/);
});

test("a new agent takes over at once while the replaced round is still working", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "rename");
  const replaced = await waitAsync(repository, "--timeout", "5");
  repository.feedback("agent", "progress", "--claim", replaced.claim, "--body", "Renaming");
  repository.write("implementation.txt", "implementation v2\n");
  const started = Date.now();
  const takeover = await waitAsync(repository, "--timeout", "120");
  // Neither the replaced round's lease nor its unfinished work holds the new agent back.
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
  assert.deepEqual(threadIds(takeover), ["rename"]);
  assert.notEqual(takeover.claim, replaced.claim);
});
