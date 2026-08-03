import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeReview,
} from "../helpers/repository.mjs";

test("publish, prepare-pr, and archive enforce publication boundaries", (t) => {
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

  repository.semantic(
    "prepare-pr",
    "--branch",
    "review/check-only",
    "--check-only",
  );
  assert.notEqual(
    repository.result("git", [
      "rev-parse",
      "--verify",
      "refs/heads/review/check-only",
    ]).status,
    0,
  );

  repository.semantic("publish", "--message", "Publish test review");
  const published = repository.git("rev-parse", "HEAD");
  assert.equal(repository.git("rev-parse", "HEAD^"), stageTip);
  assert.match(
    repository.git("show", "-s", "--format=%B", "HEAD"),
    /Co-authored-by: Copilot/,
  );
  const publishedPaths = repository
    .git("diff", "--name-only", "HEAD^", "HEAD")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(
    publishedPaths.length > 0 &&
      publishedPaths.every((file) => file.startsWith(".semantic-review/")),
  );

  repository.semantic("publish");
  assert.equal(repository.git("rev-parse", "HEAD"), published);
  repository.semantic("prepare-pr", "--branch", "review/published");
  assert.equal(repository.git("rev-parse", "review/published"), published);

  repository.git("branch", "review/conflict", stageTip);
  repository.expectSemanticFailure(
    "already points to",
    "prepare-pr",
    "--branch",
    "review/conflict",
  );
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
