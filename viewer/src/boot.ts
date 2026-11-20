/* Starts the viewer page. The page receives its secrets through a single-use
   launch code in the URL fragment, loads the review data with them, and only
   then loads the app, whose modules read that data when they load. */
import { currentAccess, showFreshLinkNotice, storedAccess, takeLaunchCode, useAccess, type Access } from "./access";
import * as api from "./api";

declare global {
  interface Window {
    /** Set by app.js when it runs: the start of the page, which a fresh link
     * repeats when it failed, for example because the viewer restarted. */
    SEMANTIC_APP?: {
      /** Whether the page started, once the current attempt settled. */
      started(): Promise<boolean>;
      /** Starts the page unless it started already; whether it started. */
      start(): Promise<boolean>;
    };
  }
}

async function redeem(code: string): Promise<Access | null> {
  try {
    const response = await api.startSession({ code });
    const body = await response.json();
    return response.ok && body.ok ? { key: body.key, read: body.read } : null;
  } catch { return null; }
}

function loadScript(src: string): void {
  const script = document.createElement("script");
  script.src = src;
  // Dynamically added scripts run in the order added only when not async.
  script.async = false;
  document.body.append(script);
}

/** Whether the app scripts were added; they run once per page. */
let appLoaded = false;

/** Loads the review data with the access and then the app. */
async function start(access: Access): Promise<void> {
  useAccess(access);
  let start;
  try {
    const response = await api.getBootstrap();
    const body = await response.json();
    if (!response.ok || !body.ok) {
      // The request already showed how to get a fresh link.
      if (!body.ok && body.keyRequired) return;
      throw new Error(body.ok ? "" : body.error);
    }
    start = body;
  } catch (error) {
    const app = document.querySelector("#app");
    if (app && !document.getElementById("fresh-link-notice")) app.textContent = `${error instanceof Error && error.message ? error.message : "Review data could not be loaded."} Reload to retry.`;
    return;
  }
  if (appLoaded) return;
  appLoaded = true;
  window.SEMANTIC_IMPLEMENTATION = start.implementation;
  window.SEMANTIC_REVIEW_CONTEXT = start.context;
  loadScript("markdown.js");
  loadScript("app.js");
}

const booting = (async function boot() {
  // The code leaves the address bar before anything else happens.
  const code = takeLaunchCode();
  // A spent or expired link leaves the access this tab already has in place.
  const access = (code ? await redeem(code) : null) ?? storedAccess();
  if (!access) { showFreshLinkNotice(); return; }
  await start(access);
})();

// A launch link opened in a tab that already shows this viewer changes only the
// fragment. Its code may belong to a restarted viewer on the same port.
window.addEventListener("hashchange", () => {
  const code = takeLaunchCode();
  if (!code) return;
  void booting.then(async () => {
    const access = await redeem(code);
    // A spent or expired link leaves a working page as it is.
    if (!access) { if (!currentAccess()) showFreshLinkNotice(); return; }
    if (!appLoaded) { await start(access); return; }
    // An app whose start failed starts with the new access. One that has not
    // run yet uses the access when it does.
    const app = window.SEMANTIC_APP;
    if (!app || !await app.started()) {
      useAccess(access);
      if (app) await app.start();
      return;
    }
    // A reload loads the page the server now serves, when this tab keeps the
    // access across it; otherwise the running page continues with the new access.
    if (useAccess(access)) window.location.reload();
  });
});
