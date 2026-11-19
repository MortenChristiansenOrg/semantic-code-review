// Lightweight per-line syntax highlighting for diff rows. A line becomes a list
// of plain strings and token templates, so lit renders the source as text and
// escapes nothing by hand.
import { html, type TemplateResult } from "lit-html";

/** One piece of a highlighted line: plain source text or a coloured token. */
export type CodeToken = string | TemplateResult;

const KEYWORDS = new Set(
  ("abstract as async await base bool break byte case catch char checked class const continue " +
   "decimal default delegate do double else enum event explicit extern false finally fixed float " +
   "for foreach function get goto if implicit in int interface internal is let lock long namespace " +
   "new null object operator out override params private protected public readonly record ref return " +
   "sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof " +
   "uint ulong unchecked unsafe ushort using var virtual void volatile while yield await async " +
   "export import extends implements instanceof of with from type keyof readonly never unknown any " +
   "boolean number undefined def elif except lambda pass raise global nonlocal None True False and " +
   "or not in").split(/\s+/),
);
// Languages whose line comments start with "#".
const HASH_COMMENTS = new Set(["py", "rb", "sh", "bash", "yml", "yaml", "toml", "ps1", "r", "pl", "ini", "cfg"]);

const comment = (text: string) => html`<span class="tok-com">${text}</span>`;
const string = (text: string) => html`<span class="tok-str">${text}</span>`;
const number = (text: string) => html`<span class="tok-num">${text}</span>`;
const keyword = (text: string) => html`<span class="tok-key">${text}</span>`;

/** The highlighting language of a path: its lowercased extension. */
export function langFor(path: unknown): string {
  return String(path || "").split(".").pop()!.toLowerCase();
}

const isIdStart = (c: string) => /[A-Za-z_$@#]/.test(c);
const isId = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Splits one source line into tokens. Adjacent plain text stays one string. */
export function tokenizeLine(source: unknown, lang: string): CodeToken[] {
  const s = String(source);
  const n = s.length;
  const hash = HASH_COMMENTS.has(lang);
  const out: CodeToken[] = [];
  let plain = "";
  const push = (token: TemplateResult) => {
    if (plain) { out.push(plain); plain = ""; }
    out.push(token);
  };
  let i = 0;
  while (i < n) {
    const c = s[i]!;
    if ((!hash && c === "/" && s[i + 1] === "/") || (hash && c === "#")) { push(comment(s.slice(i))); i = n; break; }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      push(comment(s.slice(i, stop))); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === "\\") j++; j++; }
      j = Math.min(j + 1, n);
      push(string(s.slice(i, j))); i = j; continue;
    }
    if (/[0-9]/.test(c) && (i === 0 || !isId(s[i - 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXbBoO._]/.test(s[j]!)) j++;
      push(number(s.slice(i, j))); i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(s[j])) j++;
      const word = s.slice(i, j);
      if (KEYWORDS.has(word)) push(keyword(word)); else plain += word;
      i = j; continue;
    }
    plain += c; i++;
  }
  if (plain) out.push(plain);
  return out.length ? out : [" "];
}

// Lines repeat across renders and pages; reuse their tokens.
const cache = new Map<string, readonly CodeToken[]>();

/** The tokens of a line, cached by language and text. */
export function highlightCode(source: unknown, lang: string): readonly CodeToken[] {
  const key = `${lang}\0${String(source)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const tokens = tokenizeLine(source, lang);
  if (key.length < 20000) {
    cache.set(key, tokens);
    while (cache.size > 4000) cache.delete(cache.keys().next().value!);
  }
  return tokens;
}
