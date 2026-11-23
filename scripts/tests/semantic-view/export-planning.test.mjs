import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { rememberImplementation } from "../../src/shared/artifact-store.ts";
import { fileURLToPath } from "node:url";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  feedbackCli,
  flowCli,
  implementationFromScript,
  initializeImplementation,
  organizeStage,
  scriptsDirectory,
  sourceLoader,
} from "../helpers/repository.mjs";
import { HOSTILE_GIT, PATH_PREFIX_CHANGES, pathPrefixStage, submoduleAndRenamesStage, UPDATE_AND_RENAMES, withHostileGit } from "../helpers/hostile-git.mjs";

const moduleUrl = new URL("../../src/semantic-view.ts", import.meta.url).href;

/** Records a new head for a stage, and optionally a new base for the stack,
 * as if the stage branch had been revised; the inventory is derived from it. */
function recordStageHead(repository, id, headRevision, baseRevision) {
  const manifest = repository.artifact.readJson("manifest.json");
  manifest.stages = manifest.stages.map((entry) => (entry.id === id ? { ...entry, headRevision } : entry));
  if (baseRevision) manifest.baseRevision = baseRevision;
  repository.artifact.write("manifest.json", manifest);
}

/** Replaces the finalized stages by the given [id, headRevision, nodeChanges]
 * stack; each stage is based on the head below it. */
function seedStages(repository, stages) {
  const template = repository.artifact.readJson("stages/implementation.json");
  repository.artifact.remove("stages/implementation.json");
  for (const [id, , paths] of stages) {
    repository.artifact.write(`stages/${id}.json`, {
      ...template,
      id,
      nodes: [{ id: "change", description: "Change", changes: paths.map((path) => ({ path, classification: "behavior" })) }],
    });
  }
  const manifest = repository.artifact.readJson("manifest.json");
  repository.artifact.write("manifest.json", {
    ...manifest,
    stages: stages.map(([id, headRevision]) => ({ id, headRevision })),
  });
}

const {
  buildFeedbackTargetData,
  createImplementationDataScript,
  createSnapshotReader,
  createViewerDataSource,
  exportFeedback,
  exportFeedbackReplies,
  planFeedbackThreads,
  resolveLineDraftSnapshots,
  mapNoteTarget,
  readFeedbackThread,
  viewerSnapshot,
  feedbackDirectory,
  readReview,
  registeredReviews,
  reviewId,
} = await import(moduleUrl);

const implementation = {
  stages: [
    {
      id: "implementation",
      title: "Implement behavior",
      nodes: [{ id: "impl-change", title: "Implementation change" }],
    },
    {
      id: "cleanup",
      title: "Cleanup",
      nodes: [],
    },
  ],
};

test("mapNoteTarget maps a stage note to a stage target", () => {
  assert.deepEqual(mapNoteTarget({ kind: "stage", id: "implementation" }, implementation), {
    "target-kind": "stage",
    stage: "implementation",
    label: "Implement behavior",
  });
});

test("mapNoteTarget maps a node note to a first-class node target", () => {
  assert.deepEqual(
    mapNoteTarget({ kind: "node", id: "impl-change", stageId: "implementation" }, implementation),
    {
      "target-kind": "node",
      stage: "implementation",
      node: "impl-change",
      label: "Implementation change",
    },
  );
});

test("mapNoteTarget maps a file note id into a file target", () => {
  assert.deepEqual(
    mapNoteTarget({ kind: "file", id: "f:implementation:src/app.js" }, implementation),
    {
      "target-kind": "file",
      stage: "implementation",
      path: "src/app.js",
      label: "src/app.js",
    },
  );
});

test("mapNoteTarget maps a line note id into a line target", () => {
  assert.deepEqual(
    mapNoteTarget({ kind: "line", id: "l:implementation:new:42:src/app.js" }, implementation),
    {
      "target-kind": "line",
      stage: "implementation",
      path: "src/app.js",
      side: "new",
      line: 42,
      label: "src/app.js:42",
    },
  );
  assert.deepEqual(
    mapNoteTarget({ kind: "line", id: "l:implementation:old:7:src/app.js" }, implementation),
    {
      "target-kind": "line",
      stage: "implementation",
      path: "src/app.js",
      side: "old",
      line: 7,
      label: "src/app.js:7",
    },
  );
});

test("mapNoteTarget rejects unknown targets", () => {
  assert.throws(() => mapNoteTarget({ kind: "stage", id: "missing" }, implementation), /unknown stage/);
  assert.throws(() => mapNoteTarget({ kind: "node", id: "missing" }, implementation), /unknown node/);
  assert.throws(
    () => mapNoteTarget({ kind: "file", id: "not-a-file-id" }, implementation),
    /unrecognized file id/,
  );
  assert.throws(
    () => mapNoteTarget({ kind: "line", id: "not-a-line-id" }, implementation),
    /unrecognized line id/,
  );
  assert.throws(
    () => mapNoteTarget({ kind: "line", id: "l:ghost:new:1:src/app.js" }, implementation),
    /unknown stage/,
  );
});

test("planFeedbackThreads plans valid notes and preserves ref order", () => {
  const notes = [
    { ref: 0, kind: "stage", id: "implementation", body: "  needs a test  " },
    { ref: 1, kind: "file", id: "f:implementation:src/app.js", body: "rename this" },
  ];
  const { planned, skipped } = planFeedbackThreads(notes, implementation);
  assert.equal(skipped.length, 0);
  assert.equal(planned.length, 2);
  assert.deepEqual(
    planned.map((p) => p.ref),
    [0, 1],
  );
  assert.equal(planned[0].body, "needs a test", "body is trimmed");
  assert.equal(planned[0].target["target-kind"], "stage");
  assert.equal(planned[1].target["target-kind"], "file");
});

test("planFeedbackThreads skips empty bodies and unresolved targets with reasons", () => {
  const notes = [
    { ref: 5, kind: "stage", id: "implementation", body: "   " },
    { ref: 6, kind: "stage", id: "ghost", body: "real body" },
    { ref: 7, kind: "stage", id: "implementation", body: "keep me" },
  ];
  const { planned, skipped } = planFeedbackThreads(notes, implementation);
  assert.deepEqual(
    planned.map((p) => p.ref),
    [7],
  );
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped[0], { ref: 5, reason: "empty body" });
  assert.equal(skipped[1].ref, 6);
  assert.match(skipped[1].reason, /unknown stage/);
});

test("planFeedbackThreads falls back to array index when ref is absent", () => {
  const { planned } = planFeedbackThreads(
    [{ kind: "stage", id: "cleanup", body: "note without ref" }],
    implementation,
  );
  assert.equal(planned.length, 1);
  assert.equal(planned[0].ref, 0);
});

test("planFeedbackThreads tolerates a non-array payload", () => {
  assert.deepEqual(planFeedbackThreads(null, implementation), { planned: [], skipped: [] });
});

test("planFeedbackThreads rejects a node note's non-string stage and ignores snapshots it never checks", () => {
  const { planned, skipped } = planFeedbackThreads([
    { ref: 0, kind: "node", id: "impl-change", stageId: 42, body: "Which stage?" },
    { ref: 1, kind: "node", id: "impl-change", stageId: "", body: "First stage with the node" },
    { ref: 2, kind: "stage", id: "implementation", body: "Stage note", snapshot: { base: "abc" } },
  ], implementation);
  assert.deepEqual(skipped, [{ ref: 0, reason: 'unknown stage "42"' }]);
  assert.deepEqual(planned.map((thread) => [thread.ref, thread.target["target-kind"]]), [[1, "node"], [2, "stage"]]);
});

