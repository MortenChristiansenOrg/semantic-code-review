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
/** Counts announcements, so one that repeats the last still changes the region's text and is read. */
let announcements = 0;
/** Stops the reveal of the reply a Show is waiting for. */
let stopReveal: (() => void) | null = null;
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
    const text = arrived.length === 1 ? `Agent replied about ${about(arrived[0].thread)}.` : arrived.length ? `Agent sent ${arrived.length} replies.` : "";
    if (text) announcement = text + (++announcements % 2 ? "" : "\u00a0");
  }
  known = new Set(all.map((reply) => reply.key));
  const unread = new Set(all.filter(({ thread, comment }) => isUnreadReply(thread, comment)).map((reply) => reply.key));
  toasts = toasts.filter((key) => unread.has(key));
  if (toasts.length <= TOAST_GROUP_AFTER) expanded = false;
}

/** Plain text for a line of Markdown: emphasis marks dropped outside code spans and links. */
function plain(line: string): string {
  return line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, "").split(/(`+[^`]*?`+|<?https?:\/\/[^\s>]+>?)/).map((part, index) => {
    if (index % 2) return part.replace(/^`+|`+$/g, "").replace(/^<|>$/g, "");
    return part.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3");
  }).join("");
}
/** The first line of a reply's text as plain text, or of its code when it has only code. */
function excerpt(body: string): string {
  let fence: string | null = null;
  const prose: string[] = [], code: string[] = [];
  for (const text of body.split(/\r?\n/).map((item) => item.trim())) {
    const marker = /^(`{3,}|~{3,})/.exec(text)?.[1];
    // A fence closes only with a fence of its own mark, at least as long.
    if (marker && (!fence ? true : marker[0] === fence[0] && marker.length >= fence.length && !text.slice(marker.length).trim())) { fence = fence ? null : marker; continue; }
    if (text) (fence ? code : prose).push(text);
  }
  return prose.length ? plain(prose[0]) : code[0] ?? "";
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
   now in its place, else back to where focus was before it entered the
   toasts. */
export interface ToastFocus { action: string; index: number }
/** The toasts of single replies, without the summary of a group. */
const toastSelector = ".notice-stack .reply-toast:not(.reply-toast-group)";
/** A control that can take focus: in the page, shown and not inert. */
const usable = (element: Element | null): boolean => Boolean(element?.isConnected && element.getClientRects().length && !element.closest("[inert], [hidden]"));
export function captureToastFocus(): ToastFocus | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.dataset.action || !focused.closest(".notice-stack")) return null;
  const toast = focused.closest(".reply-toast");
  return { action: focused.dataset.action, index: toast ? [...app.querySelectorAll(toastSelector)].indexOf(toast) : 0 };
}
export function restoreToastFocus(focus: ToastFocus | null): void {
  if (!focus || document.activeElement && document.activeElement !== document.body) return;
  const shown = [...app.querySelectorAll(toastSelector)];
  const toast = shown[Math.min(focus.index, shown.length - 1)];
  // Never another control: a held key would act on it, and Dismiss all would clear every toast.
  const inToasts = focusable(toast?.querySelector(`[data-action="${cssEsc(focus.action)}"]`));
  const target = inToasts || (usable(focusBefore) ? focusable(focusBefore) : null);
  target?.focus({ preventScroll: true });
  // A list of toasts that scrolls shows the control focused in it.
  inToasts?.scrollIntoView({ block: "nearest", behavior: "instant" });
}
export function installReplyToasts(): void {
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && !event.target.closest(".notice-stack")) focusBefore = event.target;
  });
  // Whatever the reviewer does next takes over from a Show still waiting for its reply.
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(type, () => stopReveal?.(), { capture: true, passive: true });
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

/** Scrolls to the reply once the navigation that shows it finished, however long its
 * diff takes to load, and focuses it, unless the reviewer did something else meanwhile. */
function revealReply(key: string, where: string): void {
  stopReveal?.();
  let frames = 0, frame = 0;
  // A diff that fails to load, or takes this long, never shows the reply in time to be wanted.
  const until = performance.now() + 15000;
  const stop = stopReveal = () => { cancelAnimationFrame(frame); if (stopReveal === stop) stopReveal = null; };
  const step = () => {
    frames += 1;
    const reply = app.querySelector(`${where} .tmsg[data-reply-key="${cssEsc(key)}"]`);
    // The navigation scrolls to the thread two frames on, or once its diff page loaded.
    if (frames < 3 || lazyJumpPending() || !reply?.getClientRects().length) {
      if (performance.now() < until && replies().some((item) => item.key === key)) frame = requestAnimationFrame(step);
      else stop();
      return;
    }
    stop();
    reply.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // The button pressed went away with its toast; focus elsewhere was the reviewer's choice.
    if (document.activeElement && document.activeElement !== document.body) return;
    if (!reply.hasAttribute("tabindex")) reply.setAttribute("tabindex", "-1");
    if (reply instanceof HTMLElement) reply.focus({ preventScroll: true });
  };
  frame = requestAnimationFrame(step);
}

/** Takes the reviewer to the reply where its thread shows in the code, or in the notes
 * panel when the thread's target is gone from the review. */
export function showReplyToast(key: string): void {
  const reply = replies().find((item) => item.key === key);
  toasts = toasts.filter((item) => item !== key);
  if (!reply) { render(); return; }
  // Focus goes to the reply, not to the next toast.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(".notice-stack")) focused.blur();
  if (threadCollapsed(reply.thread)) { state.threadCollapsed = { ...(state.threadCollapsed || {}), [reply.thread.id]: false }; persist(); }
  // A thread shows beside its element, and a line thread whose line left the diff beside its
  // file. One whose element is gone, so that it would jump to the stage holding it, shows in the notes panel.
  const kind = reply.thread.target?.kind;
  const ref = threadElementRef(reply.thread);
  const inCode = ref && (ref.kind === kind || kind === "line" && ref.kind === "file");
  if (inCode) jumpToElement(ref.kind, ref.id, ref.stageId, ref.nodeId);
  else showThreadInNotes(reply.thread);
  revealReply(key, inCode ? "main.shell" : ".side.notes");
}
