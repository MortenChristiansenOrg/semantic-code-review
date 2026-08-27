import assert from "node:assert/strict";
import test from "node:test";
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

  const manifest = repository.readJson(".semantic-review/manifest.json");
  const initial = repository.readJson(
    ".semantic-review/requirements/story.json",
  );
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
    repository.readJson(".semantic-review/manifest.json").requirements,
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
  assert.equal(repository.exists(".semantic-review"), false);

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
  assert.equal(repository.exists(".semantic-review"), false);
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
    repository.readJson(".semantic-review/manifest.json").stages,
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
  assert.equal(repository.exists(".semantic-review"), false);

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
    repository.exists(".semantic-review/requirements/aux.json"),
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
    repository.exists(".semantic-review/.work/stages/nul.json"),
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

  const stage = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
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
    repository.readJson(".semantic-review/stages/implementation.json")
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

  const stage = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
  assert.equal(stage.change.headRevision, commit);
  assert.equal(
    stage.change.branch,
    "semantic-flow/test-implementation/01-implementation",
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
    repository.exists(".semantic-review/.work/stages/discarded.json"),
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

  const stage = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
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

test("stage discard removes an unchanged generated branch and frees the ordinal", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);

  const branch = "semantic-flow/test-implementation/02-extra";
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

  const branch = "semantic-flow/test-implementation/02-extra";
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
