import { html, type TemplateResult } from "lit-html";

/** A comment body as text with `inline code` spans. Comments are prose: any
 * line ending is a line break, as the HTML parser would make it. */
export function commentBody(value: unknown): Array<string | TemplateResult> {
  // Splitting on a capture group puts the code spans at the odd indices.
  // Stored agent questions are not validated, so a missing body renders as empty.
  return String(value ?? "").replace(/\r\n?/g, "\n").split(/`([^`\n]+)`/)
    .map((part, index) => index % 2 ? html`<code>${part}</code>` : part);
}
