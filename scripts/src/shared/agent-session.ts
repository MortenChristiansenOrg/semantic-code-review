/** Runtime coordination between the viewer and the implementation agent.
 * Stored beside the review's feedback as `agent.json`; it is not part of the
 * feedback format and every change holds the per-review lock. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseJson } from "./json.js";
import { isRecord, isStringArray } from "./narrow.js";
import { atomicJson, reviewDirectory, withReviewLock } from "./review-store.js";
import type { AgentStatus } from "./viewer-protocol.js";

/** A claim without agent activity for this long returns its threads to the queue. */
export const CLAIM_LEASE_MS = 30 * 60_000;
/** A listener counts as present this long after its last heartbeat, covering re-arming. */
export const LISTENER_GRACE_MS = 90_000;
/** Upper bound for one viewer send; a crashed send cannot hold feedback back longer. */
export const SENDING_LIMIT_MS = 60_000;
/** A listening session ends after this long without new feedback. */
export const IDLE_LIMIT_MS = 2 * 60 * 60_000;
/** How long a listener leaves a finished round's unanswered threads claimed, so
 * replies posted alongside the next wait land before the threads return to the queue. */
export const REPLY_GRACE_MS = 10_000;
/** Released and completed rounds remembered for fencing late replies. */
const RETIRED_CLAIM_LIMIT = 50;

export interface ClaimedThread { id: string; through: string; answeredAt?: string }
export interface AgentClaim {
  id: string; sessionId: string | null; startedAt: string; activityAt: string;
  threads: ClaimedThread[]; note?: string;
  /** When a listener first found this round finished with threads still unanswered. */
  releasingAt?: string;
  /** Set as a new session takes the round's threads over; kept only by its retired record. */
  replaced?: true;
}
export interface AgentRequest {
  id: string; sessionId: string | null; body: string; choices: string[]; createdAt: string;
  /** The round that asked; the question goes when another agent takes that round over. */
  claimId?: string;
  response?: { body: string; respondedAt: string };
}
export interface AgentSession {
  id: string; startedAt: string; heartbeatAt: string; feedbackAt: string;
  stopRequestedAt?: string; endedAt?: string; endReason?: string;
}
/** What a released or completed round answered, so its late replies stay fenced.
 * `replaced`: another session took its threads over, so it posts no more replies. */
export interface RetiredClaim { id: string; threads: { id: string; through: string }[]; sessionId?: string | null; replaced?: true }
/** The latest automatic move of the implementation onto its advanced target branch. */
export interface TargetRefresh { at: string; targetBranch: string; previousBaseRevision: string; baseRevision: string }
export interface AgentState {
  session: AgentSession | null;
  claims: AgentClaim[];
  retiredClaims: RetiredClaim[];
  requests: AgentRequest[];
  /** Viewer sends in progress, by send token, with their expiry. */
  sends: Record<string, string>;
  lastRound?: { id: string; completedAt: string; threadIds: string[] };
  targetRefresh?: TargetRefresh;
}

const iso = (now: number) => new Date(now).toISOString();
const age = (now: number, value?: string) => value ? now - Date.parse(value) : Infinity;

function agentFile(reviewId: string) {
  return path.join(reviewDirectory(reviewId), "agent.json");
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
/** An optional field; a value of the wrong type counts as absent, as it did when
 * the state was read untyped, so it never costs the entry that holds it. */
const optional = (value: unknown): string | undefined => (isString(value) ? value : undefined);
/** The entries that parse; entries missing a required field are dropped. */
function listOf<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] {
  return Array.isArray(value) ? value.flatMap((entry: unknown) => {
    const parsed = parse(entry);
    return parsed === undefined ? [] : [parsed];
  }) : [];
}

