import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactDraft, commitArtifact, readArtifact } from "../../src/shared/artifact-store.ts";
import {
  beginStage,
  createRepository,
  finalizeStage,
  flowCli,
  initializeImplementation,
  semanticCli,
} from "../helpers/repository.mjs";

const ACTIVE = "refs/semantic-review/active/test-implementation";

/** The stage summary the stored working stage records. */
const storedSummary = (repo) =>
  JSON.parse(repo.git("cat-file", "blob", `${ACTIVE}:.work/stages/implementation.json`)).summary;

test("the active artifact lives in a private ref and survives git clean -fdx", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);
  assert.equal(fs.existsSync(path.join(repo.root, ".semantic-review")), false);
  assert.equal(repo.git("status", "--porcelain", "--ignored"), "");
  assert.match(repo.git("reflog", "--format=%gs", ACTIVE), /semantic-flow/);

  repo.git("clean", "-fdx");
  repo.semantic("validate");
  assert.equal(storedSummary(repo), "Add the implementation.");
});

test("every worktree of the repository sees the same artifact", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);
  const second = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-second-")), "worktree");
  t.after(() => fs.rmSync(path.dirname(second), { recursive: true, force: true }));
  repo.git("worktree", "add", "--detach", second, "main");

  const exported = JSON.parse(repo.run(process.execPath, [...semanticCli, "export"]));
  const secondExport = JSON.parse(spawnSyncChecked(process.execPath, [...semanticCli, "export"], second));
  assert.deepEqual(secondExport, exported);
});

test("the review ID stays private to the active artifact", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  const { reviewId } = JSON.parse(readArtifact(repo.root).read("review.json"));
  assert.match(reviewId, /^[a-z0-9-]+--test-implementation--[a-f0-9]{64}$/);
  beginStage(repo);
  finalizeStage(repo);
  repo.semantic("validate", "--publish");
  assert.doesNotMatch(repo.semantic("export"), new RegExp(reviewId));
  const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-export-")), "artifact");
  t.after(() => fs.rmSync(path.dirname(destination), { recursive: true, force: true }));
  repo.semantic("export", "--destination", destination);
  assert.ok(fs.existsSync(path.join(destination, "manifest.json")));
  assert.equal(fs.existsSync(path.join(destination, "review.json")), false);
  // Publication stores the same full form.
  repo.semantic("prepare-branch", "--branch", "review/test-implementation");
  const published = repo.git("ls-tree", "-r", "--name-only", "semantic-flow/test-implementation/metadata", ".semantic-review").split("\n");
  assert.ok(published.includes(".semantic-review/manifest.json"));
  assert.equal(published.some((file) => file.endsWith("review.json")), false);
  assert.equal(JSON.parse(readArtifact(repo.root).read("review.json")).reviewId, reviewId);
});

test("the loser of two concurrent writers fails cleanly and leaves a whole artifact", async (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);

  // A writer that read the artifact before another one committed must not overwrite it.
  const stale = readArtifact(repo.root);
  repo.semantic("stage", "set", "--id", "implementation", "--summary", "Written first.");
  const draft = new ArtifactDraft(stale);
  draft.write(".work/stages/implementation.json", stale.read(".work/stages/implementation.json"));
  assert.throws(() => commitArtifact(repo.root, stale, draft), /changed while this command ran; retry it/);
  assert.equal(storedSummary(repo), "Written first.");

  // Racing processes: each either commits whole or fails with the retry message.
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    runAsync(process.execPath, [...semanticCli, "stage", "set", "--id", "implementation", "--summary", `Writer ${index}.`], repo.root)));
  const winners = results.filter((result) => result.status === 0);
  assert.ok(winners.length >= 1);
  for (const result of results.filter((result) => result.status !== 0)) {
    assert.match(result.stderr, /changed while this command ran; retry it/);
  }
  repo.semantic("validate");
  assert.match(storedSummary(repo), /^Writer \d\.$/);
});

