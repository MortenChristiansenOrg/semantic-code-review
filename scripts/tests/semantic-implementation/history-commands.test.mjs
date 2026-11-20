import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

  repository.artifact.write("stages/implementation.json", "{}\n");
  repository.semantic("repair");
  assert.equal(
    repository.artifact.exists("stages/implementation.json"),
    false,
  );
  assert.equal(
    repository.artifact.exists(".work/stages/implementation.json"),
    true,
  );

  repository.semantic("repair");
  repository.artifact.remove(".work/stages/implementation.json");
  repository.artifact.write("stages/orphan.json", "{}\n");
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

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  const output = repository.semantic("restack", "--from", "policy");
  assert.match(
    output,
    /Restacked 2 stage\(s\) from policy; rewrote 1 branch\./,
  );
  assert.doesNotMatch(output, /[0-9a-f]{40}/);

  const rewrittenPolicy = repository.artifact.stage("policy").change.headRevision;
  const rewrittenPersistence = repository.artifact.stage("persistence").change.headRevision;
  assert.notEqual(rewrittenPolicy, originalPolicy);
  assert.notEqual(rewrittenPersistence, originalPersistence);
  assert.equal(
    repository.git("rev-parse", "semantic-flow/test-implementation/stages/persistence"),
    rewrittenPersistence,
  );
  assert.equal(repository.read("policy.txt"), "policy v2\n");
  repository.semantic("validate", "--publish");
});

test("restack accepts several edited stage heads in one pass", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, {
    id: "policy",
    file: "policy.txt",
    contents: "policy v1\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });
  beginStage(repository, {
    id: "api",
    dependencies: ["persistence"],
  });
  const originalApi = finalizeStage(repository, {
    id: "api",
    file: "api.txt",
    contents: "api v1\n",
  });

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  repository.git("switch", "semantic-flow/test-implementation/stages/persistence");
  repository.write("persistence.txt", "persistence v2\n");
  repository.git("add", "persistence.txt");
  repository.git(
    "commit",
    "--author",
    "Original Author <original@example.test>",
    "-m",
    "Fix persistence",
  );
  repository.expectSemanticFailure(
    "requires checked-out stage branch",
    "restack",
    "--from",
    "policy",
  );
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.expectSemanticFailure(
    "either --from or --base",
    "restack",
    "--from",
    "policy",
    "--base",
    "main",
  );

  const result = JSON.parse(
    repository.semantic("restack", "--from", "policy", "--json"),
  );
  assert.equal(result.refreshedStages, 3);
  assert.equal(result.rewrittenBranches, 2);
  assert.deepEqual(
    result.stages.map(({ id, rewritten }) => ({ id, rewritten })),
    [
      { id: "policy", rewritten: false },
      { id: "persistence", rewritten: true },
      { id: "api", rewritten: true },
    ],
  );
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:persistence.txt",
    ),
    "persistence v2",
  );
  assert.equal(
    repository.git(
      "show",
      "-s",
      "--format=%an <%ae>%n%B",
      "semantic-flow/test-implementation/stages/persistence",
    ),
    "Original Author <original@example.test>\nFix persistence",
  );
  assert.notEqual(
    repository.git("rev-parse", "semantic-flow/test-implementation/stages/api"),
    originalApi,
  );
  repository.semantic("validate", "--publish");
});