test("a line draft without a file revision is checked by its base and head revisions", (t) => {
  const { repository } = createImplementationWithStages(t);
  const current = buildFeedbackTargetData(repository.root), [stage] = current.stages;
  const note = { kind: "line", id: "l:implementation:new:1:implementation.txt", body: "Check this line",
    snapshot: { base: stage.baseRevision, head: stage.headRevision, fileRevision: null } };
  assert.equal(resolveLineDraftSnapshots(repository.root, [note])[0].snapshot.fileRevision, stage.files[0].revision);
  assert.deepEqual(planFeedbackThreads([note], current).skipped, []);
  const sent = exportFeedback({ repoRoot: repository.root, implementation: current }, [note, { ...note, snapshot: { ...note.snapshot, fileRevision: "" } }]);
  assert.equal(sent.ok, true, JSON.stringify(sent)); assert.equal(sent.exported.length, 2);
  const moved = { ...note, snapshot: { ...note.snapshot, head: "f".repeat(40) } };
  assert.match(planFeedbackThreads([moved], current).skipped[0].reason, /file changed/);
  assert.match(planFeedbackThreads([{ ...note, snapshot: { ...note.snapshot, fileRevision: 42 } }], current).skipped[0].reason, /snapshot is invalid/);
});

test("feedback export target data omits diff reconstruction", (t) => {
  const { repository } = createImplementationWithStages(t);
  const targetData = buildFeedbackTargetData(repository.root);

  assert.equal(targetData.implementationId, "test-implementation");
  assert.deepEqual(
    targetData.stages.map((stage) => ({
      id: stage.id,
      nodes: stage.nodes.map((node) => node.id),
    })),
    [{ id: "implementation", nodes: ["implementation-change"] }],
  );
  assert.match(targetData.stages[0].files[0].revision, /^[a-f0-9]{64}$/);
  assert.equal("lines" in targetData.stages[0].files[0], false);
});

test("viewer data preserves zero-context hunk ownership", async (t) => {
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
  organizeStage(repository, {
    nodes: [
      {
        id: "refresh-imports",
        description: "Update imports.",
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
        description: "Update behavior.",
        changes: [
          {
            path: "service.txt",
            classification: "behavior",
            hunks: [2],
          },
        ],
      },
    ],
    itemLinks: [],
  });
  repository.semantic("stage", "finish");

  const dataSource = createViewerDataSource(repository.root);
  const script = dataSource.implementationDataScript();
  const data = implementationFromScript(script);
  const stage = data.stages[0];
  const file = data.stages[0].files[0];
  const diff = await dataSource.fileDiff(
    "implementation",
    "service.txt",
    stage.baseRevision,
    stage.headRevision,
  );

  assert.equal("lines" in file, false);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
  assert.deepEqual(
    [...new Set(diff.lines.filter((line) => line.t !== "ctx").map((line) => line.h))],
    [1, 2],
  );
  assert.deepEqual(
    file.memberships.map(({ nodeId, hunks }) => ({ nodeId, hunks })),
    [
      { nodeId: "refresh-imports", hunks: [1] },
      { nodeId: "change-behavior", hunks: [2] },
    ],
  );
});

test("viewer data caches metadata and batches lazy diffs by stage", async (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  repository.write("first.txt", "first\n");
  repository.write("second.txt", "second\n");
  repository.git("add", ".");
  repository.git("commit", "-m", "Add viewer fixtures");
  organizeStage(repository);
  repository.semantic("stage", "finish");

  const calls = [];
  const dataSource = createViewerDataSource(repository.root, {
    gitCapture(cwd, args) {
      calls.push(args);
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    },
  });

  const firstScript = dataSource.implementationDataScript();
  const stage = implementationFromScript(firstScript).stages[0];
  const initialDiffCalls = calls.filter((args) => args.includes("diff-tree")).length;
  assert.equal(initialDiffCalls, 1);
  assert.equal(dataSource.implementationDataScript(), firstScript);
  assert.equal(calls.filter((args) => args.includes("diff-tree")).length, 1);

  assert.equal(
    (await dataSource.fileDiff(
      "implementation",
      "first.txt",
      stage.baseRevision,
      stage.headRevision,
    )).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff-tree")).length, 3);
  assert.equal(
    (await dataSource.fileDiff(
      "implementation",
      "second.txt",
      stage.baseRevision,
      stage.headRevision,
    )).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff-tree")).length, 3);
});

test("viewer refreshes a revised inventory without discarding unrelated immutable diffs", async (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  repository.commitFile("first.txt", "first\n", "Add first fixture");
  organizeStage(repository);
  repository.semantic("stage", "finish");
  const original = repository.artifact.stage("implementation");
  let gitCalls = 0;
  const source = createViewerDataSource(repository.root);
  const counting = createViewerDataSource(repository.root, {
    gitCapture(cwd, args) {
      if (args.includes("diff-tree")) gitCalls++;
      return execFileSync("git", args, { cwd, encoding: "utf8" });
    },
  });
  counting.implementationDataScript();
  const diff = (name, head) => counting.fileDiff(original.id, name, original.change.baseRevision, head);
  await diff("first.txt", original.change.headRevision);
  await assert.rejects(diff("second.txt", original.change.headRevision), /not changed/);

  // The inventory follows the recorded head; nothing else records it.
  const head = repository.commitFile("second.txt", "second\n", "Add second fixture");
  const stage = repository.artifact.readJson("stages/implementation.json");
  stage.nodes[0].changes.push({ path: "second.txt", classification: "behavior" });
  repository.artifact.write("stages/implementation.json", stage);
  recordStageHead(repository, "implementation", head);
  assert.deepEqual(
    implementationFromScript(source.implementationDataScript()).stages[0].files.map((file) => file.path),
    ["first.txt", "second.txt"],
  );
  counting.implementationDataScript();
  assert.equal((await diff("second.txt", head)).lines[0].s, "second");
  const revisedCalls = gitCalls;
  stage.summary += " Updated review explanation.";
  repository.artifact.write("stages/implementation.json", stage);
  counting.implementationDataScript();
  assert.equal((await diff("second.txt", head)).lines[0].s, "second");
  assert.equal(gitCalls, revisedCalls, "explanation-only refresh keeps immutable diff caches");
});

test("lazy stage diff preserves renamed file content changes", async (t) => {
  const repository = createRepository(t);
  repository.write("old name.txt", "stable\nbefore\n");
  repository.git("add", ".");
  repository.git("commit", "-m", "Add rename fixture");
  initializeImplementation(repository);
  beginStage(repository);
  repository.git("mv", "old name.txt", "new name.txt");
  repository.write("new name.txt", "stable\nafter\n");
  repository.git("add", ".");
  repository.git("commit", "-m", "Rename and update fixture");
  organizeStage(repository);
  repository.semantic("stage", "finish");

  const dataSource = createViewerDataSource(repository.root);
  const data = implementationFromScript(dataSource.implementationDataScript());
  assert.deepEqual(
    data.stages[0].files.map(({ path, previousPath, kind }) => ({
      path,
      previousPath,
      kind,
    })),
    [{
      path: "new name.txt",
      previousPath: "old name.txt",
      kind: "renamed",
    }],
  );

  const stage = data.stages[0];
  const diff = await dataSource.fileDiff(
    "implementation",
    "new name.txt",
    stage.baseRevision,
    stage.headRevision,
  );
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.deepEqual(
    diff.lines.filter((line) => line.t !== "ctx").map((line) => line.s),
    ["before", "after"],
  );
});

test("file revisions ignore unrelated changes in the same stage", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  repository.write("first.txt", "first\n");
  repository.write("second.txt", "second\n");
  repository.git("add", ".");
  repository.git("commit", "-m", "Add revision fixtures");
  organizeStage(repository);
  repository.semantic("stage", "finish");

  const dataSource = createViewerDataSource(repository.root);
  const readData = () => implementationFromScript(dataSource.implementationDataScript());
  const initial = readData();
  const initialRevisions = new Map(
    initial.stages[0].files.map((file) => [file.path, file.revision]),
  );

  repository.write("second.txt", "second updated\n");
  repository.git("add", "second.txt");
  repository.git("commit", "-m", "Update second fixture");
  recordStageHead(repository, "implementation", repository.git("rev-parse", "HEAD"));

  const refreshed = readData();
  const refreshedRevisions = new Map(
    refreshed.stages[0].files.map((file) => [file.path, file.revision]),
  );
  assert.equal(
    refreshedRevisions.get("first.txt"),
    initialRevisions.get("first.txt"),
  );
  assert.notEqual(
    refreshedRevisions.get("second.txt"),
    initialRevisions.get("second.txt"),
  );
});

test("lazy diff stays bound to the metadata stage revision", async (t) => {
  const { repository } = createImplementationWithStages(t);
  const dataSource = createViewerDataSource(repository.root);
  const initial = implementationFromScript(dataSource.implementationDataScript());
  const initialStage = initial.stages[0];

  repository.write("implementation.txt", "changed after viewer load\n");
  repository.git("add", "implementation.txt");
  repository.git("commit", "-m", "Advance stage after viewer load");
  recordStageHead(repository, "implementation", repository.git("rev-parse", "HEAD"));

  const diff = await dataSource.fileDiff(
    "implementation",
    "implementation.txt",
    initialStage.baseRevision,
    initialStage.headRevision,
  );
  assert.deepEqual(
    diff.lines.filter((line) => line.t === "add").map((line) => line.s),
    ["implementation"],
  );
});

test("feedback export commits the valid subset when one batch item is stale", (t) => {
  const { repository } = createImplementationWithStages(t);
  const result = exportFeedback(
    {
      repoRoot: repository.root,
      implementation: buildFeedbackTargetData(repository.root),
    },
    [
      {
        ref: 0,
        kind: "stage",
        id: "implementation",
        body: "Keep this valid note.",
      },
      {
        ref: 1,
        kind: "file",
        id: "f:implementation:missing.txt",
        body: "This target is stale.",
      },
    ],
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.exported.map((entry) => entry.ref),
    [0],
  );
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].ref, 1);
  assert.match(result.skipped[0].reason, /not changed/);
});

