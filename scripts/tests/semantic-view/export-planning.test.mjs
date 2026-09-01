import assert from "node:assert/strict";
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

test("mapNoteTarget maps a node note to its stage with the node title", () => {
  assert.deepEqual(
    mapNoteTarget({ kind: "node", id: "impl-change", stageId: "implementation" }, implementation),
    { "target-kind": "stage", stage: "implementation", label: "Implementation change" },
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

  const script = createImplementationDataScript(repository.root);
  const data = JSON.parse(
    script.match(/^window\.SEMANTIC_IMPLEMENTATION = (.*);\n$/s)[1],
  );
  const file = data.stages[0].files[0];

  assert.deepEqual(
    [...new Set(file.lines.filter((line) => line.t !== "ctx").map((line) => line.h))],
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
  const readData = () => {
    const script = createImplementationDataScript(repository.root);
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
  assert.match(app, /fetch\("\/api\/revision"/);
  assert.match(app, /fetch\("\/api\/feedback\/reply-batch"/);
  assert.match(app, /observedAwaitingAgentReplies > 0 && awaiting === 0/);
  assert.match(app, /Boolean\(compose && compose\.dirty\)/);
  assert.match(app, /window\.confirm\(/);
  assert.doesNotMatch(app, /stableSince/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.doesNotMatch(app, /activeCount\s*=.*pendingReplies\(\)/);
  assert.match(app, /Notes <b>\$\{activeNoteCount\(\)\}<\/b>/);
  assert.equal(app.match(/const activeCount = activeNoteCount\(\);/g)?.length, 2);
  assert.match(
    app,
    /<div class="stage-approve">\$\{stageNoteCluster\(stage\.id\)\}\$\{approveBtn\("stage", stage\.id, "sm"\)\}<\/div>/,
  );
  assert.match(
    app,
    /<div class="note-cluster">\$\{notesToggle\("stage", id\)\}\$\{commentBtn\("stage", id\)\}<\/div>/,
  );
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
