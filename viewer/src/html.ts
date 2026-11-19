/** Escapes a value for use in HTML text or a quoted attribute. */
export function esc(v: unknown): string {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;")
    // The HTML parser turns a literal carriage return into a newline; a reference keeps it.
    .replaceAll("\r", "&#13;");
}