test("restack reports enough context to resolve a conflicting stage", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, {
    id: "policy",
    file: "policy.txt",
    contents: "policy=original\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  finalizeStage(repository, {
    id: "persistence",
    file: "shared.txt",
    contents: "setting=original\npersistence=true\n",
  });
  beginStage(repository, {
    id: "api",
    dependencies: ["persistence"],
  });
  const originalApi = finalizeStage(repository, {
    id: "api",
    file: "shared.txt",
    contents: "setting=api\npersistence=true\napi=true\n",
  });
  const api = repository.artifact.stage("api");

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile(
    "policy.txt",
    "policy=revised\n",
    "Revise policy",
  );
  repository.git(
    "switch",
    "semantic-flow/test-implementation/stages/persistence",
  );
  repository.commitFile(
    "shared.txt",
    "setting=persistence\npersistence=true\n",
    "Revise persistence",
  );
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  const failure = repository.expectSemanticFailure(
    "Restacking stage api",
    "restack",
    "--from",
    "policy",
  );
  const output = `${failure.stdout}\n${failure.stderr}`;
  assert.match(output, /No stage refs or artifacts were changed\./);
  const context = output.match(
    /Conflict context: stage base ([0-9a-f]{40}), stage head ([0-9a-f]{40}), new parent ([0-9a-f]{40})\./,
  );
  assert.ok(context);
  const [, stageBase, stageHead, newParent] = context;
  assert.equal(stageBase, api.change.baseRevision);
  assert.equal(stageHead, originalApi);
  assert.notEqual(
    newParent,
    repository.git(
      "rev-parse",
      "semantic-flow/test-implementation/stages/persistence",
    ),
  );
  assert.equal(
    repository.git(
      "rev-parse",
      "semantic-flow/test-implementation/stages/api",
    ),
    originalApi,
  );
  assert.equal(
    repository.artifact.stage("api").change.headRevision,
    originalApi,
  );

  const recoveryBranch = "restack-recovery-api";
  const resolutionBranch = "restack-resolution-api";
  const patch = repository.path("..", `${path.basename(repository.root)}.patch`);
  t.after(() => fs.rmSync(patch, { force: true }));
  repository.git("branch", recoveryBranch, stageHead);
  repository.git("switch", "-c", resolutionBranch, newParent);
  repository.git(
    "diff",
    "--binary",
    "--full-index",
    "--find-renames=50%",
    `--output=${patch}`,
    stageBase,
    stageHead,
    "--",
  );
  const apply = repository.result("git", [
    "apply",
    "--3way",
    "--index",
    patch,
  ]);
  assert.notEqual(apply.status, 0);
  assert.match(repository.git("ls-files", "-u"), /shared\.txt/);

  repository.write(
    "shared.txt",
    "setting=resolved\npersistence=true\napi=true\n",
  );
  repository.git("add", "shared.txt");
  repository.git("commit", "-m", "Resolve API restack");
  const resolutionHead = repository.git("rev-parse", "HEAD");
  repository.git(
    "update-ref",
    "refs/heads/semantic-flow/test-implementation/stages/api",
    resolutionHead,
    stageHead,
  );
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.git("branch", "-D", resolutionBranch);
  fs.rmSync(patch, { force: true });

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  repository.semantic("restack", "--from", "policy");
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/api:shared.txt",
    ),
    "setting=resolved\npersistence=true\napi=true",
  );
  repository.git("branch", "-D", recoveryBranch);
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

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("shared.txt", "revised\n", "Address policy feedback");
  repository.semantic("restack", "--from", "policy");

  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:shared.txt",
    ),
    "revised",
  );
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:persistence.txt",
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

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
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

  const policy = repository.artifact.stage("policy");
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

  // Until restacking, the stage above keeps building on the earlier policy head.
  const pending = repository.artifact.readJson("manifest.json").stages[1];
  assert.equal(pending.id, "persistence");
  assert.equal(pending.baseRevision, repository.artifact.stage("persistence").change.baseRevision);
  assert.notEqual(pending.baseRevision, policy.change.headRevision);
  repository.expectSemanticFailure(/Stage persistence still builds on [0-9a-f]{40}, not on the head [0-9a-f]{40} of stage policy; .*restack --from policy/, "validate");

  repository.semantic("restack", "--from", "policy");
  assert.deepEqual(Object.keys(repository.artifact.readJson("manifest.json").stages[1]).sort(), ["headRevision", "id"]);
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
    "semantic-flow/test-implementation/stages/policy",
  );
  const rebasedPersistence = repository.git(
    "rev-parse",
    "semantic-flow/test-implementation/stages/persistence",
  );
  assert.equal(
    repository.artifact.readJson("manifest.json").baseRevision,
    newBase,
  );
  assert.equal(
    repository.artifact.stage("policy").change.headRevision,
    rebasedPolicy,
  );
  assert.equal(
    repository.artifact.stage("persistence").change.headRevision,
    rebasedPersistence,
  );
  assert.notEqual(rebasedPolicy, policy);
  assert.notEqual(rebasedPersistence, persistence);
  assert.notEqual(newBase, originalBase);
  repository.semantic("validate", "--publish");
});

