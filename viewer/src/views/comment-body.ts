import { html, type TemplateResult } from "lit-html";

/** A comment body as text with `inline code` spans. Comments are prose: any
 * line ending is a line break, as the HTML parser would make it. */
export function commentBody(value: string): Array<string | TemplateResult> {
  // Splitting on a capture group puts the code spans at the odd indices.
  return value.replace(/\r\n?/g, "\n").split(/`([^`\n]+)`/)
    .map((part, index) => index % 2 ? html`<code>${part}</code>` : part);
}
