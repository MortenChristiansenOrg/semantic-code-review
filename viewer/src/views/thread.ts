// Feedback threads, local notes and the note composer, and the containers that
// show them beside a stage, step, evidence, file or diff line.
import { html, nothing, type TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { attachmentEditor, attachmentList, type AttachmentEditorView, type AttachmentView } from "./attachments";
import { commentBody } from "./comment-body";
import { arrowIcon, caretIcon } from "./icons";
import { labelHint } from "../tooltips";

/** Where a jump control leads: the element a thread or note is about. */
export interface JumpView {
  kind: string;
  id: string;
  /** Empty when the target needs no stage to be found. */
  stageId: string;
  /** Empty when the target belongs to no step. */
  nodeId: string;
}

export interface ThreadMessageView {
  author: "agent" | "user";
  /** An agent reply the reviewer has not seen yet. */
  unread: boolean;
  /** Identifies an agent reply for read tracking; empty for the reviewer's comments. */
  replyKey: string;
  /** The formatted time; empty when unknown. */
  time: string;
  body: string;
  attachments: readonly AttachmentView[];
}

/** A reply saved locally and not yet sent with the feedback. */
export interface ReplyDraftView {
  id: string;
  body: string;
  attachments: readonly AttachmentView[];
  /** The draft is in a send request and cannot be changed. */
  sending: boolean;
}

export interface ReplyFormView {
  /** The unsent text. */
  draft: string;
  /** The form revises a saved draft instead of adding one. */
  editing: boolean;
  attachments: AttachmentEditorView;
  saveDisabled: boolean;
}

export type ThreadAgentState = "queued" | "working" | "new" | "answered";

export interface ThreadView {
  id: string;
  status: string;
  collapsed: boolean;
  /** The kind of element the thread is about, which picks its icon. */
  kind: string;
  kindLabel: string;
  /** The target's name, with its full form for the tooltip; absent to leave it out. */
  title: { text: string; tooltip: string } | null;
  /** The stage the conversation is assigned to, when that adds information; empty otherwise. */
  assignedStage: string;
  agentState: ThreadAgentState | null;
  /** A jump to the target, a disabled jump for a deleted file, or none. */
  jump: JumpView | "deleted" | null;
  /** Why the target may no longer match; empty when it does. */
  stale: string;
  /** The last failed resolve or reopen; empty otherwise. */
  error: string;
  /** A resolve or reopen is in progress. */
  busy: boolean;
  messages: readonly ThreadMessageView[];
  drafts: readonly ReplyDraftView[];
  /** The thread can be resolved, reopened and replied to. */
  actionable: boolean;
  /** The title of the removed stage the thread belongs to; the thread is then read-only. Absent otherwise. */
  removedStage?: string;
  /** A reply is being written to this thread somewhere on the page. */
  replying: boolean;
  /** Present where the reply being written is shown. */
  reply: ReplyFormView | null;
}

export interface LocalNoteView {
  /** The note's position in the saved notes, which its controls address. */
  index: number;
  /** Stays with the note while others are added or removed, unlike its index,
   * so focus kept by a control never passes to another note's control. */
  id: string;
  mode: "personal" | "feedback";
  sent: boolean;
  sending: boolean;
  /** The target's name; absent where the surrounding element names it. */
  label: { text: string; title: string } | null;
  jump: JumpView | null;
  /** Why the note is not shown at its target; empty when it is. */
  missing: string;
  time: string;
  body: string;
  attachments: readonly AttachmentView[];
}

export interface ComposerView {
  mode: "personal" | "feedback";
  /** Remote reviews take personal notes only. */
  remote: boolean;
  body: string;
  attachments: AttachmentEditorView;
  /** The composer revises a saved note instead of adding one. */
  editing: boolean;
  saveDisabled: boolean;
}

/** One item in a list of conversations: a thread, a local note, or the
 * composer editing that note in its place. The key keeps each item's
 * elements, and so a draft's focus and text, across updates. */
export type ThreadEntryView =
  | { type: "thread"; key: string; thread: ThreadView }
  | { type: "note"; key: string; note: LocalNoteView }
  | { type: "composer"; key: string; composer: ComposerView };

/** The conversations about one element. */
export interface ThreadListView {
  /** The element's ID, as notes and threads address it. */
  id: string;
  kind: string;
  /** The stage of a step; null for targets the ID identifies alone. */
  stageId: string | null;
  /** Identifies the list while a code selection runs through it and holds its threads. */
  listKey: string;
  entries: readonly ThreadEntryView[];
  /** A new note being written here; it replaces the add-note button. */
  composer: ComposerView | null;
}

const AGENT_STATE: Record<ThreadAgentState, string> = { queued: "Queued", working: "Agent working", new: "New reply", answered: "Answered" };

function typeIcon(kind: string): TemplateResult {
  if (kind === "stage")
    return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M12 3.5l8 4-8 4-8-4 8-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  if (kind === "node")
    return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/></svg>`;
  if (kind === "specification")
    return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M12 3.2l2.3 5 5.5.5-4.1 3.6 1.2 5.3L12 20.4 6.8 22.6 8 17.3 3.9 13.7l5.5-.5 2.3-5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  if (kind === "criterion")
    return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 12.4l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (kind === "insight")
    return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M9 18h6M10 21h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 3a6 6 0 0 0-3.4 10.9c.6.4.9 1 .9 1.6v.5h5v-.5c0-.6.3-1.2.9-1.6A6 6 0 0 0 12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  return html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13.5 3.5V8h4.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

const resolvedIcon = html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const openIcon = html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg>`;
const spinner = html`<span class="tspin" aria-hidden="true"></span>`;

function jumpButton(jump: JumpView, label: string): TemplateResult {
  return html`<button class="tthread-jump" data-action="jump-to" data-kind=${jump.kind} data-id=${jump.id} data-stage=${jump.stageId} data-node-id=${jump.nodeId} type="button" data-tooltip=${label} aria-label=${label}>${arrowIcon}</button>`;
}

const JUMP = "Show what this thread is about";
const REMOVED = "Stage removed · read-only";
const DELETED = "This file no longer exists";

function threadJump(jump: ThreadView["jump"]): TemplateResult | typeof nothing {
  if (jump === "deleted") return html`<button class="tthread-jump" type="button" disabled data-tooltip=${DELETED} aria-label=${DELETED}>${arrowIcon}</button>`;
  return jump ? jumpButton(jump, JUMP) : nothing;
}

/** The header's hint names everything its icons show, and the title's full
 * form where the title shows less. `clipped` gives the hint for when the title
 * is cut off and so shows less than its full form. */
function headerTooltip(thread: ThreadView, clipped = false): string {
  const parts = [thread.collapsed ? "Expand thread" : "Collapse thread", thread.kindLabel,
    thread.title && (clipped || thread.title.tooltip !== thread.title.text) ? thread.title.tooltip : "",
    thread.assignedStage ? `Assigned to stage: ${thread.assignedStage}` : "", thread.removedStage === undefined ? "" : REMOVED, thread.status,
    thread.jump === "deleted" ? DELETED : thread.jump ? JUMP : ""];
  return [...new Set(parts.filter(Boolean))].join(" · ");
}

function message(view: ThreadMessageView): TemplateResult {
  const agent = view.author === "agent";
  return html`<div class="tmsg tmsg-${view.author}${view.unread ? " is-unread" : ""}" data-reply-key=${agent ? view.replyKey : nothing}>
          <div class="tmsg-h"><span class="tmsg-who">${agent ? "Implementation agent" : "You"}${view.unread ? html`<span class="tmsg-new">New</span>` : nothing}</span>${view.time ? html`<time>${view.time}</time>` : nothing}</div>
          <p class="comment-body">${commentBody(view.body)}</p>${attachmentList(view.attachments)}
        </div>`;
}

function replyDraft(threadId: string, draft: ReplyDraftView): TemplateResult {
  return html`<div class="tmsg tmsg-user tmsg-draft" data-reply-id=${draft.id}>
          <div class="tmsg-h"><span class="tmsg-who">You</span><span class="tmsg-draft-tag">${draft.sending ? "Sending…" : "Draft"}</span>
            ${draft.sending ? nothing : html`<span class="tmsg-act">
              <button data-action="reply-edit" data-id=${threadId} data-reply-id=${draft.id} type="button">Edit</button>
              <button class="tmsg-del" data-action="reply-del" data-reply-id=${draft.id} type="button" aria-label="Delete draft reply">×</button>
            </span>`}
          </div>
          <p class="comment-body">${commentBody(draft.body)}</p>${attachmentList(draft.attachments)}
        </div>`;
}

function replyForm(threadId: string, form: ReplyFormView): TemplateResult {
  return html`<form class="tthread-reply" data-reply-form data-id=${threadId}>
          <textarea name="reply-body" rows="3" placeholder="Continue the conversation…" .value=${live(form.draft)}></textarea>${attachmentEditor(form.attachments)}
          <div class="nc-actions"><button type="button" data-action="reply-cancel">Cancel</button><button class="nc-save" type="submit" ?disabled=${form.saveDisabled}>${form.editing ? "Update reply" : "Save reply"}</button></div>
        </form>`;
}

function threadActions(thread: ThreadView): TemplateResult {
  const status = thread.status === "resolved"
    ? html`<button data-action="thread-reopen" data-id=${thread.id} type="button" ?disabled=${thread.busy}>${thread.busy ? html`${spinner}Reopening…` : "Unresolve"}</button>`
    : html`<button class="tthread-resolve" data-action="thread-resolve" data-id=${thread.id} type="button" ?disabled=${thread.busy}>${thread.busy ? html`${spinner}Resolving…` : "Mark resolved"}</button>`;
  return html`<div class="tthread-act">
          ${status}
          ${thread.replying ? nothing : html`<button data-action="thread-reply" data-id=${thread.id} type="button" ?disabled=${thread.busy}>Reply</button>`}
        </div>`;
}

/** An exported feedback thread: a reviewer and agent conversation the reviewer
 * can continue, mark resolved, or reopen. Only the reviewer controls closure. */
export function threadView(thread: ThreadView): TemplateResult {
  return html`<article class="tthread status-${thread.status} ${thread.collapsed ? "is-collapsed" : ""}" data-thread-id=${thread.id}>
      <div class="tthread-h" data-action="toggle-thread-collapse" data-id=${thread.id} role="button" tabindex="0" aria-expanded=${String(!thread.collapsed)} data-tooltip=${headerTooltip(thread)}
        data-tooltip-clipped=${thread.title && thread.title.tooltip === thread.title.text ? headerTooltip(thread, true) : nothing}>
        <span class="tthread-caret">${caretIcon}</span>
        <span class="tthread-type" aria-label=${thread.kindLabel}>${typeIcon(thread.kind)}</span>
        ${thread.title
          ? html`<strong class="tthread-title" data-clippable>${thread.title.text}</strong>`
          : html`<span class="tthread-title tthread-title-empty" aria-hidden="true"></span>`}
        ${thread.assignedStage ? html`<span class="tthread-stage">${thread.assignedStage}</span>` : nothing}
        ${thread.agentState ? html`<span class="tthread-agent is-${thread.agentState}">${AGENT_STATE[thread.agentState]}</span>` : nothing}
        ${thread.removedStage === undefined ? nothing : html`<span class="tthread-removed">Stage removed</span>`}
        <span class="tthread-status-ic s-${thread.status}" aria-label=${thread.status}>${thread.status === "resolved" ? resolvedIcon : openIcon}</span>
        ${threadJump(thread.jump)}
      </div>
      <div class="tthread-body">
        <div class="tthread-body-inner">
          ${thread.removedStage === undefined ? nothing
            : html`<p class="tthread-removed-note">Stage “${thread.removedStage}” changed nothing and was removed. This conversation is kept for reference and can no longer be replied to or reopened.</p>`}
          ${thread.stale ? html`<p class="tthread-stale">${thread.stale}</p>` : nothing}
          <div class="tthread-msgs">${thread.messages.map(message)}${repeat(thread.drafts, (draft) => draft.id, (draft) => replyDraft(thread.id, draft))}</div>
          ${thread.error ? html`<p class="tthread-err">${thread.error}</p>` : nothing}
          ${thread.actionable && thread.removedStage === undefined ? threadActions(thread) : nothing}
          ${thread.reply ? replyForm(thread.id, thread.reply) : nothing}
        </div>
      </div>
    </article>`;
}

function noteLabel(label: { text: string; title: string }): TemplateResult {
  const hint = labelHint(label.title, label.text);
  return html`<strong class="tthread-title" data-clippable data-tooltip=${hint.tooltip || nothing} data-tooltip-clipped=${hint.clipped || nothing}>${label.text}</strong>`;
}

/** A browser-local note. Drafts can be edited and deleted; a sent note waiting
 * for its thread to load is read-only. */
export function localNoteView(note: LocalNoteView): TemplateResult {
  const feedback = note.mode === "feedback";
  return html`<article class="tthread tnote mode-${note.mode} ${note.sent ? "is-sent" : "is-draft"}">
        <div class="tthread-h tnote-h">
          <span class="tnote-mode">${feedback ? "Feedback" : "Personal"}</span>
          ${feedback ? html`<span class="tnote-state">${note.sent ? "Sent" : note.sending ? "Sending…" : "Draft"}</span>` : nothing}
          ${note.label ? noteLabel(note.label) : nothing}${note.jump ? jumpButton(note.jump, "Show note target") : nothing}
        </div>
        ${note.missing ? html`<p class="tthread-stale">${note.missing}</p>` : nothing}
        <div class="tmsg tmsg-user ${feedback && !note.sent ? "tmsg-draft" : ""}"><div class="tmsg-h"><span class="tmsg-who">You</span><time>${note.time}</time>${note.sent || note.sending ? nothing : html`<div class="tnote-act">
          <button data-action="edit-note" data-index=${note.index} data-note-id=${note.id} type="button">Edit</button>
          <button class="tnote-del" data-action="del-note" data-index=${note.index} data-note-id=${note.id} type="button" aria-label="Delete note">×</button>
        </div>`}</div>
        <p class="comment-body">${commentBody(note.body)}</p>${attachmentList(note.attachments)}</div>
      </article>`;
}

/** The note composer, shown in the element's own thread so the reviewer keeps
 * what they comment on in view while they write. */
export function composerView(view: ComposerView): TemplateResult {
  const feedback = !view.remote && view.mode === "feedback";
  return html`<form class="note-compose mode-${feedback ? "feedback" : "personal"}" data-note-form>
      <div class="nc-mode" role="radiogroup" aria-label="Note type">
        <label class="nc-opt"><input type="radio" name="nc-mode" value="personal" .checked=${live(!feedback)}><span><b>Personal</b><small>Just for you.</small></span></label>
        ${view.remote ? nothing : html`<label class="nc-opt"><input type="radio" name="nc-mode" value="feedback" .checked=${live(feedback)}><span><b>Feedback</b><small>For the author.</small></span></label>`}
      </div>
      <textarea name="nc-body" rows="3" placeholder="A concise observation for your review…" .value=${live(view.body)}></textarea>${attachmentEditor(view.attachments)}
      <div class="nc-actions">
        <button type="button" data-action="compose-cancel">Cancel</button>
        <button class="nc-save" type="submit" ?disabled=${view.saveDisabled}>${view.editing ? "Save note" : "Add note"}</button>
      </div>
    </form>`;
}

function entry(item: ThreadEntryView): TemplateResult {
  if (item.type === "thread") return threadView(item.thread);
  if (item.type === "note") return localNoteView(item.note);
  return composerView(item.composer);
}

/** Threads and notes in order, each keeping its elements across updates. */
export function threadEntries(entries: readonly ThreadEntryView[]): unknown {
  return repeat(entries, (item) => item.key, entry);
}

function addNote(view: ThreadListView): TemplateResult {
  return view.composer ? composerView(view.composer)
    : html`<button class="thread-add" data-action="comment" data-kind=${view.kind} data-id=${view.id} data-stage=${view.stageId ?? nothing} type="button">＋ Add note</button>`;
}

/** The notes on a stage, step or evidence; nothing while they are hidden. */
export function inlineThread(view: ThreadListView | null): TemplateResult | typeof nothing {
  if (!view) return nothing;
  return html`<div class="thread" data-thread=${view.id} data-thread-list=${view.listKey}>${threadEntries(view.entries)}${addNote(view)}</div>`;
}

/** The notes on an open file, below its diff. Hidden notes leave the add-note
 * control in place. */
export function fileNotesView(view: ThreadListView): TemplateResult {
  return html`<div class="thread file-notes" data-thread=${view.id} data-thread-list=${view.listKey}>${view.entries.length ? html`<div class="file-note-threads">${threadEntries(view.entries)}</div>` : nothing}${addNote(view)}</div>`;
}

/** The notes on one diff line, shown beneath it. */
export function lineThreadView(view: ThreadListView): TemplateResult {
  return html`<div class="line-thread" data-thread=${view.id} data-thread-list=${view.listKey}><div class="line-thread-h"><span class="line-thread-where">Line notes</span>${view.entries.length
      ? html`<button class="line-thread-hide" data-action="line-note" data-id=${view.id} type="button" data-tooltip="Hide these notes">Hide</button>`
      : nothing}</div>${threadEntries(view.entries)}${addNote(view)}</div>`;
}