function parseClaimedThread(value: unknown): ClaimedThread | undefined {
  if (!isRecord(value) || !isString(value.id) || !isString(value.through)) return undefined;
  const answeredAt = optional(value.answeredAt);
  return { id: value.id, through: value.through, ...(answeredAt === undefined ? {} : { answeredAt }) };
}
function parseAgentClaim(value: unknown): AgentClaim | undefined {
  if (!isRecord(value) || !isString(value.id) || !isNullableString(value.sessionId) || !isString(value.startedAt) ||
    !isString(value.activityAt) || !Array.isArray(value.threads)) return undefined;
  const threads = listOf(value.threads, parseClaimedThread);
  // A claim whose thread ownership cannot be read is not trusted to fence anything.
  if (threads.length !== value.threads.length) return undefined;
  const note = optional(value.note), releasingAt = optional(value.releasingAt);
  return { id: value.id, sessionId: value.sessionId, startedAt: value.startedAt, activityAt: value.activityAt, threads,
    ...(note === undefined ? {} : { note }), ...(releasingAt === undefined ? {} : { releasingAt }) };
}
function parseRetiredThread(value: unknown): RetiredClaim["threads"][number] | undefined {
  return isRecord(value) && isString(value.id) && isString(value.through) ? { id: value.id, through: value.through } : undefined;
}
function parseRetiredClaim(value: unknown): RetiredClaim | undefined {
  if (!isRecord(value) || !isString(value.id) || !Array.isArray(value.threads)) return undefined;
  const threads = listOf(value.threads, parseRetiredThread);
  if (threads.length !== value.threads.length) return undefined;
  return { id: value.id, threads, ...(isNullableString(value.sessionId) ? { sessionId: value.sessionId } : {}),
    ...(value.replaced === true ? { replaced: true as const } : {}) };
}
function parseAgentRequest(value: unknown): AgentRequest | undefined {
  if (!isRecord(value) || !isString(value.id) || !isNullableString(value.sessionId) || !isString(value.body) ||
    !isString(value.createdAt)) return undefined;
  const { response } = value;
  const answered = isRecord(response) && isString(response.body) && isString(response.respondedAt)
    ? { response: { body: response.body, respondedAt: response.respondedAt } } : {};
  const claimId = optional(value.claimId);
  return { id: value.id, sessionId: value.sessionId, body: value.body, choices: isStringArray(value.choices) ? value.choices : [],
    createdAt: value.createdAt, ...(claimId === undefined ? {} : { claimId }), ...answered };
}
function parseAgentSession(value: unknown): AgentSession | undefined {
  if (!isRecord(value) || !isString(value.id) || !isString(value.startedAt) || !isString(value.heartbeatAt) ||
    !isString(value.feedbackAt)) return undefined;
  const session: AgentSession = { id: value.id, startedAt: value.startedAt, heartbeatAt: value.heartbeatAt, feedbackAt: value.feedbackAt };
  const stopRequestedAt = optional(value.stopRequestedAt), endedAt = optional(value.endedAt), endReason = optional(value.endReason);
  if (stopRequestedAt !== undefined) session.stopRequestedAt = stopRequestedAt;
  if (endedAt !== undefined) session.endedAt = endedAt;
  if (endReason !== undefined) session.endReason = endReason;
  return session;
}
function isLastRound(value: unknown): value is NonNullable<AgentState["lastRound"]> {
  return isRecord(value) && isString(value.id) && isString(value.completedAt) && isStringArray(value.threadIds);
}
function isTargetRefresh(value: unknown): value is TargetRefresh {
  return isRecord(value) && isString(value.at) && isString(value.targetBranch) &&
    isString(value.previousBaseRevision) && isString(value.baseRevision);
}
function sendsOf(value: unknown): Record<string, string> {
  const sends: Record<string, string> = {};
  if (isRecord(value)) for (const [token, until] of Object.entries(value)) if (isString(until)) sends[token] = until;
  return sends;
}

/** Missing or unreadable runtime state is treated as idle. Entries missing a
 * required field are dropped; malformed optional fields count as absent. */
export function readAgentState(reviewId: string): AgentState {
  let value: unknown = null;
  try { value = parseJson(fs.readFileSync(agentFile(reviewId), "utf8")); }
  catch { /* No agent has coordinated with this review yet. */ }
  const stored = isRecord(value) ? value : {};
  return {
    session: parseAgentSession(stored.session) ?? null,
    claims: listOf(stored.claims, parseAgentClaim),
    retiredClaims: listOf(stored.retiredClaims, parseRetiredClaim),
    requests: listOf(stored.requests, parseAgentRequest),
    sends: sendsOf(stored.sends),
    ...(isLastRound(stored.lastRound) ? { lastRound: stored.lastRound } : {}),
    ...(isTargetRefresh(stored.targetRefresh) ? { targetRefresh: stored.targetRefresh } : {}),
  };
}

