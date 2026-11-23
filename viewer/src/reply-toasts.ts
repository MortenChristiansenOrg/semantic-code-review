// A toast for each agent reply that arrives while the page is open, until the
// reviewer shows, dismisses or reads the reply.
import type { FeedbackComment, FeedbackThread } from "../../scripts/src/shared/viewer-protocol";
import { app } from "./context";
import { artifactThreads } from "./lookups";
import { jumpToElement, lazyJumpPending } from "./navigation";
import { render } from "./render";
import { persist, state } from "./state";
import { threadElementRef, threadTargetDisplay, threadTypeLabel } from "./thread-models";
import { threadCollapsed } from "./threads";
import { isUnreadReply, replyKey, showThreadInNotes } from "./unread-replies";
import { cssEsc, focusable } from "./util";
import type { ReplyToastView, ReplyToastsView } from "./views/notices";

/** More toasts than this collapse into one group. */
export const TOAST_GROUP_AFTER = 5;

/** The reply keys of the toasts shown, oldest first. */
let toasts: string[] = [];
/** Every agent reply the page has shown, so only replies that arrive later get a toast; null before the first render. */
let known: Set<string> | null = null;
/** Whether the group of toasts is expanded. */
let expanded = false;
/** What screen readers announce about the latest replies; the status region keeps it until new replies replace it. */
let announcement = "";
/** The last element focused outside the toasts, which takes focus back when the last toast goes. */
let focusBefore: Element | null = null;

function replies(): { thread: FeedbackThread; comment: FeedbackComment; key: string }[] {
  return artifactThreads.flatMap((thread) => (thread.comments || [])
    .filter((comment) => comment.author === "agent")
    .map((comment) => ({ thread, comment, key: replyKey(thread, comment) })));
}
/** What a reply's thread is about, such as "line shared.js:3". */
function about(thread: FeedbackThread): string {
  return `${threadTypeLabel(thread.target?.kind || "thread").toLowerCase()} ${threadTargetDisplay(thread).title}`;
}

/** Adds a toast for each unread reply that arrived since the last render, and drops those
 * whose reply was read or is gone. Replies shown when the page starts get none. */
export function updateReplyToasts(): void {
  const all = replies();
  if (known) {
    const arrived = all.filter(({ thread, comment, key }) => !known?.has(key) && isUnreadReply(thread, comment) && !toasts.includes(key));
    toasts.push(...arrived.map((reply) => reply.key));
    if (arrived.length === 1) announcement = `Agent replied about ${about(arrived[0].thread)}.`;
    else if (arrived.length) announcement = `Agent sent ${arrived.length} replies.`;
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

export function replyToastsModel(): ReplyToastsView {
  const byKey = new Map(replies().map((reply) => [reply.key, reply]));
  const items = toasts.flatMap((key): ReplyToastView[] => {
    const reply = byKey.get(key);
    if (!reply) return [];
    const target = threadTargetDisplay(reply.thread);
    return [{ key, kind: threadTypeLabel(reply.thread.target?.kind || "thread"), target: target.text, targetTitle: target.title,
      label: `Agent reply about ${about(reply.thread)}`, excerpt: excerpt(reply.comment.body || "") }];
  });
  return { items, grouped: items.length > TOAST_GROUP_AFTER, expanded, announcement };
}

/* ---- focus ------------------------------------------------------------
   A toast control that goes away while focused, as when its toast is
   dismissed or its reply read, passes focus to the same control of the toast
   now in its place, else to the toasts' remaining controls, else back to where
   focus was before it entered the toasts. */
export interface ToastFocus { action: string; index: number }
export function captureToastFocus(): ToastFocus | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.dataset.action || !focused.closest(".notice-stack")) return null;
  const toast = focused.closest(".reply-toast");
  return { action: focused.dataset.action, index: toast ? [...app.querySelectorAll(".notice-stack .reply-toast")].indexOf(toast) : 0 };
}
export function restoreToastFocus(focus: ToastFocus | null): void {
  if (!focus || document.activeElement && document.activeElement !== document.body) return;
  const shown = [...app.querySelectorAll(".notice-stack .reply-toast")];
  const toast = shown[Math.min(focus.index, shown.length - 1)];
  const next = toast?.querySelector(`[data-action="${cssEsc(focus.action)}"]`) || app.querySelector(".notice-stack button");
  const target = focusable(next) || (focusBefore?.isConnected ? focusable(focusBefore) : null);
  target?.focus({ preventScroll: true });
}
export function installReplyToasts(): void {
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && !event.target.closest(".notice-stack")) focusBefore = event.target;
  });
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

/** Scrolls to the reply once the navigation that shows it finished, and focuses it. */
function revealReply(key: string, where: string): void {
  let frames = 0;
  const step = () => {
    frames += 1;
    const reply = app.querySelector(`${where} .tmsg[data-reply-key="${cssEsc(key)}"]`);
    // The navigation scrolls to the thread two frames on, or once its diff page loaded.
    if (frames < 3 || lazyJumpPending() || !reply?.getClientRects().length) {
      if (frames < 300) requestAnimationFrame(step);
      return;
    }
    reply.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!reply.hasAttribute("tabindex")) reply.setAttribute("tabindex", "-1");
    if (reply instanceof HTMLElement) reply.focus({ preventScroll: true });
  };
  requestAnimationFrame(step);
}

/** Takes the reviewer to the reply where its thread shows in the code, or in the notes
 * panel when the thread's target is gone from the review. */
export function showReplyToast(key: string): void {
  const reply = replies().find((item) => item.key === key);
  toasts = toasts.filter((item) => item !== key);
  if (!reply) { render(); return; }
  if (threadCollapsed(reply.thread)) { state.threadCollapsed = { ...(state.threadCollapsed || {}), [reply.thread.id]: false }; persist(); }
  const ref = threadElementRef(reply.thread);
  if (ref) jumpToElement(ref.kind, ref.id, ref.stageId, ref.nodeId);
  else showThreadInNotes(reply.thread);
  revealReply(key, ref ? "main.shell" : ".side.notes");
}
