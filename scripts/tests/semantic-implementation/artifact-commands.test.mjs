import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginStage,
  createRepository,
  finalizeStage,
  initializeImplementation,
  organizeStage,
} from "../helpers/repository.mjs";

test("init and specification add create complete specification metadata", (t) => {
  const repository = createRepository(t);
  const base = repository.git("rev-parse", "HEAD");

  initializeImplementation(repository, {
    implementationId: "42-orders",
    sourceUrl: "https://example.invalid/stories/42",
    criteria: [
      ["cancel", "Pending orders can be cancelled."],
      ["persist", "Cancellation is persisted."],
    ],
  });

  const manifest = repository.artifact.readJson("manifest.json");
  const initial = repository.artifact.readJson("requirements/story.json");
  assert.equal(manifest.skillVersion, fs.readFileSync(new URL("../../../skills/semantic-flow/VERSION", import.meta.url), "utf8").trim());
  assert.equal(manifest.baseRevision, base);
  assert.equal(manifest.branchPrefix, "semantic-flow/42-orders");
  assert.deepEqual(manifest.requirements, ["story"]);
  assert.equal(initial.source.url, "https://example.invalid/stories/42");
  assert.equal(initial.acceptanceCriteria.length, 2);

  repository.semantic(
    "specification",
    "add",
    "--specification-id",
    "audit",
    "--specification-title",
    "Audit cancellation",
    "--specification-summary",
    "Record who cancelled an order.",
    "--source-kind",
    "local",
    "--source-reference",
    "audit-story",
    "--criterion",
    "actor=The cancelling actor is recorded.",
  );
  assert.deepEqual(
    repository.artifact.readJson("manifest.json").requirements,
    ["story", "audit"],
  );

  repository.expectSemanticFailure(
    "Specification audit already exists.",
    "specification",
    "add",
    "--specification-id",
    "audit",
    "--specification-title",
    "Duplicate",
    "--specification-summary",
    "Duplicate",
    "--source-kind",
    "local",
    "--source-reference",
    "duplicate",
    "--criterion",
    "duplicate=Duplicate",
  );
  repository.expectSemanticFailure(
    "A semantic implementation already exists",
    "init",
  );
  repository.semantic("validate", "--schema-only");
});

test("init rejects dirty repositories and rolls back invalid specifications", (t) => {
  const repository = createRepository(t);
  repository.write("dirty.txt", "dirty\n");
  repository.expectSemanticFailure(
    "Initialization requires a clean worktree",
    "init",
    "--implementation-id",
    "dirty",
    "--title",
    "Dirty",
    "--summary",
    "Dirty",
    "--target-branch",
    "main",
    "--specification-id",
    "story",
    "--specification-title",
    "Story",
    "--specification-summary",
    "Story",
    "--source-kind",
    "local",
    "--source-reference",
    "story",
    "--criterion",
    "works=Works",
  );
  assert.equal(repository.artifact.present(), false);

  repository.remove("dirty.txt");
  repository.expectSemanticFailure(
    "At least one --criterion",
    "init",
    "--implementation-id",
    "missing-criterion",
    "--title",
    "Missing criterion",
    "--summary",
    "Missing criterion",
    "--target-branch",
    "main",
    "--specification-id",
    "story",
    "--specification-title",
    "Story",
    "--specification-summary",
    "Story",
    "--source-kind",
    "local",
    "--source-reference",
    "story",
  );
  assert.equal(repository.artifact.present(), false);
});

test("semantic IDs may start with digits", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    implementationId: "1-implementation",
    specificationId: "2-specification",
    criteria: [["3-criterion", "Numeric-leading IDs work."]],
  });
  beginStage(repository, {
    id: "4-stage",
    specificationRefs: ["2-specification#3-criterion"],
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
    repository.artifact.implementation().manifest.stages,
    ["4-stage"],
  );
});

