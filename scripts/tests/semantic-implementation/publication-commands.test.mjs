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
  repository.semantic("prepare-branch");
  repository.git("branch", "review/conflict", "main");
  repository.expectSemanticFailure(
    "is bound to cumulative branch",
    "prepare-branch",
    "--branch",
    "review/conflict",
  );
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/conflict",
    "--rebind",
    "--adopt",
  );
  assert.equal(repository.git("rev-parse", "review/conflict"), stageTip);
  assert.equal(repository.git("rev-parse", "review/publish-implementation"), stageTip);

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

test("repeat preparation updates the bound PR branch and metadata atomically", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "stable-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/stable-pr";
  const bindingRef = `refs/semantic-review/prepared/stable-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;

  repository.semantic("prepare-branch", "--branch", branch);
  const originalMetadata = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/metadata",
  );
  assert.equal(repository.git("rev-parse", branch), originalHead);
  assert.equal(repository.git("rev-parse", bindingRef), originalHead);

  repository.commitFile("implementation.txt", "implementation v2\n", "Fix CI");
  repository.semantic("restack", "--from", "implementation");
  const revisedHead = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/01-implementation",
  );
  assert.notEqual(revisedHead, originalHead);

  const output = repository.semantic("prepare-branch");
  assert.match(output, /Updated bound cumulative branch review\/stable-pr/);
  assert.match(
    output,
    new RegExp(`--force-with-lease=refs/heads/review/stable-pr:${originalHead}`),
  );
  assert.equal(repository.git("rev-parse", branch), revisedHead);
  assert.equal(repository.git("rev-parse", bindingRef), revisedHead);
  const revisedMetadata = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/metadata",
  );
  assert.notEqual(revisedMetadata, originalMetadata);
  assert.equal(
    repository.git("rev-parse", "semantic-flow/stable-pr/metadata^"),
    revisedHead,
  );

  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.cumulativeBranch, branch);
  assert.equal(stack.preparedHeadRevision, revisedHead);
});

test("combined preparation reuses bindings and rejects drift before publication", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "combined-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/combined-pr";
  const metadataBranch = "semantic-flow/combined-pr/metadata";

  const initial = JSON.parse(repository.flow("prepare", "--branch", branch, "--json"));
  assert.equal(initial.cumulativeBranch, branch);
  assert.equal(initial.preparedHeadRevision, originalHead);

  repository.commitFile("implementation.txt", "implementation v2\n", "Revise implementation");
  repository.semantic("restack", "--from", "implementation");
  const revised = JSON.parse(repository.flow("prepare", "--branch", branch, "--json"));
  assert.notEqual(revised.finalHeadRevision, originalHead);
  assert.equal(revised.preparedHeadRevision, revised.finalHeadRevision);
  assert.equal(repository.git("rev-parse", branch), revised.finalHeadRevision);
  assert.equal(repository.git("rev-parse", `${metadataBranch}^`), revised.finalHeadRevision);

  const metadataHead = repository.git("rev-parse", metadataBranch);
  repository.commitFile("implementation.txt", "implementation v3\n", "Revise again");
  repository.semantic("restack", "--from", "implementation");
  repository.git("branch", "-f", branch, "main");
  assert.throws(
    () => repository.flow("prepare", "--branch", branch, "--json"),
    /moved from prepared head/,
  );
  assert.equal(repository.git("rev-parse", metadataBranch), metadataHead);
  assert.equal(repository.git("rev-parse", branch), repository.git("rev-parse", "main"));
  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.preparedHeadRevision, revised.finalHeadRevision);
});

test("repeat preparation refuses externally moved bound branches without partial publication", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "guarded-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/guarded-pr";

  repository.semantic("prepare-branch", "--branch", branch);
  const originalMetadata = repository.git(
    "rev-parse",
    "semantic-flow/guarded-pr/metadata",
  );
  repository.commitFile("implementation.txt", "implementation v2\n", "Fix CI");
  repository.semantic("restack", "--from", "implementation");
  repository.git("branch", "-f", branch, "main");

  repository.expectSemanticFailure(
    "moved from prepared head",
    "prepare-branch",
  );
  assert.equal(repository.git("rev-parse", branch), repository.git("rev-parse", "main"));
  assert.equal(
    repository.git("rev-parse", "semantic-flow/guarded-pr/metadata"),
    originalMetadata,
  );
  const bindingRef = `refs/semantic-review/prepared/guarded-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;
  assert.equal(repository.git("rev-parse", bindingRef), originalHead);
});

test("preparation explicitly adopts a cumulative branch created before binding support", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "adopt-pr" });
  beginStage(repository);
  const reviewedHead = finalizeStage(repository);
  const branch = "review/adopt-pr";
  repository.git("branch", branch, "main");

  repository.expectSemanticFailure(
    "use --adopt",
    "prepare-branch",
    "--branch",
    branch,
  );
  repository.semantic("prepare-branch", "--branch", branch, "--adopt");
  assert.equal(repository.git("rev-parse", branch), reviewedHead);
  const bindingRef = `refs/semantic-review/prepared/adopt-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;
  assert.equal(repository.git("rev-parse", bindingRef), reviewedHead);
});

test("preparation requires adoption before binding an existing branch at the reviewed head", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "adopt-current-pr" });
  beginStage(repository);
  const reviewedHead = finalizeStage(repository);
  const branch = "review/adopt-current-pr";
  repository.git("branch", branch, reviewedHead);

  repository.expectSemanticFailure(
    "use --adopt",
    "prepare-branch",
    "--branch",
    branch,
  );
  const output = repository.semantic(
    "prepare-branch",
    "--branch",
    branch,
    "--adopt",
  );
  assert.match(output, /Adopted and bound existing cumulative branch/);
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

test("preparation ignores acceptance criteria outside the review", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    criteria: [
      ["reviewed", "Covered by the reviewed implementation."],
      ["not-reviewed", "Outside this review."],
    ],
  });
  beginStage(repository, { specificationRefs: ["story#reviewed"] });
  const stageTip = finalizeStage(repository);

  repository.semantic("validate");
  repository.semantic("validate", "--publish");
  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.finalHeadRevision, stageTip);
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/reviewed-criteria-only",
  );
  assert.equal(repository.git("rev-parse", "review/reviewed-criteria-only"), stageTip);
});
