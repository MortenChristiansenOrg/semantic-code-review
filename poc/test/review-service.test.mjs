import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readStageDiff,
  readStageFileDiff,
  ReviewServiceError,
} from "../src/review-service.mjs";

test("rejects artifact revisions before they can become Git options", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "semantic-review-revision-"),
  );
  try {
    const artifact = path.join(root, ".semantic-review");
    await fs.mkdir(path.join(artifact, "requirements"), {
      recursive: true,
    });
    await fs.mkdir(path.join(artifact, "stages"), { recursive: true });
    await fs.writeFile(
      path.join(artifact, "manifest.json"),
      JSON.stringify({
        reviewId: "unsafe-review",
        baseRevision: "--output=overwritten.txt",
        requirements: ["story"],
        stages: ["unsafe-stage"],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(artifact, "requirements", "story.json"),
      JSON.stringify({
        id: "story",
        acceptanceCriteria: [
          {
            id: "criterion",
            text: "The stage is reviewable.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(artifact, "stages", "unsafe-stage.json"),
      JSON.stringify({
        id: "unsafe-stage",
        dependsOn: [],
        requirementRefs: ["story#criterion"],
        change: {
          branch: "semantic-review/unsafe-review/01-unsafe-stage",
          baseBranch: "main",
          baseRevision: "--output=overwritten.txt",
          headRevision: "2222222222222222222222222222222222222222",
          files: [
            {
              path: "file.txt",
              kind: "added",
            },
          ],
        },
      }),
      "utf8",
    );

    await assert.rejects(
      readStageDiff({
        repositoryRoot: root,
        stageId: "unsafe-stage",
      }),
      (error) =>
        error instanceof ReviewServiceError &&
        error.code === "invalid-git-revision",
    );
    await assert.rejects(
      readStageFileDiff({
        repositoryRoot: root,
        stageId: "unsafe-stage",
        filePath: "file.txt",
      }),
      (error) =>
        error instanceof ReviewServiceError &&
        error.code === "invalid-git-revision",
    );
    await assert.rejects(
      fs.access(path.join(root, "overwritten.txt")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