test("Windows-reserved semantic identifiers are rejected before mutation", (t) => {
  const repository = createRepository(t);
  const expectInvalidInit = (implementationId, branchPrefix) => {
    const args = [
      "init",
      "--implementation-id",
      implementationId,
      "--title",
      "Portable implementation",
      "--summary",
      "Reject identifiers that cannot become Windows filenames.",
      "--target-branch",
      "main",
      "--specification-id",
      "story",
      "--specification-title",
      "Story",
      "--specification-summary",
      "Remain portable.",
      "--source-kind",
      "local",
      "--source-reference",
      "portable-implementation",
      "--criterion",
      "works=Portable identifiers work.",
    ];
    if (branchPrefix) args.push("--branch-prefix", branchPrefix);
    repository.expectSemanticFailure("must match pattern", ...args);
  };

  for (const implementationId of ["con", "aux", "com1", "lpt9"]) {
    expectInvalidInit(implementationId);
  }

  expectInvalidInit("portable-implementation", "semantic-flow/CON");
  assert.equal(repository.artifact.present(), false);

  initializeImplementation(repository, { implementationId: "portable-implementation" });
  repository.expectSemanticFailure(
    "must match pattern",
    "specification",
    "add",
    "--specification-id",
    "aux",
    "--specification-title",
    "Invalid",
    "--specification-summary",
    "Invalid on Windows.",
    "--source-kind",
    "local",
    "--source-reference",
    "invalid",
    "--criterion",
    "works=Works",
  );
  assert.equal(
    repository.artifact.exists("requirements/aux.json"),
    false,
  );

  repository.expectSemanticFailure(
    "must match pattern",
    "stage",
    "begin",
    "--id",
    "nul",
    "--title",
    "Invalid",
    "--summary",
    "Invalid on Windows.",
    "--rationale",
    "Verify portable filenames.",
    "--specification-ref",
    "story#works",
  );
  assert.equal(repository.git("branch", "--show-current"), "main");
  assert.equal(
    repository.artifact.exists(".work/stages/nul.json"),
    false,
  );
});

test("stage file inventories use locale-independent ordering", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  repository.write("z.txt", "z\n");
  repository.write("ä.txt", "a-umlaut\n");
  repository.git("add", "z.txt", "ä.txt");
  repository.git("commit", "-m", "Add locale-sensitive paths");
  organizeStage(repository, {
    nodes: [
      {
        id: "add-files",
        description: "Add files whose names sort differently across locales.",
        changes: ["z.txt", "ä.txt"].map((path) => ({
          path,
          classification: "test",
        })),
      },
    ],
    itemLinks: [],
  });
  repository.semantic("stage", "finish");

  const stage = repository.artifact.stage("implementation");
  assert.deepEqual(
    stage.change.files.map((file) => file.path),
    ["z.txt", "ä.txt"],
  );
});

test("JSON input and current stage simplify mutations", (t) => {
  const repository = createRepository(t);
  repository.write(
    "implementation-input.json",
    `${JSON.stringify(
      {
        implementationId: "easy-flow",
        title: "Easy flow",
        summary: "Exercise concise command forms.",
        targetBranch: "main",
        specificationId: "story",
        specificationTitle: "Story",
        specificationSummary: "Use concise commands.",
        sourceKind: "local",
        sourceReference: "easy-flow",
        criterion: ["works=Concise commands work."],
      },
      null,
      2,
    )}\n`,
  );
  repository.write(
    "stage-input.json",
    `${JSON.stringify(
      {
        id: "implementation",
        title: "Implement behavior",
        summary: "Add the implementation.",
        rationale: "Keep the change independently reviewable.",
        specificationRef: ["story#works"],
      },
      null,
      2,
    )}\n`,
  );
  repository.git("add", "implementation-input.json", "stage-input.json");
  repository.git("commit", "-m", "Add semantic input");

  repository.semantic("init", "--input", "implementation-input.json");
  assert.equal(repository.git("status", "--short"), "");
  repository.semantic(
    "stage",
    "begin",
    "--input",
    "stage-input.json",
  );
  repository.semantic(
    "stage",
    "record",
    "--kind",
    "decision",
    "--item-id",
    "concise-command",
    "--category",
    "engineering",
    "--summary",
    "Infer the active stage.",
    "--rationale",
    "Only one working stage can exist.",
  );
  repository.semantic(
    "stage",
    "validation",
    "--stage",
    "current",
    "--item-id",
    "command-test",
    "--type",
    "analysis",
    "--status",
    "passed",
    "--summary",
    "The concise command path worked.",
  );

  repository.commitFile("implementation.txt", "implementation\n", "Implement");
  organizeStage(repository);
  repository.semantic("stage", "finish");
  assert.equal(
    repository.artifact.readJson("stages/implementation.json")
      .decisions[0].id,
    "concise-command",
  );
});