/** Applies one locked change. Reviews whose data was deleted are left untouched. */
export function updateAgentState<T>(reviewId: string, change: (state: AgentState, now: number) => T): T {
  return withReviewLock(reviewId, () => {
    const state = readAgentState(reviewId);
    const before = JSON.stringify(state);
    const previous = [...state.claims];
    const now = Date.now();
    const result = change(state, now);
    state.claims = state.claims.filter((claim) => claimActive(claim, now));
    for (const [token, until] of Object.entries(state.sends)) if (age(now, until) >= 0) delete state.sends[token];
    const remaining = new Set(state.claims.map((claim) => claim.id));
    const retired = previous.filter((claim) => !remaining.has(claim.id))
      .map((claim) => ({ id: claim.id, threads: claim.threads.map(({ id, through }) => ({ id, through })),
        sessionId: claim.sessionId, ...(claim.replaced ? { replaced: true as const } : {}) }));
    if (retired.length) state.retiredClaims = [...state.retiredClaims, ...retired].slice(-RETIRED_CLAIM_LIMIT);
    if (JSON.stringify(state) !== before && fs.existsSync(path.join(reviewDirectory(reviewId), "review.json"))) atomicJson(agentFile(reviewId), state);
    return result;
  });
}

export function claimActive(claim: AgentClaim, now: number) {
  return age(now, claim.activityAt) < CLAIM_LEASE_MS && claim.threads.some((thread) => !thread.answeredAt);
}

export function liveSession(state: AgentState) {
  return state.session && !state.session.endedAt ? state.session : null;
}

/** Threads another round is still answering. */
export function claimedThreadIds(state: AgentState, now: number) {
  return new Set(state.claims.filter((claim) => claimActive(claim, now))
    .flatMap((claim) => claim.threads.filter((thread) => !thread.answeredAt).map((thread) => thread.id)));
}

/** Extends the lease of the named rounds and keeps the session visibly present.
 * Without names it renews the live session's rounds, or standalone rounds when no
 * session runs, so activity never keeps an abandoned round from expiring. */
export function touchAgent(state: AgentState, now: number, claimIds?: Iterable<string>) {
  const session = liveSession(state);
  const named = claimIds ? new Set(claimIds) : null;
  for (const claim of state.claims) {
    const owned = named ? named.has(claim.id) : claim.sessionId === (session?.id ?? null);
    if (owned && claimActive(claim, now)) claim.activityAt = iso(now);
  }
  if (session) session.heartbeatAt = iso(now);
}

/** Starting to listen replaces any earlier session and returns the threads of every running round to the queue. */
export function startSession(state: AgentState, now: number): AgentSession {
  for (const claim of state.claims) replaceRound(state, claim);
  endSession(state, now, "superseded");
  state.claims = [];
  const session = { id: randomUUID(), startedAt: iso(now), heartbeatAt: iso(now), feedbackAt: iso(now) };
  state.session = session;
  return session;
}

/** Ends the live session; threads its unfinished round still holds return to the queue. */
export function endSession(state: AgentState, now: number, reason: string) {
  const session = liveSession(state);
  if (!session) return;
  session.endedAt = iso(now);
  session.endReason = reason;
  releaseClaims(state, session.id);
  state.requests = state.requests.filter((request) => request.sessionId !== session.id);
}

/** Records the threads one round answers, through each thread's latest user comment. */
export function createClaim(state: AgentState, now: number, sessionId: string | null, threads: ClaimedThread[]) {
  if (!threads.length) return null;
  const claim: AgentClaim = { id: randomUUID(), sessionId, startedAt: iso(now), activityAt: iso(now), threads };
  state.claims.push(claim);
  // A listening session that takes a thread over from another agent's expired or
  // retired round replaces that round; a round its own session reissued keeps
  // answering, as does a retired round recorded without its session.
  if (sessionId) {
    const taken = new Set(threads.map((thread) => thread.id));
    for (const earlier of [...state.claims, ...state.retiredClaims]) {
      if (earlier === claim || earlier.sessionId === undefined || earlier.sessionId === sessionId) continue;
      if (earlier.threads.some((thread) => taken.has(thread.id))) replaceRound(state, earlier);
    }
  }
  const session = liveSession(state);
  if (session && session.id === sessionId) session.feedbackAt = iso(now);
  return claim.id;
}

/** Marks a round as taken over and drops the questions it asked, which its agent no longer awaits. */
function replaceRound(state: AgentState, round: AgentClaim | RetiredClaim) {
  round.replaced = true;
  state.requests = state.requests.filter((request) => request.claimId !== round.id);
}

/** Releases claims so their unanswered threads can be picked up again. */
export function releaseClaims(state: AgentState, sessionId: string | null) {
  state.claims = state.claims.filter((claim) => claim.sessionId !== sessionId);
}

/** Returns a finished round's unanswered threads to the queue once replies had
 * time to land. Reports whether a round is still settling and the threads released now. */
