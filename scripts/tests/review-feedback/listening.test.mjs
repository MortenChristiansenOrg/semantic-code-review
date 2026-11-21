import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { controlAgent, feedbackDirectory, readReview, sendFeedback, setReviewCompleted, buildFeedbackTargetData } from "../../src/semantic-view.ts";
import { createImplementationWithStages, flowCli } from "../helpers/repository.mjs";

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
  const context = { repoRoot: repository.root, implementation: buildFeedbackTargetData(repository.root) };
  const sent = sendFeedback(context,
    [{ ref: 0, kind: "stage", id: "implementation", body: "A new note", attachments: [], clientId: "1" }],
    [{ ref: "reply-1", threadId: "earlier", body: "One more thing", attachments: [] }]);
  assert.equal(sent.ok, true);
  assert.deepEqual(agentState(repository).sends, {});
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

test("standalone runs leave another run's active round alone", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "busy");
  const first = flowJson(repository);
  assert.deepEqual(threadIds(first), ["busy"]);
  const second = flowJson(repository);
  assert.deepEqual(second.stages, []);
  assert.equal(second.claimedElsewhere, 1);
  assert.equal(second.claim, null);
});

test("a round another agent's session took over posts no more replies, and a standalone round started later still does", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "late");
  addThread(repository, "solo");
  const earlier = await waitAsync(repository, "--timeout", "5");
  reply(repository, "late", "follow-up", "user");
  const replacement = await waitAsync(repository, "--timeout", "5");
  assert.notEqual(replacement.session, earlier.session);
  assert.deepEqual(threadIds(replacement), ["late", "solo"]);

  repository.expectFeedbackFailure("was replaced", "thread", "reply", "--id", "late", "--comment-id", "late-answer", "--author", "agent", "--claim", earlier.claim, "--body", "Answered the first note.");
  repository.expectFeedbackFailure("was replaced", "thread", "reply-batch", "--replies", JSON.stringify([{ id: "solo", "comment-id": "solo-answer", author: "agent", body: "Done." }]), "--claim", earlier.claim);
  assert.deepEqual(repository.readAbsoluteJson(repository.feedbackPath("threads", "late.json")).comments.map((comment) => comment.id), ["late-note", "follow-up"]);
  assert.deepEqual(repository.readAbsoluteJson(repository.feedbackPath("threads", "solo.json")).comments.map((comment) => comment.id), ["solo-note"]);
  repository.expectFeedbackFailure("is not part of round", "thread", "reply", "--id", "late", "--comment-id", "unknown", "--author", "agent", "--claim", "missing-round", "--body", "?");
  repository.expectFeedbackFailure("--claim applies only to agent replies", "thread", "reply", "--id", "late", "--comment-id", "user-claim", "--claim", earlier.claim, "--body", "?");

  repository.feedback("thread", "reply-batch", "--replies", JSON.stringify([{ id: "late", "comment-id": "final", author: "agent", body: "Done." }]), "--claim", replacement.claim);
  const thread = repository.readAbsoluteJson(repository.feedbackPath("threads", "late.json"));
  assert.equal(thread.comments.at(-1).respondsTo, "follow-up");

  // A standalone round taken while the session listens is not replaced by it.
  reply(repository, "late", "again", "user");
  const standalone = flowJson(repository);
  assert.deepEqual(threadIds(standalone), ["late"]);
  repository.feedback("thread", "reply", "--id", "late", "--comment-id", "standalone-answer", "--author", "agent", "--claim", standalone.claim, "--body", "Done again.");
  repository.feedback("thread", "reply", "--id", "solo", "--comment-id", "solo-answer", "--author", "agent", "--claim", replacement.claim, "--body", "Done.");
  assert.equal(agentState(repository).lastRound.id, replacement.claim);
  assert.deepEqual(flowJson(repository).stages, []);
});