test("stage commands cover metadata, every insight kind, and validation", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);

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
    "--specification-ref",
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
    "--specification-ref",
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
    "specification",
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
    "--node-ref",
    "implementation-change",
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
    "--node-ref",
    "implementation-change",
  );

  const stage = repository.artifact.stage("implementation");
  assert.equal(stage.change.headRevision, commit);
  assert.equal(
    stage.change.branch,
    "semantic-flow/test-implementation/stages/implementation",
  );
  assert.equal(stage.change.baseBranch, "main");
  assert.equal(stage.title, "Updated implementation");
  assert.equal(stage.decisions[0].category, "specification");
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
    repository.artifact.exists(".work/stages/discarded.json"),
    false,
  );
  repository.semantic("validate", "--publish");
});

test("stage organization partitions multi-cause files by diff hunk", (t) => {
  const repository = createRepository(t);
  repository.write(
    "service.txt",
    "imports\nstable-a\nstable-b\nstable-c\nbehavior\n",
  );
  repository.git("add", "service.txt");
  repository.git("commit", "-m", "Add service fixture");
  initializeImplementation(repository);
  beginStage(repository);
  repository.write(
    "service.txt",
    "updated imports\nstable-a\nstable-b\nstable-c\nupdated behavior\n",
  );
  repository.git("add", "service.txt");
  repository.git("commit", "-m", "Update service fixture");
  repository.semantic(
    "stage",
    "record",
    "--kind",
    "decision",
    "--item-id",
    "split-causes",
    "--category",
    "engineering",
    "--summary",
    "Separate import maintenance from behavior.",
    "--rationale",
    "The file contains two independently meaningful changes.",
  );

  const nodes = [
    {
      id: "refresh-imports",
      description: "Update imports needed by the new implementation.",
      changes: [
        {
          path: "service.txt",
          classification: "trivial",
          hunks: [1],
        },
      ],
    },
    {
      id: "change-behavior",
      description: "Replace the service behavior with the requested flow.",
      changes: [
        {
          path: "service.txt",
          classification: "behavior",
          hunks: [2],
        },
      ],
    },
  ];
  const itemLinks = [
    {
      collection: "decisions",
      itemId: "split-causes",
      nodeRefs: ["refresh-imports", "change-behavior"],
    },
  ];
  organizeStage(repository, { nodes, itemLinks });
  repository.semantic("stage", "finish");

  const stage = repository.artifact.readJson("stages/implementation.json");
  assert.equal(stage.nodes.length, 2);
  assert.deepEqual(stage.decisions[0].nodeRefs, [
    "refresh-imports",
    "change-behavior",
  ]);
  assert.deepEqual(stage.nodes[0].changes[0].hunks, [1]);
});

function branchExists(repository, name) {
  return (
    repository.result("git", ["rev-parse", "--verify", `refs/heads/${name}`])
      .status === 0
  );
}

test("stage discard removes an unchanged generated branch so the stage can begin again", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);

  const branch = "semantic-flow/test-implementation/stages/extra";
  beginStage(repository, { id: "extra", dependencies: ["implementation"] });
  assert.equal(branchExists(repository, branch), true);

  const output = repository.semantic("stage", "discard", "--id", "extra");
  assert.match(output, /Removed unchanged branch/);
  assert.equal(branchExists(repository, branch), false);

  beginStage(repository, { id: "extra", dependencies: ["implementation"] });
  assert.equal(branchExists(repository, branch), true);
  repository.semantic("validate");
});

