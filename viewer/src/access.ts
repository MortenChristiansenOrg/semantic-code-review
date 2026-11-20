// The secrets the page uses to reach its viewer, and the notice shown when it
// has none that work. Both boot.js and app.js bundle this module.

/** The viewer's key and read token, from POST `/api/session`. */
export interface Access {
  key: string;
  read: string;
}

declare global {
  interface Window {
    /** Written by boot.js before it loads the app. */
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

export function storeAccess(access: Access | null): void {
  try {
    if (access) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(access));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* The page keeps the access in memory only. */ }
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
