import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { controlAgent, feedbackDirectory, sendFeedback, buildFeedbackTargetData } from "../../../skills/semantic-flow/scripts/semantic-view.mjs";
import { createImplementationWithStages, feedbackCli, flowCli } from "../helpers/repository.mjs";

function addThread(repository, id) {
  repository.feedback("thread", "add", "--id", id, "--comment-id", `${id}-note`, "--body", `Change ${id}.`,
    "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
}
const reply = (repository, id, commentId, author = "agent") =>
  repository.feedback("thread", "reply", "--id", id, "--comment-id", commentId, "--author", author, "--body", `${author} ${commentId}`);
const flowJson = (repository, ...args) => JSON.parse(repository.flow("feedback", "--json", ...args));
const reviewDirectory = (repository) => path.dirname(feedbackDirectory(repository.root));
const agentState = (repository) => JSON.parse(fs.readFileSync(path.join(reviewDirectory(repository), "agent.json"), "utf8"));
const threadIds = (result) => result.stages.flatMap((stage) => stage.threads.map((thread) => thread.id)).sort();
const reviewContext = (repository) => ({ reviewId: path.basename(reviewDirectory(repository)) });

function waitAsync(repository, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [flowCli, "feedback", "--json", "--wait", ...args], { cwd: repository.root, encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(JSON.parse(stdout)));
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("agent replies answer the claimed comment and keep follow-ups sent meanwhile queued", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "first");

  const round = flowJson(repository);
  assert.ok(round.claim);
  assert.deepEqual(threadIds(round), ["first"]);
  assert.match(round.stages[0].stageHead, /^[a-f0-9]{40}$/);
  reply(repository, "first", "follow-up", "user");
  reply(repository, "first", "answer");

  const thread = repository.readAbsoluteJson(repository.feedbackPath("threads", "first.json"));
  assert.equal(thread.comments.find((comment) => comment.id === "answer").respondsTo, "first-note");
  assert.equal(agentState(repository).lastRound.id, round.claim);
  const next = flowJson(repository);
  assert.deepEqual(threadIds(next), ["first"]);
  assert.deepEqual(next.stages[0].threads[0].comments.map((comment) => comment.body), ["Change first.", "user follow-up", "agent answer"]);
  reply(repository, "first", "second-answer");
  assert.deepEqual(flowJson(repository).stages, []);
  repository.feedback("validate");
});

test("claims keep threads from other runs until a new session replaces the listener", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "alpha");
  addThread(repository, "beta");

  const round = await waitAsync(repository, "--timeout", "5");
  assert.deepEqual(threadIds(round), ["alpha", "beta"]);
  const standalone = flowJson(repository);
  assert.deepEqual(standalone.stages, []);
  assert.equal(standalone.claimedElsewhere, 2);
  reply(repository, "alpha", "alpha-answer");
  assert.equal(flowJson(repository).claimedElsewhere, 1);

  const replacement = await waitAsync(repository, "--timeout", "5");
  assert.notEqual(replacement.session, round.session);
  assert.deepEqual(threadIds(replacement), ["beta"]);
  assert.deepEqual(await waitAsync(repository, "--session", round.session, "--timeout", "2"),
    { session: round.session, stopped: true, reason: "superseded" });
});

test("a listening session times out, takes one viewer send as one round, and stops on request", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "earlier");
  const first = await waitAsync(repository, "--timeout", "5");
  reply(repository, "earlier", "earlier-answer");
  const quiet = await waitAsync(repository, "--session", first.session, "--timeout", "1");
  assert.deepEqual(quiet, { session: first.session, timedOut: true });
  assert.ok(Date.now() - Date.parse(agentState(repository).session.heartbeatAt) < 60_000);

  const listening = waitAsync(repository, "--session", first.session, "--timeout", "30");
  await pause(1500);
  const context = { repoRoot: repository.root, feedbackCli, implementation: buildFeedbackTargetData(repository.root) };
  const sent = sendFeedback(context,
    [{ ref: 0, kind: "stage", id: "implementation", body: "A new note", attachments: [], clientId: "1" }],
    [{ ref: "reply-1", threadId: "earlier", body: "One more thing", attachments: [] }]);
  assert.equal(sent.ok, true);
  assert.equal(agentState(repository).sendingUntil, undefined);
  const round = await listening;
  assert.equal(round.stages[0].threads.length, 2);
  assert.ok(threadIds(round).includes("earlier"));

  for (const thread of threadIds(round)) reply(repository, thread, `${thread}-done`);
  const stopping = waitAsync(repository, "--session", first.session, "--timeout", "30");
  await pause(1500);
  controlAgent(reviewContext(repository), "stop", {});
  assert.deepEqual(await stopping, { session: first.session, stopped: true, reason: "stopped" });
  assert.equal(agentState(repository).session.endReason, "stopped");
});

