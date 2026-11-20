import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  flowCli,
  implementationFromScript,
  initializeImplementation,
  organizeStage,
  scriptsDirectory,
  sourceLoader,
} from "../helpers/repository.mjs";
import { ArtifactDraft, commitArtifact, requireArtifact } from "../../src/shared/artifact-store.ts";

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

/** Copies the active artifact of one worktree into another through the store. */
function copyArtifact(from, to) {
  const snapshot = requireArtifact(from), draft = new ArtifactDraft(undefined);
  for (const file of snapshot.list()) draft.write(file, snapshot.read(file));
  commitArtifact(to, undefined, draft);
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
  const initialDiffCalls = calls.filter((args) => args.includes("diff")).length;
  assert.equal(initialDiffCalls, 1);
  assert.equal(dataSource.implementationDataScript(), firstScript);
  assert.equal(calls.filter((args) => args.includes("diff")).length, 1);

  assert.equal(
    (await dataSource.fileDiff(
      "implementation",
      "first.txt",
      stage.baseRevision,
      stage.headRevision,
    )).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff")).length, 3);
  assert.equal(
    (await dataSource.fileDiff(
      "implementation",
      "second.txt",
      stage.baseRevision,
      stage.headRevision,
    )).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff")).length, 3);
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
      if (args.includes("diff")) gitCalls++;
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
  const pageModules = fs.readdirSync(viewerSources, { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".ts") && name !== "api.ts" && name !== "markdown.ts").sort();
  assert.ok(pageModules.includes("app.ts"));
  const app = pageModules.map((name) => fs.readFileSync(new URL(name, viewerSources), "utf8")).join("\n");
  const styles = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "viewer", "styles.css"),
    "utf8",
  );
  assert.match(app, /api\.getRevision\(\)/);
  assert.match(api, /getRevision = \(\) => getJson<RevisionResponse>\("\/api\/revision"\)/);
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
  assert.match(api, /getImplementation = \(\) => getJson<ImplementationResponse>\("\/api\/implementation"\)/);
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


test("viewer and CLI feedback use the selected worktree across identical implementation IDs", (t) => {
  const { repository: first } = createImplementationWithStages(t);
  const { repository: otherRepo } = createImplementationWithStages(t);
  const linked = first.root + "-linked";
  first.git("worktree", "add", "--detach", linked, "HEAD");
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  copyArtifact(first.root, linked);
  const roots = [first.root, linked, otherRepo.root];
  const ids = roots.map((repoRoot) => {
    const result = exportFeedback({ repoRoot, implementation: buildFeedbackTargetData(repoRoot) },
      [{ kind: "stage", id: "implementation", body: "Same message", clientId: "same-client" }]);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(repoRoot, ".semantic-review-feedback")), false);
    return result.exported[0].threadId;
  });
  assert.equal(new Set(roots.map((root) => feedbackDirectory(root))).size, 3);
  assert.equal(new Set(ids).size, 1); // Same IDs remain isolated by review identity.
  const before = fs.readFileSync(path.join(path.dirname(feedbackDirectory(linked)), "review.json"), "utf8");
  const replies = exportFeedbackReplies({ repoRoot: linked }, [{ threadId: ids[1], ref: "reply", body: "Only in the linked worktree" }]);
  assert.equal(replies.ok, true);
  assert.deepEqual(roots.map((root, i) => readFeedbackThread(root, ids[i]).comments.length), [1, 2, 1]);
  const inspection = JSON.parse(execFileSync(process.execPath, [flowCli, "inspect", "--project", linked, "--json"], { cwd: first.root, encoding: "utf8" }));
  assert.equal(inspection.selected.feedbackDirectory, feedbackDirectory(linked));
  assert.notEqual(fs.readFileSync(path.join(path.dirname(feedbackDirectory(linked)), "review.json"), "utf8"), before);
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
  // The store reads the manifest from this file; the mock swaps its content between reads.
  const manifestPath = requireArtifact(repository.root).describe("manifest.json");
  const originalRead = fs.readFileSync;
  const initial = JSON.parse(originalRead(manifestPath, "utf8"));
  let reads = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === manifestPath) {
      reads++;
      return JSON.stringify({ ...initial, implementationId: reads === 1 ? initial.implementationId : "replacement" });
    }
    return originalRead(file, ...args);
  });
  assert.throws(() => viewerSnapshot(repository.root), /active implementation changed/);
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
