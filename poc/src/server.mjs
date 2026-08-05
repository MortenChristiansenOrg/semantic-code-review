import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ArtifactError, readSemanticReview } from "./artifact-reader.mjs";
import {
  readStageDiff,
  ReviewServiceError,
  validateCurrentReview,
} from "./review-service.mjs";
import {
  addFeedbackComment,
  approveAllFeedback,
  approveFeedbackItem,
  approveFeedbackStack,
  createFeedbackBatch,
  deleteFeedbackBatch,
  deleteFeedbackComment,
  editFeedbackComment,
  initializeFeedback,
  readFeedback,
  submitFeedbackBatch,
} from "./feedback-service.mjs";

const modulePath = fileURLToPath(import.meta.url);
const publicDirectory = path.resolve(path.dirname(modulePath), "..", "public");
const defaultRepositoryRoot = path.resolve(
  path.dirname(modulePath),
  "..",
  "..",
);
const LOCAL_HOST_PATTERN =
  /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/i;

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
  if (error instanceof ReviewServiceError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }
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

function isAllowedHost(host) {
  return typeof host === "string" && LOCAL_HOST_PATTERN.test(host);
}

function validateMutationRequest(request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return;
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ReviewServiceError(
      "invalid-content-type",
      "Mutation requests must use application/json.",
      415,
    );
  }
  const expectedOrigin = `http://${request.headers.host}`;
  if (request.headers.origin && request.headers.origin !== expectedOrigin) {
    throw new ReviewServiceError(
      "invalid-origin",
      "Mutation requests must originate from this localhost service.",
      403,
    );
  }
  if (
    request.headers["sec-fetch-site"] &&
    !["same-origin", "none"].includes(request.headers["sec-fetch-site"])
  ) {
    throw new ReviewServiceError(
      "invalid-origin",
      "Cross-site mutation requests are not accepted.",
      403,
    );
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) {
      throw new ReviewServiceError(
        "request-too-large",
        "Request body exceeds the 64 KB limit.",
        413,
      );
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReviewServiceError(
      "invalid-request",
      "Request body must be valid JSON.",
      400,
    );
  }
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewServiceError(
      "invalid-request",
      `${name} is required.`,
      400,
    );
  }
  return value.trim();
}

export function createReviewServer({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot);
  return http.createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request.headers.host)) {
        sendJson(response, 403, {
          error: {
            code: "invalid-host",
            message: "This service only accepts localhost requests.",
          },
        });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      validateMutationRequest(request);
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review") {
        const review = await readSemanticReview({ repositoryRoot: root });
        sendJson(response, 200, review);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/validation") {
        const validation = await validateCurrentReview({
          repositoryRoot: root,
        });
        sendJson(response, 200, validation);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/feedback") {
        sendJson(response, 200, await readFeedback({ repositoryRoot: root }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/feedback/init") {
        sendJson(
          response,
          201,
          await initializeFeedback({ repositoryRoot: root }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/feedback/batches"
      ) {
        const body = await readRequestBody(request);
        sendJson(
          response,
          201,
          await createFeedbackBatch({
            repositoryRoot: root,
            title: requireText(body.title, "title"),
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/feedback/comments"
      ) {
        const body = await readRequestBody(request);
        if (!body.target || typeof body.target !== "object") {
          throw new ReviewServiceError(
            "invalid-request",
            "target is required.",
            400,
          );
        }
        sendJson(
          response,
          201,
          await addFeedbackComment({
            repositoryRoot: root,
            batchId: requireText(body.batchId, "batchId"),
            body: requireText(body.body, "body"),
            target: body.target,
          }),
        );
        return;
      }
      const submitMatch = url.pathname.match(
        /^\/api\/feedback\/batches\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/submit$/,
      );
      const deleteBatchMatch = url.pathname.match(
        /^\/api\/feedback\/batches\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/,
      );
      if (request.method === "DELETE" && deleteBatchMatch) {
        sendJson(
          response,
          200,
          await deleteFeedbackBatch({
            repositoryRoot: root,
            batchId: deleteBatchMatch[1],
          }),
        );
        return;
      }
      if (request.method === "POST" && submitMatch) {
        sendJson(
          response,
          200,
          await submitFeedbackBatch({
            repositoryRoot: root,
            batchId: submitMatch[1],
          }),
        );
        return;
      }
      const approveAllMatch = url.pathname.match(
        /^\/api\/feedback\/batches\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/approve-all$/,
      );
      if (request.method === "POST" && approveAllMatch) {
        sendJson(
          response,
          200,
          await approveAllFeedback({
            repositoryRoot: root,
            batchId: approveAllMatch[1],
          }),
        );
        return;
      }
      const approveItemMatch = url.pathname.match(
        /^\/api\/feedback\/items\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/approve$/,
      );
      if (request.method === "POST" && approveItemMatch) {
        sendJson(
          response,
          200,
          await approveFeedbackItem({
            repositoryRoot: root,
            itemId: approveItemMatch[1],
          }),
        );
        return;
      }
      const editItemMatch = url.pathname.match(
        /^\/api\/feedback\/items\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/,
      );
      if (request.method === "PATCH" && editItemMatch) {
        const body = await readRequestBody(request);
        sendJson(
          response,
          200,
          await editFeedbackComment({
            repositoryRoot: root,
            itemId: editItemMatch[1],
            body: requireText(body.body, "body"),
          }),
        );
        return;
      }
      if (request.method === "DELETE" && editItemMatch) {
        sendJson(
          response,
          200,
          await deleteFeedbackComment({
            repositoryRoot: root,
            itemId: editItemMatch[1],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/feedback/approve-stack"
      ) {
        sendJson(
          response,
          200,
          await approveFeedbackStack({
            repositoryRoot: root,
          }),
        );
        return;
      }
      const diffMatch = url.pathname.match(
        /^\/api\/stages\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/diff$/,
      );
      if (request.method === "GET" && diffMatch) {
        const diff = await readStageDiff({
          repositoryRoot: root,
          stageId: diffMatch[1],
        });
        sendJson(response, 200, diff);
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
  repositoryRoot = process.env.REPOSITORY_ROOT ?? defaultRepositoryRoot,
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