test("a round that retired before another agent took over posts no more replies, and its replaced wait skips validation", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "late");
  const first = await waitAsync(repository, "--timeout", "5");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.claims[0].releasingAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  const reissued = await waitAsync(repository, "--session", first.session, "--timeout", "5");
  assert.notEqual(reissued.claim, first.claim);

  const replacement = await waitAsync(repository, "--timeout", "5");
  assert.deepEqual(threadIds(replacement), ["late"]);
  for (const claim of [first.claim, reissued.claim]) {
    repository.expectFeedbackFailure("was replaced", "thread", "reply", "--id", "late", "--comment-id", `late-${claim}`, "--author", "agent", "--claim", claim, "--body", "Answered.");
  }
  // The replaced agent learns it was replaced even while the feedback fails validation.
  fs.writeFileSync(repository.feedbackPath("threads", "late.json"), "{");
  assert.deepEqual(await waitAsync(repository, "--session", first.session, "--timeout", "2"),
    { session: first.session, stopped: true, reason: "superseded" });
});

test("a listener that takes no thread from a retired round leaves that round's replies accepted", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "done");
  const standalone = flowJson(repository);
  repository.feedback("thread", "reply", "--id", "done", "--comment-id", "answer", "--author", "agent", "--claim", standalone.claim, "--body", "Done.");
  const listener = await waitAsync(repository, "--timeout", "1");
  assert.deepEqual(listener, { session: listener.session, timedOut: true });
  repository.feedback("thread", "reply", "--id", "done", "--comment-id", "addendum", "--author", "agent", "--claim", standalone.claim, "--body", "One more note.");
  assert.equal(repository.readAbsoluteJson(repository.feedbackPath("threads", "done.json")).comments.at(-1).respondsTo, "done-note");
});

test("a first wait on a completed review starts no session and leaves a running round its threads", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "finishing");
  const standalone = flowJson(repository);
  assert.deepEqual(threadIds(standalone), ["finishing"]);
  const { reviewId } = reviewContext(repository);
  setReviewCompleted(reviewId, readReview(reviewId).generation, true, null);

  assert.deepEqual(await waitAsync(repository, "--timeout", "5"), { session: null, stopped: true, reason: "completed" });
  assert.equal(agentState(repository).session, null);
  repository.feedback("thread", "reply", "--id", "finishing", "--comment-id", "finished", "--author", "agent", "--claim", standalone.claim, "--body", "Done.");
  assert.equal(agentState(repository).lastRound.id, standalone.claim);
});

test("a wait started alongside the round's replies does not reissue the round", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "racing");
  const round = await waitAsync(repository, "--timeout", "5");
  const next = waitAsync(repository, "--session", round.session, "--timeout", "4");
  // Reply only once the wait found the round unanswered, as when both run as parallel tool calls.
  for (const deadline = Date.now() + 10_000; !agentState(repository).claims[0]?.releasingAt;) {
    assert.ok(Date.now() < deadline, "the wait never examined the round");
    await pause(20);
  }
  repository.feedback("thread", "reply-batch", "--replies", JSON.stringify([{ id: "racing", "comment-id": "racing-answer", author: "agent", body: "Done." }]), "--claim", round.claim);
  assert.deepEqual(await next, { session: round.session, timedOut: true });
  const state = agentState(repository);
  assert.deepEqual(state.claims, []);
  assert.equal(state.lastRound.id, round.claim);
});

test("an idle or stopping session lets a racing reply land before it ends", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "settling");
  const round = await waitAsync(repository, "--timeout", "5");
  addThread(repository, "queued");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.session.feedbackAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  state.session.stopRequestedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  const next = waitAsync(repository, "--session", round.session, "--timeout", "30");
  for (const deadline = Date.now() + 10_000; !agentState(repository).claims[0]?.releasingAt;) {
    assert.ok(Date.now() < deadline, "the wait never examined the round");
    await pause(20);
  }
  assert.equal(agentState(repository).session.endedAt, undefined);
  repository.feedback("thread", "reply-batch", "--replies", JSON.stringify([{ id: "settling", "comment-id": "settling-answer", author: "agent", body: "Done." }]), "--claim", round.claim);
  assert.deepEqual(await next, { session: round.session, stopped: true, reason: "stopped" });
  assert.equal(agentState(repository).lastRound.id, round.claim);
  assert.deepEqual(agentState(repository).claims, []); // A pending Stop starts no new round.
});

