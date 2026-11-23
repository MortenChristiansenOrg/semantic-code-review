// A toast for each agent reply that arrives while the page is open, until the
// reviewer shows, dismisses or reads the reply.
import type { FeedbackComment, FeedbackThread } from "../../scripts/src/shared/viewer-protocol";
import { artifactThreads } from "./lookups";
import { jumpToElement } from "./navigation";
import { render } from "./render";
import { persist, state } from "./state";
import { threadElementRef, threadTargetDisplay, threadTypeLabel } from "./thread-models";
import { threadCollapsed } from "./threads";
import { isUnreadReply, replyKey, showUnreadReplies } from "./unread-replies";
import type { ReplyToastView, ReplyToastsView } from "./views/notices";

/** More toasts than this collapse into one group. */
export const TOAST_GROUP_AFTER = 5;

/** The reply keys of the toasts shown, oldest first. */
let toasts: string[] = [];
/** Every agent reply the page has shown, so only replies that arrive later get a toast; null before the first render. */
let known: Set<string> | null = null;
/** Whether the group of toasts is expanded. */
let expanded = false;

function replies(): { thread: FeedbackThread; comment: FeedbackComment; key: string }[] {
  return artifactThreads.flatMap((thread) => (thread.comments || [])
    .filter((comment) => comment.author === "agent")
    .map((comment) => ({ thread, comment, key: replyKey(thread, comment) })));
}

/** Adds a toast for each unread reply that arrived since the last render, and drops those
 * whose reply was read or is gone. Replies shown when the page starts get none. */
export function updateReplyToasts(): void {
  const all = replies();
  if (known) for (const { thread, comment, key } of all) {
    if (!known.has(key) && isUnreadReply(thread, comment) && !toasts.includes(key)) toasts.push(key);
  }
  known = new Set(all.map((reply) => reply.key));
  const unread = new Set(all.filter(({ thread, comment }) => isUnreadReply(thread, comment)).map((reply) => reply.key));
  toasts = toasts.filter((key) => unread.has(key));
  if (toasts.length <= TOAST_GROUP_AFTER) expanded = false;
}

/** The first line of a reply, as plain text. */
function excerpt(body: string): string {
  const line = body.split(/\r?\n/).map((text) => text.trim()).find(Boolean) || "";
  return line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, "").replace(/[*_`]/g, "");
}

export function replyToastsModel(): ReplyToastsView | null {
  if (!toasts.length) return null;
  const byKey = new Map(replies().map((reply) => [reply.key, reply]));
  const items = toasts.flatMap((key): ReplyToastView[] => {
    const reply = byKey.get(key);
    if (!reply) return [];
    const kind = reply.thread.target?.kind || "thread";
    const target = threadTargetDisplay(reply.thread);
    return [{ key, kind: threadTypeLabel(kind), target: target.text, targetTitle: target.title, excerpt: excerpt(reply.comment.body || "") }];
  });
  return items.length ? { items, grouped: items.length > TOAST_GROUP_AFTER, expanded } : null;
}

export function dismissReplyToast(key: string): void {
  toasts = toasts.filter((item) => item !== key);
  render();
}
export function dismissReplyToasts(): void {
  toasts = []; expanded = false;
  render();
}
export function toggleReplyToasts(): void {
  expanded = !expanded;
  render();
}

/** Takes the reviewer to the reply where its thread shows in the code, or in the notes
 * panel when the thread's target is gone from the review. */
export function showReplyToast(key: string): void {
  const reply = replies().find((item) => item.key === key);
  toasts = toasts.filter((item) => item !== key);
  if (!reply) { render(); return; }
  const ref = threadElementRef(reply.thread);
  if (!ref) { showUnreadReplies([reply.thread.id]); return; }
  if (threadCollapsed(reply.thread)) { state.threadCollapsed = { ...(state.threadCollapsed || {}), [reply.thread.id]: false }; persist(); }
  jumpToElement(ref.kind, ref.id, ref.stageId, ref.nodeId);
}
