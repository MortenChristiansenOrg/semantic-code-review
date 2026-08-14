import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeReview,
} from "../helpers/repository.mjs";

test("init and requirement add create complete requirement metadata", (t) => {
  const repository = createRepository(t);
  const base = repository.git("rev-parse", "HEAD");

  initializeReview(repository, {
    reviewId: "42-orders",
    sourceUrl: "https://example.invalid/stories/42",
    criteria: [
      ["cancel", "Pending orders can be cancelled."],
      ["persist", "Cancellation is persisted."],
    ],
  });

  const manifest = repository.readJson(".semantic-review/manifest.json");
  const initial = repository.readJson(
    ".semantic-review/requirements/story.json",
  );
  assert.equal(manifest.baseRevision, base);
  assert.equal(manifest.branchPrefix, "semantic-review/42-orders");
  assert.deepEqual(manifest.requirements, ["story"]);
  assert.equal(initial.source.url, "https://example.invalid/stories/42");
  assert.equal(initial.acceptanceCriteria.length, 2);

  repository.semantic(
    "requirement",
    "add",
    "--requirement-id",
    "audit",
    "--requirement-title",
    "Audit cancellation",
    "--requirement-summary",
    "Record who cancelled an order.",
    "--source-kind",
    "local",
    "--source-reference",
    "audit-story",
    "--criterion",
    "actor=The cancelling actor is recorded.",
  );
  assert.deepEqual(
    repository.readJson(".semantic-review/manifest.json").requirements,
    ["story", "audit"],
  );

  repository.expectSemanticFailure(
    "Requirement audit already exists.",
    "requirement",
    "add",
    "--requirement-id",
    "audit",
    "--requirement-title",
    "Duplicate",
    "--requirement-summary",
    "Duplicate",
    "--source-kind",
    "local",
    "--source-reference",
    "duplicate",
    "--criterion",
    "duplicate=Duplicate",
  );
  repository.expectSemanticFailure(
    "A semantic review already exists",
    "init",
  );
  repository.semantic("validate", "--schema-only");
});

test("init rejects dirty repositories and rolls back invalid requirements", (t) => {
  const repository = createRepository(t);
  repository.write("dirty.txt", "dirty\n");
  repository.expectSemanticFailure(
    "Initialization requires a clean worktree",
    "init",
    "--review-id",
    "dirty",
    "--title",
    "Dirty",
    "--summary",
    "Dirty",
    "--target-branch",
    "main",
    "--requirement-id",
    "story",
    "--requirement-title",
    "Story",
    "--requirement-summary",
    "Story",
    "--source-kind",
    "local",
    "--source-reference",
    "story",
    "--criterion",
    "works=Works",
  );
  assert.equal(repository.exists(".semantic-review"), false);

  repository.remove("dirty.txt");
  repository.expectSemanticFailure(
    "At least one --criterion",
    "init",
    "--review-id",
    "missing-criterion",
    "--title",
    "Missing criterion",
    "--summary",
    "Missing criterion",
    "--target-branch",
    "main",
    "--requirement-id",
    "story",
    "--requirement-title",
    "Story",
    "--requirement-summary",
    "Story",
    "--source-kind",
    "local",
    "--source-reference",
    "story",
  );
  assert.equal(repository.exists(".semantic-review"), false);
});

test("semantic IDs may start with digits", (t) => {
  const repository = createRepository(t);
  initializeReview(repository, {
    reviewId: "1-review",
    requirementId: "2-requirement",
    criteria: [["3-criterion", "Numeric-leading IDs work."]],
  });
  beginStage(repository, {
    id: "4-stage",
    requirementRefs: ["2-requirement#3-criterion"],
  });
  repository.semantic(
    "stage",
    "record",
    "--stage",
    "4-stage",
    "--kind",
    "decision",
    "--item-id",
    "5-decision",
    "--category",
    "engineering",
    "--summary",
    "Use numeric-leading semantic IDs.",
    "--rationale",
    "All semantic IDs share one format.",
  );
  finalizeStage(repository, { id: "4-stage" });

  assert.deepEqual(
    repository.readJson(".semantic-review/manifest.json").stages,
    ["4-stage"],
  );
});

