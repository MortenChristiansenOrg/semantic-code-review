import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeReview,
} from "../helpers/repository.mjs";

test("repair removes unambiguous interrupted writes", (t) => {
  const repository = createRepository(t);
  initializeReview(repository);
  beginStage(repository);

  repository.write(".semantic-review/stages/implementation.json", "{}\n");
  repository.semantic("repair");
  assert.equal(
    repository.exists(".semantic-review/stages/implementation.json"),
    false,
  );
  assert.equal(
    repository.exists(".semantic-review/.work/stages/implementation.json"),
    true,
  );

  repository.semantic("repair");
  repository.remove(".semantic-review/.work/stages/implementation.json");
  repository.write(".semantic-review/stages/orphan.json", "{}\n");
  repository.expectSemanticFailure(
    "Repair is ambiguous",
    "repair",
  );
});

test("restack refreshes an edited stage branch and rebuilds branches above it", (t) => {
  const repository = createRepository(t);
  initializeReview(repository);
  beginStage(repository, { id: "policy" });
  const originalPolicy = finalizeStage(repository, {
    id: "policy",
    file: "policy.txt",
    contents: "policy v1\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  const originalPersistence = finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });

  repository.git("switch", "semantic-review/test-review/01-policy");
  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  repository.semantic("restack", "--from", "policy");

  const rewrittenPolicy = repository.readJson(
    ".semantic-review/stages/policy.json",
  ).change.headRevision;
  const rewrittenPersistence = repository.readJson(
    ".semantic-review/stages/persistence.json",
  ).change.headRevision;
  assert.notEqual(rewrittenPolicy, originalPolicy);
  assert.notEqual(rewrittenPersistence, originalPersistence);
  assert.equal(
    repository.git("rev-parse", "semantic-review/test-review/02-persistence"),
    rewrittenPersistence,
  );
  assert.equal(repository.read("policy.txt"), "policy v2\n");
  repository.semantic("validate", "--publish");
});

test("restack rebases every stage branch onto an advanced target", (t) => {
  const repository = createRepository(t);
  initializeReview(repository);
  const originalBase = repository.git("rev-parse", "HEAD");
  beginStage(repository, { id: "policy" });
  const policy = finalizeStage(repository, { id: "policy" });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  const persistence = finalizeStage(repository, { id: "persistence" });

  repository.expectSemanticFailure("restack requires --from", "restack");
  repository.git("switch", "main");
  const newBase = repository.commitFile(
    "base-update.txt",
    "new base\n",
    "Advance base",
  );
  repository.semantic("restack", "--base", "main");
  const rebasedPolicy = repository.git(
    "rev-parse",
    "semantic-review/test-review/01-policy",
  );
  const rebasedPersistence = repository.git(
    "rev-parse",
    "semantic-review/test-review/02-persistence",
  );
  assert.equal(
    repository.readJson(".semantic-review/manifest.json").baseRevision,
    newBase,
  );
  assert.equal(
    repository.readJson(".semantic-review/stages/policy.json").change.headRevision,
    rebasedPolicy,
  );
  assert.equal(
    repository.readJson(".semantic-review/stages/persistence.json").change
      .headRevision,
    rebasedPersistence,
  );
  assert.notEqual(rebasedPolicy, policy);
  assert.notEqual(rebasedPersistence, persistence);
  assert.notEqual(newBase, originalBase);
  repository.semantic("validate", "--publish");
});
