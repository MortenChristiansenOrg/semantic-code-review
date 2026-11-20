// The secrets the page uses to reach its viewer, and the notice shown when it
// has none that work. Both boot.js and app.js bundle this module, so the
// current secrets live on the window, where both bundles see the same ones.

/** The viewer's key and read token, from POST `/api/session`. */
export interface Access {
  key: string;
  read: string;
}

declare global {
  interface Window {
    /** The secrets requests use; absent until boot.js has them and after the server refused them. */
    SEMANTIC_ACCESS?: Access;
  }
}

const STORAGE_KEY = "semantic-flow-access";

// Session storage keeps reloads of this tab working; each viewer port is its own origin.
export function storedAccess(): Access | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (value && typeof value === "object" && "key" in value && "read" in value && typeof value.key === "string" && typeof value.read === "string") return { key: value.key, read: value.read };
  } catch { /* Unavailable or damaged storage holds no access. */ }
  return null;
}

/** Stores the access for reloads of this tab; false when session storage is unavailable. */
function storeAccess(access: Access | null): boolean {
  try {
    if (access) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(access));
    else sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch { return false; }
}

/** The secrets requests use now, or null when the page has none that work. */
export function currentAccess(): Access | null {
  return window.SEMANTIC_ACCESS ?? null;
}

/** Makes requests use these secrets. Returns whether a reload of this tab keeps
 * them: without session storage the page holds them in memory only. */
export function useAccess(access: Access): boolean {
  window.SEMANTIC_ACCESS = access;
  document.getElementById("fresh-link-notice")?.remove();
  return storeAccess(access);
}

/** Drops the secrets a request used after the server refused them, and shows how
 * to get a fresh link. Secrets the page adopted since then stay. */
export function loseAccess(used: Access | null): void {
  const current = currentAccess();
  if (current && used && current.key !== used.key) return;
  delete window.SEMANTIC_ACCESS;
  storeAccess(null);
  showFreshLinkNotice();
}

/** Takes a launch code from the address and removes it from the address bar. */
export function takeLaunchCode(): string | null {
  const match = /^#launch=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (window.location.hash.startsWith("#launch=")) {
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
  }
  return match ? match[1] : null;
}

/** Shows that the page needs a fresh link. The rest of the page stays as it is,
 * so unsaved text remains visible and can be copied. */
export function showFreshLinkNotice(): void {
  if (document.getElementById("fresh-link-notice")) return;
  const notice = document.createElement("div");
  notice.id = "fresh-link-notice";
  notice.className = "fresh-link-notice";
  notice.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = "This review page needs a fresh link.";
  const detail = document.createElement("p");
  detail.textContent = "Run the review command again in the repository, or ask the agent to open the review. A new tab or a bookmark of this page also needs a fresh link.";
  notice.append(title, detail);
  document.body.prepend(notice);
}
