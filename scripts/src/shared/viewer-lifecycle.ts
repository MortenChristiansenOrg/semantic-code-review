import http from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseJson } from "./json.js";
import { booleanField, errorCode, isRecord, numberField, stringField } from "./narrow.js";

export const VIEWER_HOST = "127.0.0.1";
export const VIEWER_APP_ID = "semantic-flow-review-viewer";
/** The request header that carries a viewer's key. Viewers of older releases ignore it. */
export const KEY_HEADER = "x-semantic-flow-key";

export interface ViewerIdentity {
  app: typeof VIEWER_APP_ID;
  implementationId: string;
  repositoryRoot?: string;
  skillDirectory?: string;
  processId?: number;
  viewerVersion?: string;
  healthy?: boolean;
  port?: number;
  reviewId?: string;
  generation?: string;
  reviewHome?: string;
  /** The key the identity was read with, from the review record; absent for
   * viewers of older releases, which need none. Not part of the response. */
  key?: string;
}

const OPTIONAL_IDENTITY_FIELDS = {
  repositoryRoot: "string", skillDirectory: "string", processId: "number", viewerVersion: "string",
  healthy: "boolean", reviewId: "string", generation: "string", reviewHome: "string",
} as const;

/** A /api/whoami response, or null when it is not a viewer identity. A field
 * of the wrong type makes the whole identity unrecognized. */
function parseViewerIdentity(value: unknown, port: number): ViewerIdentity | null {
  if (!isRecord(value) || value.app !== VIEWER_APP_ID || typeof value.implementationId !== "string") return null;
  for (const [key, type] of Object.entries(OPTIONAL_IDENTITY_FIELDS)) {
    if (value[key] !== undefined && typeof value[key] !== type) return null;
  }
  return {
    app: VIEWER_APP_ID, implementationId: value.implementationId, port,
    repositoryRoot: stringField(value, "repositoryRoot"), skillDirectory: stringField(value, "skillDirectory"),
    processId: numberField(value, "processId"), viewerVersion: stringField(value, "viewerVersion"),
    healthy: booleanField(value, "healthy"), reviewId: stringField(value, "reviewId"),
    generation: stringField(value, "generation"), reviewHome: stringField(value, "reviewHome"),
  };
}

