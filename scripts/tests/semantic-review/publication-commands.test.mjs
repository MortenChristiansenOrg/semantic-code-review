import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeReview,
} from "../helpers/repository.mjs";

test("publish, local preparation, and archive enforce boundaries", (t) => {
  const repository = createRepository(t);
  initializeReview(repository, { reviewId: "publish-review" });
  beginStage(repository);
  const stageTip = finalizeStage(repository);

  repository.expectSemanticFailure(
    "cannot be combined",
    "validate",
    "--schema-only",
    "--publish",
  );
  repository.semantic("validate");
  repository.semantic("validate", "--publish");

  const prepared = JSON.parse(repository.semantic("prepare-stack", "--json"));
  assert.equal(prepared.stages[0].baseBranch, "main");
  assert.equal(prepared.finalHeadRevision, stageTip);
  assert.equal("github" in prepared, false);

  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/publish-review",
  );
  assert.equal(repository.git("rev-parse", "review/publish-review"), stageTip);
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/publish-review",
  );
  repository.git("branch", "review/conflict", "main");
  repository.expectSemanticFailure(
    "already points to",
    "prepare-branch",
    "--branch",
    "review/conflict",
  );

  repository.semantic("publish", "--message", "Publish test review");
  const metadataBranch = "semantic-review/publish-review/metadata";
  const published = repository.git("rev-parse", metadataBranch);
  assert.equal(repository.git("rev-parse", `${metadataBranch}^`), stageTip);
  assert.equal(repository.git("rev-parse", "HEAD"), stageTip);
  assert.match(
    repository.git("show", "-s", "--format=%B", metadataBranch),
    /Co-authored-by: Copilot/,
  );
  const publishedPaths = repository
    .git("diff", "--name-only", `${metadataBranch}^`, metadataBranch)
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(
    publishedPaths.length > 0 &&
      publishedPaths.every((file) => file.startsWith(".semantic-review/")),
  );

  repository.semantic("publish");
  assert.equal(repository.git("rev-parse", metadataBranch), published);
  repository.expectSemanticFailure(
    "Archive destination must",
    "archive",
    "--destination",
    "../outside/.semantic-review",
  );

  repository.semantic(
    "archive",
    "--destination",
    ".semantic-review-history/publish-review/.semantic-review",
    "--message",
    "Archive test review",
  );
  assert.equal(repository.exists(".semantic-review"), false);
  assert.equal(
    repository.exists(
      ".semantic-review-history/publish-review/.semantic-review/manifest.json",
    ),
    true,
  );
  assert.match(
    repository.git("show", "-s", "--format=%B", "HEAD"),
    /Co-authored-by: Copilot/,
  );
});
