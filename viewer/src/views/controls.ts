// Approval and note controls shared by stages, steps and insights.
import { html, nothing, type TemplateResult } from "lit-html";
import { bubbleIcon } from "./icons";

export type ApprovalState = "none" | "approved" | "stale";

/** The kinds of element a note or thread toggle can address. */
export type NoteTargetKind = "stage" | "node" | "insight";

export interface ApproveButtonView {
  kind: string;
  id: string;
  state: ApprovalState;
  /** Why the approval cannot be captured now; empty when it can. */
  blocked: string;
  /** An accessible name naming the target; absent to use the button text. */
  label?: string;
}

/** An approval toggle. `subject` names its target in the button text, e.g. "stage 01". */
export function approveButton(view: ApproveButtonView, size = "", subject = ""): TemplateResult {
  const of = subject ? ` ${subject}` : "";
  const stale = !view.blocked && view.state === "stale";
  const on = !view.blocked && view.state === "approved";
  const tooltip = view.blocked || (stale ? "Changed since you approved it — click to re-approve" : "");
  return html`<button class="approve ${size} ${stale ? "is-stale" : ""} ${on ? "is-on" : ""}" data-action="approve" data-kind=${view.kind} data-id=${view.id} type="button"
      aria-pressed=${String(on)} aria-label=${view.label ?? nothing} ?disabled=${Boolean(view.blocked)} data-tooltip=${tooltip || nothing}><span class="check">${stale ? "!" : on ? "✓" : ""}</span>${stale ? "Re-approve" : on ? "Approved" : "Approve"}${of}</button>`;
}

export interface NotesToggleView {
  kind: NoteTargetKind;
  id: string;
  stageId: string;
  /** Threads and visible local notes on the element. */
  total: number;
  /** The unresolved part of `total`. */
  open: number;
  expanded: boolean;
}

/** Shows or hides an element's notes; absent when it has none. */
export function notesToggle(view: NotesToggleView | null): TemplateResult | typeof nothing {
  if (!view) return nothing;
  const title = `${view.total} thread${view.total === 1 ? "" : "s"}${view.open ? `, ${view.open} open` : ", all resolved"}`;
  return html`<button class="notes-toggle ${view.expanded ? "is-open" : ""} ${view.open ? "" : "all-resolved"}" data-action="toggle-thread" data-kind=${view.kind} data-id=${view.id} data-stage=${view.stageId} type="button" aria-expanded=${String(view.expanded)} aria-label=${title} data-tooltip=${title}>${bubbleIcon}<b>${view.total}</b>${view.open ? html`<i class="nt-dot"></i>` : nothing}</button>`;
}

export interface NoteTargetView {
  kind: NoteTargetKind;
  id: string;
  stageId: string;
}

/** Starts a note on an element. */
export function addNoteButton(target: NoteTargetView): TemplateResult {
  return html`<button class="comment" data-action="comment" data-kind=${target.kind} data-id=${target.id} data-stage=${target.stageId} type="button">＋ Add note</button>`;
}

export interface AcceptanceChipView {
  /** The criterion ID shown on the chip. */
  id: string;
  /** The validation status class: passed, notrun, or empty when uncovered. */
  vstat: string;
  glyph: string;
  label: string;
  meta: string;
  /** The criterion text, or its ID when it is unknown. */
  text: string;
}

/** An acceptance criterion a stage covers; its popover shows the criterion. */
export function acceptanceChip(view: AcceptanceChipView): TemplateResult {
  return html`<button class="ac-chip tag-face" type="button" data-tagpop="1"
      data-type="acceptance" data-vstat=${view.vstat}
      data-glyph=${view.glyph} data-label=${view.label} data-meta=${view.meta}
      data-title=${view.text} data-body=""
      aria-haspopup="true"><span class="ac-chip-id">${view.id}</span><span class="ac-chip-stat vstat-${view.vstat}">${view.glyph}</span></button>`;
}