test("superseded stage heads stay reachable after git gc --prune=now", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);
  const first = finalizeStage(repo);
  repo.commitFile("implementation.txt", "amended\n", "Amend the stage");
  repo.git("commit", "--amend", "-m", "Rewrite the stage");
  repo.semantic("restack", "--from", "implementation");
  const current = repo.git("rev-parse", "HEAD");
  assert.notEqual(current, first);

  const parents = repo.git("log", "-1", "--format=%P", ACTIVE).split(" ");
  assert.ok(parents.includes(first), `${first} is not among ${parents}`);
  assert.equal(parents.includes(current), false);
  repo.git("reflog", "expire", "--expire-unreachable=now", "--all");
  repo.git("gc", "--quiet", "--prune=now");
  assert.equal(repo.git("cat-file", "-t", first), "commit");

  // Later snapshots carry the superseded head forward.
  repo.semantic("stage", "set", "--id", "implementation", "--finalized", "--summary", "Changed later.");
  assert.ok(repo.git("log", "-1", "--format=%P", ACTIVE).split(" ").includes(first));
});

test("artifact bytes are stored unchanged whatever the line-ending settings", (t) => {
  const repo = createRepository(t);
  repo.git("config", "core.autocrlf", "true");
  repo.commitFile(".gitattributes", "* text eol=crlf\n", "Normalize line endings");
  initializeImplementation(repo);
  beginStage(repo);
  repo.commitFile("feature.txt", "feature\n", "Add feature");
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-output-")), "output.txt");
  t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
  const bytes = Buffer.from("first line\r\nsecond line\nthird\r\n", "utf8");
  fs.writeFileSync(output, bytes);
  repo.semantic("stage", "evidence", "--item-id", "run", "--kind", "terminal", "--summary", "The command runs", "--file", output);

  const stage = JSON.parse(repo.git("cat-file", "blob", `${ACTIVE}:.work/stages/implementation.json`));
  const [attachment] = stage.evidence[0].attachments;
  const stored = repo.run("git", ["cat-file", "blob", `${ACTIVE}:${attachment.path}`]);
  assert.equal(stored, bytes.toString("utf8").trim());
  const exportDirectory = path.join(path.dirname(output), "export");
  repo.semantic("export", "--destination", exportDirectory);
  assert.deepEqual(fs.readFileSync(path.join(exportDirectory, ...attachment.path.split("/"))), bytes);
});

test("an artifact folder from an earlier version is reported, not continued", (t) => {
  const repo = createRepository(t);
  fs.mkdirSync(path.join(repo.root, ".semantic-review"));
  fs.writeFileSync(path.join(repo.root, ".semantic-review", "manifest.json"), "{}\n");
  repo.expectSemanticFailure(/written by an earlier Semantic Flow version/, "validate");
  assert.throws(() => initializeImplementation(repo), /written by an earlier Semantic Flow version/);
  const inspected = spawnResult(process.execPath, [flowCli, "inspect"], repo.root);
  assert.notEqual(inspected.status, 0);
  assert.match(inspected.stderr, /written by an earlier Semantic Flow version/);
  // A worktree holding one is reported even while another worktree has an active implementation.
  fs.rmSync(path.join(repo.root, ".semantic-review"), { recursive: true });
  initializeImplementation(repo);
  const second = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-legacy-")), "worktree");
  t.after(() => fs.rmSync(path.dirname(second), { recursive: true, force: true }));
  repo.git("worktree", "add", "--detach", second, "main");
  fs.mkdirSync(path.join(second, ".semantic-review"));
  fs.writeFileSync(path.join(second, ".semantic-review", "manifest.json"), "{}\n");
  const fromSecond = spawnResult(process.execPath, [flowCli, "inspect"], second);
  assert.notEqual(fromSecond.status, 0);
  assert.match(fromSecond.stderr, /written by an earlier Semantic Flow version/);
  assert.equal(spawnResult(process.execPath, [flowCli, "inspect"], repo.root).status, 0);
});