export function settleSessionClaims(state: AgentState, now: number, sessionId: string) {
  const released: string[] = [];
  let settling = false;
  state.claims = state.claims.filter((claim) => {
    if (claim.sessionId !== sessionId || !claimActive(claim, now)) return true;
    claim.releasingAt ??= iso(now);
    if (age(now, claim.releasingAt) < REPLY_GRACE_MS) return settling = true;
    released.push(...claim.threads.filter((thread) => !thread.answeredAt).map((thread) => thread.id));
    return false;
  });
  return { settling, released };
}

/** A session's round that asked the reviewer something keeps its threads until the answer is collected. */
export function roundAwaitingAnswer(state: AgentState, now: number, sessionId: string) {
  return state.claims.some((claim) => claim.sessionId === sessionId && claimActive(claim, now)) &&
    state.requests.some((request) => request.sessionId === sessionId);
}

/** Keeps the session's running round from expiring while it waits for the reviewer. */
export function renewSessionClaims(state: AgentState, now: number, sessionId: string) {
  for (const claim of state.claims) if (claim.sessionId === sessionId && claimActive(claim, now)) claim.activityAt = iso(now);
}

/** The user comment a reply to this thread answers, when a running round claimed it. */
export function claimedThrough(state: AgentState, now: number, threadId: string) {
  for (const claim of state.claims) {
    if (!claimActive(claim, now)) continue;
    const thread = claim.threads.find((item) => item.id === threadId && !item.answeredAt);
    if (thread) return thread.through;
  }
  return undefined;
}

/** Whether a new session took the named round's threads over. Its agent answers
 * them, so the replaced round must not. */
export function roundReplaced(state: AgentState, claimId: string) {
  return state.retiredClaims.some((item) => item.id === claimId && item.replaced);
}

/** What an agent whose round was replaced is told, whichever command it ran. */
export function replacedRoundMessage(claimId: string) {
  return `Round ${claimId} was replaced: another agent started listening to this review and took over its threads. ` +
    "Make no further changes for this round: no commits, restacks, stage changes, questions or replies. End with one short line.";
}

/** Who changes the implementation: the agent of a feedback round, a listening
 * session itself (its automatic target restack), or null for a change outside any round. */
export type RoundIdentity = { claim: string } | { session: string } | null;

/** Why the implementation may not be changed for round now, or undefined when it may.
 * A named round may change it unless another agent took it over. A change that names
 * no round is refused while a listening session's round runs, so the agent of a
 * replaced round that forgets its claim cannot change the stages the new round works on. */
export function roundRefusal(state: AgentState, now: number, round: RoundIdentity): string | undefined {
  if (round && "claim" in round) {
    if (roundReplaced(state, round.claim)) return replacedRoundMessage(round.claim);
    const known = state.claims.some((claim) => claim.id === round.claim) || state.retiredClaims.some((claim) => claim.id === round.claim);
    return known ? undefined : `Round ${round.claim} is not a feedback round of this review. Pass the claim the feedback preflight or wait returned.`;
  }
  if (round) return liveSession(state)?.id === round.session ? undefined : "This listening session was replaced or stopped.";
  const session = liveSession(state);
  if (session && state.claims.some((claim) => claim.sessionId === session.id && claimActive(claim, now))) {
    return "A listening agent is answering a feedback round of this review. If this change belongs to your round, " +
      "pass the claim your feedback preflight or wait returned with --claim. Any other change waits until the round is finished.";
  }
  return undefined;
}

/** The session a named round belongs to, for the questions it asks. Fails when the
 * round was replaced or is unknown. */
export function roundSession(state: AgentState, now: number, claimId: string): string | null {
  const refusal = roundRefusal(state, now, { claim: claimId });
  if (refusal) throw new Error(refusal);
  const claim = state.claims.find((item) => item.id === claimId) ?? state.retiredClaims.find((item) => item.id === claimId);
  return claim?.sessionId ?? null;
}

/** The comment a named round answers in a thread, even after the round was released. */
export function roundThrough(state: AgentState, claimId: string, threadId: string) {
  const claim = state.claims.find((item) => item.id === claimId) ?? state.retiredClaims.find((item) => item.id === claimId);
  return claim?.threads.find((thread) => thread.id === threadId)?.through;
}

/** Marks agent replies; a round completes when every claimed thread has one.
 * A reply naming its round only counts for that round, or for a newer round that
 * holds the same reviewer comment, so a replaced round never ends a newer one early. */
