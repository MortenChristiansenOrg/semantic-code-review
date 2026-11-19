/** Escapes a value for use in HTML text or a quoted attribute. */
export function esc(v: unknown): string {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;")
    // The HTML parser turns a literal carriage return into a newline; a reference keeps it.
    .replaceAll("\r", "&#13;");
}

/** Escapes a comment body and renders `inline code` spans. Comments are prose:
 * any line ending is a line break, as the HTML parser would make it. */
export function formatCommentBody(v: unknown): string {
  return esc(String(v).replace(/\r\n?/g, "\n")).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}
