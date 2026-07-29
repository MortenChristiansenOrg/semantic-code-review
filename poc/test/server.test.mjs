import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

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