test("the longest branch prefix that matches the checked-out branch claims it", (t) => {
  const repo = createRepository(t);
  const init = (cwd, id, prefix) => spawnSyncChecked(process.execPath, [...semanticCli, "init", "--implementation-id", id,
    "--title", id, "--summary", "Work.", "--target-branch", "main", "--branch-prefix", prefix,
    "--specification-id", "story", "--specification-title", "Story", "--specification-summary", "Work.",
    "--source-kind", "local", "--source-reference", id, "--criterion", "works=It works."], cwd);
  const begin = (cwd) => spawnSyncChecked(process.execPath, [...semanticCli, "stage", "begin", "--id", "implementation",
    "--title", "Implement", "--summary", "Work.", "--rationale", "Reviewable.", "--specification-ref", "story#works"], cwd);
  init(repo.root, "alpha", "team");
  begin(repo.root);
  const second = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-second-")), "worktree");
  t.after(() => fs.rmSync(path.dirname(second), { recursive: true, force: true }));
  repo.git("worktree", "add", "--detach", second, "main");
  init(second, "beta", "team/beta");
  begin(second);
  // Only the branch identifies the implementation once the worktree's own claim is gone.
  fs.rmSync(spawnSyncChecked("git", ["rev-parse", "--path-format=absolute", "--git-path", "semantic-review-implementation"], second));

  assert.equal(spawnSyncChecked("git", ["symbolic-ref", "--short", "HEAD"], second), "team/beta/stages/implementation");
  assert.equal(JSON.parse(spawnSyncChecked(process.execPath, [...semanticCli, "export"], second)).manifest.implementationId, "beta");
  assert.equal(JSON.parse(repo.semantic("export")).manifest.implementationId, "alpha");

  // A prefix that only resembles another implementation's stage branch does not claim it.
  const third = path.join(path.dirname(second), "third");
  repo.git("worktree", "add", "--detach", third, "main");
  init(third, "gamma", "team/stages");
  begin(third);
  fs.rmSync(spawnSyncChecked("git", ["rev-parse", "--path-format=absolute", "--git-path", "semantic-review-implementation"], repo.root), { force: true });
  assert.equal(repo.git("symbolic-ref", "--short", "HEAD"), "team/stages/implementation");
  assert.equal(JSON.parse(repo.semantic("export")).manifest.implementationId, "alpha");
});

test("a stage begins when only the post-checkout hook fails", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  const hook = path.join(repo.git("rev-parse", "--path-format=absolute", "--git-path", "hooks"), "post-checkout");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  beginStage(repo);
  assert.equal(repo.git("symbolic-ref", "--short", "HEAD"), "semantic-flow/test-implementation/stages/implementation");
  fs.rmSync(hook);
  repo.semantic("validate");
});

test("several active implementations are told apart by their worktrees", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);
  const second = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-second-")), "worktree");
  t.after(() => fs.rmSync(path.dirname(second), { recursive: true, force: true }));
  repo.git("worktree", "add", "--detach", second, "main");
  const inSecond = (...args) => spawnSyncChecked(process.execPath, [...semanticCli, ...args], second);
  inSecond("init", "--implementation-id", "other", "--title", "Other", "--summary", "Other work.", "--target-branch", "main",
    "--specification-id", "other", "--specification-title", "Other", "--specification-summary", "Other work.",
    "--source-kind", "local", "--source-reference", "other", "--criterion", "works=It works.");

  // The first worktree has its stage branch checked out; the second initialized the other implementation.
  assert.equal(JSON.parse(repo.semantic("export")).manifest.implementationId, "test-implementation");
  assert.equal(JSON.parse(inSecond("export")).manifest.implementationId, "other");
  assert.throws(() => inSecond("init", "--implementation-id", "third", "--title", "Third", "--summary", "Third.", "--target-branch", "main",
    "--specification-id", "third", "--specification-title", "Third", "--specification-summary", "Third.",
    "--source-kind", "local", "--source-reference", "third", "--criterion", "works=It works."), /A semantic implementation already exists in this worktree: other/);

  // Without a claim, a worktree must not guess between them.
  const third = path.join(path.dirname(second), "third");
  repo.git("worktree", "add", "--detach", third, "main");
  const result = spawnResult(process.execPath, [...semanticCli, "export"], third);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Several semantic implementations are active in this repository: other, test-implementation/);
});

function spawnResult(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function spawnSyncChecked(command, args, cwd) {
  const result = spawnResult(command, args, cwd);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runAsync(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