test("feedback reply export batches reviewer replies", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  for (const id of ["reply-first", "reply-second"]) {
    repository.feedback(
      "thread",
      "add",
      "--id",
      id,
      "--comment-id",
      `${id}-comment`,
      "--body",
      "Review comment.",
      "--label",
      "Implementation",
      "--target-kind",
      "stage",
      "--stage",
      "implementation",
    );
  }

  const result = exportFeedbackReplies(
    { repoRoot: repository.root },
    [
      { ref: "draft-first", threadId: "reply-first", body: "First response." },
      { ref: "draft-second", threadId: "reply-second", body: "Second response." },
    ],
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.replied.map((entry) => entry.ref),
    ["draft-first", "draft-second"],
  );
  assert.deepEqual(
    result.replied.map((entry) => entry.comment.body),
    ["First response.", "Second response."],
  );
});

test("viewer snapshot detects when the feedback command finishes replies", (t) => {
  const { repository } = createImplementationWithStages(t);
  const initial = viewerSnapshot(repository.root);
  assert.equal(initial.awaitingAgentReplies, 0);

  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "auto-reload",
    "--comment-id",
    "auto-reload-comment",
    "--body",
    "Update this.",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );
  const awaiting = viewerSnapshot(repository.root);
  assert.equal(awaiting.awaitingAgentReplies, 1);
  assert.notEqual(awaiting.revision, initial.revision);

  repository.feedback(
    "thread",
    "reply",
    "--id",
    "auto-reload",
    "--comment-id",
    "auto-reload-response",
    "--author",
    "agent",
    "--body",
    "Updated.",
  );
  const completed = viewerSnapshot(repository.root);
  assert.equal(completed.awaitingAgentReplies, 0);
  assert.notEqual(completed.revision, awaiting.revision);
});

test("createImplementationDataScript reloads feedback from disk", (t) => {
  const { repository } = createImplementationWithStages(t);
  const dataSource = createViewerDataSource(repository.root);
  const readData = () => {
    const script = dataSource.implementationDataScript();
    return implementationFromScript(script);
  };

  assert.deepEqual(readData().feedback, []);

  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "reload-feedback",
    "--comment-id",
    "reload-feedback-comment",
    "--body",
    "Show this after refresh.",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );

  assert.equal(readData().feedback[0].comments.length, 1);

  repository.feedback(
    "thread",
    "resolve",
    "--id",
    "reload-feedback",
    "--comment-id",
    "reload-feedback-response",
    "--body",
    "This reply should appear after refresh.",
  );

  const refreshed = readData();
  assert.equal(typeof refreshed.viewerRevision, "string");
  assert.equal(refreshed.awaitingAgentReplies, 0);
  assert.equal(refreshed.feedback[0].comments.length, 2);
  assert.equal(
    refreshed.feedback[0].comments[1].body,
    "This reply should appear after refresh.",
  );
});

test("viewer client refreshes data without reloading the page", () => {
  // The shipped viewer is minified; read the repository sources.
  const viewerSources = new URL("../../../viewer/src/", import.meta.url);
  const api = fs.readFileSync(new URL("api.ts", viewerSources), "utf8");
  // The page's modules: everything bundled into app.js except its request module.
  // boot.ts starts the page before app.js loads and may reload it for a new launch link.
  const pageModules = fs.readdirSync(viewerSources, { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".ts") && name !== "api.ts" && name !== "markdown.ts" && name !== "boot.ts").sort();
  assert.ok(pageModules.includes("app.ts"));
  const app = pageModules.map((name) => fs.readFileSync(new URL(name, viewerSources), "utf8")).join("\n");
  const styles = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "viewer", "styles.css"),
    "utf8",
  );
  assert.match(app, /api\.getRevision\(\)/);
  assert.match(api, /getRevision = \(\) => getJson<RevisionResponse>\("\/api\/revision", POLL_DEADLINE_MS\)/);
  assert.match(app, /api\.getDiff\(query\)/);
  assert.match(api, /getJson<DiffResponse>\(`\/api\/diff\?\$\{params\}`\)/);
  assert.match(app, /Loading diff…/);
  assert.match(app, /loadOpenDiffs\(\);/);
  assert.match(app, /replies: sendable\.map/);
  assert.doesNotMatch(app, /\/api\/feedback\/reply-batch/);
  assert.doesNotMatch(api, /\/api\/feedback\/reply-batch/);
  assert.match(app, /api\.getImplementation\(\)/);
  // One module issues every server request.
  const directRequest = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|EventSource/;
  assert.match("fetch (url)", directRequest);
  assert.match("window.fetch(url)", directRequest);
  const modules = fs.readdirSync(viewerSources, { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".ts") && name !== "api.ts");
  assert.ok(modules.includes("app.ts"));
  for (const file of modules) {
    assert.doesNotMatch(fs.readFileSync(path.join(fileURLToPath(viewerSources), file), "utf8"), directRequest, file);
  }
  assert.match(api, /getImplementation = \(\) => getJson<ImplementationResponse>\("\/api\/implementation", IMPLEMENTATION_DEADLINE_MS\)/);
  assert.doesNotMatch(app, /window\.location\.reload/);

  assert.doesNotMatch(app, /activeCount\s*=.*pendingReplies\(\)/);
  assert.match(app, /activeNotes: activeNoteCount\(\)/);
  assert.match(app, /base: fileBaseRevision\(entry\)/);
  assert.match(app, /head: entry\.stage\.headRevision/);
  assert.match(app, /cancelLazyJump\(\);\s+state\.notesOpen = false/);
  assert.match(app, /function resumePendingLazyJump\(\)/);
  assert.equal(app.match(/const activeCount = activeNoteCount\(\);/g)?.length, 1);
  assert.match(
    app,
    /t\.target\.nodeId === id && t\.target\.stageId === stageId/,
  );
  // The page renders through lit templates and builds no markup strings.
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(styles, /\.drow > code \{/);
  assert.doesNotMatch(styles, /\.drow code \{/);
});

