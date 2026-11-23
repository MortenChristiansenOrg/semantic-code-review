// The removal of test directories, with a lock simulated as Windows reports it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeDirectory } from "./helpers/directories.mjs";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-cleanup-"));
  fs.writeFileSync(path.join(root, "file.txt"), "contents\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const locked = (directory) => Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${directory}'`), { code: "EBUSY" });

test("a directory that is locked for a moment is removed once it is released", (t) => {
  const root = directory(t);
  let attempts = 0;
  removeDirectory(root, { delayMs: 10, remove(target, options) {
    if (++attempts <= 3) throw locked(target);
    fs.rmSync(target, options);
  } });
  assert.equal(attempts, 4);
  assert.equal(fs.existsSync(root), false);
});

test("a directory that stays locked fails once the wait is over", (t) => {
  const root = directory(t);
  let attempts = 0;
  const started = Date.now();
  assert.throws(() => removeDirectory(root, { timeoutMs: 300, delayMs: 20, remove(target) { attempts++; throw locked(target); } }), { code: "EBUSY" });
  assert.ok(attempts > 1, "The removal was not tried again.");
  assert.ok(Date.now() - started >= 250, "The removal gave up before the wait was over.");
  assert.equal(fs.existsSync(root), true);
});

test("an error other than a lock fails at once", (t) => {
  const root = directory(t);
  let attempts = 0;
  assert.throws(() => removeDirectory(root, { remove() { attempts++; throw Object.assign(new Error("Invalid"), { code: "EINVAL" }); } }), { code: "EINVAL" });
  assert.equal(attempts, 1);
});

test("a directory is removed with its contents, and a missing one is no error", (t) => {
  const root = directory(t);
  removeDirectory(root);
  assert.equal(fs.existsSync(root), false);
  removeDirectory(root);
});
