// Requests to a running review viewer, made the way the CLI makes them: with the
// viewer's key, read from the review record of the viewer on that port.
import fs from "node:fs";
import path from "node:path";

export const KEY_HEADER = "x-semantic-flow-key";

/** Whether a process is running. */
function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

/** The key of the running viewer recorded on `port`, or undefined. A stopped
 * viewer's record may still name the port, which a later viewer reuses, so
 * only a record whose viewer process still runs counts. */
export function viewerKey(port, home = process.env.SEMANTIC_FLOW_HOME) {
  const reviews = path.join(home, "reviews");
  let names = [];
  try { names = fs.readdirSync(reviews); } catch { return undefined; }
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(reviews, name, "review.json"), "utf8"));
      if (record.viewer?.port === Number(port) && record.viewer.key && running(record.viewer.processId)) return record.viewer.key;
    } catch { /* Not a review. */ }
  }
  return undefined;
}

/** A viewer URL without its launch fragment, ending in "/". */
export function viewerBase(url) {
  const base = new URL(url);
  base.hash = "";
  base.pathname = "/";
  base.search = "";
  return base.href;
}

/** fetch with the viewer's key added; `key` overrides the recorded one. */
export function viewerFetch(url, init = {}, key = viewerKey(new URL(url).port)) {
  const headers = new Headers(init.headers);
  if (key && !headers.has(KEY_HEADER)) headers.set(KEY_HEADER, key);
  return fetch(url, { ...init, headers });
}