test("agent questions are answered in the viewer and returned once by feedback", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.expectFeedbackFailure("No feedback round is in progress", "agent", "progress", "--body", "Working");
  repository.feedback("agent", "ask", "--id", "refund-email", "--body", "Should refunds skip the email?", "--choice", "Yes", "--choice", "No");
  repository.feedback("agent", "ask", "--id", "refund-email", "--body", "Should refunds skip the email?", "--choice", "Yes", "--choice", "No");
  repository.expectFeedbackFailure("already exists with different content", "agent", "ask", "--id", "refund-email", "--body", "Other");

  const status = controlAgent(reviewContext(repository), "respond", { requestId: "refund-email", body: "Yes" });
  assert.deepEqual(status.requests, []);
  assert.throws(() => controlAgent(reviewContext(repository), "respond", { requestId: "refund-email", body: "No" }), /already answered/);
  assert.deepEqual(flowJson(repository).responses, [{ id: "refund-email", question: "Should refunds skip the email?", answer: "Yes" }]);
  assert.deepEqual(flowJson(repository).responses, []);
});

test("restacking renews the running round and reports progress notes", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "change");
  flowJson(repository);
  repository.feedback("agent", "progress", "--body", "Changing the implementation stage");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.claims[0].activityAt = new Date(Date.now() - 20 * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));

  repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  repository.semantic("restack", "--from", "implementation");
  const renewed = agentState(repository).claims[0];
  assert.ok(Date.now() - Date.parse(renewed.activityAt) < 60_000);
  assert.equal(renewed.note, "Changing the implementation stage");
});

test("a replaced round's late reply answers only what that round claimed", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "late");
  const earlier = flowJson(repository);
  reply(repository, "late", "follow-up", "user");
  const replacement = flowJson(repository);
  assert.notEqual(replacement.claim, earlier.claim);
  assert.deepEqual(threadIds(replacement), ["late"]);

  repository.feedback("thread", "reply", "--id", "late", "--comment-id", "late-answer", "--author", "agent", "--claim", earlier.claim, "--body", "Answered the first note.");
  let thread = repository.readAbsoluteJson(repository.feedbackPath("threads", "late.json"));
  assert.equal(thread.comments.at(-1).respondsTo, "late-note");
  assert.deepEqual(agentState(repository).claims.map((claim) => [claim.id, claim.threads[0].answeredAt]), [[replacement.claim, undefined]]);
  repository.expectFeedbackFailure("is not part of round", "thread", "reply", "--id", "late", "--comment-id", "unknown", "--author", "agent", "--claim", "missing-round", "--body", "?");
  repository.expectFeedbackFailure("--claim applies only to agent replies", "thread", "reply", "--id", "late", "--comment-id", "user-claim", "--claim", earlier.claim, "--body", "?");

  repository.feedback("thread", "reply-batch", "--replies", JSON.stringify([{ id: "late", "comment-id": "final", author: "agent", body: "Done." }]), "--claim", replacement.claim);
  thread = repository.readAbsoluteJson(repository.feedbackPath("threads", "late.json"));
  assert.equal(thread.comments.at(-1).respondsTo, "follow-up");
  assert.equal(agentState(repository).lastRound.id, replacement.claim);
  assert.deepEqual(flowJson(repository).stages, []);
});

test("a listener does not claim feedback while a viewer send is still writing", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  const { session } = await waitAsync(repository, "--timeout", "1");
  addThread(repository, "sending");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const claimNext = () => JSON.parse(repository.feedback("next", "--json", "--compact", "--claim", "--session", session));
  fs.writeFileSync(file, JSON.stringify({ ...agentState(repository), sendingUntil: new Date(Date.now() + 60_000).toISOString() }));
  assert.deepEqual(claimNext(), { claim: null, claimedElsewhere: 0, stages: [] });
  const { sendingUntil, ...settled } = agentState(repository);
  fs.writeFileSync(file, JSON.stringify(settled));
  assert.deepEqual(claimNext().stages.flatMap((stage) => stage.threads.map((thread) => thread.id)), ["sending"]);
});

test("JSON input carries agent messages verbatim and a batch round applies only to agent replies", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "mixed");
  const round = flowJson(repository);
  const input = (name, value) => {
    const file = path.join(fs.mkdtempSync(path.join(path.dirname(repository.root), "semantic-input-")), `${name}.json`);
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  repository.feedback("agent", "ask", "--input", input("ask", { id: "shell-text", body: "Keep `$(rm -rf x)` literal?", choice: ["Yes", "No"] }));
  assert.deepEqual(agentState(repository).requests.map(({ body, choices }) => ({ body, choices })), [{ body: "Keep `$(rm -rf x)` literal?", choices: ["Yes", "No"] }]);
  repository.feedback("thread", "reply-batch", "--input", input("batch", { claim: round.claim, replies: [
    { id: "mixed", "comment-id": "reviewer-note", author: "user", body: "Reviewer aside." },
    { id: "mixed", "comment-id": "agent-note", author: "agent", body: "Renamed to `isCancellable`." },
  ] }));
  const comments = repository.readAbsoluteJson(repository.feedbackPath("threads", "mixed.json")).comments;
  assert.equal(comments.find((comment) => comment.id === "agent-note").body, "Renamed to `isCancellable`.");
  assert.equal(comments.find((comment) => comment.id === "agent-note").respondsTo, "mixed-note");
  assert.equal(agentState(repository).lastRound.id, round.claim);
});
