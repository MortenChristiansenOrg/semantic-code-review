/* Starts the viewer page. The page receives its secrets through a single-use
   launch code in the URL fragment, loads the review data with them, and only
   then loads the app, whose modules read that data when they load. */
import { showFreshLinkNotice, storeAccess, storedAccess, takeLaunchCode, type Access } from "./access";
import * as api from "./api";

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

// A launch link opened in a tab that already shows this viewer changes only the
// fragment. Its code may belong to a restarted viewer on the same port: start over with it.
window.addEventListener("hashchange", () => {
  const code = takeLaunchCode();
  if (!code) return;
  void redeem(code).then((access) => {
    if (!access) { showFreshLinkNotice(); return; }
    storeAccess(access);
    window.location.reload();
  });
});

void (async function boot() {
  // The code leaves the address bar before anything else happens.
  const code = takeLaunchCode();
  const access = code ? await redeem(code) : storedAccess();
  if (!access) { storeAccess(null); showFreshLinkNotice(); return; }
  storeAccess(access);
  api.configureAccess(access);
  let start;
  try {
    const response = await api.getBootstrap();
    const body = await response.json();
    if (!response.ok || !body.ok) {
      if (!body.ok && body.keyRequired) return;
      throw new Error(body.ok ? "" : body.error);
    }
    start = body;
  } catch (error) {
    const app = document.querySelector("#app");
    if (app && !document.getElementById("fresh-link-notice")) app.textContent = `${error instanceof Error && error.message ? error.message : "Review data could not be loaded."} Reload to retry.`;
    return;
  }
  window.SEMANTIC_ACCESS = access;
  window.SEMANTIC_IMPLEMENTATION = start.implementation;
  window.SEMANTIC_REVIEW_CONTEXT = start.context;
  loadScript("markdown.js");
  loadScript("app.js");
})();
