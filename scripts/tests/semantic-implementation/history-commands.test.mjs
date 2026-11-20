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
  const correction = repository.git("rev-parse", "HEAD");
  // A stage branch that is a symbolic ref would move the branch it names.
  repository.git("branch", "unrelated", "main");
  const persistenceRef = "refs/heads/semantic-flow/test-implementation/stages/persistence";
  repository.git("update-ref", "-d", persistenceRef);
  repository.git("symbolic-ref", persistenceRef, "refs/heads/unrelated");
  repository.expectSemanticFailure("is a symbolic ref", "restack", "--from", "policy");
  assert.equal(repository.git("rev-parse", "unrelated"), repository.git("rev-parse", "main"));
  repository.git("symbolic-ref", "--delete", persistenceRef);
  repository.git("update-ref", persistenceRef, originalPersistence);
  const output = repository.semantic("restack", "--from", "policy");
  assert.match(
    output,
    /Restacked 2 stage\(s\) from policy; rewrote 2 branches\./,
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
  // The correction is folded into the stage's one commit; the checkout stays clean on it.
  assert.equal(repository.git("rev-list", "--count", `main..${rewrittenPolicy}`), "1");
  repository.git("merge-base", "--is-ancestor", correction, "refs/semantic-review/active/test-implementation");
  assert.equal(repository.git("rev-parse", "HEAD"), rewrittenPolicy);
  assert.equal(repository.git("status", "--porcelain"), "");
  repository.semantic("validate", "--publish");
});

test("restack replays a stage rebuilt on the correction below from that correction", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: "0\n" });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: "u\n" });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  const correction = repository.commitFile("shared.txt", "1\n", "Correct policy");
  // The stage above is rebuilt on the correction and changes the same line.
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", correction);
  repository.commitFile("shared.txt", "2\n", "Build on the corrected policy");
  repository.git("switch", `${prefix}/policy`);
  repository.semantic("restack", "--from", "policy");
  const api = `${prefix}/api`;
  assert.equal(repository.git("show", `${api}:shared.txt`), "2");
  assert.equal(repository.git("rev-parse", `${api}^`), repository.git("rev-parse", `${prefix}/policy`));
  assert.equal(repository.git("show", `${prefix}/policy:shared.txt`), "1");
});

test("restack keeps the changes of a stage rebuilt on an earlier correction below", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, last) => `${first}\na\nb\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  const correction = repository.commitFile("shared.txt", lines(1, "x"), "Correct policy");
  // The stage above is rebuilt on that correction and sets the first line back.
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", correction);
  repository.commitFile("shared.txt", lines(0, "x"), "Keep the original value");
  // A later correction below changes only the last line.
  repository.git("switch", `${prefix}/policy`);
  repository.commitFile("shared.txt", lines(1, "y"), "Correct the policy again");
  repository.semantic("restack", "--from", "policy");
  assert.equal(repository.git("show", `${prefix}/api:shared.txt`), lines(0, "y").trimEnd());
});

test("restack replays a stage rebuilt on an amended stage below from that stage", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, last) => `${first}\na\nb\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  // The stage's commit is amended, then corrected again.
  repository.write("shared.txt", lines(1, "x"));
  repository.git("commit", "--quiet", "--amend", "--all", "--no-edit");
  repository.commitFile("shared.txt", lines(1, "y"), "Correct the policy again");
  const below = repository.git("rev-parse", "HEAD");
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", below);
  repository.commitFile("shared.txt", lines("u", "y"), "Rebuild the API on the policy");
  repository.git("switch", `${prefix}/policy`);
  repository.semantic("restack", "--from", "policy");
  assert.equal(repository.git("show", `${prefix}/api:shared.txt`), lines("u", "y").trimEnd());
});

