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

test("rewrite-stage rebuilds the target and downstream stack", (t) => {
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

  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  repository.semantic("rewrite-stage", "--stage", "policy", "--fix", "HEAD");

  const rewrittenPolicy = repository.readJson(
    ".semantic-review/stages/policy.json",
  ).change.commit;
  const rewrittenPersistence = repository.readJson(
    ".semantic-review/stages/persistence.json",
  ).change.commit;
  assert.notEqual(rewrittenPolicy, originalPolicy);
  assert.notEqual(rewrittenPersistence, originalPersistence);
  assert.equal(repository.git("rev-parse", "HEAD"), rewrittenPersistence);
  assert.equal(repository.read("policy.txt"), "policy v2\n");
  repository.semantic("validate", "--publish");
});

test("refresh updates a rebased base and every stage binding", (t) => {
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

  repository.expectSemanticFailure(
    "refresh requires --base",
    "refresh",
  );
  repository.git("checkout", "--detach", originalBase);
  const newBase = repository.commitFile(
    "base-update.txt",
    "new base\n",
    "Advance base",
  );
  repository.git("cherry-pick", "--no-commit", policy);
  repository.git("commit", "-m", "Rebase policy");
  const rebasedPolicy = repository.git("rev-parse", "HEAD");
  repository.git("cherry-pick", "--no-commit", persistence);
  repository.git("commit", "-m", "Rebase persistence");
  const rebasedPersistence = repository.git("rev-parse", "HEAD");

  repository.semantic(
    "refresh",
    "--base",
    newBase,
    "--stage",
    `policy=${rebasedPolicy}`,
    "--stage",
    `persistence=${rebasedPersistence}`,
  );
  assert.equal(
    repository.readJson(".semantic-review/manifest.json").baseRevision,
    newBase,
  );
  assert.equal(
    repository.readJson(".semantic-review/stages/policy.json").change.commit,
    rebasedPolicy,
  );
  assert.equal(
    repository.readJson(".semantic-review/stages/persistence.json").change
      .commit,
    rebasedPersistence,
  );
  repository.semantic("validate", "--publish");
});
