import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeImplementation,
  organizeStage,
} from "../helpers/repository.mjs";

test("repair removes unambiguous interrupted writes", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
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
  initializeImplementation(repository);
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

  repository.git("switch", "semantic-flow/test-implementation/01-policy");
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
    repository.git("rev-parse", "semantic-flow/test-implementation/02-persistence"),
    rewrittenPersistence,
  );
  assert.equal(repository.read("policy.txt"), "policy v2\n");
  repository.semantic("validate", "--publish");
});

test("restack applies the finalized net stage diff", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, {
    id: "policy",
    file: "shared.txt",
    contents: "original\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  repository.write("shared.txt", "temporary\n");
  repository.write("persistence.txt", "persistence\n");
  repository.git("add", "shared.txt", "persistence.txt");
  repository.git("commit", "-m", "Implement persistence");
  organizeStage(repository, { id: "persistence" });
  repository.semantic("stage", "finish", "--id", "persistence");

  repository.commitFile("shared.txt", "original\n", "Restore shared file");
  const organization = {
    $schema:
      "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
    nodes: [
      {
        id: "implementation-change",
        description: "Implement the persistence behavior.",
        changes: [
          {
            path: "persistence.txt",
            classification: "behavior",
          },
        ],
      },
    ],
    itemLinks: [],
  };
  repository.write(
    "organization.json",
    `${JSON.stringify(organization, null, 2)}\n`,
  );
  try {
    repository.semantic(
      "stage",
      "organize",
      "--stage",
      "persistence",
      "--file",
      "organization.json",
      "--finalized",
    );
  } finally {
    repository.remove("organization.json");
  }

  repository.git("switch", "semantic-flow/test-implementation/01-policy");
  repository.commitFile("shared.txt", "revised\n", "Address policy feedback");
  repository.semantic("restack", "--from", "policy");

  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/02-persistence:shared.txt",
    ),
    "revised",
  );
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/02-persistence:persistence.txt",
    ),
    "persistence",
  );
  repository.semantic("validate", "--publish");
});

test("feedback can remove a finalized stage file before restacking", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  repository.write("keep.txt", "keep v1\n");
  repository.write("obsolete.txt", "obsolete\n");
  repository.git("add", "keep.txt", "obsolete.txt");
  repository.git("commit", "-m", "Implement policy");
  const organization = {
    $schema:
      "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
    nodes: [
      {
        id: "policy-change",
        description: "Implement the policy.",
        changes: ["keep.txt", "obsolete.txt"].map((path) => ({
          path,
          classification: "behavior",
        })),
      },
    ],
    itemLinks: [],
  };
  repository.write("organization.json", `${JSON.stringify(organization, null, 2)}\n`);
  repository.semantic(
    "stage",
    "organize",
    "--stage",
    "policy",
    "--file",
    "organization.json",
  );
  repository.remove("organization.json");
  repository.semantic("stage", "finish", "--id", "policy");

  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });

  repository.git("switch", "semantic-flow/test-implementation/01-policy");
  repository.write("keep.txt", "keep v2\n");
  repository.remove("obsolete.txt");
  repository.git("add", "-A");
  const correctedPolicy = repository.git(
    "commit",
    "-m",
    "Address policy feedback",
  );
  assert.match(correctedPolicy, /Address policy feedback/);

  repository.semantic(
    "stage",
    "record",
    "--stage",
    "policy",
    "--finalized",
    "--kind",
    "decision",
    "--item-id",
    "remove-obsolete-file",
    "--category",
    "engineering",
    "--summary",
    "Remove the obsolete file.",
    "--rationale",
    "The feedback showed that the file is unnecessary.",
    "--node-ref",
    "policy-change",
  );

  const revisedOrganization = {
    ...organization,
    nodes: [
      {
        ...organization.nodes[0],
        changes: [
          {
            path: "keep.txt",
            classification: "behavior",
          },
        ],
      },
    ],
    itemLinks: [
      {
        collection: "decisions",
        itemId: "remove-obsolete-file",
        nodeRefs: ["policy-change"],
      },
    ],
  };
  repository.write(
    "organization.json",
    `${JSON.stringify(revisedOrganization, null, 2)}\n`,
  );
  repository.semantic(
    "stage",
    "organize",
    "--stage",
    "policy",
    "--file",
    "organization.json",
    "--finalized",
  );
  repository.remove("organization.json");

  const policy = repository.readJson(".semantic-review/stages/policy.json");
  assert.equal(
    policy.change.headRevision,
    repository.git("rev-parse", "HEAD"),
  );
  assert.deepEqual(policy.change.files, [
    {
      path: "keep.txt",
      kind: "added",
    },
  ]);

  repository.semantic("restack", "--from", "policy");
  repository.semantic("validate", "--publish");
});

test("restack rebases every stage branch onto an advanced target", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
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
    "semantic-flow/test-implementation/01-policy",
  );
  const rebasedPersistence = repository.git(
    "rev-parse",
    "semantic-flow/test-implementation/02-persistence",
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