test("feedback target stays present when it leaves the current stage diff", (t) => {
  const { repository, commits } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "moved-to-earlier-stage",
    "--comment-id",
    "moved-to-earlier-stage-comment",
    "--body",
    "Move this change to an earlier stage.",
    "--label",
    "implementation.txt",
    "--target-kind",
    "file",
    "--stage",
    "implementation",
    "--path",
    "implementation.txt",
  );

  const newHead = repository.commitFile(
    "README.md",
    "Updated test repository\n",
    "Update unrelated stage file",
  );
  // implementation.txt moves below the stage: the stack is now based on the
  // commit that adds it.
  const stagePath = "stages/implementation.json";
  const stage = repository.artifact.readJson(stagePath);
  stage.nodes[0].changes = [
    {
      path: "README.md",
      classification: "behavior",
    },
  ];
  repository.artifact.write(stagePath, stage);
  recordStageHead(repository, "implementation", newHead, commits.get("implementation"));

  const script = createImplementationDataScript(repository.root);
  const data = implementationFromScript(script);
  assert.deepEqual(data.feedback[0].targetState, { state: "present" });
  assert.deepEqual(
    data.stages[0].files.map((file) => file.path),
    ["README.md"],
  );
});

test("readFeedbackThread reloads one thread without rebuilding implementation data", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "fast-status",
    "--comment-id",
    "fast-status-comment",
    "--body",
    "Resolve this quickly.",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );

  assert.equal(
    readFeedbackThread(repository.root, "fast-status").status,
    "open",
  );
  repository.feedback("thread", "resolve", "--id", "fast-status");
  assert.equal(
    readFeedbackThread(repository.root, "fast-status").status,
    "resolved",
  );
  assert.equal(readFeedbackThread(repository.root, "missing"), null);
});


test("viewer and CLI feedback share one review across worktrees and isolate repositories with identical implementation IDs", (t) => {
  const { repository: first } = createImplementationWithStages(t);
  const { repository: otherRepo } = createImplementationWithStages(t);
  const linked = first.root + "-linked";
  first.git("worktree", "add", "--detach", linked, "HEAD");
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  // The linked worktree sees the same artifact, and so the same review, as first.root.
  const roots = [first.root, linked, otherRepo.root];
  const ids = roots.map((repoRoot) => {
    const result = exportFeedback({ repoRoot, implementation: buildFeedbackTargetData(repoRoot) },
      [{ kind: "stage", id: "implementation", body: "Same message", clientId: "same-client" }]);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(repoRoot, ".semantic-review-feedback")), false);
    return result.exported[0].threadId;
  });
  assert.equal(feedbackDirectory(linked), feedbackDirectory(first.root));
  assert.notEqual(feedbackDirectory(otherRepo.root), feedbackDirectory(first.root));
  assert.equal(new Set(ids).size, 1); // Same IDs remain isolated by review identity.
  const before = fs.readFileSync(path.join(path.dirname(feedbackDirectory(linked)), "review.json"), "utf8");
  const replies = exportFeedbackReplies({ repoRoot: linked }, [{ threadId: ids[1], ref: "reply", body: "Seen from every worktree" }]);
  assert.equal(replies.ok, true);
  assert.deepEqual(roots.map((root, i) => readFeedbackThread(root, ids[i]).comments.length), [2, 2, 1]);
  // A worktree is selected for the implementation it has claimed.
  rememberImplementation(linked, "test-implementation");
  const inspection = JSON.parse(execFileSync(process.execPath, [flowCli, "inspect", "--project", linked, "--json"], { cwd: first.root, encoding: "utf8" }));
  assert.equal(inspection.selected.feedbackDirectory, feedbackDirectory(first.root));
  assert.notEqual(fs.readFileSync(path.join(path.dirname(feedbackDirectory(linked)), "review.json"), "utf8"), before);
});

test("a moved worktree keeps its review and feedback, and commands record the new location", (t) => {
  const { repository } = createImplementationWithStages(t);
  const linked = fs.realpathSync(path.dirname(repository.root)) + path.sep + path.basename(repository.root) + "-linked";
  const moved = linked + "-moved";
  repository.git("worktree", "add", "--detach", linked, "HEAD");
  t.after(() => { for (const directory of [linked, moved]) fs.rmSync(directory, { recursive: true, force: true }); });
  const feedback = (cwd, ...args) => execFileSync(process.execPath, [...feedbackCli, ...args], { cwd, encoding: "utf8" });
  feedback(linked, "init");
  const id = reviewId(linked, "test-implementation"), registered = readReview(id);
  assert.equal(registered.repositoryRoot, linked);
  const thread = exportFeedback({ repoRoot: linked, implementation: buildFeedbackTargetData(linked) },
    [{ kind: "stage", id: "implementation", body: "Unanswered", clientId: "moved" }]).exported[0].threadId;
  // A command from another working worktree leaves the recorded location alone.
  feedback(repository.root, "validate");
  assert.equal(readReview(id).repositoryRoot, linked);
  repository.git("worktree", "move", linked, moved);
  assert.equal(registeredReviews().find((entry) => entry.id === id).available, false);
  feedback(moved, "validate");
  const relocated = readReview(id);
  assert.equal(relocated.repositoryRoot, moved);
  assert.equal(relocated.generation, registered.generation);
  assert.equal(relocated.gitCommonDir, fs.realpathSync(repository.path(".git")));
  assert.equal(reviewId(moved, "test-implementation"), id);
  assert.equal(readFeedbackThread(moved, thread).comments.length, 1);
  assert.equal(registeredReviews().find((entry) => entry.id === id).available, true);
});

test("concurrent first submissions initialize shared feedback once and deduplicate retries", async (t) => {
  const { repository } = createImplementationWithStages(t);
  const source = `import { exportFeedback, buildFeedbackTargetData } from ${JSON.stringify(moduleUrl)};
    const repoRoot = process.argv[1];
    const result = exportFeedback({ repoRoot, implementation: buildFeedbackTargetData(repoRoot) }, [{ kind: "stage", id: "implementation", body: "Concurrent message", clientId: "retry" }]);
    console.log(JSON.stringify(result));`;
  const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, [...sourceLoader, "--input-type=module", "-e", source, repository.root])));
  for (const result of results) assert.equal(JSON.parse(result.stdout).ok, true);
  const manifest = repository.readAbsoluteJson(repository.feedbackPath("manifest.json"));
  assert.equal(manifest.threads.length, 1);
  assert.equal(readFeedbackThread(repository.root, manifest.threads[0]).comments.length, 1);
});


test("snapshot reads reject an implementation switch instead of changing feedback stores", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  // While the snapshot reads feedback, another implementation replaces the active one.
  const active = "refs/semantic-review/active/test-implementation";
  const commit = repository.git("rev-parse", active);
  const manifestPath = repository.feedbackPath("manifest.json");
  const originalRead = fs.readFileSync;
  let switched = false;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === manifestPath && !switched) {
      switched = true;
      repository.git("update-ref", "refs/semantic-review/active/replacement", commit);
      repository.git("update-ref", "-d", active);
    }
    return originalRead(file, ...args);
  });
  assert.throws(() => viewerSnapshot(repository.root), /active implementation changed/);
  assert.equal(switched, true);
});


test("viewer release version is independent of artifact creation metadata", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const manifest = repository.artifact.readJson("manifest.json");
  const source = createViewerDataSource(repository.root);
  const data = () => implementationFromScript(source.implementationDataScript());
  manifest.skillVersion = "0.2.0";
  repository.artifact.write("manifest.json", manifest);
  // This test loads the viewer from source, which has no installed VERSION file.
  // The workflow helper tests check the served bundle reports the built version.
  const runningVersion = "unversioned";
  assert.equal(data().skillVersion, "0.2.0");
  assert.equal(data().viewerReleaseVersion, runningVersion);
  assert.equal(repository.artifact.readJson("manifest.json").skillVersion, "0.2.0");
  delete manifest.skillVersion;
  repository.artifact.write("manifest.json", manifest);
  assert.equal(data().skillVersion, null);
  assert.equal(data().viewerReleaseVersion, runningVersion);
  assert.equal("skillVersion" in repository.artifact.readJson("manifest.json"), false);
});