export function viewerPort(): number {
  const configured = process.env.SEMANTIC_VIEW_PORT;
  if (configured === undefined) {
    return 29180;
  }
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SEMANTIC_VIEW_PORT must be an integer from 1 to 65535.`);
  }
  return port;
}

/** What a viewer port answered to /api/whoami. `refused` means a viewer that
 * requires a key refused the one sent, or none was sent. */
export interface ViewerProbe {
  identity: ViewerIdentity | null;
  refused: boolean;
}

interface ViewerRequestOptions {
  agent?: http.Agent;
  /** The viewer's key, when known. */
  key?: string;
}

const keyHeaders = (key: string | undefined): Record<string, string> => key ? { [KEY_HEADER]: key } : {};

/** How long one request to a viewer may take in total. */
const REQUEST_DEADLINE_MS = 3000;

/** One request to a viewer port: its status and body text, or null when it fails,
 * the response ends early or the deadline passes. It always settles. */
function viewerRequest(
  port: number,
  options: { method: "GET" | "POST"; path: string; headers: Record<string, string>; agent?: http.Agent },
  body?: string,
): Promise<{ status: number; text: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { status: number; text: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!result) request.destroy();
      resolve(result);
    };
    const request = http.request({ host: VIEWER_HOST, port, ...options, timeout: 1500 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => settle({ status: response.statusCode ?? 0, text }));
      // Before "end", these mean the body is incomplete.
      response.on("aborted", () => settle(null));
      response.on("error", () => settle(null));
      response.on("close", () => settle(null));
    });
    const deadline = setTimeout(() => settle(null), REQUEST_DEADLINE_MS);
    request.on("error", () => settle(null));
    request.on("timeout", () => settle(null));
    request.on("close", () => settle(null));
    request.end(body);
  });
}

/** Whether a 403 is a viewer's refusal of a missing or wrong key. Other servers
 * that answer 403 are not viewers. */
function keyRefusal(text: string): boolean {
  try { return booleanField(parseJson(text), "keyRequired") === true; } catch { return false; }
}

export async function probeViewerAccess(
  port = viewerPort(),
  { agent, key }: ViewerRequestOptions = {},
): Promise<ViewerProbe> {
  const response = await viewerRequest(port, { method: "GET", path: "/api/whoami", headers: keyHeaders(key), agent });
  if (!response) return { identity: null, refused: false };
  if (response.status === 403) return { identity: null, refused: keyRefusal(response.text) };
  try {
    const identity = parseViewerIdentity(parseJson(response.text), port);
    return { identity: identity && key ? { ...identity, key } : identity, refused: false };
  } catch {
    return { identity: null, refused: false };
  }
}

/** The identity of the viewer on a port, or null when none answers or it refuses the key. */
export async function probeViewer(
  port = viewerPort(),
  options: ViewerRequestOptions = {},
): Promise<ViewerIdentity | null> {
  return (await probeViewerAccess(port, options)).identity;
}

/** POSTs an empty JSON body to a viewer route; the parsed response, or null when
 * the request fails. */
async function postViewer(port: number, route: string, { agent, key }: ViewerRequestOptions): Promise<{ status: number; body: unknown } | null> {
  const response = await viewerRequest(port, { method: "POST", path: route, headers: { "content-type": "application/json", ...keyHeaders(key) }, agent }, "{}");
  if (!response) return null;
  let body: unknown = null;
  try { body = parseJson(response.text); } catch { /* Not JSON. */ }
  return { status: response.status, body };
}

/** Asks a running viewer for a new single-use launch code. */
export async function requestLaunchCode(port: number, key: string): Promise<string | null> {
  const response = await postViewer(port, "/api/launch", { key });
  const code = response?.status === 200 ? stringField(response.body, "code") : undefined;
  return code && /^[A-Za-z0-9_-]{16,}$/.test(code) ? code : null;
}

export async function requestViewerShutdown(
  port = viewerPort(),
  options: ViewerRequestOptions = {},
): Promise<boolean> {
  return (await postViewer(port, "/api/shutdown", options))?.status === 200;
}

export async function stopViewerAndWait(
  viewer: ViewerIdentity,
  port = viewer.port ?? viewerPort(),
  timeoutMs = 5000,
): Promise<void> {
  const pid = viewer.processId;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Cannot safely stop a viewer without a valid process ID.");
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const connect = agent.createConnection.bind(agent);
  let connection: ReturnType<typeof connect>;
  // Viewers of older releases take no key, so the shutdown must reach the process
  // whose identity was just checked: never reconnect to a new occupant.
  agent.createConnection = (options, callback) => {
    if (connection) {
      const error = new Error("The verified viewer connection closed before shutdown.");
      if (!callback) throw error;
      callback(error, connection);
      return undefined;
    }
    connection = connect(options, callback);
    return connection;
  };
  try {
    const current = await probeViewer(port, { agent, key: viewer.key });
    if (current?.processId !== pid ||
        current.repositoryRoot !== viewer.repositoryRoot ||
        current.implementationId !== viewer.implementationId ||
        current.skillDirectory !== viewer.skillDirectory ||
        current.viewerVersion !== viewer.viewerVersion) {
      throw new Error("The viewer changed before shutdown; refusing to stop it.");
    }
    if (!await requestViewerShutdown(port, { agent, key: viewer.key })) {
      throw new Error(`Could not request viewer shutdown on port ${port}.`);
    }
  } finally {
    agent.destroy();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Viewer process ${pid} did not exit after shutdown.`);
}
