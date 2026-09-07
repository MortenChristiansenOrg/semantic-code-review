import http from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

export const VIEWER_HOST = "127.0.0.1";
export const VIEWER_APP_ID = "semantic-flow-review-viewer";

export interface ViewerIdentity {
  app: typeof VIEWER_APP_ID;
  implementationId: string;
  repositoryRoot?: string;
  skillDirectory?: string;
  processId?: number;
  viewerVersion?: string;
  healthy?: boolean;
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

export function probeViewer(
  port = viewerPort(),
  agent?: http.Agent,
): Promise<ViewerIdentity | null> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: VIEWER_HOST,
        port,
        path: "/api/whoami",
        timeout: 1500,
        agent,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(
              parsed &&
                parsed.app === VIEWER_APP_ID &&
                typeof parsed.implementationId === "string"
                ? parsed
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

export function requestViewerShutdown(
  port = viewerPort(),
  agent?: http.Agent,
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: VIEWER_HOST,
        port,
        path: "/api/shutdown",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 1500,
        agent,
      },
      (response) => {
        response.on("data", () => {});
        response.on("end", () => resolve(response.statusCode === 200));
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end("{}");
  });
}

export async function stopViewerAndWait(
  viewer: ViewerIdentity,
  port = viewerPort(),
  timeoutMs = 5000,
): Promise<void> {
  const pid = viewer.processId;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Cannot safely stop a viewer without a valid process ID.");
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const connect = agent.createConnection.bind(agent);
  let connection: ReturnType<typeof connect>;
  // Legacy viewers cannot validate a shutdown token. Never reconnect to a new occupant.
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
    const current = await probeViewer(port, agent);
    if (current?.processId !== pid ||
        current.repositoryRoot !== viewer.repositoryRoot ||
        current.implementationId !== viewer.implementationId ||
        current.skillDirectory !== viewer.skillDirectory ||
        current.viewerVersion !== viewer.viewerVersion) {
      throw new Error("The viewer changed before shutdown; refusing to stop it.");
    }
    if (!await requestViewerShutdown(port, agent)) {
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
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Viewer process ${pid} did not exit after shutdown.`);
}
