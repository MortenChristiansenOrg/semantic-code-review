// The listening agent: its status, the questions it asks, and sending feedback
// to it as the reviewer saves notes.
import type { AgentStatus, FeedbackThread } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { data } from "./context";
import { exportFeedback, exportState } from "./feedback-actions";
import { setRefreshNotice } from "./polling";
import { render } from "./render";
import { errorMessage, failureOf } from "./narrow";
import type { Note } from "./types";
import { showUnreadReplies } from "./unread-replies";

// Listening-agent status from the server; null until the first poll answers.
export let agent: AgentStatus | null = null;
/** The latest round the agent finished, until the reviewer opens or dismisses it. */
export interface RoundNotice {
  count: number;
  threadIds: string[];
}
export let roundNotice: RoundNotice | null = null;
export function setRoundNotice(notice: RoundNotice | null): void { roundNotice = notice; }
export let agentCommandCopied = false;
export const agentAnswers = new Map<string, string>();
export const agentAnswerOps = new Map<string, { busy: boolean; error: string }>();
// Questions the reviewer minimized; a new question opens the overlay again.
export const minimizedAgentQuestions = new Set<string>();
export const AGENT_COMMAND = "/semantic-flow review -i";
// The "Send automatically" choice is a viewer preference, kept in this browser across reviews.
export const AUTO_SEND_KEY = "semantic-flow:auto-send-feedback";
// Null when storage is unavailable, so the in-page choice still applies.
// After a failed write the stored value is stale, so this tab keeps its own choice.
export let autoSendStoreFailed = false;
export const readAutoSendPreferred = (): boolean | null => { if (autoSendStoreFailed) return null; try { return localStorage.getItem(AUTO_SEND_KEY) === "true"; } catch { return null; } };
export let autoSendPreferred = readAutoSendPreferred() ?? false;
// Saved notes (objects) and reply draft IDs waiting for an automatic send.
export const autoSendQueue = { notes: new Set<Note>(), replies: new Set<string>() };
/** Drafts to send: saved notes and reply draft IDs. */
export type DraftSelection = typeof autoSendQueue;
// Drafts in the request being sent; they cannot be edited or deleted until it answers.
export const sendingDrafts = new Set<Note | string>();
// Turning it off drops queued saves; they stay as drafts for Prepare feedback.
export function adoptAutoSendPreferred(on: boolean): void {
  autoSendPreferred = on;
  if (!on) { autoSendQueue.notes.clear(); autoSendQueue.replies.clear(); }
}
export function setAutoSendPreferred(on: boolean): void {
  adoptAutoSendPreferred(on);
  try { localStorage.setItem(AUTO_SEND_KEY, String(on)); autoSendStoreFailed = false; } catch { autoSendStoreFailed = true; }
}
// Offered only while an interactive session can take feedback as it arrives.
export const agentTakesFeedback = (): boolean => Boolean(!data.remote && agent?.session && !agent.stopRequested && (agent.listening || agent.working));
export const autoSendActive = (): boolean => autoSendPreferred && agentTakesFeedback();
// Send just the saved note or reply at once; a save during a send goes out when that send finishes.
export function autoSendFeedback(saved?: { note?: Note; reply?: string | null }): void {
  const stored = readAutoSendPreferred();
  if (stored !== null && stored !== autoSendPreferred) adoptAutoSendPreferred(stored);
  if (!autoSendActive()) { autoSendQueue.notes.clear(); autoSendQueue.replies.clear(); return; }
  if (saved?.note) autoSendQueue.notes.add(saved.note);
  else if (saved && saved.reply != null) autoSendQueue.replies.add(saved.reply);
  if (exportState.phase === "working") return;
  const only = { notes: new Set(autoSendQueue.notes), replies: new Set(autoSendQueue.replies) };
  autoSendQueue.notes.clear(); autoSendQueue.replies.clear();
  if (only.notes.size || only.replies.size) void exportFeedback(only);
}

export const agentMinutes = (status: AgentStatus | null): number => status?.working
  ? Math.max(0, Math.floor((Date.parse(status.serverTime) - Date.parse(status.working.startedAt)) / 60000)) : 0;
