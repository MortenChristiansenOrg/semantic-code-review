import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { git, gitRaw, isolateGitEnvironment } from "../../src/shared/git.ts";
import { beginStage, createRepository, finalizeStage, flowCli, initializeImplementation } from "../helpers/repository.mjs";

// What Git sets for a hook or `git rebase --exec` run in another repository.
// A pre-receive hook also runs in a quarantine that forbids ref updates.
const otherRepository = (other) => ({
  GIT_DIR: other.path(".git"), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: other.path(".git/index"),
  GIT_QUARANTINE_PATH: other.path(".git/objects/incoming"), GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "1",
});

test("CLI commands act on their own repository whatever Git variables the caller set", (t) => {
  const repository = createRepository(t), other = createRepository(t, "semantic-flow-other-");
  initializeImplementation(repository);
  // A finished stage makes export read its changes from Git.
  beginStage(repository, { id: "first" });
  finalizeStage(repository, { id: "first" });
  const before = other.git("for-each-ref");
  // Records every child process the CLI starts that would still see GIT_DIR.
  const seen = path.join(repository.root, "..", `${path.basename(repository.root)}-children.log`);
  const preload = path.join(repository.root, "..", `${path.basename(repository.root)}-children.mjs`);
  t.after(() => { fs.rmSync(seen, { force: true }); fs.rmSync(preload, { force: true }); });
  fs.writeFileSync(preload, `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (command, args, options) {
    const env = (Array.isArray(args) ? options : args)?.env ?? process.env;
    if (Object.keys(env).some((key) => /^GIT_DIR$/i.test(key))) fs.appendFileSync(${JSON.stringify(seen)}, String(command) + "\\n");
    return original.apply(this, arguments);
  };
}
syncBuiltinESMExports();
`);
  const run = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, flowCli, ...args], {
    cwd: repository.root, encoding: "utf8", env: { ...process.env, ...otherRepository(other) },
  });
  const exported = run("implementation", "export");
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), JSON.parse(repository.semantic("export")));
  const begun = run("implementation", "stage", "begin", "--id", "second", "--title", "Implement behavior",
    "--summary", "Add the implementation.", "--rationale", "Keep it reviewable.", "--specification-ref", "story#works");
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(repository.git("branch", "--show-current"), /stages\/second$/);
  assert.equal(other.git("for-each-ref"), before);
  assert.equal(fs.existsSync(seen) ? fs.readFileSync(seen, "utf8") : "", "");
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

test("the CLI removes the caller's Git variables from its own environment", (t) => {
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { GIT_DIR: "elsewhere", git_work_tree: "elsewhere", GIT_CEILING_DIRECTORIES: "elsewhere", GIT_CONFIG_KEY_0: "user.name", GIT_AUTHOR_NAME: "Kept" });
  isolateGitEnvironment();
  for (const key of ["GIT_DIR", "git_work_tree", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_KEY_0"]) assert.equal(process.env[key], undefined, key);
  assert.equal(process.env.GIT_AUTHOR_NAME, "Kept");
  // Every child process the CLI starts inherits the result, Git or not.
  const child = spawnSync(process.execPath, ["-p", "process.env.GIT_DIR ?? 'unset'"], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), "unset");
});
