// Following a line thread's line from the snapshot it was written on to its
// stage's current diff.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitRaw } from "../../src/shared/git.ts";
import { locateLineAnchors } from "../../src/shared/line-anchors.ts";
import { createRepository } from "../helpers/repository.mjs";

const lines = (...items) => `${items.join("\n")}\n`;

/** A repository whose commits are written from file maps through the index,
 * so paths any platform's files cannot have still work; null removes a file. */
function history(t) {
  const repository = createRepository(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "line-anchors-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  repository.git("commit", "--allow-empty", "-m", "Root");
  const root = repository.git("rev-parse", "HEAD");
  let count = 0;
  // Windows Git refuses such paths in the index unless told the files are never written.
  const index = (...args) => repository.git("-c", "core.protectNTFS=false", ...args);
  const commit = (parent, files, { mode } = {}) => {
    index("read-tree", parent);
    for (const [file, contents] of Object.entries(files)) {
      if (contents === null) { index("update-index", "--force-remove", "--", file); continue; }
      const source = path.join(scratch, `blob-${++count}`);
      fs.writeFileSync(source, contents);
      const blob = repository.git("hash-object", "-w", "--", source);
      index("update-index", "--add", "--cacheinfo", `${mode?.[file] ?? "100644"},${blob},${file}`);
    }
    const tree = index("write-tree");
    return repository.git("commit-tree", tree, "-p", parent, "-m", `Change ${count}`);
  };
  return { repository, root, commit };
}

/** Locates anchors and lists the Git commands it ran. */
function locate(repository, inputs, cache) {
  const runs = [];
  const result = locateLineAnchors(repository.root, inputs, { cache, runGit: (args, input, env) => {
    runs.push(args.find((arg) => ["cat-file", "diff-tree"].includes(arg)));
    return gitRaw(args, { cwd: repository.root, input, env, allowFailure: true });
  } });
  return { result, runs };
}
const modified = { kind: "modified" };

test("a line thread follows its unchanged line through new heads and moves", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "src/app.js": lines("a", "b", "c", "d") });
  const head = commit(base, { "src/app.js": lines("a", "B", "c", "d", "e") });
  const anchor = (side, line) => ({ stageHead: head, path: "src/app.js", side, line });
  // The same content folded again: a new head commit, the same line.
  const refolded = commit(base, { "src/app.js": lines("a", "B", "c", "d", "e"), "notes.txt": "notes\n" });
  // Restacked onto a base with two more lines above, and another edit below.
  const movedBase = commit(root, { "src/app.js": lines("x", "y", "a", "b", "c", "d") });
  const moved = commit(movedBase, { "src/app.js": lines("x", "y", "a", "B", "c", "d", "E") });
  const ranges = {
    refolded: { baseRevision: base, headRevision: refolded },
    moved: { baseRevision: movedBase, headRevision: moved },
  };
  const inputs = [
    { anchor: anchor("new", 2), stage: ranges.refolded, file: modified },
    { anchor: anchor("new", 2), stage: ranges.moved, file: modified },
    { anchor: anchor("old", 2), stage: ranges.moved, file: modified },
    { anchor: anchor("new", 3), stage: ranges.moved, file: modified },
    // Line 5 ("e") was replaced by "E": it has no row any more.
    { anchor: anchor("new", 5), stage: ranges.moved, file: modified },
  ];
  const cache = new Map();
  const { result, runs } = locate(repository, inputs, cache);
  assert.deepEqual(result, [2, 4, 4, 5, null]);
  // One read resolves the anchored snapshots, and one diff serves every line.
  assert.deepEqual(runs, ["cat-file", "diff-tree"]);
  // Locating them again runs no Git.
  const again = locate(repository, inputs, cache);
  assert.deepEqual(again.result, result);
  assert.deepEqual(again.runs, []);
});

test("a line thread has no row once its line changed, left its side, or its file's diff shows no lines", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "app.js": lines("a", "b", "c"), "gone.js": lines("g"), "tool.sh": lines("echo", "one") });
  const head = commit(base, { "app.js": lines("a", "c"), "gone.js": lines("g", "h"), "tool.sh": lines("echo", "two") }, { mode: { "tool.sh": "100755" } });
  const anchor = (filePath, side, line, stageHead = head) => ({ stageHead, path: filePath, side, line });
  // The stage no longer removes "b", deletes gone.js instead of changing it,
  // and only makes tool.sh executable.
  const corrected = commit(base, { "app.js": lines("a", "b", "c", "d"), "gone.js": null, "tool.sh": lines("echo", "one") }, { mode: { "tool.sh": "100755" } });
  const stage = { baseRevision: base, headRevision: corrected };
  const { result } = locate(repository, [
    { anchor: anchor("app.js", "old", 2), stage, file: modified },
    { anchor: anchor("gone.js", "new", 1), stage, file: { kind: "deleted" } },
    // The deleted file's lines are now its removed rows.
    { anchor: anchor("gone.js", "old", 1), stage, file: { kind: "deleted" } },
    { anchor: anchor("tool.sh", "new", 1), stage, file: modified },
    { anchor: anchor("app.js", "new", 1, "1".repeat(40)), stage, file: modified },
    { anchor: anchor("other.js", "new", 1), stage },
  ]);
  assert.deepEqual(result, [null, null, 1, null, null, null]);
  assert.deepEqual(locateLineAnchors(repository.root, []), []);
});