test("stage discard keeps a branch that carries local commits", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);

  const branch = "semantic-flow/test-implementation/stages/extra";
  beginStage(repository, { id: "extra", dependencies: ["implementation"] });
  repository.commitFile("extra.txt", "extra\n", "Work in progress");

  const output = repository.semantic("stage", "discard", "--id", "extra");
  assert.match(output, /has local commits and was kept/);
  assert.equal(branchExists(repository, branch), true);
});

test("unresolved specification ref reports valid normalized criteria", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    criteria: [
      ["works", "The implementation works."],
      ["persists", "The result persists."],
    ],
  });
  const failure = repository.expectSemanticFailure(
    /Valid criteria: story#works, story#persists\./,
    "stage",
    "begin",
    "--id",
    "implementation",
    "--title",
    "Implement behavior",
    "--summary",
    "Add the implementation.",
    "--rationale",
    "Keep the change independently reviewable.",
    "--specification-ref",
    "story#missing",
  );
  assert.match(failure.stderr + failure.stdout, /unresolved specification ref/);
});

test("implementation simulation recovers from an unsupported decision category and finishes", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  repository.write("implementation.txt", "Valid implementation remains in progress.\n");
  const args = ["stage", "record", "--kind", "decision", "--item-id", "architecture-choice",
    "--summary", "Keep the boundary in one module.", "--rationale", "The implementation has one caller."];
  repository.expectSemanticFailure(/category|engineering|specification/, ...args, "--category", "architecture");
  assert.equal(repository.artifact.readJson(".work/stages/implementation.json").decisions.length, 0);
  assert.equal(repository.read("implementation.txt"), "Valid implementation remains in progress.\n");
  repository.semantic(...args, "--category", "engineering");
  repository.git("add", "implementation.txt");
  repository.git("commit", "-m", "Complete implementation after metadata recovery");
  organizeStage(repository);
  repository.semantic("stage", "finish");
  const stage = repository.artifact.readJson("stages/implementation.json");
  assert.equal(stage.decisions.length, 1);
  assert.equal(stage.decisions[0].category, "engineering");
  assert.equal(stage.decisions[0].rationale, "The implementation has one caller.");
});

test("specification sources accept arbitrary providers while retaining reference and URI validation", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { sourceKind: "internal-tracker", sourceReference: "TEAM-42", sourceUrl: "https://work.example.com/TEAM-42" });
  const file = "requirements/story.json";
  const specification = repository.artifact.readJson(file);
  assert.equal(specification.source.kind, "internal-tracker");
  repository.semantic("validate", "--schema-only");
  for (const source of [
    { kind: "", reference: "TEAM-42" },
    { kind: "   ", reference: "TEAM-42" },
    { kind: "internal-tracker", reference: "" },
    { kind: "internal-tracker" },
    { kind: "internal-tracker", reference: "TEAM-42", url: "not a URI" },
    { kind: "url", reference: "TEAM-42" },
  ]) {
    repository.artifact.write(file, { ...specification, source });
    repository.expectSemanticFailure(/validation|must|source/i, "validate", "--schema-only");
  }
});

test("stage set --finalized updates metadata on a finalized stage", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    criteria: [
      ["works", "The implementation works."],
      ["persists", "The result is persisted."],
    ],
  });
  beginStage(repository);
  finalizeStage(repository);
  const file = "stages/implementation.json";
  const before = repository.artifact.stage("implementation");
  const stored = repository.artifact.read(file);

  repository.expectSemanticFailure(
    "Working stage implementation does not exist",
    "stage", "set", "--id", "implementation", "--specification-ref", "story#persists",
  );
  repository.expectSemanticFailure(
    "--finalized requires an explicit --id <stage-id>",
    "stage", "set", "--finalized", "--specification-ref", "story#persists",
  );
  repository.expectSemanticFailure(
    "unresolved specification ref story#missing",
    "stage", "set", "--finalized", "--id", "implementation", "--specification-ref", "story#missing",
  );
  assert.equal(repository.artifact.read(file), stored);

  const output = repository.semantic(
    "stage", "set", "--finalized", "--id", "implementation",
    "--title", "Implement and persist behavior",
    "--specification-ref", "story#works",
    "--specification-ref", "story#persists",
  );
  assert.match(output, /Updated finalized stage implementation\./);
  const stage = repository.artifact.stage("implementation");
  assert.deepEqual(stage.specificationRefs, ["story#works", "story#persists"]);
  assert.equal(stage.title, "Implement and persist behavior");
  assert.deepEqual(stage.change, before.change);
  repository.semantic("validate", "--publish");
});

