import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  feedbackCli,
  initializeImplementation,
  organizeStage,
  scriptsDirectory,
} from "../helpers/repository.mjs";

const moduleUrl = pathToFileURL(
  path.join(scriptsDirectory, "semantic-view.mjs"),
).href;
const {
  buildFeedbackTargetData,
  createImplementationDataScript,
  createViewerDataSource,
  exportFeedback,
  exportFeedbackReplies,
  planFeedbackThreads,
  mapNoteTarget,
  readFeedbackThread,
  viewerSnapshot,
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
  assert.equal("files" in targetData.stages[0], false);
});

test("viewer data preserves zero-context hunk ownership", (t) => {
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
  const data = JSON.parse(
    script.match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
  const stage = data.stages[0];
  const file = data.stages[0].files[0];
  const diff = dataSource.fileDiff(
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

test("viewer data caches metadata and batches lazy diffs by stage", (t) => {
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
  const stage = JSON.parse(
    firstScript.match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  ).stages[0];
  const initialDiffCalls = calls.filter((args) => args.includes("diff")).length;
  assert.equal(initialDiffCalls, 1);
  assert.equal(dataSource.implementationDataScript(), firstScript);
  assert.equal(calls.filter((args) => args.includes("diff")).length, 1);

  assert.equal(
    dataSource.fileDiff(
      "implementation",
      "first.txt",
      stage.baseRevision,
      stage.headRevision,
    ).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff")).length, 3);
  assert.equal(
    dataSource.fileDiff(
      "implementation",
      "second.txt",
      stage.baseRevision,
      stage.headRevision,
    ).additions,
    1,
  );
  assert.equal(calls.filter((args) => args.includes("diff")).length, 3);
});

test("lazy stage diff preserves renamed file content changes", (t) => {
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
  const data = JSON.parse(
    dataSource.implementationDataScript()
      .match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
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
  const diff = dataSource.fileDiff(
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
  const readData = () => JSON.parse(
    dataSource.implementationDataScript()
      .match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
  const initial = readData();
  const initialRevisions = new Map(
    initial.stages[0].files.map((file) => [file.path, file.revision]),
  );

  repository.write("second.txt", "second updated\n");
  repository.git("add", "second.txt");
  repository.git("commit", "-m", "Update second fixture");
  const stagePath = ".semantic-review/stages/implementation.json";
  const stage = repository.readJson(stagePath);
  stage.change.headRevision = repository.git("rev-parse", "HEAD");
  repository.write(stagePath, `${JSON.stringify(stage, null, 2)}\n`);

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

test("lazy diff stays bound to the metadata stage revision", (t) => {
  const { repository } = createImplementationWithStages(t);
  const dataSource = createViewerDataSource(repository.root);
  const initial = JSON.parse(
    dataSource.implementationDataScript()
      .match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
  const initialStage = initial.stages[0];

  repository.write("implementation.txt", "changed after viewer load\n");
  repository.git("add", "implementation.txt");
  repository.git("commit", "-m", "Advance stage after viewer load");
  const stagePath = ".semantic-review/stages/implementation.json";
  const currentStage = repository.readJson(stagePath);
  currentStage.change.headRevision = repository.git("rev-parse", "HEAD");
  repository.write(stagePath, `${JSON.stringify(currentStage, null, 2)}\n`);

  const diff = dataSource.fileDiff(
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

test("feedback export falls back per note when one batch item is stale", (t) => {
  const { repository } = createImplementationWithStages(t);
  const result = exportFeedback(
    {
      repoRoot: repository.root,
      implementation: buildFeedbackTargetData(repository.root),
      feedbackCli,
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
    { repoRoot: repository.root, feedbackCli },
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
    return JSON.parse(script.match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1]);
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

test("viewer client polls for completed feedback and reloads", () => {
  const app = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "viewer", "app.js"),
    "utf8",
  );
  const styles = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "viewer", "styles.css"),
    "utf8",
  );
  assert.match(app, /fetch\("\/api\/revision"/);
  assert.match(app, /fetch\(`\/api\/diff\?\$\{query\}`/);
  assert.match(app, /Loading diff…/);
  assert.match(app, /pendingDiffs\.forEach\(ensureFileDiff\)/);
  assert.match(app, /fetch\("\/api\/feedback\/reply-batch"/);
  assert.match(app, /observedAwaitingAgentReplies > 0 && awaiting === 0/);
  assert.match(app, /Boolean\(compose && compose\.dirty\)/);
  assert.match(app, /window\.confirm\(/);
  assert.doesNotMatch(app, /stableSince/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.doesNotMatch(app, /activeCount\s*=.*pendingReplies\(\)/);
  assert.match(app, /Notes <b>\$\{activeNoteCount\(\)\}<\/b>/);
  assert.match(app, /base: entry\.stage\.baseRevision/);
  assert.match(app, /head: entry\.stage\.headRevision/);
  assert.match(app, /pendingLazyJump = null;\s+state\.notesOpen = false/);
  assert.match(app, /function resumePendingLazyJump\(\)/);
  assert.equal(app.match(/const activeCount = activeNoteCount\(\);/g)?.length, 2);
  assert.match(
    app,
    /<div class="stage-approve">\$\{stageNoteCluster\(stage\.id\)\}\$\{approveBtn\("stage", stage\.id, "sm"\)\}<\/div>/,
  );
  assert.match(
    app,
    /<div class="note-cluster">\$\{notesToggle\("stage", id\)\}\$\{commentBtn\("stage", id\)\}<\/div>/,
  );
  assert.match(
    app,
    /t\.target\.nodeId === id && t\.target\.stageId === stageId/,
  );
  assert.match(
    app,
    /data-kind="\$\{kind\}" data-id="\$\{id\}" data-stage="\$\{stageId \|\| ""\}"/,
  );
  assert.match(
    app,
    /data-action="jump-to"[^>]*data-stage="\$\{esc\(ref\.stageId \|\| ""\)\}"/,
  );
  assert.match(styles, /\.drow > code \{/);
  assert.doesNotMatch(styles, /\.drow code \{/);
});

test("viewer client propagates legacy stale approvals before loading diffs", () => {
  const source = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "viewer", "app.js"),
    "utf8",
  );
  const app = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const classList = { toggle() {}, add() {}, remove() {} };
  const windowObject = {
    SEMANTIC_IMPLEMENTATION: {
      implementationId: "client-test",
      title: "Client test",
      summary: "Render metadata without loading diffs.",
      targetBranch: "main",
      baseRevision: "0123456789abcdef",
      requirements: [],
      stages: [{
        id: "implementation",
        title: "Implementation",
        summary: "Summary",
        rationale: "Rationale",
        dependsOn: [],
        specificationRefs: [],
        baseRevision: "base",
        headRevision: "head",
        nodes: [{
          id: "configure-settings",
          title: "Configure settings",
          description: "Update application settings.",
        }],
        files: [{
          path: "appsettings.json",
          kind: "modified",
          project: "Client",
          memberships: [{
            nodeId: "configure-settings",
            classification: "configuration",
          }],
          additions: 1,
          deletions: 0,
          binary: false,
          revision: "current-file-revision",
        }],
        insights: [],
      }],
      feedback: [{
        id: "resolved-stage-thread",
        status: "resolved",
        target: {
          kind: "stage",
          stageId: "implementation",
          label: "Implementation",
        },
        comments: [{
          id: "resolved-stage-comment",
          author: "user",
          body: "Resolved feedback.",
        }],
      }, {
        id: "resolved-node-thread",
        status: "resolved",
        target: {
          kind: "node",
          stageId: "implementation",
          nodeId: "configure-settings",
          label: "Configure settings",
        },
        comments: [{
          id: "resolved-node-comment",
          author: "user",
          body: "Resolved node feedback.",
        }],
      }],
      awaitingAgentReplies: 0,
    },
    addEventListener() {},
    matchMedia: () => ({ matches: true }),
    setInterval() {},
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
  };
  const documentObject = {
    querySelector: () => app,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList },
    documentElement: { style: {} },
  };
  const storage = {
    getItem: () => JSON.stringify({
      openThreads: { implementation: true, "configure-settings": true },
      approvals: {
        implementation: true,
        "f:implementation:appsettings.json": {
          fp: "legacy-diff-fingerprint",
          at: 1,
        },
      },
    }),
    setItem() {},
  };

  new Function(
    "window",
    "document",
    "localStorage",
    "CSS",
    "fetch",
    "requestAnimationFrame",
    source,
  )(
    windowObject,
    documentObject,
    storage,
    { escape: (value) => String(value) },
    () => Promise.reject(new Error("unexpected fetch")),
    (callback) => callback(),
  );

  assert.match(app.innerHTML, /Client test/);
  assert.match(app.innerHTML, /data-thread-id="resolved-node-thread"/);
  assert.match(
    app.innerHTML,
    /class="node\s+is-stale" data-node="configure-settings"/,
  );
  assert.match(
    app.innerHTML,
    /class="frow\s+is-stale\s*" data-file="f:implementation:appsettings\.json"/,
  );
  assert.match(
    app.innerHTML,
    /class="stage(?![^"]*is-approved)[^"]*" data-stage="implementation"/,
  );
  assert.match(
    app.innerHTML,
    /class="notes-toggle is-open all-resolved"[^>]*data-id="implementation"[^>]*title="1 thread, all resolved"/,
  );
  assert.match(app.innerHTML, /data-thread="implementation"/);
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
  const stagePath = ".semantic-review/stages/implementation.json";
  const stage = repository.readJson(stagePath);
  stage.change.baseRevision = commits.get("implementation");
  stage.change.headRevision = newHead;
  stage.change.files = [
    {
      path: "README.md",
      kind: "modified",
    },
  ];
  stage.nodes[0].changes = [
    {
      path: "README.md",
      classification: "behavior",
    },
  ];
  repository.write(stagePath, `${JSON.stringify(stage, null, 2)}\n`);

  const script = createImplementationDataScript(repository.root);
  const data = JSON.parse(
    script.match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
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