test("restack stops when the stage below took in a stage's commit", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, middle, last) => `${first}\na\n${middle}\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "m", "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  const api = finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "m", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  // The stage below takes in the API's commit, reverts its edit and corrects its own line.
  repository.git("switch", `${prefix}/policy`);
  repository.git("merge", "--quiet", "--ff-only", api);
  repository.commitFile("shared.txt", lines(0, "m", "x"), "Take the API edit back out");
  repository.commitFile("shared.txt", lines(0, "m", "y"), "Correct the policy");
  // The API stage adds a second edit.
  repository.git("switch", `${prefix}/api`);
  repository.commitFile("shared.txt", lines("u", "n", "x"), "Extend the API");
  repository.git("switch", `${prefix}/policy`);
  const before = repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  repository.expectSemanticFailure(`Stage policy holds the commit ${api} of stage api`, "restack", "--from", "policy");
  assert.equal(repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), before);
});

test("restack onto a target that merged a stage is not refused when a stage below was rebuilt on it", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const prefix = "semantic-flow/test-implementation/stages";
  beginStage(repository, { id: "a" });
  finalizeStage(repository, { id: "a", file: "settings.txt", contents: "a\n" });
  beginStage(repository, { id: "b", dependencies: ["a"] });
  const b = finalizeStage(repository, { id: "b", file: "b.txt", contents: "b\n" });
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", b);
  repository.commitFile("settings.txt", "main\n", "Edit the settings on the target");
  repository.git("rm", "--quiet", "b.txt");
  repository.git("commit", "--quiet", "-m", "Remove b on the target");
  // The stage below is rebuilt on the target, which holds stage b's commit.
  repository.git("switch", `${prefix}/a`);
  repository.git("reset", "--quiet", "--hard", "main");
  repository.commitFile("settings.txt", "resolved\n", "Resolve the settings");
  repository.git("switch", "--detach");
  repository.semantic("restack", "--base", "main");
  assert.equal(repository.git("show", `${prefix}/a:settings.txt`), "resolved");
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
  assert.equal(result.rewrittenBranches, 3);
  assert.deepEqual(
    result.stages.map(({ id, rewritten }) => ({ id, rewritten })),
    [
      { id: "policy", rewritten: true },
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
    // The fold is authored by whoever ran it; the correction's author is a co-author.
    "Semantic Flow Test <semantic-flow@example.invalid>\nImplement behavior\n\nAdd the implementation.\n\nCo-authored-by: Original Author <original@example.test>",
  );
  for (const stage of ["policy", "persistence", "api"]) {
    const head = repository.git("rev-parse", `semantic-flow/test-implementation/stages/${stage}`);
    assert.equal(repository.git("rev-list", "--count", `${head}^..${head}`), "1");
  }
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
  // The target is checked, not deleted: a hook that refuses deleting it lets the restack through.
  const hooks = path.resolve(repository.root, repository.git("rev-parse", "--git-path", "hooks"));
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "reference-transaction"),
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\n',
    { mode: 0o755 });
  const targetReflog = repository.git("reflog", "--format=%H", "refs/heads/main");
  repository.semantic("restack", "--base", "main");
  assert.equal(repository.git("reflog", "--format=%H", "refs/heads/main"), targetReflog);
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
  // review.json holds the private review ID.
  assert.deepEqual([...documents.keys()], ["requirements/story.json", "review.json", "stages/persistence.json", "stages/policy.json"]);
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

test("finishing folds a stage's commits into one with a generated message and co-authors", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { title: "Add checks", summary: "Check the input before use." });
  repository.write("first.txt", "first\n");
  repository.git("add", "first.txt");
  repository.git("commit", "--author", "Ada Author <ada@example.test>", "-m", "First part");
  repository.commitFile("second.txt", "second\n", "Second part\n\nCo-authored-by: Bob Pair <bob@example.test>");
  repository.commitFile("third.txt", "third\n", "Third part\n\nCo-authored-by: Ada Author <ADA@example.test>");
  // Only the trailer block credits anyone; this line is part of the body.
  repository.commitFile("fourth.txt", "fourth\n", "Fourth part\n\nFor example:\nCo-authored-by: Example Person <example@example.test>\n\nNo trailers here.");
  // A malformed trailer value is ignored whole, whatever bytes it holds.
  repository.commitFile("fifth.txt", "fifth\n", "Fifth part\n\nCo-authored-by: Bad >\u0002Fake <fake@example.test>");
  repository.semantic("stage", "record", "--kind", "risk", "--item-id", "risk", "--summary", "May reject input",
    "--code-path", "second.txt", "--code-start", "1");
  const workHead = repository.git("rev-parse", "HEAD");
  organizeStage(repository);
  // A malformed option fails before the branch is rewritten.
  repository.expectSemanticFailure("Option --json is a flag", "stage", "finish", "--json=no");
  assert.equal(repository.git("rev-parse", "HEAD"), workHead);
  repository.semantic("stage", "finish");

  const head = repository.git("rev-parse", "HEAD");
  assert.notEqual(head, workHead);
  assert.equal(repository.git("rev-parse", `${head}^`), repository.git("rev-parse", "main"));
  assert.equal(repository.git("rev-parse", `${head}^{tree}`), repository.git("rev-parse", `${workHead}^{tree}`));
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), "semantic-flow/test-implementation/stages/implementation");
  assert.equal(repository.git("status", "--porcelain"), "");
  assert.equal(
    repository.git("show", "-s", "--format=%an <%ae>%n%B", head),
    "Semantic Flow Test <semantic-flow@example.invalid>\nAdd checks\n\nCheck the input before use.\n\nCo-authored-by: Ada Author <ada@example.test>\nCo-authored-by: Bob Pair <bob@example.test>",
  );
  const stage = repository.artifact.stage("implementation");
  assert.equal(stage.change.headRevision, head);
  // A code target captured before the fold points at the folded commit.
  assert.equal(stage.risks[0].codeTarget.revision, head);
  // The folded commits stay reachable from the artifact for targets that keep their revision.
  repository.git("merge-base", "--is-ancestor", workHead, "refs/semantic-review/active/test-implementation");
  repository.semantic("validate", "--publish");

  // A finalized stage of several commits is rejected.
  repository.git("commit", "--allow-empty", "-m", "Fourth part");
  const extra = repository.git("rev-parse", "HEAD");
  const manifest = repository.artifact.readJson("manifest.json");
  manifest.stages[0].headRevision = extra;
  repository.artifact.write("manifest.json", manifest);
  repository.expectSemanticFailure("has 2 commits", "validate");
});