test("each line's row depends on its own thread only", (t) => {
  const { repository, root, commit } = history(t);
  const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const base = commit(root, { "old.txt": lines(...body), "keep.txt": lines("k1", "k2") });
  const head = commit(base, { "old.txt": lines(...body, "more"), "keep.txt": lines("k1", "K2") });
  // A correction renames old.txt to new.txt.
  const corrected = commit(base, { "old.txt": null, "new.txt": lines(...body, "more"), "keep.txt": lines("k1", "K2") });
  const stage = { baseRevision: base, headRevision: corrected };
  const onOld = { anchor: { stageHead: head, path: "old.txt", side: "new", line: 13 }, stage };
  const onKeep = { anchor: { stageHead: head, path: "keep.txt", side: "new", line: 2 }, stage, file: modified };
  const onNew = { anchor: { stageHead: corrected, path: "new.txt", side: "new", line: 1 }, stage, file: { kind: "renamed", previousPath: "old.txt" } };
  const alone = locate(repository, [onOld, onKeep]).result;
  const together = locate(repository, [onOld, onKeep, onNew]).result;
  assert.deepEqual(alone, [null, 2]);
  assert.deepEqual(together.slice(0, 2), alone);
  assert.equal(together[2], 1);
});

test("rows of renamed files and unusual paths are followed", (t) => {
  const { repository, root, commit } = history(t);
  const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const odd = "dir/with space \"and\" 🦊 quote.txt";
  const base = commit(root, { "old.js": lines(...body), [odd]: lines("one", "two") });
  const head = commit(base, { "old.js": null, "new.js": lines(...body.filter((line) => line !== "line 5")), [odd]: lines("one") });
  const restackedBase = commit(root, { "old.js": lines("top", ...body), [odd]: lines("zero", "one", "two") });
  const restacked = commit(restackedBase, { "old.js": null, "new.js": lines("top", ...body.filter((line) => line !== "line 5")), [odd]: lines("zero", "one") });
  const stage = { baseRevision: restackedBase, headRevision: restacked };
  const renamed = { kind: "renamed", previousPath: "old.js" };
  const { result } = locate(repository, [
    { anchor: { stageHead: head, path: "new.js", side: "new", line: 5 }, stage, file: renamed },
    // A renamed file's removed rows are not followed.
    { anchor: { stageHead: head, path: "new.js", side: "old", line: 5 }, stage, file: renamed },
    { anchor: { stageHead: head, path: odd, side: "old", line: 2 }, stage, file: modified },
    { anchor: { stageHead: head, path: odd, side: "new", line: 1 }, stage, file: modified },
  ]);
  assert.deepEqual(result, [6, null, 3, 2]);
});

test("removed lines that look like diff headers do not confuse the reading", (t) => {
  const { repository, root, commit } = history(t);
  const tricky = ["--- a/app.js", "+++ b/app.js", "diff --git a/x b/x", "@@ -1 +1 @@", "a".repeat(40)];
  const base = commit(root, { "app.js": lines(...tricky, "keep") });
  const head = commit(base, { "app.js": lines("keep") });
  const restackedBase = commit(root, { "app.js": lines("first", ...tricky, "keep") });
  const restacked = commit(restackedBase, { "app.js": lines("first", "keep") });
  const stage = { baseRevision: restackedBase, headRevision: restacked };
  const { result } = locate(repository, [
    { anchor: { stageHead: head, path: "app.js", side: "old", line: 5 }, stage, file: modified },
    { anchor: { stageHead: head, path: "app.js", side: "new", line: 1 }, stage, file: modified },
  ]);
  assert.deepEqual(result, [6, 2]);
});

test("lines are compared as the viewer's diff shows them, whatever the user's Git configuration", (t) => {
  const { repository, root, commit } = history(t);
  // The viewer's diff shows no text conversion and uses Git's default algorithm.
  repository.git("config", "diff.drop.textconv", "sed 1d");
  repository.git("config", "diff.algorithm", "patience");
  fs.writeFileSync(path.join(repository.root, ".gitattributes"), "*.txt diff=drop\n");
  const base = commit(root, { "app.txt": lines("hidden", "a", "b") });
  const head = commit(base, { "app.txt": lines("hidden", "a", "B") });
  // Raw line 1 stays; it would change in the text conversion.
  const corrected = commit(base, { "app.txt": lines("hidden", "c", "B") });
  const stage = { baseRevision: base, headRevision: corrected };
  const anchor = { stageHead: head, path: "app.txt", side: "new", line: 1 };
  const runs = [];
  const result = locateLineAnchors(repository.root, [{ anchor, stage, file: modified }], { runGit: (args, input, env) => {
    runs.push(args);
    return gitRaw(args, { cwd: repository.root, input, env, allowFailure: true });
  } });
  assert.deepEqual(result, [1]);
  assert.ok(runs.filter((args) => args.includes("diff-tree")).every((args) => args.includes("--diff-algorithm=myers")));
});

test("a line stays where it was written while the stage head is the anchored one", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "old.js": lines("a", "b") });
  const head = commit(base, { "old.js": null, "new.js": lines("a", "c") });
  const stage = { baseRevision: base, headRevision: head };
  const file = { previousPath: "old.js" };
  const { result, runs } = locate(repository, [
    { anchor: { stageHead: head, path: "new.js", side: "old", line: 2 }, stage, file },
    { anchor: { stageHead: head, path: "new.js", side: "new", line: 2 }, stage, file },
  ]);
  assert.deepEqual(result, [2, 2]);
  assert.deepEqual(runs, []);
});

test("a file renamed without changes shows no lines", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "old.js": lines("a", "b") });
  const head = commit(base, { "old.js": null, "new.js": lines("a", "c") });
  // The correction keeps only the rename.
  const corrected = commit(base, { "old.js": null, "new.js": lines("a", "b") });
  const { result } = locate(repository, [
    { anchor: { stageHead: head, path: "new.js", side: "new", line: 1 }, stage: { baseRevision: base, headRevision: corrected }, file: { previousPath: "old.js" } },
  ]);
  assert.deepEqual(result, [null]);
});
