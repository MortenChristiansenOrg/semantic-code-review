import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, gitRaw } from "../../src/shared/git.ts";
import { createRepository, flowCli, initializeImplementation } from "../helpers/repository.mjs";

// What Git sets for a hook or `git rebase --exec` run in another repository.
const otherRepository = (other) => ({
  GIT_DIR: other.path(".git"), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: other.path(".git/index"),
});

test("CLI commands act on their own repository whatever Git variables the caller set", (t) => {
  const repository = createRepository(t), other = createRepository(t, "semantic-flow-other-");
  initializeImplementation(repository);
  const before = other.git("for-each-ref");
  const run = (...args) => spawnSync(process.execPath, [flowCli, ...args], {
    cwd: repository.root, encoding: "utf8", env: { ...process.env, ...otherRepository(other) },
  });
  const exported = run("implementation", "export");
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), JSON.parse(repository.semantic("export")));
  const begun = run("implementation", "stage", "begin", "--id", "implementation", "--title", "Implement behavior",
    "--summary", "Add the implementation.", "--rationale", "Keep it reviewable.", "--specification-ref", "story#works");
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(repository.git("branch", "--show-current"), /stages\/implementation$/);
  assert.equal(other.git("for-each-ref"), before);
});

test("git and gitRaw ignore the caller's Git variables but keep the ones a command sets", (t) => {
  const repository = createRepository(t), other = createRepository(t, "semantic-flow-other-");
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, otherRepository(other));
  const top = (value) => fs.realpathSync.native(value);
  assert.equal(top(git(["rev-parse", "--show-toplevel"], { cwd: repository.root })), top(repository.root));
  assert.equal(top(gitRaw(["rev-parse", "--show-toplevel"], { cwd: repository.root })), top(repository.root));
  // A temporary index the command sets itself still applies.
  const index = path.join(repository.root, ".git", "scratch-index");
  gitRaw(["read-tree", "HEAD"], { cwd: repository.root, env: { GIT_INDEX_FILE: index } });
  assert.ok(fs.existsSync(index));
});
