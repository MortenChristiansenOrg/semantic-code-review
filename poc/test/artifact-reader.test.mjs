import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactError,
  readSemanticReview,
} from "../src/artifact-reader.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

test("loads the POC review and its active working stage", async () => {
  const review = await readSemanticReview({ repositoryRoot });

  assert.equal(review.manifest.reviewId, "review-tool-poc");
  assert.equal(review.requirements.length, 1);
  assert.equal(review.stages.length, 0);
  assert.deepEqual(
    review.workingStages.map((stage) => stage.id),
    ["load-artifact-api"],
  );
});

test("reports an indexed document that is missing", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "semantic-review-reader-"),
  );
  try {
    const artifactRoot = path.join(root, ".semantic-review");
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(
      path.join(artifactRoot, "manifest.json"),
      JSON.stringify({
        requirements: ["missing-requirement"],
        stages: [],
      }),
      "utf8",
    );

    await assert.rejects(
      readSemanticReview({ repositoryRoot: root }),
      (error) =>
        error instanceof ArtifactError &&
        error.code === "missing-document" &&
        error.message.includes("requirements/missing-requirement.json"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
