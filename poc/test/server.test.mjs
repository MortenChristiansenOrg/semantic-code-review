import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

function requestWithHost({ port, host, requestPath }) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        headers: {
          host,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    request.on("error", reject);
  });
}

test("serves the current semantic review as JSON", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/review`,
    );
    const body = await response.json();
    const visibleStageIds = [
      ...body.stages.map((stage) => stage.id),
      ...body.workingStages.map((stage) => stage.id),
    ];

    assert.equal(response.status, 200);
    assert.equal(body.manifest.reviewId, "review-tool-poc");
    assert.ok(visibleStageIds.includes("load-artifact-api"));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("discovers the repository when npm changes the working directory", async () => {
  const server = await startServer({ port: 0 });
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/review`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.manifest.reviewId, "review-tool-poc");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves the browser workspace assets", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    const [html, script, styles] = await Promise.all([
      htmlResponse.text(),
      scriptResponse.text(),
      styleResponse.text(),
    ]);

    assert.equal(htmlResponse.status, 200);
    assert.match(html, /Semantic Review Workspace/);
    assert.equal(scriptResponse.status, 200);
    assert.match(script, /renderStageDetail/);
    assert.equal(styleResponse.status, 200);
    assert.match(styles, /\.stage-spine/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves authoritative validation and a finalized stage diff", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [validationResponse, diffResponse] = await Promise.all([
      fetch(`${baseUrl}/api/validation`),
      fetch(`${baseUrl}/api/stages/load-artifact-api/diff`),
    ]);
    const [validation, diff] = await Promise.all([
      validationResponse.json(),
      diffResponse.json(),
    ]);

    assert.equal(validationResponse.status, 200);
    assert.equal(validation.status, "passed");
    assert.match(validation.summary, /full validation passed/i);
    assert.equal(diffResponse.status, 200);
    assert.equal(diff.stageId, "load-artifact-api");
    assert.match(diff.diff, /poc\/src\/artifact-reader\.mjs/);
    assert.match(diff.diff, /^\+.*readSemanticReview/m);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects non-local Host headers before serving repository data", async () => {
  const server = await startServer({ repositoryRoot, port: 0 });
  try {
    const address = server.address();
    const response = await requestWithHost({
      port: address.port,
      host: "attacker.example",
      requestPath: "/api/review",
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "invalid-host");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