test("repeated files compare with their last stage across gaps and renames", async (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  const first = repository.commitFile('repeat.txt', 'first\nstable\n', 'First occurrence');
  organizeStage(repository);
  repository.semantic('stage', 'finish');
  const gap = repository.commitFile('other.txt', 'other\n', 'Intervening file');
  const second = repository.commitFile('repeat.txt', 'second\nstable\n', 'Second occurrence');
  repository.git('mv', 'repeat.txt', 'renamed.txt');
  repository.git('commit', '-m', 'Rename file');
  const renamed = repository.git('rev-parse', 'HEAD');
  const last = repository.commitFile('renamed.txt', 'third\nstable\n', 'Update renamed file');
  seedStages(repository, [
    ['first', first, ['repeat.txt']],
    ['gap', gap, ['other.txt']],
    ['second', second, ['repeat.txt']],
    ['rename', renamed, ['renamed.txt']],
    ['last', last, ['renamed.txt']],
  ]);
  const source = createViewerDataSource(repository.root);
  const data = implementationFromScript(source.implementationDataScript());
  const stage = data.stages[2], file = stage.files[0];
  assert.deepEqual(stage.files.map((entry) => entry.path), ['repeat.txt']);
  assert.equal(file.baseRevision, first);
  assert.equal(file.previousStageId, 'first');
  assert.equal(file.kind, 'modified');
  assert.equal(file.additions, 1); assert.equal(file.deletions, 1);
  for (const mode of ['changes', 'full']) {
    const diff = await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, mode);
    assert.deepEqual(diff.lines.filter((line) => line.t !== 'ctx').map((line) => line.s), ['first', 'second']);
  }
  // The feedback targets and a draft saved before drafts held the file's
  // revision, compared from the stage's own base, give the file's revision.
  assert.equal(buildFeedbackTargetData(repository.root).stages[2].files[0].revision, file.revision);
  const legacy = { kind: 'line', id: `l:${stage.id}:new:1:repeat.txt`, body: 'Check this line', snapshot: { base: file.baseRevision, head: stage.headRevision } };
  assert.equal(resolveLineDraftSnapshots(repository.root, [legacy])[0].snapshot.fileRevision, file.revision);
  const renameFile = data.stages[3].files[0], lastFile = data.stages[4].files[0];
  assert.equal(renameFile.baseRevision, second); assert.equal(renameFile.previousPath, 'repeat.txt');
  assert.equal(lastFile.baseRevision, renamed); assert.equal(lastFile.previousPath, undefined);
  assert.equal(lastFile.kind, 'modified');
  const diff = await source.fileDiff('last', lastFile.path, lastFile.baseRevision, last);
  assert.deepEqual(diff.lines.filter((line) => line.t !== 'ctx').map((line) => line.s), ['second', 'third']);
});

test("a rename follows its source history when the destination was previously deleted", async (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  const first = repository.commitFile('source.txt', 'original\nstable one\nstable two\nstable three\n', 'Add source');
  organizeStage(repository);
  repository.semantic('stage', 'finish');
  const destination = repository.commitFile('destination.txt', 'unrelated\n', 'Old destination');
  repository.git('rm', 'destination.txt'); repository.git('commit', '-m', 'Delete destination');
  const deleted = repository.git('rev-parse', 'HEAD');
  const updated = repository.commitFile('source.txt', 'updated\nstable one\nstable two\nstable three\n', 'Update source');
  repository.git('mv', 'source.txt', 'destination.txt'); repository.git('commit', '-m', 'Rename source');
  const renamed = repository.git('rev-parse', 'HEAD');
  seedStages(repository, [
    ['source', first, ['source.txt']],
    ['destination', destination, ['destination.txt']],
    ['delete', deleted, ['destination.txt']],
    ['update', updated, ['source.txt']],
    ['rename', renamed, ['destination.txt']],
  ]);
  assert.deepEqual(repository.artifact.stage('rename').change.files, [{ path: 'destination.txt', kind: 'renamed', previousPath: 'source.txt' }]);
  const source = createViewerDataSource(repository.root);
  const data = implementationFromScript(source.implementationDataScript());
  const file = data.stages.at(-1).files[0];
  assert.equal(file.baseRevision, updated);
  assert.equal(file.previousStageId, 'update');
  assert.equal(file.previousPath, 'source.txt');
  assert.equal(file.additions, 0); assert.equal(file.deletions, 0);
  const diff = await source.fileDiff('rename', file.path, file.baseRevision, renamed);
  assert.deepEqual(diff.lines, []);
});


const twentyLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`);
const editedLines = twentyLines.map((line, index) => index < 6 ? `edited ${index + 1}\n` : line).join("");

/** Seeds the stages of `changes` on a repository holding the given files;
 * each change commits its stage's change and returns the paths it changed. */
function seededStages(t, files, changes) {
  const repository = createRepository(t);
  for (const [file, contents] of Object.entries(files)) repository.commitFile(file, contents, `Add ${file}`);
  initializeImplementation(repository);
  const [[firstId, first], ...rest] = Object.entries(changes);
  beginStage(repository);
  const firstPaths = first(repository);
  organizeStage(repository);
  repository.semantic("stage", "finish");
  const stages = [[firstId, repository.git("rev-parse", "HEAD"), firstPaths], ...rest.map(([id, change]) => {
    const paths = change(repository);
    return [id, repository.git("rev-parse", "HEAD"), paths];
  })];
  seedStages(repository, stages);
  repository.feedback("init");
  return repository;
}

const removeFile = (file) => (repository) => {
  repository.git("rm", "--quiet", file);
  repository.git("commit", "-m", `Remove ${file}`);
  return [file];
};
const writeFile = (file, contents) => (repository) => {
  repository.commitFile(file, contents, `Write ${file}`);
  return [file];
};

/** The changed rows of a diff page, removed lines with "-" and added with "+". */
const changedRows = (diff) => diff.lines.filter((line) => line.t !== "ctx").map((line) => `${line.t === "add" ? "+" : "-"}${line.s}`);

const renamedLines = twentyLines.map((line, index) => index === 0 ? "edited 1\n" : index === 19 ? "line twenty\n" : line).join("");

// Diffed from the head of the last stage that changed a.txt, the whole tree
// also holds what the stage in between added or deleted, and Git paired b.txt
// with that instead of a.txt. In the last case, a diff of the paths a.txt and
// b.txt alone also selects the file below the directory b.txt, which the last
// stage moves away.
for (const [between, files, change, alsoMove = []] of [
  ["deletes a similar file", { "c.txt": twentyLines.map((line, index) => index === 15 ? "C-only line sixteen\n" : line).join("") }, removeFile("c.txt")],
  ["adds a copy", {}, writeFile("copy.txt", editedLines)],
  ["deletes the file at the new path", { "b.txt": "an unrelated file\n" }, removeFile("b.txt")],
  ["adds a similar file below a directory of the new path", {}, writeFile("b.txt/x.txt", renamedLines.replace("line twenty", "line 20")), ["b.txt/x.txt", "x.txt"]],
]) test(`a renamed file is compared with the file it was renamed from when a stage in between ${between}`, async (t) => {
  const repository = seededStages(t, { "a.txt": twentyLines.join(""), ...files }, {
    first: writeFile("a.txt", editedLines),
    between: change,
    last: (repository) => {
      if (alsoMove.length) {
        repository.git("mv", ...alsoMove);
        fs.rmSync(path.join(repository.root, path.dirname(alsoMove[0])), { recursive: true });
      }
      repository.git("mv", "a.txt", "b.txt");
      // Most of the first stage's edit is undone, so b.txt is less like a.txt there.
      return [...alsoMove.slice(1), ...writeFile("b.txt", renamedLines)(repository)];
    },
  });
  assert.deepEqual(repository.artifact.stage("last").change.files.find((item) => item.path === "b.txt"), { path: "b.txt", kind: "renamed", previousPath: "a.txt" });
  const source = createViewerDataSource(repository.root);
  const stages = implementationFromScript(source.implementationDataScript()).stages;
  const stage = stages.find((item) => item.id === "last");
  const file = stage.files.find((item) => item.path === "b.txt");
  const { kind, previousPath, previousStageId, baseRevision, additions, deletions } = file;
  assert.deepEqual({ kind, previousPath, previousStageId, baseRevision, additions, deletions },
    { kind: "renamed", previousPath: "a.txt", previousStageId: "first", baseRevision: stages[0].headRevision, additions: 6, deletions: 6 });
  const expected = [2, 3, 4, 5, 6].map((line) => `-edited ${line}`).concat([2, 3, 4, 5, 6].map((line) => `+line ${line}`), ["-line 20", "+line twenty"]);
  for (const mode of ["changes", "full"]) {
    assert.deepEqual(changedRows(await source.fileDiff("last", "b.txt", file.baseRevision, stage.headRevision, mode)), expected, mode);
  }
  const implementation = buildFeedbackTargetData(repository.root);
  assert.equal(implementation.stages.find((item) => item.id === "last").files.find((item) => item.path === "b.txt").revision, file.revision);
  const snapshot = { base: file.baseRevision, head: stage.headRevision };
  const note = (side, line, fileRevision) => ({ kind: "line", id: `l:last:${side}:${line}:b.txt`, body: `About ${side} line ${line}.`, clientId: `${side}-${line}`,
    snapshot: fileRevision === undefined ? snapshot : { ...snapshot, fileRevision } });
  const result = exportFeedback({ repoRoot: repository.root, implementation }, [note("old", 2, file.revision), note("new", 20, file.revision)]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exported.length, 2);
  // A draft saved before drafts held the file's revision was written where the
  // file was shown compared with another file, so its line cannot be trusted.
  const legacy = exportFeedback({ repoRoot: repository.root, implementation }, [note("old", 20)]);
  assert.equal(legacy.ok, false);
  assert.match(legacy.skipped[0].reason, /file changed since this line draft was written/);
});

test("the full view of a file renamed below a directory of its old path shows the rename", async (t) => {
  const repository = seededStages(t, { "a.txt": twentyLines.join("") }, {
    first: (repository) => {
      repository.git("mv", "a.txt", "moved");
      fs.mkdirSync(path.join(repository.root, "a.txt"));
      repository.git("mv", "moved", "a.txt/b.txt");
      return writeFile("a.txt/b.txt", twentyLines.join("").replace("line 20\n", "line twenty\n"))(repository);
    },
  });
  const source = createViewerDataSource(repository.root);
  const stage = implementationFromScript(source.implementationDataScript()).stages[0];
  const [file] = stage.files;
  assert.deepEqual([file.path, file.kind, file.previousPath], ["a.txt/b.txt", "renamed", "a.txt"]);
  for (const mode of ["changes", "full"]) {
    assert.deepEqual(changedRows(await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, mode)), ["-line 20", "+line twenty"], mode);
  }
});

test("the full view of a file renamed out of a directory of its new path compares it with its own source", async (t) => {
  const renamed = twentyLines.join("").replace("line 20\n", "line twenty\n");
  // c.txt is more like the new a.txt than b.txt is, and leaves for outside.txt.
  const repository = seededStages(t, {
    "a.txt/b.txt": twentyLines.join("").replace("line 19\n", "line 19 old\n"),
    "a.txt/c.txt": renamed.replace("line 1\n", "first\n"),
  }, {
    first: (repository) => {
      repository.git("mv", "a.txt/c.txt", "outside.txt");
      repository.git("mv", "a.txt/b.txt", "moved");
      fs.rmSync(path.join(repository.root, "a.txt"), { recursive: true });
      repository.git("mv", "moved", "a.txt");
      return [...writeFile("a.txt", renamed)(repository), "outside.txt"];
    },
  });
  const source = createViewerDataSource(repository.root);
  const stage = implementationFromScript(source.implementationDataScript()).stages[0];
  const file = stage.files.find((item) => item.path === "a.txt");
  assert.deepEqual([file.kind, file.previousPath], ["renamed", "a.txt/b.txt"]);
  for (const mode of ["changes", "full"]) {
    assert.deepEqual(changedRows(await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, mode)),
      ["-line 19 old", "-line 20", "+line 19", "+line twenty"], mode);
  }
});

test("a file added again is not compared with a similar file a stage in between deleted", async (t) => {
  const similar = twentyLines.map((line, index) => index === 0 ? "first\n" : line).join("");
  const repository = seededStages(t, { "p.txt": "an unrelated file\n", "q.txt": similar }, {
    first: removeFile("p.txt"),
    between: removeFile("q.txt"),
    last: writeFile("p.txt", similar.replace("line 20\n", "line twenty\n")),
  });
  const source = createViewerDataSource(repository.root);
  const stage = implementationFromScript(source.implementationDataScript()).stages.find((item) => item.id === "last");
  const [file] = stage.files;
  const { kind, previousPath, previousStageId, additions, deletions } = file;
  assert.deepEqual({ kind, previousPath, previousStageId, additions, deletions }, { kind: "added", previousPath: undefined, previousStageId: "first", additions: 20, deletions: 0 });
  const diff = await source.fileDiff("last", "p.txt", file.baseRevision, stage.headRevision);
  assert.equal(changedRows(diff).length, 20);
  assert.ok(changedRows(diff).every((row) => row.startsWith("+")));
  assert.equal(buildFeedbackTargetData(repository.root).stages.find((item) => item.id === "last").files[0].revision, file.revision);
});

test("file revisions detect base and head mode changes without blob changes", (t) => {
  const repository = createRepository(t);
  repository.git('config', 'core.filemode', 'false');
  repository.commitFile('code.txt', 'base\n', 'Base content');
  initializeImplementation(repository); beginStage(repository);
  repository.commitFile('code.txt', 'head\n', 'Head content');
  organizeStage(repository); repository.semantic('stage', 'finish');
  const stage = repository.artifact.stage('implementation');
  const source = createViewerDataSource(repository.root);
  const revision = () => implementationFromScript(source.implementationDataScript()).stages[0].files[0].revision;
  const original = revision(), branch = repository.git('branch', '--show-current');
  const baseBlob = repository.git('rev-parse', `${stage.change.baseRevision}:code.txt`);
  repository.git('switch', 'main'); repository.git('update-index', '--chmod=+x', 'code.txt');
  repository.git('commit', '-m', 'Executable base');
  const executableBase = repository.git('rev-parse', 'HEAD');
  assert.equal(repository.git('rev-parse', 'HEAD:code.txt'), baseBlob);
  repository.git('switch', branch); recordStageHead(repository, 'implementation', stage.change.headRevision, executableBase);
  const baseChanged = revision(); assert.notEqual(baseChanged, original);
  const headBlob = repository.git('rev-parse', 'HEAD:code.txt');
  repository.git('update-index', '--chmod=+x', 'code.txt'); repository.git('commit', '-m', 'Executable head');
  recordStageHead(repository, 'implementation', repository.git('rev-parse', 'HEAD'));
  assert.equal(repository.git('rev-parse', 'HEAD:code.txt'), headBlob);
  assert.notEqual(revision(), baseChanged);
});

test("line drafts survive unrelated restacks and reject actual file changes", (t) => {
  const { repository } = createImplementationWithStages(t);
  const original = buildFeedbackTargetData(repository.root).stages[0];
  const snapshot = { base: original.baseRevision, head: original.headRevision };
  const legacy = { kind: 'line', id: 'l:implementation:new:1:implementation.txt', body: 'Check this line', snapshot };
  const modern = { ...legacy, snapshot: { ...snapshot, fileRevision: original.files[0].revision } };
  const branch = repository.git('branch', '--show-current');
  repository.git('switch', 'main');
  const base = repository.commitFile('unrelated.txt', 'unrelated\n', 'Unrelated lower change');
  repository.git('switch', branch); repository.git('rebase', 'main');
  recordStageHead(repository, 'implementation', repository.git('rev-parse', 'HEAD'), base);
  const current = buildFeedbackTargetData(repository.root);
  const migrated = resolveLineDraftSnapshots(repository.root, [legacy])[0];
  assert.deepEqual(migrated.snapshot, modern.snapshot, 'migration preserves the original commit anchor');
  assert.equal(planFeedbackThreads([modern, migrated], current).planned.length, 2);
  const result = exportFeedback({ repoRoot: repository.root, implementation: current }, [legacy, modern]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.exported.length, 2);
  const thread = readFeedbackThread(repository.root, result.exported[0].threadId);
  assert.equal(thread.target.kind, 'line'); assert.equal(thread.target.path, 'implementation.txt');
  recordStageHead(repository, 'implementation', repository.commitFile('implementation.txt', 'changed\n', 'Change the commented file'));
  const rejected = exportFeedback({ repoRoot: repository.root, implementation: buildFeedbackTargetData(repository.root) }, [legacy, modern]);
  assert.equal(rejected.ok, false); assert.equal(rejected.skipped.length, 2);
  assert.match(rejected.skipped[0].reason, /file changed/);
  const unavailable = { ...legacy, snapshot: { ...snapshot, head: 'f'.repeat(40) } };
  assert.deepEqual(resolveLineDraftSnapshots(repository.root, [unavailable]), [unavailable]);
  assert.equal(planFeedbackThreads([unavailable], current).planned.length, 0);
});

for (const kind of ['modified', 'deleted', 'renamed']) test(`legacy line snapshots retain ${kind} file identities`, (t) => {
  const repository = createRepository(t);
  repository.commitFile('old name.txt', 'one\ntwo\nthree\n', 'Original');
  initializeImplementation(repository); beginStage(repository);
  if (kind === 'modified') repository.write('old name.txt', 'one\ntwo\nchanged\n');
  if (kind === 'deleted') repository.git('rm', 'old name.txt');
  if (kind === 'renamed') repository.git('mv', 'old name.txt', 'new name.txt');
  repository.git('add', '.'); repository.git('commit', '-m', 'Stage change');
  organizeStage(repository); repository.semantic('stage', 'finish');
  const stage = buildFeedbackTargetData(repository.root).stages[0];
  const note = { kind: 'line', id: `l:implementation:old:1:${stage.files[0].path}`, snapshot: { base: stage.baseRevision, head: stage.headRevision } };
  assert.equal(resolveLineDraftSnapshots(repository.root, [note])[0].snapshot.fileRevision, stage.files[0].revision);
});

test("a feedback thread that fails its schema does not hide the other threads", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  for (const id of ["valid", "damaged"]) {
    repository.feedback("thread", "add", "--id", id, "--comment-id", `${id}-comment`, "--body", "Check this.",
      "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
  }
  const file = repository.feedbackPath("threads", "damaged.json");
  const original = repository.readAbsoluteJson(file);
  repository.writeAbsolute(file, JSON.stringify({ ...original, createdAt: "not a date" }));
  const implementationData = () => implementationFromScript(createImplementationDataScript(repository.root));

  const data = implementationData();
  assert.deepEqual(data.feedback.map((thread) => thread.id), ["valid"]);
  assert.equal(data.awaitingAgentReplies, 1);
  assert.equal(data.stages.length, 1);

  // A duplicate key is a strict-validation error; the viewer reads the thread as before.
  const text = JSON.stringify(original);
  repository.writeAbsolute(file, `{"createdAt":"not a date",${text.slice(1)}`);
  const repaired = implementationData();
  assert.deepEqual(repaired.feedback.map((thread) => thread.id), ["valid", "damaged"]);
  assert.equal(repaired.awaitingAgentReplies, 2);
});

test("a missing or truncated feedback thread does not take down the viewer and is noticed once restored", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  for (const id of ["valid", "damaged"]) {
    repository.feedback("thread", "add", "--id", id, "--comment-id", `${id}-comment`, "--body", "Check this.",
      "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
  }
  const file = repository.feedbackPath("threads", "damaged.json");
  const original = fs.readFileSync(file, "utf8");
  const dataSource = createViewerDataSource(repository.root);
  const implementationData = () => implementationFromScript(dataSource.implementationDataScript());
  const reader = createSnapshotReader(repository.root);
  const snapshots = () => {
    const [polled, read] = [viewerSnapshot(repository.root), reader()];
    assert.equal(polled.awaitingAgentReplies, read.awaitingAgentReplies);
    return { polled, read };
  };
  const healthy = snapshots();
  assert.equal(healthy.polled.awaitingAgentReplies, 2);

  for (const damage of [() => repository.writeAbsolute(file, "{"), () => fs.rmSync(file)]) {
    damage();
    const data = implementationData();
    assert.deepEqual(data.feedback.map((thread) => thread.id), ["valid"]);
    assert.equal(data.awaitingAgentReplies, 1);
    assert.equal(data.stages.length, 1);
    const damaged = snapshots();
    assert.equal(damaged.polled.awaitingAgentReplies, 1);
    assert.notEqual(damaged.polled.revision, healthy.polled.revision);
    assert.notEqual(damaged.read.revision, healthy.read.revision);

    repository.writeAbsolute(file, original);
    const restored = snapshots();
    assert.equal(restored.polled.revision, healthy.polled.revision);
    assert.equal(restored.read.revision, healthy.read.revision);
    assert.deepEqual(implementationData().feedback.map((thread) => thread.id), ["valid", "damaged"]);
  }
});

test("viewer snapshots skip listed thread IDs that are not feedback IDs", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "valid", "--comment-id", "valid-comment", "--body", "Check this.",
    "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
  // A thread outside the threads directory, reachable only through a path in the ID.
  fs.copyFileSync(repository.feedbackPath("threads", "valid.json"), repository.feedbackPath("outside.json"));
  const manifestFile = repository.feedbackPath("manifest.json");
  const manifest = repository.readAbsoluteJson(manifestFile);
  repository.writeAbsolute(manifestFile, JSON.stringify({ ...manifest, threads: ["valid", "../outside", "../missing", "Valid"] }));

  assert.equal(viewerSnapshot(repository.root).awaitingAgentReplies, 1);
  assert.equal(createSnapshotReader(repository.root)().awaitingAgentReplies, 1);
});

test("stored __proto__ keys stay ordinary data on the viewer page", (t) => {
  const { repository } = createImplementationWithStages(t);
  const [specificationId] = repository.artifact.readJson("manifest.json").requirements;
  const specificationPath = `requirements/${specificationId}.json`;
  const specification = repository.artifact.readJson(specificationPath);
  // In a JavaScript object literal this key would set the prototype, so the page would inherit a reference it cannot render.
  repository.artifact.write(specificationPath, JSON.stringify({ ...specification, source: { kind: "local", nested: { kept: false }, url: 1 } })
    .replace('"kind":"local"', '"kind":"local","__proto__":{"reference":{"toString":1}}'));
  const stagePath = "stages/implementation.json";
  const stage = repository.artifact.readJson(stagePath);
  repository.artifact.write(stagePath, JSON.stringify({ ...stage, summary: "</script><script>", nodes: stage.nodes.map((node, index) => index ? node : { ...node, description: "PLACEHOLDER" }) })
    .replace('"PLACEHOLDER"', '{"__proto__":{"inherited":true},"text":"</script><script>"}'));
  const script = createViewerDataSource(repository.root).implementationDataScript();
  assert.doesNotMatch(script, /<\/script/i);

  const data = implementationFromScript(script);
  // Display values are narrowed to the wire types; nothing is inherited from a stored __proto__ key.
  const [source] = data.requirements.map((requirement) => requirement.source);
  assert.deepEqual(source, { kind: "local", reference: "" });
  assert.equal(Object.getPrototypeOf(source), Object.prototype);
  assert.ok(Object.hasOwn(source, "reference"));
  const { description } = data.stages[0].nodes[0];
  assert.equal(description, "");
  assert.equal(data.stages[0].summary, "</script><script>");
  assert.equal({}.inherited, undefined);
});

test("a thread removed while a snapshot reads it does not fail the poll", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  for (const id of ["valid", "removed"]) {
    repository.feedback("thread", "add", "--id", id, "--comment-id", `${id}-comment`, "--body", "Check this.",
      "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
  }
  const file = repository.feedbackPath("threads", "removed.json");
  const original = fs.readFileSync(file, "utf8");
  const healthyPoll = viewerSnapshot(repository.root);

  // The cached reader finds the file by its stat, then it disappears before the read.
  let removeOnRead = false;
  const reader = createSnapshotReader(repository.root, { readFile: (target) => {
    if (removeOnRead && target === file) fs.rmSync(file);
    return fs.readFileSync(target, "utf8");
  } });
  const healthy = reader(true);
  removeOnRead = true;
  const removed = reader(true);
  removeOnRead = false;
  const missing = createSnapshotReader(repository.root)();
  assert.equal(removed.revision, missing.revision);
  assert.notEqual(removed.revision, healthy.revision);
  assert.equal(removed.awaitingAgentReplies, 1);
  repository.writeAbsolute(file, original);
  assert.equal(reader(true).revision, healthy.revision);

  // The uncached reader hashes the bytes it counted, even when the file disappears right after.
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    const result = read(target, ...args);
    if (String(target) === file) fs.rmSync(file);
    return result;
  });
  const polled = viewerSnapshot(repository.root);
  t.mock.restoreAll();
  assert.deepEqual(polled, healthyPoll);
  assert.notEqual(viewerSnapshot(repository.root).revision, healthyPoll.revision);
});

test("mapNoteTarget keeps carriage returns and line feeds in file and line paths", () => {
  const filePath = "src/a\r\nb\n.js";
  assert.deepEqual(mapNoteTarget({ kind: "file", id: `f:implementation:${filePath}` }, implementation),
    { "target-kind": "file", stage: "implementation", path: filePath, label: filePath });
  assert.deepEqual(mapNoteTarget({ kind: "line", id: `l:implementation:old:3:${filePath}` }, implementation),
    { "target-kind": "line", stage: "implementation", path: filePath, side: "old", line: 3, label: `${filePath}:3` });
  assert.deepEqual(mapNoteTarget({ kind: "file", id: "f:implementation:\r\n" }, implementation),
    { "target-kind": "file", stage: "implementation", path: "\r\n", label: '"\\r\\n"' });
});

// Windows forbids line breaks in file names.
test("file and line feedback on paths with line breaks is sent and its line snapshot resolves", { skip: process.platform === "win32" }, (t) => {
  const repository = createRepository(t);
  const name = "line\nbreak\r.txt";
  repository.commitFile(name, "one\ntwo\n", "Original");
  initializeImplementation(repository); beginStage(repository);
  repository.write(name, "one\nchanged\n");
  repository.git("add", "."); repository.git("commit", "-m", "Stage change");
  organizeStage(repository, { nodes: [{ id: "implementation-change", description: "Change the file.", changes: [{ path: name, classification: "behavior" }] }] });
  repository.semantic("stage", "finish");
  const targets = buildFeedbackTargetData(repository.root);
  const stage = targets.stages[0];
  assert.equal(stage.files[0].path, name);
  const legacy = { kind: "line", id: `l:implementation:new:2:${name}`, body: "Check this line", snapshot: { base: stage.baseRevision, head: stage.headRevision } };
  assert.equal(resolveLineDraftSnapshots(repository.root, [legacy])[0].snapshot.fileRevision, stage.files[0].revision);
  const file = { kind: "file", id: `f:implementation:${name}`, body: "Check this file" };
  const result = exportFeedback({ repoRoot: repository.root, implementation: targets }, [legacy, file]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const [line, whole] = result.exported.map((item) => readFeedbackThread(repository.root, item.threadId).target);
  assert.deepEqual([line.kind, line.path, line.side, line.line], ["line", name, "new", 2]);
  assert.deepEqual([whole.kind, whole.path], ["file", name]);
});

test("the viewer lists and shows a stage's changes as its inventory does, whatever the user's Git configuration", async (t) => {
  const repository = submoduleAndRenamesStage(t);
  const { baseRevision: base, headRevision: head } = repository.artifact.stage("implementation").change;
  const commitOf = (revision) => `Subproject commit ${repository.git("rev-parse", `${revision}:sub`)}`;
  const changed = (lines) => lines.filter((line) => line.t !== "ctx").map(({ t, o, n, s }) => ({ t, o, n, s }));
  const shown = {
    "renamed-first.txt": [{ t: "add", o: undefined, n: 41, s: "edited" }],
    "renamed-second.txt": [
      { t: "del", o: 1, n: undefined, s: "second line 0" },
      { t: "add", o: undefined, n: 1, s: "changed" },
      { t: "add", o: undefined, n: 41, s: "edited" },
    ],
    sub: [{ t: "del", o: 1, n: undefined, s: commitOf(base) }, { t: "add", o: undefined, n: 1, s: commitOf(head) }],
    "third.txt": [{ t: "add", o: undefined, n: 41, s: "edited" }],
  };
  for (const group of Object.keys(HOSTILE_GIT)) {
    await withHostileGit(repository.root, group, async () => {
      const source = createViewerDataSource(repository.root);
      const stage = implementationFromScript(source.implementationDataScript()).stages[0];
      assert.deepEqual(stage.files.map(({ path, kind, previousPath, additions, deletions, binary }) => ({ path, kind, previousPath, additions, deletions, binary })), [
        { ...UPDATE_AND_RENAMES[0], additions: 1, deletions: 0, binary: false },
        { ...UPDATE_AND_RENAMES[1], additions: 2, deletions: 1, binary: false },
        { ...UPDATE_AND_RENAMES[2], previousPath: undefined, additions: 1, deletions: 1, binary: false },
        { ...UPDATE_AND_RENAMES[3], previousPath: undefined, additions: 1, deletions: 0, binary: false },
      ], group);
      // A small stage's patches, and a page of a file's whole content.
      for (const mode of ["changes", "full"]) {
        for (const file of stage.files) {
          const { lines } = await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, mode);
          assert.deepEqual(changed(lines), shown[file.path], `${group}, ${mode}: ${file.path}`);
          // The empty line before the last one is context, on both sides.
          if (file.path !== "sub") assert.ok(lines.some((line) => line.t === "ctx" && line.s === "" && line.o === 39 && line.n === 39), `${group}, ${mode}: ${file.path}`);
        }
      }
    });
  }
});

test("the viewer pages a file's own diff, not that of files below a directory of the same name", async (t) => {
  const repository = pathPrefixStage(t);
  organizeStage(repository, { nodes: [{ id: "implementation-change", description: "Replace files by folders.",
    changes: PATH_PREFIX_CHANGES.map(({ path }) => ({ path, classification: "behavior" })) }] });
  repository.semantic("stage", "finish");
  const source = createViewerDataSource(repository.root);
  const stage = implementationFromScript(source.implementationDataScript()).stages[0];
  const shown = async (filePath) => {
    const file = stage.files.find((item) => item.path === filePath);
    return (await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, "full")).lines.map(({ t, s }) => ({ t, s }));
  };
  assert.deepEqual(await shown("gone.txt"), "abcdefghij".split("").map((s) => ({ t: "del", s })));
  assert.deepEqual(await shown("old.txt/child.txt"), [{ t: "add", s: "child" }]);
});

test("the viewer shows changed lines that look like patch headers", async (t) => {
  const repository = createRepository(t);
  repository.commitFile("query.sql", "-- legacy\nselect 1;\n", "Add query");
  initializeImplementation(repository);
  beginStage(repository);
  repository.commitFile("query.sql", "++ new\nselect 1;\n", "Change query");
  organizeStage(repository);
  repository.semantic("stage", "finish");
  const source = createViewerDataSource(repository.root);
  const stage = implementationFromScript(source.implementationDataScript()).stages[0];
  const file = stage.files[0];
  for (const mode of ["changes", "full"]) {
    const { lines } = await source.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision, mode);
    assert.deepEqual(lines.map(({ t, o, n, s }) => ({ t, o, n, s })), [
      { t: "del", o: 1, n: undefined, s: "-- legacy" },
      { t: "add", o: undefined, n: 1, s: "++ new" },
      { t: "ctx", o: 2, n: 2, s: "select 1;" },
    ], mode);
  }
});
