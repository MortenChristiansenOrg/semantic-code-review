// Agent replies the reviewer has not read yet, and marking them read as they are seen.
import type { FeedbackComment, FeedbackThread } from "../../scripts/src/shared/viewer-protocol";
import { agentWorkingOn, awaitsAgent, roundNotice, setRoundNotice } from "./agent";
import { app, data } from "./context";
import { artifactThreads } from "./lookups";
import { render } from "./render";
import { persist, state } from "./state";
import { cssEsc } from "./util";
import type { ThreadAgentState } from "./views/thread";

// Comment IDs are unique only within a thread, so read markers name both.
export const replyKey = (thread: FeedbackThread, comment: FeedbackComment): string => JSON.stringify([thread.id, comment.id]);
// Replies from before unread tracking started (repliesSeenThrough) count as read.
export const isUnreadReply = (thread: FeedbackThread, comment: FeedbackComment): boolean => comment.author === "agent" && !data.remote &&
  typeof state.repliesSeenThrough === "string" && String(comment.createdAt || "") > state.repliesSeenThrough &&
  !state.readReplies?.[replyKey(thread, comment)];
export const unreadReplies = (thread: FeedbackThread): FeedbackComment[] => (thread.comments || []).filter((comment) => isUnreadReply(thread, comment));
export const unreadReplyCount = (): number => artifactThreads.reduce((count, thread) => count + unreadReplies(thread).length, 0);
export function threadAgentState(thread: FeedbackThread): ThreadAgentState | null {
  if (data.remote || thread.status !== "open") return null;
  if (agentWorkingOn(thread.id)) return "working";
  if (awaitsAgent(thread)) return "queued";
  if (unreadReplies(thread).length) return "new";
  return (thread.comments || []).some((comment) => comment.author === "agent") ? "answered" : null;
}
export function markRepliesRead(keys: string[]): void {
  const fresh = keys.filter((key) => !state.readReplies?.[key]);
  if (!fresh.length) return;
  state.readReplies = { ...(state.readReplies || {}), ...Object.fromEntries(fresh.map((key) => [key, true])) };
  persist(); render();
}
// A reply counts as read once most of it, or half the visible area for a long
// reply, has been on screen for a moment.
export const readTimers = new Map<Element, number>();
/** The rendered unread replies the observer watches. */
const observedReplies = new Set<Element>();
function cancelDwell(element: Element): void { clearTimeout(readTimers.get(element)); readTimers.delete(element); }
export const replyObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const element = entry.target;
    // A browser may deliver a queued report after the reply was removed and unobserved.
    if (!element.isConnected || !observedReplies.has(element)) { cancelDwell(element); continue; }
    const visibleHeight = entry.rootBounds?.height || window.innerHeight;
    const seen = entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= visibleHeight * 0.5;
    if (seen && !document.hidden && element.classList.contains("is-unread")) {
      if (!readTimers.has(element)) readTimers.set(element, setTimeout(() => {
        readTimers.delete(element);
        const key = element.getAttribute("data-reply-key");
        if (key !== null && element.isConnected && !document.hidden) markRepliesRead([key]);
      }, 1200));
    } else cancelDwell(element);
  }
}, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1] }) : null;
/** Watches the rendered unread replies and stops watching replies that were read or replaced. */
export function observeUnreadReplies(): void {
  if (!replyObserver) return;
  const unread = new Set(app.querySelectorAll(".tmsg.is-unread"));
  for (const element of observedReplies) {
    if (!unread.has(element)) { replyObserver.unobserve(element); observedReplies.delete(element); cancelDwell(element); }
  }
  for (const element of unread) {
    if (!observedReplies.has(element)) { observedReplies.add(element); replyObserver.observe(element); }
  }
}
/** A hidden page reads nothing: hiding cancels each dwell, and showing the page starts a fresh one. */
export function installUnreadReplies(): void {
  document.addEventListener("visibilitychange", () => {
    if (!replyObserver) return;
    if (document.hidden) { for (const element of [...readTimers.keys()]) cancelDwell(element); return; }
    // Observing a reply again reports its current visibility.
    for (const element of observedReplies) { replyObserver.unobserve(element); replyObserver.observe(element); }
  });
}
// Prefers an active thread from the announced round; resolved threads may hold
// replies that stay unread because their list is out of view.
export function showUnreadReplies(threadIds: string[] = roundNotice?.threadIds || []): void {
  setRoundNotice(null);
  const inRound = (item: FeedbackThread) => threadIds.includes(item.id);
  const active = (item: FeedbackThread) => item.status !== "resolved";
  const unread = (item: FeedbackThread) => unreadReplies(item).length > 0;
  const thread = artifactThreads.find((item) => inRound(item) && active(item) && unread(item))
    || artifactThreads.find((item) => inRound(item) && active(item))
    || artifactThreads.find((item) => active(item) && unread(item))
    || artifactThreads.find((item) => item.status === "open" && (item.comments || []).at(-1)?.author === "agent")
    || artifactThreads.find((item) => inRound(item) || unread(item));
  if (!thread) { render(); return; }
  state.notesOpen = true; state.coverageOpen = false;
  state.notesFilter = thread.status === "resolved" ? "resolved" : "active";
  if (!state.threadCollapsed) state.threadCollapsed = {};
  state.threadCollapsed[thread.id] = false;
  persist(); render();
  requestAnimationFrame(() => app.querySelector(`.side.notes .tthread[data-thread-id="${cssEsc(thread.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}