/** Every stored file of the artifact except the manifest, with its bytes. */
function storedDocuments(repository) {
  return new Map(
    repository.artifact
      .list()
      .filter((file) => file !== "manifest.json")
      .map((file) => [file, repository.artifact.readBytes(file)]),
  );
}

/** Asserts the derived change of every stage follows from the manifest and Git. */
function assertDerivedStack(repository, branchPrefix) {
  const { manifest, stages } = repository.artifact.implementation();
  const stored = repository.artifact.readJson("manifest.json");
  let baseBranch = manifest.targetBranch, baseRevision = manifest.baseRevision;
  for (const [index, id] of manifest.stages.entries()) {
    const { change } = stages[id];
    const branch = `${branchPrefix}/stages/${id}`;
    assert.deepEqual(stored.stages[index], { id, headRevision: change.headRevision });
    assert.equal(change.branch, branch);
    assert.equal(change.baseBranch, baseBranch);
    assert.equal(change.baseRevision, baseRevision);
    assert.equal(change.headRevision, repository.git("rev-parse", branch));
    assert.deepEqual(
      change.files.map(({ path, kind }) => `${kind} ${path}`),
      repository
        .git("diff", "--name-status", "--no-renames", baseRevision, change.headRevision)
        .split("\n")
        .map((line) => {
          const [status, path] = line.split("\t");
          return `${{ A: "added", M: "modified", D: "deleted" }[status]} ${path}`;
        }),
    );
    baseBranch = branch;
    baseRevision = change.headRevision;
  }
  return stored;
}

test("restack rewrites only the manifest and the stage inventories follow from Git", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy v1\n" });
  beginStage(repository, { id: "persistence", dependencies: ["policy"] });
  finalizeStage(repository, { id: "persistence", file: "persistence.txt", contents: "persistence v1\n" });
  const prefix = "semantic-flow/test-implementation";
  const documents = storedDocuments(repository);
  assert.deepEqual([...documents.keys()], ["requirements/story.json", "stages/persistence.json", "stages/policy.json"]);
  for (const [file, bytes] of documents) {
    if (file.endsWith(".json")) assert.equal("change" in JSON.parse(bytes), false, file);
  }
  const initial = assertDerivedStack(repository, prefix);

  // An edited stage branch moves the heads of it and every stage above it.
  repository.git("switch", `${prefix}/stages/policy`);
  repository.commitFile("policy.txt", "policy v2\n", "Revise policy");
  repository.semantic("restack", "--from", "policy");
  assert.deepEqual(storedDocuments(repository), documents);
  const edited = assertDerivedStack(repository, prefix);
  assert.equal(edited.baseRevision, initial.baseRevision);
  for (const index of [0, 1]) {
    assert.notEqual(edited.stages[index].headRevision, initial.stages[index].headRevision);
  }
  assert.deepEqual(
    repository.artifact.stage("policy").change.files.map(({ path }) => path),
    ["policy.txt"],
  );

  // An advanced target changes the base revision and every head, not the stage files.
  repository.git("switch", "main");
  const newBase = repository.commitFile("base-update.txt", "new base\n", "Advance base");
  repository.semantic("restack", "--base", "main");
  assert.deepEqual(storedDocuments(repository), documents);
  const rebased = assertDerivedStack(repository, prefix);
  assert.equal(rebased.baseRevision, newBase);
  for (const index of [0, 1]) {
    assert.notEqual(rebased.stages[index].headRevision, edited.stages[index].headRevision);
  }
  assert.deepEqual(
    repository.artifact.stage("policy").change.files.map(({ path }) => path),
    ["policy.txt"],
  );
  assert.equal(repository.git("show", `${prefix}/stages/persistence:policy.txt`), "policy v2");
  repository.semantic("validate");
});