test("manifest document IDs are validated before they name files", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const manifest = repository.artifact.readJson("manifest.json");
  manifest.stages = [{ id: "../../outside", headRevision: manifest.baseRevision }];
  repository.artifact.write("manifest.json", manifest);
  repository.expectSemanticFailure(/manifest\.json\/stages\/0 must match pattern/, "validate");
});

test("the active artifact stores stage heads and leaves branches, bases and files to Git", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  assert.equal("branch" in repository.artifact.readJson(".work/stages/implementation.json"), false);
  const policy = finalizeStage(repository);
  beginStage(repository, { id: "persistence", dependencies: ["implementation"] });
  const persistence = finalizeStage(repository, { id: "persistence" });

  const stored = repository.artifact.readJson("manifest.json");
  assert.deepEqual(stored.stages, [
    { id: "implementation", headRevision: policy },
    { id: "persistence", headRevision: persistence },
  ]);
  for (const id of ["implementation", "persistence"]) {
    assert.equal("change" in repository.artifact.readJson(`stages/${id}.json`), false);
  }

  const { change } = repository.artifact.stage("persistence");
  assert.deepEqual(change, {
    branch: "semantic-flow/test-implementation/stages/persistence",
    baseBranch: "semantic-flow/test-implementation/stages/implementation",
    baseRevision: policy,
    headRevision: persistence,
    files: [{ path: "persistence.txt", kind: "added" }],
  });
  assert.equal(repository.artifact.stage("implementation").change.baseRevision, stored.baseRevision);
  repository.semantic("validate");
});

test("stored derived data and malformed manifest stage entries are rejected", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);
  beginStage(repository, { id: "persistence", dependencies: ["implementation"] });
  const derived = repository.artifact.stage("implementation").change;

  const stage = repository.artifact.read("stages/implementation.json");
  repository.artifact.write("stages/implementation.json", { ...JSON.parse(stage), change: derived });
  repository.expectSemanticFailure(/stages\/implementation\.json: change is derived from Git and must not be stored/, "validate", "--schema-only");
  repository.artifact.write("stages/implementation.json", stage);

  const work = repository.artifact.read(".work/stages/persistence.json");
  repository.artifact.write(".work/stages/persistence.json", { ...JSON.parse(work), branch: "semantic-flow/test-implementation/stages/persistence" });
  repository.expectSemanticFailure(/persistence\.json: branch is derived from Git and must not be stored/, "validate", "--schema-only");
  repository.artifact.write(".work/stages/persistence.json", work);

  const manifest = repository.artifact.read("manifest.json");
  const entry = JSON.parse(manifest).stages[0];
  for (const [stages, message] of [
    [["implementation"], /stages\/0 must have exactly a string id and headRevision/],
    [[{ id: "implementation" }], /stages\/0 must have exactly a string id and headRevision/],
    [[{ ...entry, branch: derived.branch }], /stages\/0 must have exactly a string id and headRevision/],
    [[{ ...entry, headRevision: entry.headRevision.slice(0, 12) }], /stages\/0\/headRevision must be a full lowercase SHA-1 commit ID/],
  ]) {
    repository.artifact.write("manifest.json", { ...JSON.parse(manifest), stages });
    repository.expectSemanticFailure(message, "validate", "--schema-only");
  }
  repository.artifact.write("manifest.json", manifest);
  repository.semantic("validate");
});

test("a stage branch that moved away from its recorded head fails validation", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  const head = finalizeStage(repository);
  repository.commitFile("later.txt", "later\n", "Move the stage branch");
  repository.expectSemanticFailure(
    new RegExp(`Stage implementation branch semantic-flow/test-implementation/stages/implementation moved from ${head} to [0-9a-f]{40}; check it out, then run restack --from implementation\\.`),
    "validate",
  );
  repository.git("reset", "--hard", head);
  repository.semantic("validate");
});

