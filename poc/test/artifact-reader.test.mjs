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

test("loads the POC review across working and finalized lifecycle states", async () => {
  const review = await readSemanticReview({ repositoryRoot });
  const visibleStageIds = [
    ...review.stages.map((stage) => stage.id),
    ...review.workingStages.map((stage) => stage.id),
  ];

  assert.equal(review.manifest.reviewId, "review-tool-poc");
  assert.ok(review.requirements.length >= 1);
  assert.ok(visibleStageIds.includes("load-artifact-api"));
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
