import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ArtifactError, readSemanticReview } from "./artifact-reader.mjs";

const modulePath = fileURLToPath(import.meta.url);
const publicDirectory = path.resolve(path.dirname(modulePath), "..", "public");

function sendJson(response, status, body) {
  const content = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  response.end(content);
}

async function sendPublicFile(response, filename, contentType) {
  const content = await fs.readFile(path.join(publicDirectory, filename));
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": content.length,
    "cache-control": "no-store",
  });
  response.end(content);
}

function errorResponse(error) {
  if (error instanceof ArtifactError) {
    return {
      status: 422,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal-error",
        message: "The review could not be loaded.",
      },
    },
  };
}

export function createReviewServer({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot);
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review") {
        const review = await readSemanticReview({ repositoryRoot: root });
        sendJson(response, 200, review);
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        await sendPublicFile(
          response,
          "index.html",
          "text/html; charset=utf-8",
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        await sendPublicFile(
          response,
          "app.js",
          "text/javascript; charset=utf-8",
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/styles.css") {
        await sendPublicFile(
          response,
          "styles.css",
          "text/css; charset=utf-8",
        );
        return;
      }
      sendJson(response, 404, {
        error: {
          code: "not-found",
          message: "Route not found.",
        },
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, {
          error: {
            code: "not-found",
            message: "Route asset not found.",
          },
        });
        return;
      }
      const { status, body } = errorResponse(error);
      sendJson(response, status, body);
    }
  });
}

export async function startServer({
  repositoryRoot = process.cwd(),
  host = "127.0.0.1",
  port = Number(process.env.PORT ?? 4173),
} = {}) {
  const server = createReviewServer({ repositoryRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  const server = await startServer();
  const address = server.address();
  console.log(
    `Semantic Review Tool POC listening at http://${address.address}:${address.port}`,
  );
}