export function recordAgentReplies(state: AgentState, now: number, replies: { threadId: string; claimId?: string }[]) {
  const answering = new Set<string>();
  const answers = (reply: { threadId: string; claimId?: string }, claim: AgentClaim, thread: ClaimedThread) =>
    reply.threadId === thread.id && (!reply.claimId || reply.claimId === claim.id || roundThrough(state, reply.claimId, thread.id) === thread.through);
  for (const claim of state.claims) {
    if (!claimActive(claim, now)) continue;
    for (const thread of claim.threads) {
      if (!thread.answeredAt && replies.some((reply) => answers(reply, claim, thread))) {
        thread.answeredAt = iso(now);
        answering.add(claim.id);
      }
    }
    if (claim.threads.every((thread) => thread.answeredAt)) {
      state.lastRound = { id: claim.id, completedAt: iso(now), threadIds: claim.threads.map((thread) => thread.id) };
      // A finished round counts as activity, so a long round does not end the session as idle.
      const session = liveSession(state);
      if (session && session.id === claim.sessionId) session.feedbackAt = iso(now);
    }
  }
  touchAgent(state, now, answering);
}

/** Each send owns a token, so one finishing send never clears another's marker. */
export function markSending(state: AgentState, now: number, token: string, sending: boolean) {
  if (sending) state.sends[token] = iso(now + SENDING_LIMIT_MS);
  else delete state.sends[token];
}

export function sendInProgress(state: AgentState, now: number) {
  return Object.values(state.sends).some((until) => age(now, until) < 0);
}

/** Adds a question for the reviewer. A question that names its round belongs to that
 * round's session; one that names none is asked outside any listening session. */
export function addRequest(state: AgentState, now: number, id: string, body: string, choices: string[], claimId?: string) {
  const sessionId = claimId === undefined ? null : roundSession(state, now, claimId);
  if (claimId === undefined && liveSession(state)) {
    throw new Error("An agent is listening to this review. Pass the claim of the round this question belongs to with --claim.");
  }
  const existing = state.requests.find((request) => request.id === id);
  if (existing) {
    if (existing.body !== body || JSON.stringify(existing.choices) !== JSON.stringify(choices)) throw new Error(`Request ${id} already exists with different content.`);
    return existing;
  }
  const request: AgentRequest = { id, sessionId, body, choices, createdAt: iso(now), ...(claimId === undefined ? {} : { claimId }) };
  state.requests.push(request);
  touchAgent(state, now, claimId === undefined ? undefined : [claimId]);
  return request;
}

export function respondToRequest(state: AgentState, now: number, id: string, body: string) {
  const request = state.requests.find((item) => item.id === id);
  if (!request) throw new Error("The agent no longer needs this answer.");
  if (request.response) {
    if (request.response.body === body) return request;
    throw new Error("This question was already answered.");
  }
  request.response = { body, respondedAt: iso(now) };
  return request;
}

/** Returns and removes answered requests for the given session (or sessionless runs). */
export function takeResponses(state: AgentState, sessionId: string | null) {
  const answered: { id: string; question: string; answer: string }[] = [];
  state.requests = state.requests.filter((request) => {
    if (!request.response || (request.sessionId !== sessionId && request.sessionId !== null)) return true;
    answered.push({ id: request.id, question: request.body, answer: request.response.body });
    return false;
  });
  return answered;
}

/** Viewer-facing summary; contains no paths or process details. */
export function agentStatus(state: AgentState, now: number): AgentStatus {
  const session = liveSession(state);
  const claims = state.claims.filter((claim) => claimActive(claim, now));
  const threads = claims.flatMap((claim) => claim.threads.map((thread) => ({ id: thread.id, answered: Boolean(thread.answeredAt) })));
  const latest = claims.at(-1);
  return {
    session: Boolean(session),
    listening: Boolean(session && age(now, session.heartbeatAt) < LISTENER_GRACE_MS),
    stopRequested: Boolean(session?.stopRequestedAt),
    working: claims.length ? {
      startedAt: claims.map((claim) => claim.startedAt).sort()[0],
      threads,
      ...(latest?.note ? { note: latest.note } : {}),
    } : null,
    requests: state.requests.filter((request) => !request.response)
      .map(({ id, body, choices, createdAt }) => ({ id, body, choices, createdAt })),
    lastRound: state.lastRound ?? null,
    targetRefresh: state.targetRefresh ?? null,
    serverTime: iso(now),
  };
}
export type { AgentStatus };