test("a finished round's unanswered threads return after the grace, and a late reply answers the reissued round", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "late");
  const first = await waitAsync(repository, "--timeout", "5");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.claims[0].releasingAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  const reissued = await waitAsync(repository, "--session", first.session, "--timeout", "5");
  assert.notEqual(reissued.claim, first.claim);
  assert.deepEqual(threadIds(reissued), ["late"]);

  repository.feedback("thread", "reply", "--id", "late", "--comment-id", "late-answer", "--author", "agent", "--claim", first.claim, "--body", "Answered.");
  assert.equal(repository.readAbsoluteJson(repository.feedbackPath("threads", "late.json")).comments.at(-1).respondsTo, "late-note");
  assert.deepEqual(agentState(repository).claims, []);
  assert.equal(agentState(repository).lastRound.id, reissued.claim);
});

test("a listener does not claim feedback while a viewer send is still writing", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  const { session } = await waitAsync(repository, "--timeout", "1");
  addThread(repository, "sending");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const claimNext = () => JSON.parse(repository.feedback("next", "--json", "--compact", "--claim", "--session", session));
  const until = new Date(Date.now() + 60_000).toISOString();
  const sends = (value) => fs.writeFileSync(file, JSON.stringify({ ...agentState(repository), sends: value }));
  sends({ first: until, second: until });
  assert.deepEqual(claimNext(), { claim: null, claimedElsewhere: 0, stages: [] });
  sends({ second: until }); // One send finishing never clears another's marker.
  assert.deepEqual(claimNext(), { claim: null, claimedElsewhere: 0, stages: [] });
  sends({});
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

test("a round waiting for the reviewer keeps its work, lease, and answers through Stop", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "decide");
  const round = await waitAsync(repository, "--timeout", "5");
  // An unrestacked correction makes the stack temporarily invalid while the round waits.
  repository.commitFile("implementation.txt", "implementation v2\n", "Work in progress");
  repository.feedback("agent", "ask", "--id", "which-way", "--body", "Which way?");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const stale = new Date(Date.now() - 20 * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...agentState(repository), claims: agentState(repository).claims.map((claim) => ({ ...claim, activityAt: stale })) }));
  controlAgent(reviewContext(repository), "stop", {});
  assert.deepEqual(await waitAsync(repository, "--session", round.session, "--timeout", "2"), { session: round.session, timedOut: true });
  assert.ok(Date.parse(agentState(repository).claims[0].activityAt) > Date.parse(stale));

  controlAgent(reviewContext(repository), "respond", { requestId: "which-way", body: "Left" });
  assert.deepEqual((await waitAsync(repository, "--session", round.session, "--timeout", "5")).responses, [{ id: "which-way", question: "Which way?", answer: "Left" }]);
  repository.semantic("restack", "--from", "implementation");
  repository.feedback("thread", "reply", "--id", "decide", "--comment-id", "done", "--author", "agent", "--claim", round.claim, "--body", "Went left.");
  assert.deepEqual(await waitAsync(repository, "--session", round.session, "--timeout", "5"), { session: round.session, stopped: true, reason: "stopped" });
});

test("idle sessions still take waiting feedback before ending", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  const { session } = await waitAsync(repository, "--timeout", "1");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const age = (state) => ({ ...state, session: { ...state.session, feedbackAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } });
  addThread(repository, "late-night");
  fs.writeFileSync(file, JSON.stringify(age(agentState(repository))));
  const round = await waitAsync(repository, "--session", session, "--timeout", "5");
  assert.deepEqual(threadIds(round), ["late-night"]);
  repository.feedback("thread", "reply", "--id", "late-night", "--comment-id", "answered", "--author", "agent", "--claim", round.claim, "--body", "Done.");
  fs.writeFileSync(file, JSON.stringify(age(agentState(repository))));
  assert.deepEqual(await waitAsync(repository, "--session", session, "--timeout", "5"), { session, stopped: true, reason: "idle" });
});

