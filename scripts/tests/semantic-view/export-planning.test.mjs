import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createImplementationWithStages,
  scriptsDirectory,
} from "../helpers/repository.mjs";

const moduleUrl = pathToFileURL(
  path.join(scriptsDirectory, "semantic-view.mjs"),
).href;
const {
  createImplementationDataScript,
  planFeedbackThreads,
  mapNoteTarget,
  readFeedbackThread,
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
  assert.equal(refreshed.feedback[0].comments.length, 2);
  assert.equal(
    refreshed.feedback[0].comments[1].body,
    "This reply should appear after refresh.",
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