test("implementation export prints and writes the full form without changing the artifact", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  const head = finalizeStage(repository);
  beginStage(repository, { id: "persistence", dependencies: ["implementation"] });
  const before = Object.fromEntries(repository.artifact.list().map((file) => [file, repository.artifact.read(file)]));

  const exported = JSON.parse(repository.semantic("export"));
  assert.deepEqual(Object.keys(exported), ["manifest", "requirements", "stages", "workingStages"]);
  assert.deepEqual(exported.manifest, { ...repository.artifact.readJson("manifest.json"), stages: ["implementation"] });
  assert.deepEqual(exported.requirements.story, repository.artifact.readJson("requirements/story.json"));
  assert.deepEqual(exported.stages.implementation, {
    ...repository.artifact.readJson("stages/implementation.json"),
    change: {
      branch: "semantic-flow/test-implementation/stages/implementation",
      baseBranch: "main",
      baseRevision: exported.manifest.baseRevision,
      headRevision: head,
      files: [{ path: "implementation.txt", kind: "added" }],
    },
  });
  assert.deepEqual(exported.workingStages.persistence, {
    ...repository.artifact.readJson(".work/stages/persistence.json"),
    branch: "semantic-flow/test-implementation/stages/persistence",
  });

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-export-"));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  assert.match(repository.semantic("export", "--destination", destination), /Exported test-implementation to /);
  const written = (file) => JSON.parse(fs.readFileSync(path.join(destination, file), "utf8"));
  assert.deepEqual(written("manifest.json"), exported.manifest);
  assert.deepEqual(written("requirements/story.json"), exported.requirements.story);
  assert.deepEqual(written("stages/implementation.json"), exported.stages.implementation);
  assert.deepEqual(written(".work/stages/persistence.json"), exported.workingStages.persistence);

  fs.writeFileSync(path.join(destination, "manifest.json"), "{}\n");
  repository.expectSemanticFailure(/Export destination .* must be a new or empty directory/, "export", "--destination", destination);
  assert.deepEqual(Object.fromEntries(repository.artifact.list().map((file) => [file, repository.artifact.read(file)])), before);
  repository.semantic("validate");
});

test("a stage named metadata does not collide with the metadata branch", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "metadata" });
  const head = finalizeStage(repository, { id: "metadata" });
  assert.equal(repository.git("rev-parse", "semantic-flow/test-implementation/stages/metadata"), head);

  repository.semantic("publish");
  const published = repository.git("rev-parse", "semantic-flow/test-implementation/metadata");
  assert.notEqual(published, head);
  assert.equal(repository.git("rev-parse", "semantic-flow/test-implementation/stages/metadata"), head);
  const stage = JSON.parse(repository.git("show", `${published}:.semantic-review/stages/metadata.json`));
  assert.equal(stage.change.branch, "semantic-flow/test-implementation/stages/metadata");
  repository.semantic("validate", "--publish");
});

test("begin accepts any unrelated branch below the prefix and refuses its own existing branch", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  // Branch names hold no position, so a branch named like a former ordinal stage is no conflict.
  repository.git("branch", "semantic-flow/test-implementation/01-other");
  repository.git("branch", "semantic-flow/test-implementation/stages/other");
  repository.git("branch", "semantic-flow/test-implementation/stages/taken");
  beginStage(repository);
  assert.equal(repository.git("branch", "--show-current"), "semantic-flow/test-implementation/stages/implementation");
  finalizeStage(repository);

  assert.throws(
    () => beginStage(repository, { id: "taken", dependencies: ["implementation"] }),
    /Stage branch semantic-flow\/test-implementation\/stages\/taken already exists/,
  );
  assert.equal(repository.artifact.exists(".work/stages/taken.json"), false);
  assert.equal(repository.git("branch", "--show-current"), "semantic-flow/test-implementation/stages/implementation");
  repository.semantic("validate");
});
