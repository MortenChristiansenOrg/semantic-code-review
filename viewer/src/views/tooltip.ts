// The content of the shared floating tooltip and the reasoning tag popover.
import { html, nothing, type TemplateResult } from "lit-html";

/** A plain tooltip. */
export function tooltipView(text: string): TemplateResult {
  return html`<strong>${text}</strong>`;
}

export interface TagPopoverView {
  /** The kind line: glyph, label, meta and review state. */
  kind: string;
  title: string;
  body: string;
}

/** The popover of an insight tag or acceptance chip. */
export function tagPopoverView(view: TagPopoverView): TemplateResult {
  return html`<span class="tag-pop-kind">${view.kind}</span>
      <strong>${view.title}</strong>
      ${view.body ? html`<p>${view.body}</p>` : nothing}`;
}