export const agentView = (status: AgentStatus | null): string | null => status && JSON.stringify({ ...status, serverTime: null, minutes: agentMinutes(status) });
// The agent's session files are read from disk unvalidated. Keep only what the
// page can show, so a malformed entry cannot stop rendering. Questions keep
// their first occurrence per ID, so buttons and handlers index the same choices.
export const isText = (value: unknown): value is string => typeof value === "string";
export const record = <T>(value: T): (T & object) | null => value && typeof value === "object" ? value : null;
export function agentRequests(requests: AgentStatus["requests"]): AgentStatus["requests"] {
  const seen = new Set<string>();
  return (Array.isArray(requests) ? requests : [])
    .filter((request) => record(request) && isText(request.id) && !seen.has(request.id) && seen.add(request.id))
    .map((request) => ({ ...request, body: isText(request.body) ? request.body : "",
      choices: Array.isArray(request.choices) ? request.choices.filter(isText) : [] }));
}
export function agentWorking(working: AgentStatus["working"]): AgentStatus["working"] {
  const fields = record(working);
  if (!fields) return null;
  const threads = (Array.isArray(fields.threads) ? fields.threads : []).filter((thread) => record(thread) && isText(thread.id));
  return { ...fields, threads, note: isText(fields.note) ? fields.note : undefined };
}
export function agentStatus(next: AgentStatus): AgentStatus {
  const lastRound = record(next.lastRound);
  const round = lastRound && isText(lastRound.id) ? lastRound : null;
  const refresh = record(next.targetRefresh);
  return { ...next, requests: agentRequests(next.requests), working: agentWorking(next.working),
    lastRound: round && { ...round, threadIds: Array.isArray(round.threadIds) ? round.threadIds.filter(isText) : [] },
    targetRefresh: refresh && (["at", "targetBranch", "previousBaseRevision", "baseRevision"] as const).every((key) => isText(refresh[key])) ? refresh : null };
}
/** Adopts the agent status a response carries; a response without one leaves it. */
export function adoptAgentStatus(received: AgentStatus | undefined): void {
  if (!received || typeof received !== "object" || data.remote) return;
  const next = agentStatus(received);
  const previous = agent;
  agent = next;
  for (const id of minimizedAgentQuestions) if (!next.requests?.some((request) => request.id === id)) minimizedAgentQuestions.delete(id);
  if (previous && next.lastRound && next.lastRound.id !== previous.lastRound?.id) announceRound(next.lastRound);
  if (agentView(previous) !== agentView(next)) render();
}
export function announceRound(round: { threadIds: string[] }): void {
  const count = round.threadIds.length;
  setRoundNotice({ count, threadIds: round.threadIds });
  setRefreshNotice("");
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    const notice = new Notification("Agent replied", {
      body: `${count} feedback thread${count === 1 ? "" : "s"} answered in ${data.title || data.implementationId}.`,
      tag: `semantic-flow-${data.implementationId}`,
    });
    notice.onclick = () => { window.focus(); showUnreadReplies(round.threadIds); notice.close(); };
  }
}
// Mirrors the CLI: a user comment after the latest answered comment awaits the agent.
export function awaitsAgent(thread: FeedbackThread): boolean {
  if (thread.status !== "open") return false;
  const comments = thread.comments || [];
  let through = -1;
  comments.forEach((comment, index) => {
    if (comment.author !== "agent") return;
    const answered = comment.respondsTo ? comments.findIndex((item) => item.id === comment.respondsTo) : index - 1;
    through = Math.max(through, answered);
  });
  return comments.some((comment, index) => index > through && comment.author === "user");
}
export const agentWorkingOn = (id: string): boolean => Boolean(agent?.working?.threads.some((thread) => thread.id === id && !thread.answered));

export async function stopAgent(): Promise<void> {
  try {
    const response = await api.stopAgent();
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not stop the agent.");
    adoptAgentStatus(result.agent);
  } catch (error) { setRefreshNotice(errorMessage(error)); render(); }
}
export async function answerAgent(id: string, body: string): Promise<void> {
  body = body.trim();
  if (!body || agentAnswerOps.get(id)?.busy) return;
  agentAnswers.set(id, body);
  agentAnswerOps.set(id, { busy: true, error: "" }); render();
  try {
    const response = await api.respondToAgent({ requestId: id, body });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not send the answer.");
    agentAnswerOps.delete(id); agentAnswers.delete(id);
    adoptAgentStatus(result.agent); render();
  } catch (error) { agentAnswerOps.set(id, { busy: false, error: errorMessage(error) }); render(); }
}
export async function copyAgentCommand(): Promise<void> {
  try { await navigator.clipboard.writeText(AGENT_COMMAND); agentCommandCopied = true; }
  catch { agentCommandCopied = false; setRefreshNotice(`Copy this command into your agent: ${AGENT_COMMAND}`); }
  render();
  setTimeout(() => { agentCommandCopied = false; render(); }, 2000);
}

export function requestReplyNotifications(): void {
  if ((agent?.listening || agent?.working) && "Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
}