test("stage commands cover metadata, every context kind, and validation", (t) => {
  const repository = createRepository(t);
  initializeReview(repository);

  repository.write("dirty.txt", "dirty\n");
  repository.expectSemanticFailure(
    "Beginning a stage requires a clean worktree",
    "stage",
    "begin",
    "--id",
    "implementation",
    "--title",
    "Implementation",
    "--summary",
    "Implement.",
    "--rationale",
    "Test.",
    "--requirement-ref",
    "story#works",
  );
  repository.remove("dirty.txt");

  beginStage(repository);
  repository.expectSemanticFailure(
    "stage set requires at least one field",
    "stage",
    "set",
    "--id",
    "implementation",
  );
  repository.semantic(
    "stage",
    "set",
    "--id",
    "implementation",
    "--title",
    "Updated implementation",
    "--summary",
    "Updated summary.",
    "--rationale",
    "Updated rationale.",
    "--requirement-ref",
    "story#works",
  );

  const records = [
    [
      "decision",
      "decision-one",
      "--category",
      "engineering",
      "--summary",
      "Use a text fixture.",
      "--rationale",
      "It makes the Git diff explicit.",
    ],
    [
      "assumption",
      "assumption-one",
      "--statement",
      "Text is sufficient.",
      "--risk-if-wrong",
      "The fixture may hide encoding behavior.",
    ],
    [
      "alternative",
      "alternative-one",
      "--approach",
      "Use a generated binary.",
      "--reason-rejected",
      "It obscures the reviewed change.",
    ],
    [
      "failed-attempt",
      "attempt-one",
      "--approach",
      "Commit no file.",
      "--outcome",
      "The stage had no patch.",
      "--lesson",
      "Every stage needs an implementation change.",
    ],
    [
      "risk",
      "risk-one",
      "--summary",
      "The fixture is intentionally small.",
      "--mitigation",
      "Keep command edge cases in separate assertions.",
    ],
    [
      "question",
      "question-one",
      "--question",
      "Should the fixture cover renames later?",
    ],
  ];
  for (const [kind, id, ...options] of records) {
    repository.semantic(
      "stage",
      "record",
      "--stage",
      "implementation",
      "--kind",
      kind,
      "--item-id",
      id,
      ...options,
    );
  }

  repository.expectSemanticFailure(
    "already has decisions item decision-one",
    "stage",
    "record",
    "--stage",
    "implementation",
    "--kind",
    "decision",
    "--item-id",
    "decision-one",
    "--category",
    "engineering",
    "--summary",
    "Duplicate.",
    "--rationale",
    "Duplicate.",
  );
  repository.semantic(
    "stage",
    "record",
    "--stage",
    "implementation",
    "--kind",
    "decision",
    "--item-id",
    "decision-one",
    "--category",
    "requirement",
    "--summary",
    "Use a readable fixture.",
    "--rationale",
    "Reviewers can inspect it directly.",
    "--replace",
  );
  repository.expectSemanticFailure(
    "Unknown option --question",
    "stage",
    "record",
    "--stage",
    "implementation",
    "--kind",
    "decision",
    "--item-id",
    "invalid-decision",
    "--category",
    "engineering",
    "--summary",
    "Invalid.",
    "--rationale",
    "Invalid.",
    "--question",
    "Unrelated.",
  );

  repository.expectSemanticFailure(
    "must have required property 'command'",
    "stage",
    "validation",
    "--stage",
    "implementation",
    "--item-id",
    "invalid-automated",
    "--type",
    "automated",
    "--status",
    "passed",
    "--summary",
    "Missing command.",
  );
  const validations = [
    [
      "automated",
      "passed",
      "automated-check",
      "--command",
      "npm test",
    ],
    ["manual", "not-run", "manual-check"],
    ["analysis", "failed", "analysis-check"],
  ];
  for (const [type, status, id, ...options] of validations) {
    repository.semantic(
      "stage",
      "validation",
      "--stage",
      "implementation",
      "--item-id",
      id,
      "--type",
      type,
      "--status",
      status,
      "--summary",
      `${type} validation.`,
      ...options,
    );
  }
  repository.semantic(
    "stage",
    "validation",
    "--stage",
    "implementation",
    "--item-id",
    "analysis-check",
    "--type",
    "analysis",
    "--status",
    "passed",
    "--summary",
    "Analysis completed.",
    "--replace",
  );

  const commit = finalizeStage(repository);
  repository.semantic(
    "stage",
    "record",
    "--stage",
    "implementation",
    "--finalized",
    "--kind",
    "risk",
    "--item-id",
    "post-finalization",
    "--summary",
    "Finalized metadata remains mutable through the explicit flag.",
  );
  repository.semantic(
    "stage",
    "validation",
    "--stage",
    "implementation",
    "--finalized",
    "--item-id",
    "final-check",
    "--type",
    "analysis",
    "--status",
    "passed",
    "--summary",
    "The canonical stage remains valid.",
  );

  const stage = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
  assert.equal(stage.change.headRevision, commit);
  assert.equal(
    stage.change.branch,
    "semantic-review/test-review/01-implementation",
  );
  assert.equal(stage.change.baseBranch, "main");
  assert.equal(stage.title, "Updated implementation");
  assert.equal(stage.decisions[0].category, "requirement");
  assert.equal(stage.assumptions.length, 1);
  assert.equal(stage.alternatives.length, 1);
  assert.equal(stage.failedAttempts.length, 1);
  assert.equal(stage.risks.length, 2);
  assert.equal(stage.openQuestions.length, 1);
  assert.equal(stage.validation.length, 4);

  beginStage(repository, {
    id: "discarded",
    dependencies: ["implementation"],
  });
  repository.semantic("stage", "discard", "--id", "discarded");
  assert.equal(
    repository.exists(".semantic-review/.work/stages/discarded.json"),
    false,
  );
  repository.semantic("validate", "--publish");
});