test("agent activity renews only its own round, so an abandoned round still expires", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "active");
  const round = await waitAsync(repository, "--timeout", "5");
  assert.deepEqual(threadIds(round), ["active"]);
  // A standalone run that crashed earlier still holds another thread.
  addThread(repository, "orphaned");
  const file = path.join(reviewDirectory(repository), "agent.json");
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  const abandoned = { id: "abandoned", sessionId: null, startedAt: old, activityAt: old, threads: [{ id: "orphaned", through: "orphaned-note" }] };
  fs.writeFileSync(file, JSON.stringify({ ...agentState(repository), claims: [...agentState(repository).claims, abandoned] }));
  const abandonedActivity = () => agentState(repository).claims.find((claim) => claim.id === "abandoned")?.activityAt;

  repository.feedback("agent", "progress", "--body", "Working");
  repository.feedback("agent", "ask", "--id", "check", "--body", "Check?");
  repository.commitFile("implementation.txt", "implementation v2\n", "Address feedback");
  repository.semantic("restack", "--from", "implementation");
  repository.feedback("thread", "reply", "--id", "active", "--comment-id", "done", "--author", "agent", "--claim", round.claim, "--body", "Done.");
  assert.equal(abandonedActivity(), old);
});

test("a malformed optional field in agent state keeps the claim it belongs to", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "kept");
  const round = flowJson(repository);
  const file = path.join(reviewDirectory(repository), "agent.json");
  const state = agentState(repository);
  state.claims[0].note = null;
  fs.writeFileSync(file, JSON.stringify(state));

  repository.feedback("agent", "progress", "--body", "Still working");
  const claim = agentState(repository).claims[0];
  assert.equal(claim.id, round.claim);
  assert.deepEqual(claim.threads.map((thread) => thread.id), ["kept"]);
  assert.equal(claim.note, "Still working");
});

test("a first wait that fails on invalid feedback does not stay listening", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  addThread(repository, "invalid");
  const file = repository.feedbackPath("threads", "invalid.json");
  const thread = repository.readAbsoluteJson(file);
  thread.status = "resolved";
  repository.writeAbsolute(file, JSON.stringify(thread));

  await assert.rejects(waitAsync(repository, "--timeout", "5"), /invalid\.json/);
  const { session } = agentState(repository);
  assert.ok(session.endedAt);
  assert.equal(session.endReason, "failed");
});

test("feedback commands use the review that registration gives an implementation whose review ID was retired", async (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  /** Leaves the review as a deletion does when it cannot reach the repository:
   * its folder is gone, and its ID, which the artifact still holds, is marked retired. */
  const retire = () => {
    const directory = reviewDirectory(repository), id = path.basename(directory);
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(directory), `.retired-${id}`), "");
    return directory;
  };
  const { session } = await waitAsync(repository, "--timeout", "1");
  // A session of the deleted review cannot be resumed.
  let retired = retire();
  const resumed = spawnSync(process.execPath, [flowCli, "feedback", "--json", "--wait", "--session", session, "--timeout", "1"], { cwd: repository.root, encoding: "utf8" });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, new RegExp(`was deleted, and session ${session} with it\\. Wait again without --session to start a new session\\.`));
  assert.equal(fs.existsSync(retired), false);
  // A new session listens on the new review.
  retired = retire();
  const fresh = await waitAsync(repository, "--timeout", "1");
  assert.equal(fresh.timedOut, true);
  assert.notEqual(reviewDirectory(repository), retired);
  assert.equal(fs.existsSync(retired), false);
  assert.equal(agentState(repository).session.id, fresh.session);
  // Feedback is initialized for the new review.
  retired = retire();
  repository.feedback("init");
  assert.notEqual(reviewDirectory(repository), retired);
  assert.equal(fs.existsSync(retired), false);
  assert.ok(fs.existsSync(repository.feedbackPath("manifest.json")));
});
