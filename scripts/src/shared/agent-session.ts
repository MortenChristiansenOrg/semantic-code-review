/** Runtime coordination between the viewer and the implementation agent.
 * Stored beside the review's feedback as `agent.json`; it is not part of the
 * feedback format and every change holds the per-review lock. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, reviewDirectory, withReviewLock } from "./review-store.js";

/** A claim without agent activity for this long returns its threads to the queue. */
export const CLAIM_LEASE_MS = 30 * 60_000;
/** A listener counts as present this long after its last heartbeat, covering re-arming. */
export const LISTENER_GRACE_MS = 90_000;
/** Upper bound for one viewer send; a crashed send cannot hold feedback back longer. */
export const SENDING_LIMIT_MS = 60_000;
/** An interactive session ends after this long without new feedback. */
export const IDLE_LIMIT_MS = 2 * 60 * 60_000;
/** Released and completed rounds remembered for fencing late replies. */
const RETIRED_CLAIM_LIMIT = 50;

export interface ClaimedThread { id: string; through: string; answeredAt?: string }
export interface AgentClaim {
  id: string; sessionId: string | null; startedAt: string; activityAt: string;
  threads: ClaimedThread[]; note?: string;
}
export interface AgentRequest {
  id: string; sessionId: string | null; body: string; choices: string[]; createdAt: string;
  response?: { body: string; respondedAt: string };
}
export interface AgentSession {
  id: string; startedAt: string; heartbeatAt: string; feedbackAt: string;
  stopRequestedAt?: string; endedAt?: string; endReason?: string;
}
/** What a released or completed round answered, so its late replies stay fenced. */
export interface RetiredClaim { id: string; threads: { id: string; through: string }[] }
export interface AgentState {
  session: AgentSession | null;
  claims: AgentClaim[];
  retiredClaims: RetiredClaim[];
  requests: AgentRequest[];
  sendingUntil?: string;
  lastRound?: { id: string; completedAt: string; threadIds: string[] };
}

const iso = (now: number) => new Date(now).toISOString();
const age = (now: number, value?: string) => value ? now - Date.parse(value) : Infinity;

function agentFile(reviewId: string) {
  return path.join(reviewDirectory(reviewId), "agent.json");
}

/** Missing or unreadable runtime state is treated as idle. */
export function readAgentState(reviewId: string): AgentState {
  let value: any = null;
  try { value = JSON.parse(fs.readFileSync(agentFile(reviewId), "utf8")); }
  catch { /* No agent has coordinated with this review yet. */ }
  return {
    session: value?.session && typeof value.session.id === "string" ? value.session : null,
    claims: Array.isArray(value?.claims) ? value.claims : [],
    retiredClaims: Array.isArray(value?.retiredClaims) ? value.retiredClaims : [],
    requests: Array.isArray(value?.requests) ? value.requests : [],
    ...(typeof value?.sendingUntil === "string" ? { sendingUntil: value.sendingUntil } : {}),
    ...(value?.lastRound ? { lastRound: value.lastRound } : {}),
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
    const remaining = new Set(state.claims.map((claim) => claim.id));
    const retired = previous.filter((claim) => !remaining.has(claim.id))
      .map((claim) => ({ id: claim.id, threads: claim.threads.map(({ id, through }) => ({ id, through })) }));
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

/** Extends the lease of every running round and keeps the session visibly present. */
export function touchAgent(state: AgentState, now: number) {
  for (const claim of state.claims) if (claimActive(claim, now)) claim.activityAt = iso(now);
  const session = liveSession(state);
  if (session) session.heartbeatAt = iso(now);
}

/** Starting an interactive review replaces any earlier session and returns its threads to the queue. */
export function startSession(state: AgentState, now: number): AgentSession {
  endSession(state, now, "superseded");
  state.claims = [];
  const session = { id: randomUUID(), startedAt: iso(now), heartbeatAt: iso(now), feedbackAt: iso(now) };
  state.session = session;
  return session;
}

export function endSession(state: AgentState, now: number, reason: string) {
  const session = liveSession(state);
  if (!session) return;
  session.endedAt = iso(now);
  session.endReason = reason;
  state.requests = state.requests.filter((request) => request.sessionId !== session.id);
}

/** Records the threads one round answers, through each thread's latest user comment. */
export function createClaim(state: AgentState, now: number, sessionId: string | null, threads: ClaimedThread[]) {
  if (!threads.length) return null;
  const claim: AgentClaim = { id: randomUUID(), sessionId, startedAt: iso(now), activityAt: iso(now), threads };
  state.claims.push(claim);
  const session = liveSession(state);
  if (session && session.id === sessionId) session.feedbackAt = iso(now);
  return claim.id;
}

/** Releases claims so their unanswered threads can be picked up again. */
export function releaseClaims(state: AgentState, sessionId: string | null) {
  state.claims = state.claims.filter((claim) => claim.sessionId !== sessionId);
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

/** The comment a named round answers in a thread, even after the round was released. */
export function roundThrough(state: AgentState, claimId: string, threadId: string) {
  const claim = state.claims.find((item) => item.id === claimId) ?? state.retiredClaims.find((item) => item.id === claimId);
  return claim?.threads.find((thread) => thread.id === threadId)?.through;
}

/** Marks agent replies; a round completes when every claimed thread has one.
 * A reply naming its round only counts for that round, so a replaced round never ends a newer one. */
export function recordAgentReplies(state: AgentState, now: number, replies: { threadId: string; claimId?: string }[]) {
  for (const claim of state.claims) {
    if (!claimActive(claim, now)) continue;
    for (const thread of claim.threads) {
      if (!thread.answeredAt && replies.some((reply) => reply.threadId === thread.id && (!reply.claimId || reply.claimId === claim.id))) thread.answeredAt = iso(now);
    }
    if (claim.threads.every((thread) => thread.answeredAt)) {
      state.lastRound = { id: claim.id, completedAt: iso(now), threadIds: claim.threads.map((thread) => thread.id) };
    }
  }
  touchAgent(state, now);
}

export function markSending(state: AgentState, now: number, sending: boolean) {
  if (sending) state.sendingUntil = iso(now + SENDING_LIMIT_MS);
  else delete state.sendingUntil;
}

export function sendInProgress(state: AgentState, now: number) {
  return age(now, state.sendingUntil) < 0;
}

export function addRequest(state: AgentState, now: number, id: string, body: string, choices: string[]) {
  const existing = state.requests.find((request) => request.id === id);
  if (existing) {
    if (existing.body !== body || JSON.stringify(existing.choices) !== JSON.stringify(choices)) throw new Error(`Request ${id} already exists with different content.`);
    return existing;
  }
  const request = { id, sessionId: liveSession(state)?.id ?? null, body, choices, createdAt: iso(now) };
  state.requests.push(request);
  touchAgent(state, now);
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
  const answered = state.requests.filter((request) => request.response && (request.sessionId === sessionId || request.sessionId === null));
  state.requests = state.requests.filter((request) => !answered.includes(request));
  return answered.map((request) => ({ id: request.id, question: request.body, answer: request.response!.body }));
}

/** Viewer-facing summary; contains no paths or process details. */
export function agentStatus(state: AgentState, now: number) {
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
    serverTime: iso(now),
  };
}
export type AgentStatus = ReturnType<typeof agentStatus>;
