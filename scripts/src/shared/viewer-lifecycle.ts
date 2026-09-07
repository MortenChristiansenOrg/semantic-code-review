import http from "node:http";
import process from "node:process";

export const VIEWER_HOST = "127.0.0.1";
export const VIEWER_APP_ID = "semantic-flow-review-viewer";

export interface ViewerIdentity {
  app: typeof VIEWER_APP_ID;
  implementationId: string;
  repositoryRoot?: string;
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

export function probeViewer(port = viewerPort()): Promise<ViewerIdentity | null> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: VIEWER_HOST,
        port,
        path: "/api/whoami",
        timeout: 1500,
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
