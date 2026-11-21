// Following a line thread's line from the snapshot it was written on to its
// stage's current diff.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { gitRaw } from "../../src/shared/git.ts";
import { locateLineAnchors } from "../../src/shared/line-anchors.ts";
import { createRepository } from "../helpers/repository.mjs";

const lines = (...items) => `${items.join("\n")}\n`;

/** A repository whose commits are written from file maps; null removes a file. */
function history(t) {
  const repository = createRepository(t);
  repository.git("commit", "--allow-empty", "-m", "Root");
  const root = repository.git("rev-parse", "HEAD");
  const commit = (parent, files, message = "Change") => {
    repository.git("checkout", "--quiet", "--detach", parent);
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(repository.root, file);
      if (contents === null) repository.git("rm", "--quiet", "--", file);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
        repository.git("add", "--", file);
      }
    }
    repository.git("commit", "--allow-empty", "--quiet", "-m", message);
    return repository.git("rev-parse", "HEAD");
  };
  return { repository, root, commit };
}

/** Locates anchors and counts the Git processes it starts. */
function locate(repository, anchors) {
  const runs = [];
  const result = locateLineAnchors(repository.root, anchors, (args, input) => {
    runs.push(args);
    return gitRaw(args, { cwd: repository.root, input, allowFailure: true });
  });
  return { result, runs };
}

test("a line thread follows its unchanged line through new heads and moves", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "src/app.js": lines("a", "b", "c", "d") });
  const head = commit(base, { "src/app.js": lines("a", "B", "c", "d", "e") });
  const anchor = (side, line, stageHead = head) => ({ stageHead, path: "src/app.js", side, line });
  // The same content folded again: a new head commit, the same line.
  const refolded = commit(base, { "src/app.js": lines("a", "B", "c", "d", "e") }, "Refold");
  assert.notEqual(refolded, head);
  // Restacked onto a base with two more lines above, and another edit below.
  const movedBase = commit(root, { "src/app.js": lines("x", "y", "a", "b", "c", "d") });
  const moved = commit(movedBase, { "src/app.js": lines("x", "y", "a", "B", "c", "d", "E") });
  const ranges = {
    refolded: { baseRevision: base, headRevision: refolded },
    moved: { baseRevision: movedBase, headRevision: moved },
  };
  const { result, runs } = locate(repository, [
    { anchor: anchor("new", 2), stage: ranges.refolded },
    { anchor: anchor("new", 2), stage: ranges.moved },
    { anchor: anchor("old", 2), stage: ranges.moved },
    { anchor: anchor("new", 3), stage: ranges.moved },
    // Line 5 ("e") was replaced by "E": it has no row any more.
    { anchor: anchor("new", 5), stage: ranges.moved },
  ]);
  assert.deepEqual(result, [2, 4, 4, 5, null]);
  // One read resolves the anchored snapshots, one diff serves every line.
  assert.deepEqual(runs.map((args) => args.find((arg) => ["cat-file", "diff-tree"].includes(arg))), ["cat-file", "diff-tree"]);
});

test("a line thread has no row once its line changed, left its side, or its file left the stage", (t) => {
  const { repository, root, commit } = history(t);
  const base = commit(root, { "app.js": lines("a", "b", "c"), "gone.js": lines("g") });
  const head = commit(base, { "app.js": lines("a", "c"), "gone.js": lines("g", "h") });
  const anchor = (filePath, side, line, stageHead = head) => ({ stageHead, path: filePath, side, line });
  // The stage no longer removes "b", and deletes gone.js instead of changing it.
  const corrected = commit(base, { "app.js": lines("a", "b", "c", "d"), "gone.js": null });
  const range = { baseRevision: base, headRevision: corrected };
  const missing = "1".repeat(40);
  const { result } = locate(repository, [
    { anchor: anchor("app.js", "old", 2), stage: range },
    { anchor: anchor("gone.js", "new", 2), stage: range },
    { anchor: anchor("gone.js", "new", 1), stage: range },
    // The deleted file's lines are now its removed rows.
    { anchor: anchor("gone.js", "old", 1), stage: range },
    { anchor: anchor("app.js", "new", 1, missing), stage: range },
    { anchor: anchor("other.js", "new", 1), stage: range },
  ]);
  assert.deepEqual(result, [null, null, null, 1, null, null]);
  assert.deepEqual(locateLineAnchors(repository.root, []), []);
});

test("old rows of a renamed file and unusual paths are followed", (t) => {
  const { repository, root, commit } = history(t);
  const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const odd = "dir/with space \"and\" quote.txt";
  const base = commit(root, { "old.js": lines(...body), [odd]: lines("one", "two") });
  const head = commit(base, { "old.js": null, "new.js": lines(...body.filter((line) => line !== "line 5")), [odd]: lines("one") });
  const restackedBase = commit(root, { "old.js": lines("top", ...body), [odd]: lines("zero", "one", "two") });
  const restacked = commit(restackedBase, { "old.js": null, "new.js": lines("top", ...body.filter((line) => line !== "line 5")), [odd]: lines("zero", "one") });
  const range = { baseRevision: restackedBase, headRevision: restacked };
  const { result } = locate(repository, [
    { anchor: { stageHead: head, path: "new.js", side: "old", line: 5 }, stage: range, previousPath: "old.js" },
    { anchor: { stageHead: head, path: "new.js", side: "new", line: 5 }, stage: range, previousPath: "old.js" },
    { anchor: { stageHead: head, path: odd, side: "old", line: 2 }, stage: range },
  ]);
  assert.deepEqual(result, [6, 6, 3]);
});

test("removed lines that look like diff headers do not confuse the reading", (t) => {
  const { repository, root, commit } = history(t);
  const tricky = ["--- a/app.js", "+++ b/app.js", "diff --git a/x b/x", "@@ -1 +1 @@", "a".repeat(40)];
  const base = commit(root, { "app.js": lines(...tricky, "keep") });
  const head = commit(base, { "app.js": lines("keep") });
  const restackedBase = commit(root, { "app.js": lines("first", ...tricky, "keep") });
  const restacked = commit(restackedBase, { "app.js": lines("first", "keep") });
  const range = { baseRevision: restackedBase, headRevision: restacked };
  const { result } = locate(repository, [
    { anchor: { stageHead: head, path: "app.js", side: "old", line: 5 }, stage: range },
    { anchor: { stageHead: head, path: "app.js", side: "new", line: 1 }, stage: range },
  ]);
  assert.deepEqual(result, [6, 2]);
});
