// Access control of the local review viewer: the per-process secrets that every
// API request needs, the single-use launch codes that hand them to the viewer
// page, and the request checks and response headers the server applies.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { reviewDirectory } from "./review-store.js";
import { VIEWER_HOST } from "./viewer-lifecycle.js";

export { KEY_HEADER } from "./viewer-lifecycle.js";
/** How long a launch code stays valid. */
export const LAUNCH_CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_LAUNCH_CODES = 16;

/** The text shown when a page or request lacks a usable key. */
export const FRESH_LINK_MESSAGE = "This review page needs a fresh link. Run the review command again in the repository, or ask the agent to open the review.";

const secret = () => randomBytes(32).toString("base64url");

/** Compares two secrets in constant time. */
export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The URL that opens the viewer with a launch code. The fragment never reaches
 * the server or a Referer header. */
export function launchUrl(port: number, code: string): string {
  return `http://${VIEWER_HOST}:${port}/#launch=${code}`;
}

/** The secrets of one viewer process and its outstanding launch codes.
 *
 * `key` authorizes every API request; it is sent only in a request header and is
 * also stored in the review record so the CLI can reach a running viewer.
 *
 * `read` authorizes only GET requests of the three resources the browser loads by
 * URL (evidence, attachments and raw file content), because images, media, links
 * and downloads cannot send a header. URLs carrying it reach only browser history
 * and download records, which only the same OS user can read, and that user can
 * already read the review files. It is never stored on disk. */
export function createViewerAccess(reviewId: string, now: () => number = Date.now) {
  const key = secret(), read = secret();
  const codes = new Map<string, number>();
  const drop = (code: string) => { codes.delete(code); removeLaunchFile(reviewId, code); };
  const expire = () => { for (const [code, expires] of codes) if (expires <= now()) drop(code); };
  return {
    key,
    read,
    /** A new single-use launch code. The oldest outstanding code is dropped when
     * too many are outstanding. */
    mintCode(): string {
      expire();
      for (const oldest of codes.keys()) {
        if (codes.size < MAX_LAUNCH_CODES) break;
        drop(oldest);
      }
      const code = secret();
      codes.set(code, now() + LAUNCH_CODE_LIFETIME_MS);
      return code;
    },
    /** Spends a launch code; true when it was outstanding and unexpired. */
    redeem(code: unknown): boolean {
      const expires = typeof code === "string" ? codes.get(code) : undefined;
      if (typeof code !== "string" || expires === undefined) return false;
      drop(code);
      return expires > now();
    },
    expire,
    outstanding: () => codes.size,
  };
}
export type ViewerAccess = ReturnType<typeof createViewerAccess>;

/** The two names the viewer answers to. Browsers leave the default port out of
 * Host and Origin. */
function ownHosts(port: number): Set<string> {
  const names = [VIEWER_HOST, "localhost"];
  return new Set([...names.map((name) => `${name}:${port}`), ...(port === 80 ? names : [])]);
}

/** Whether a request target is a path, as in `GET /path?query`. Other forms
 * (absolute URLs, `*`, authority form, paths that a URL parser would read as
 * another host or rewrite) are refused before any parsing. */
export function originFormTarget(target: string | undefined): target is string {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") && !target.includes("\\");
}

/** Whether the Host header names this viewer exactly. Other names, including
 * DNS names that resolve to this machine, are refused. */
export function ownHost(request: http.IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return typeof host === "string" && ownHosts(port).has(host.toLowerCase());
}

/** Whether a request may reach the API: an Origin, when sent, is this viewer's
 * own, and fetch metadata, when sent, reports a same-origin or user-initiated request. */
export function ownApiCaller(request: http.IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && !new Set([...ownHosts(port)].map((host) => `http://${host}`)).has(origin.toLowerCase())) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** Headers sent with every response. */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

/** Headers of the page and its static files. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'none'", "script-src 'self'", "connect-src 'self'",
    "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' https: http:", "media-src 'self'", "worker-src 'none'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

/* ---- opening the browser ------------------------------------------------- */

/** Whether the browser opens the launch URL itself rather than a launch file.
 * Other users cannot read process arguments on Windows. Elsewhere,
 * `SEMANTIC_VIEW_OPEN_URL=1` opts in for browsers that cannot read the review
 * home, such as sandboxed ones, or when HTML files open in an editor. */
export function opensLaunchUrl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === "win32" || env.SEMANTIC_VIEW_OPEN_URL === "1";
}

/** The program and arguments that open a launch URL or launch file. Each target
 * is passed as one literal argument; no shell parses it. */
export function browserOpener(target: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "win32") {
    // rundll32 hands the rest of its command line to the URL handler as is, so
    // the target must not need quoting: launch URLs consist of safe characters only.
    if (!/^http:\/\/127\.0\.0\.1:\d+\/#launch=[A-Za-z0-9_-]+$/.test(target)) throw new Error("Only launch URLs open on Windows.");
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", target]];
  }
  return [platform === "darwin" ? "open" : "xdg-open", [target]];
}

/* ---- launch files -------------------------------------------------------- */

// Opening the browser with a launch URL would put the code in the process
// arguments of the browser opener, which other users of the machine can list.
// The browser opens a private file that redirects to the URL instead.
const launchDirectory = (reviewId: string) => path.join(reviewDirectory(reviewId), "launch");
const launchFileName = (code: string) => createHash("sha256").update(code).digest("hex").slice(0, 32) + ".html";

/** Writes a private file that sends the browser to the launch URL; returns its path. */
export function writeLaunchFile(reviewId: string, port: number, code: string): string {
  const directory = launchDirectory(reviewId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, launchFileName(code));
  const target = launchUrl(port, code);
  fs.writeFileSync(file, `<!doctype html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<meta http-equiv="refresh" content="0;url=${target}">\n<title>Opening review</title>\n`, { mode: 0o600 });
  return file;
}

/** Removes the launch file of a code, if any. */
export function removeLaunchFile(reviewId: string, code: string): void {
  try { fs.rmSync(path.join(launchDirectory(reviewId), launchFileName(code)), { force: true }); } catch { /* Best effort. */ }
}

/** Removes launch files older than `maxAgeMs`. */
export function sweepLaunchFiles(reviewId: string, maxAgeMs: number, now = Date.now()): void {
  let directory: string, names: string[];
  try { directory = launchDirectory(reviewId); names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.html$/.test(name)) continue;
    const file = path.join(directory, name);
    try { if (now - fs.statSync(file).mtimeMs >= maxAgeMs) fs.rmSync(file, { force: true }); } catch { /* Best effort. */ }
  }
}
