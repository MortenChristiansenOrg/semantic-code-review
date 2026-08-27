import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeImplementation,
} from "../helpers/repository.mjs";

test("publish, local preparation, and archive enforce boundaries", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "publish-implementation" });
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

  const prepared = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(prepared.stages[0].baseBranch, "main");
  assert.equal(prepared.finalHeadRevision, stageTip);
  assert.equal("github" in prepared, false);

  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/publish-implementation",
  );
  assert.equal(repository.git("rev-parse", "review/publish-implementation"), stageTip);
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/publish-implementation",
  );
  repository.git("branch", "review/conflict", "main");
  repository.expectSemanticFailure(
    "already points to",
    "prepare-branch",
    "--branch",
    "review/conflict",
  );

  repository.semantic("publish", "--message", "Publish test implementation");
  const metadataBranch = "semantic-flow/publish-implementation/metadata";
  const published = repository.git("rev-parse", metadataBranch);
  assert.equal(repository.git("rev-parse", `${metadataBranch}^`), stageTip);
  assert.equal(repository.git("rev-parse", "HEAD"), stageTip);
  assert.doesNotMatch(
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
    "Archive requires checked-out target branch main",
    "archive",
  );
  repository.git("switch", "main");
  repository.expectSemanticFailure(
    "to contain final stage head",
    "archive",
  );

  repository.semantic(
    "stage",
    "record",
    "--stage",
    "implementation",
    "--finalized",
    "--kind",
    "decision",
    "--item-id",
    "archive-current-metadata",
    "--category",
    "engineering",
    "--summary",
    "Archive only current metadata.",
    "--rationale",
    "The archive is the durable copy of the implementation artifact.",
    "--node-ref",
    "implementation-change",
  );
  repository.git(
    "merge",
    "--ff-only",
    "semantic-flow/publish-implementation/01-implementation",
  );
  repository.expectSemanticFailure(
    "does not publish the current semantic implementation",
    "archive",
  );
  repository.semantic("publish");
  repository.expectSemanticFailure(
    "Archive destination must",
    "archive",
    "--destination",
    "../outside/.semantic-review",
  );

  repository.semantic(
    "archive",
    "--destination",
    ".semantic-review-history/publish-implementation/.semantic-review",
    "--message",
    "Archive test implementation",
  );
  assert.equal(repository.exists(".semantic-review"), false);
  assert.equal(
    repository.exists(
      ".semantic-review-history/publish-implementation/.semantic-review/manifest.json",
    ),
    true,
  );
  assert.doesNotMatch(
    repository.git("show", "-s", "--format=%B", "HEAD"),
    /Co-authored-by: Copilot/,
  );
});

test("publication rejects target drift until the stack is restacked", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);

  repository.git("switch", "main");
  repository.commitFile("trunk.txt", "advanced\n", "Advance trunk");
  repository.expectSemanticFailure(
    "Target branch main moved",
    "validate",
    "--publish",
  );
  repository.expectSemanticFailure(
    "Target branch main moved",
    "validate-stack",
  );

  repository.semantic("restack", "--base", "main");
  repository.semantic("validate", "--publish");
});

test("publication requires every acceptance criterion to be covered", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    criteria: [
      ["covered", "Covered by the implementation."],
      ["missing", "Must not be omitted."],
    ],
  });
  beginStage(repository, { specificationRefs: ["story#covered"] });
  finalizeStage(repository);

  repository.semantic("validate");
  repository.expectSemanticFailure(
    "uncovered acceptance criteria: story#missing",
    "validate",
    "--publish",
  );
});
