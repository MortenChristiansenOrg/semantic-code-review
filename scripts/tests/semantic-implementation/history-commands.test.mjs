import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createRepository,
  semanticCli,
  finalizeStage,
  initializeImplementation,
  implementationFromScript,
  organizeStage,
} from "../helpers/repository.mjs";
import { createViewerDataSource } from "../../src/semantic-view.ts";

test("restack refreshes an edited stage branch and rebuilds branches above it", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  const originalPolicy = finalizeStage(repository, {
    id: "policy",
    file: "policy.txt",
    contents: "policy v1\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  const originalPersistence = finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  const correction = repository.git("rev-parse", "HEAD");
  // A stage branch that is a symbolic ref would move the branch it names.
  repository.git("branch", "unrelated", "main");
  const persistenceRef = "refs/heads/semantic-flow/test-implementation/stages/persistence";
  repository.git("update-ref", "-d", persistenceRef);
  repository.git("symbolic-ref", persistenceRef, "refs/heads/unrelated");
  repository.expectSemanticFailure("is a symbolic ref", "restack", "--from", "policy");
  assert.equal(repository.git("rev-parse", "unrelated"), repository.git("rev-parse", "main"));
  repository.git("symbolic-ref", "--delete", persistenceRef);
  repository.git("update-ref", persistenceRef, originalPersistence);
  const output = repository.semantic("restack", "--from", "policy");
  assert.match(
    output,
    /Restacked 2 stage\(s\) from policy; rewrote 2 branches\./,
  );
  assert.doesNotMatch(output, /[0-9a-f]{40}/);

  const rewrittenPolicy = repository.artifact.stage("policy").change.headRevision;
  const rewrittenPersistence = repository.artifact.stage("persistence").change.headRevision;
  assert.notEqual(rewrittenPolicy, originalPolicy);
  assert.notEqual(rewrittenPersistence, originalPersistence);
  assert.equal(
    repository.git("rev-parse", "semantic-flow/test-implementation/stages/persistence"),
    rewrittenPersistence,
  );
  assert.equal(repository.read("policy.txt"), "policy v2\n");
  // The correction is folded into the stage's one commit; the checkout stays clean on it.
  assert.equal(repository.git("rev-list", "--count", `main..${rewrittenPolicy}`), "1");
  repository.git("merge-base", "--is-ancestor", correction, "refs/semantic-review/active/test-implementation");
  assert.equal(repository.git("rev-parse", "HEAD"), rewrittenPolicy);
  assert.equal(repository.git("status", "--porcelain"), "");
  repository.semantic("validate", "--publish");
});

test("restack replays a stage rebuilt on the correction below from that correction", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: "0\n" });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: "u\n" });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  const correction = repository.commitFile("shared.txt", "1\n", "Correct policy");
  // The stage above is rebuilt on the correction and changes the same line.
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", correction);
  repository.commitFile("shared.txt", "2\n", "Build on the corrected policy");
  repository.git("switch", `${prefix}/policy`);
  repository.semantic("restack", "--from", "policy");
  const api = `${prefix}/api`;
  assert.equal(repository.git("show", `${api}:shared.txt`), "2");
  assert.equal(repository.git("rev-parse", `${api}^`), repository.git("rev-parse", `${prefix}/policy`));
  assert.equal(repository.git("show", `${prefix}/policy:shared.txt`), "1");
});

test("restack keeps the changes of a stage rebuilt on an earlier correction below", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, last) => `${first}\na\nb\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  const correction = repository.commitFile("shared.txt", lines(1, "x"), "Correct policy");
  // The stage above is rebuilt on that correction and sets the first line back.
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", correction);
  repository.commitFile("shared.txt", lines(0, "x"), "Keep the original value");
  // A later correction below changes only the last line.
  repository.git("switch", `${prefix}/policy`);
  repository.commitFile("shared.txt", lines(1, "y"), "Correct the policy again");
  repository.semantic("restack", "--from", "policy");
  assert.equal(repository.git("show", `${prefix}/api:shared.txt`), lines(0, "y").trimEnd());
});

test("restack replays a stage rebuilt on an amended stage below from that stage", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, last) => `${first}\na\nb\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  repository.git("switch", `${prefix}/policy`);
  // The stage's commit is amended, then corrected again.
  repository.write("shared.txt", lines(1, "x"));
  repository.git("commit", "--quiet", "--amend", "--all", "--no-edit");
  repository.commitFile("shared.txt", lines(1, "y"), "Correct the policy again");
  const below = repository.git("rev-parse", "HEAD");
  repository.git("switch", `${prefix}/api`);
  repository.git("reset", "--quiet", "--hard", below);
  repository.commitFile("shared.txt", lines("u", "y"), "Rebuild the API on the policy");
  repository.git("switch", `${prefix}/policy`);
  repository.semantic("restack", "--from", "policy");
  assert.equal(repository.git("show", `${prefix}/api:shared.txt`), lines("u", "y").trimEnd());
});

test("restack stops when the stage below took in a stage's commit", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const lines = (first, middle, last) => `${first}\na\n${middle}\nc\nd\n${last}\n`;
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "shared.txt", contents: lines(0, "m", "x") });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  const api = finalizeStage(repository, { id: "api", file: "shared.txt", contents: lines("u", "m", "x") });
  const prefix = "semantic-flow/test-implementation/stages";
  // The stage below takes in the API's commit, reverts its edit and corrects its own line.
  repository.git("switch", `${prefix}/policy`);
  repository.git("merge", "--quiet", "--ff-only", api);
  repository.commitFile("shared.txt", lines(0, "m", "x"), "Take the API edit back out");
  repository.commitFile("shared.txt", lines(0, "m", "y"), "Correct the policy");
  // The API stage adds a second edit.
  repository.git("switch", `${prefix}/api`);
  repository.commitFile("shared.txt", lines("u", "n", "x"), "Extend the API");
  repository.git("switch", `${prefix}/policy`);
  const before = repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  repository.expectSemanticFailure(`Stage policy holds the commit ${api} of stage api`, "restack", "--from", "policy");
  assert.equal(repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), before);
});

test("restack onto a target that merged a stage is not refused when a stage below was rebuilt on it", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const prefix = "semantic-flow/test-implementation/stages";
  beginStage(repository, { id: "a" });
  finalizeStage(repository, { id: "a", file: "settings.txt", contents: "a\n" });
  beginStage(repository, { id: "b", dependencies: ["a"] });
  const b = finalizeStage(repository, { id: "b", file: "b.txt", contents: "b\n" });
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", b);
  repository.commitFile("settings.txt", "main\n", "Edit the settings on the target");
  repository.git("rm", "--quiet", "b.txt");
  repository.git("commit", "--quiet", "-m", "Remove b on the target");
  // The stage below is rebuilt on the target, which holds stage b's commit.
  repository.git("switch", `${prefix}/a`);
  repository.git("reset", "--quiet", "--hard", "main");
  repository.commitFile("settings.txt", "resolved\n", "Resolve the settings");
  repository.git("switch", "--detach");
  repository.semantic("restack", "--base", "main");
  assert.equal(repository.git("show", `${prefix}/a:settings.txt`), "resolved");
});

test("restack accepts several edited stage heads in one pass", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, {
    id: "policy",
    file: "policy.txt",
    contents: "policy v1\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });
  beginStage(repository, {
    id: "api",
    dependencies: ["persistence"],
  });
  const originalApi = finalizeStage(repository, {
    id: "api",
    file: "api.txt",
    contents: "api v1\n",
  });

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("policy.txt", "policy v2\n", "Fix policy");
  repository.git("switch", "semantic-flow/test-implementation/stages/persistence");
  repository.write("persistence.txt", "persistence v2\n");
  repository.git("add", "persistence.txt");
  repository.git(
    "commit",
    "--author",
    "Original Author <original@example.test>",
    "-m",
    "Fix persistence",
  );
  repository.expectSemanticFailure(
    "requires checked-out stage branch",
    "restack",
    "--from",
    "policy",
  );
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.expectSemanticFailure(
    "either --from or --base",
    "restack",
    "--from",
    "policy",
    "--base",
    "main",
  );

  const result = JSON.parse(
    repository.semantic("restack", "--from", "policy", "--json"),
  );
  assert.equal(result.refreshedStages, 3);
  assert.equal(result.rewrittenBranches, 3);
  assert.deepEqual(
    result.stages.map(({ id, rewritten }) => ({ id, rewritten })),
    [
      { id: "policy", rewritten: true },
      { id: "persistence", rewritten: true },
      { id: "api", rewritten: true },
    ],
  );
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:persistence.txt",
    ),
    "persistence v2",
  );
  assert.equal(
    repository.git(
      "show",
      "-s",
      "--format=%an <%ae>%n%B",
      "semantic-flow/test-implementation/stages/persistence",
    ),
    // The fold is authored by whoever ran it; the correction's author is a co-author.
    "Semantic Flow Test <semantic-flow@example.invalid>\nImplement behavior\n\nAdd the implementation.\n\nCo-authored-by: Original Author <original@example.test>",
  );
  for (const stage of ["policy", "persistence", "api"]) {
    const head = repository.git("rev-parse", `semantic-flow/test-implementation/stages/${stage}`);
    assert.equal(repository.git("rev-list", "--count", `${head}^..${head}`), "1");
  }
  assert.notEqual(
    repository.git("rev-parse", "semantic-flow/test-implementation/stages/api"),
    originalApi,
  );
  repository.semantic("validate", "--publish");
});

/** The worktree a conflicting restack reports for its resolution. */
function conflictWorktree(failure) {
  const worktree = /Resolve the conflict in (.+?): edit the files/.exec(`${failure.stdout}\n${failure.stderr}`)?.[1];
  assert.ok(worktree, failure.stderr);
  return worktree;
}

const gitIn = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A three-stage stack whose top stage conflicts with a correction of the stage below it. */
function conflictingStack(t) {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy=original\n" });
  beginStage(repository, { id: "persistence", dependencies: ["policy"] });
  finalizeStage(repository, { id: "persistence", file: "shared.txt", contents: "setting=original\npersistence=true\n" });
  beginStage(repository, { id: "api", dependencies: ["persistence"] });
  const originalApi = finalizeStage(repository, { id: "api", file: "shared.txt", contents: "setting=api\npersistence=true\napi=true\n" });
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("policy.txt", "policy=revised\n", "Revise policy");
  repository.git("switch", "semantic-flow/test-implementation/stages/persistence");
  repository.commitFile("shared.txt", "setting=persistence\npersistence=true\n", "Revise persistence");
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  return { repository, originalApi };
}

test("a restack conflict leaves Git conflict state in a scratch worktree until restack --continue", (t) => {
  const { repository, originalApi } = conflictingStack(t);
  // A title changed before the restack reaches the stage that conflicts.
  repository.semantic("stage", "set", "--finalized", "--id", "api", "--title", "Serve the API");
  const branches = () => repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const before = branches();
  const failure = repository.expectSemanticFailure("stopped at a conflict in shared.txt", "restack", "--from", "policy");
  assert.match(failure.stderr, /No stage refs were changed\./);
  const worktree = conflictWorktree(failure);
  // The user's checkouts and every ref are untouched; the restack is recorded as pending.
  assert.equal(branches(), before);
  assert.equal(repository.git("status", "--porcelain"), "");
  assert.equal(repository.artifact.stage("api").change.headRevision, originalApi);
  assert.ok(repository.artifact.exists(".work/restack.json"));
  assert.ok(!worktree.startsWith(repository.root));
  assert.match(gitIn(worktree, "ls-files", "--unmerged"), /shared\.txt/);
  assert.match(fs.readFileSync(path.join(worktree, "shared.txt"), "utf8"), /^<<<<<<< /m);
  repository.expectSemanticFailure("restack stopped at a conflict in stage api", "validate");
  repository.expectSemanticFailure("restack stopped at a conflict in stage api", "restack", "--from", "policy");
  repository.expectSemanticFailure("Resolve and stage these files", "restack", "--continue");

  fs.writeFileSync(path.join(worktree, "shared.txt"), "setting=draft\n");
  gitIn(worktree, "add", "shared.txt");
  fs.writeFileSync(path.join(worktree, "shared.txt"), "setting=resolved\npersistence=true\napi=true\n");
  repository.expectSemanticFailure("unstaged changes", "restack", "--continue");
  gitIn(worktree, "add", "shared.txt");
  // So would an edit to another tracked file.
  fs.writeFileSync(path.join(worktree, "policy.txt"), "policy=edited\n");
  repository.expectSemanticFailure("policy.txt", "restack", "--continue");
  gitIn(worktree, "checkout", "--", "policy.txt");
  // A new file that is not added would be lost too.
  fs.writeFileSync(path.join(worktree, "notes.txt"), "notes\n");
  repository.expectSemanticFailure("notes.txt", "restack", "--continue");
  fs.rmSync(path.join(worktree, "notes.txt"));
  // A --continue that cannot finish keeps the staged resolution for the next one.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-flow-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  repository.git("worktree", "add", path.join(other, "api"), "semantic-flow/test-implementation/stages/api");
  assert.match(repository.expectSemanticFailure("checked out in a worktree", "restack", "--continue").stderr, /git switch --detach/);
  assert.equal(gitIn(worktree, "show", ":shared.txt"), "setting=resolved\npersistence=true\napi=true");
  repository.git("worktree", "remove", path.join(other, "api"));
  const result = JSON.parse(repository.semantic("restack", "--continue", "--json"));
  assert.deepEqual(result.stages.map(({ id, rewritten }) => ({ id, rewritten })),
    [{ id: "policy", rewritten: true }, { id: "persistence", rewritten: true }, { id: "api", rewritten: true }]);
  const api = "semantic-flow/test-implementation/stages/api";
  assert.equal(repository.git("show", `${api}:shared.txt`), "setting=resolved\npersistence=true\napi=true");
  assert.equal(repository.git("show", `${api}:policy.txt`), "policy=revised");
  // The resolved stage keeps its author and takes its current title.
  assert.equal(repository.git("show", "-s", "--format=%B", api), repository.git("show", "-s", "--format=%B", originalApi).replace(/^.*/, "Serve the API"));
  assert.equal(repository.git("show", "-s", "--format=%an <%ae> %aI", api), repository.git("show", "-s", "--format=%an <%ae> %aI", originalApi));
  assert.equal(repository.git("rev-list", "--count", `${api}^..${api}`), "1");
  assert.equal(fs.existsSync(worktree), false);
  assert.doesNotMatch(repository.git("worktree", "list"), new RegExp(path.basename(worktree)));
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
  repository.semantic("validate", "--publish");
});

test("restack --continue refuses once a ref moved, and restack --abort discards the restack", (t) => {
  const { repository } = conflictingStack(t);
  const worktree = conflictWorktree(repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "policy"));
  // A reset there discards the conflict, so the restack cannot be continued.
  gitIn(worktree, "reset", "--quiet", "--hard");
  repository.expectSemanticFailure("no longer holds the conflict of stage api", "restack", "--continue");
  fs.writeFileSync(path.join(worktree, "shared.txt"), "setting=resolved\npersistence=true\napi=true\n");
  gitIn(worktree, "add", "shared.txt");
  const api = "refs/heads/semantic-flow/test-implementation/stages/api";
  const apiHead = repository.git("rev-parse", api);
  repository.git("update-ref", api, repository.git("rev-parse", `${apiHead}^`), apiHead);
  repository.expectSemanticFailure(`${api} changed since the restack began`, "restack", "--continue");
  repository.git("update-ref", api, apiHead);
  // A write to the artifact meanwhile is a change too.
  const policy = repository.artifact.readJson("stages/policy.json");
  repository.artifact.write("stages/policy.json", { ...policy, rationale: "Changed meanwhile." });
  repository.expectSemanticFailure("semantic implementation changed since the restack began", "restack", "--continue");

  repository.semantic("restack", "--abort");
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
  assert.equal(repository.git("rev-parse", api), apiHead);
  repository.expectSemanticFailure("No restack is pending", "restack", "--abort");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "policy");
  repository.semantic("restack", "--abort");
});

test("restack --continue notices any artifact change, and restack --abort removes an unreadable record", (t) => {
  const { repository } = conflictingStack(t);
  const worktree = conflictWorktree(repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "policy"));
  fs.writeFileSync(path.join(worktree, "shared.txt"), "setting=resolved\npersistence=true\napi=true\n");
  gitIn(worktree, "add", "shared.txt");
  // Any artifact file written meanwhile counts, also one under .work.
  repository.artifact.write(".work/extra.txt", "extra\n");
  repository.expectSemanticFailure("semantic implementation changed since the restack began", "restack", "--continue");
  repository.artifact.remove(".work/extra.txt");

  // A damaged record cannot be continued, but it can be aborted; its fields are not trusted.
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-flow-decoy-"));
  t.after(() => fs.rmSync(decoy, { recursive: true, force: true }));
  repository.artifact.write(".work/restack.json", { worktree: decoy });
  repository.expectSemanticFailure("does not describe a restack", "restack", "--continue");
  const aborted = repository.result(process.execPath, [...semanticCli, "restack", "--abort"]);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.match(aborted.stderr, /does not describe a restack/);
  assert.equal(repository.artifact.exists(".work/restack.json"), false);
  assert.equal(fs.existsSync(decoy), true);
  assert.equal(fs.existsSync(worktree), false);
  // The corrections are still waiting for a restack, which now starts afresh.
  repository.expectSemanticFailure("run restack --from policy", "validate");
  repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "policy");
});

test("restack carries a stage's edit into a file the target renamed", (t) => {
  const repository = createRepository(t);
  repository.commitFile("settings.txt", "one\ntwo\nthree\n", "Add settings");
  initializeImplementation(repository);
  beginStage(repository);
  const stageHead = finalizeStage(repository, { file: "settings.txt", contents: "one\ntwo\nthree\nfour\n" });
  repository.git("switch", "main");
  repository.git("mv", "settings.txt", "config.txt");
  repository.git("commit", "-m", "Rename settings");
  // No hook runs in the scratch worktree.
  const hooks = path.join(repository.git("rev-parse", "--path-format=absolute", "--git-path", "hooks"));
  fs.mkdirSync(hooks, { recursive: true });
  const marker = path.join(repository.root, "..", `${path.basename(repository.root)}-hook-ran`);
  t.after(() => fs.rmSync(marker, { force: true }));
  for (const hook of ["post-checkout", "pre-commit", "post-commit"]) {
    fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
  }

  repository.semantic("restack", "--base", "main");
  const branch = "semantic-flow/test-implementation/stages/implementation";
  assert.equal(repository.git("show", `${branch}:config.txt`), "one\ntwo\nthree\nfour");
  assert.notEqual(repository.result("git", ["cat-file", "-e", `${branch}:settings.txt`]).status, 0);
  assert.equal(repository.git("rev-parse", `${branch}^`), repository.git("rev-parse", "main"));
  assert.equal(repository.git("show", "-s", "--format=%B", branch), repository.git("show", "-s", "--format=%B", stageHead));
  assert.equal(fs.existsSync(marker), false);
});

test("restack reports a stage file the target's directory rename moves as a conflict", (t) => {
  const repository = createRepository(t);
  repository.commitFile("docs/index.txt", "index\n", "Add docs");
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { file: "docs/guide.txt", contents: "guide\n" });
  repository.git("switch", "main");
  repository.git("mv", "docs", "manual");
  repository.git("commit", "-m", "Rename docs");

  const failure = repository.expectSemanticFailure("stopped at a conflict in manual/guide.txt", "restack", "--base", "main");
  const worktree = conflictWorktree(failure);
  gitIn(worktree, "add", "manual/guide.txt");
  repository.semantic("restack", "--continue");
  const branch = "semantic-flow/test-implementation/stages/implementation";
  assert.equal(repository.git("show", `${branch}:manual/guide.txt`), "guide");
  assert.notEqual(repository.result("git", ["cat-file", "-e", `${branch}:docs/guide.txt`]).status, 0);
  // The stage's nodes still name the old path until the stage is organized again.
  repository.expectSemanticFailure("manual/guide.txt", "validate");
});

test("a stage the target already contains stays as a marked empty stage that preparation skips", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  beginStage(repository, { id: "api", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "api.txt", contents: "api\n" });
  const policy = "semantic-flow/test-implementation/stages/policy";
  const originalPolicy = repository.git("rev-parse", policy);
  repository.git("switch", "main");
  repository.commitFile("policy.txt", "policy\n", "Land the policy elsewhere");

  const restacked = repository.semantic("restack", "--base", "main");
  assert.match(restacked, /Stage\(s\) policy now change nothing, because the target or the stages below already contain their changes\./);
  assert.doesNotMatch(restacked, /resolution/);
  const result = { stages: repository.artifact.implementation().manifest.stages.map((id) => ({ id, emptied: repository.artifact.stage(id).change.files.length === 0 })) };
  assert.deepEqual(result.stages.map(({ id, emptied }) => ({ id, emptied })), [{ id: "policy", emptied: true }, { id: "api", emptied: false }]);
  assert.equal(repository.git("rev-parse", `${policy}^`), repository.git("rev-parse", "main"));
  assert.equal(repository.git("rev-parse", `${policy}^{tree}`), repository.git("rev-parse", "main^{tree}"));
  // The marker names the stage commit it replaced.
  const marker = new RegExp(`^Semantic-Flow-Empty: ${originalPolicy}$`, "m");
  assert.match(repository.git("show", "-s", "--format=%B", policy), marker);
  assert.deepEqual(repository.artifact.stage("policy").change.files, []);
  repository.semantic("validate", "--publish");
  // The viewer shows the emptied stage with its nodes and no diff.
  const viewed = implementationFromScript(createViewerDataSource(repository.root).implementationDataScript());
  assert.deepEqual(viewed.stages.map((stage) => [stage.id, stage.empty ?? false]), [["policy", true], ["api", false]]);
  // A replacement ref that rewrites the stage commit's parents changes nothing the viewer decides.
  const policyHead = repository.git("rev-parse", policy);
  repository.git("replace", "--graft", policyHead, "main~1");
  const replaced = implementationFromScript(createViewerDataSource(repository.root).implementationDataScript());
  assert.deepEqual(replaced.stages.map((stage) => [stage.id, stage.empty ?? false]), [["policy", true], ["api", false]]);
  repository.git("replace", "--delete", policyHead);
  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.deepEqual(stack.emptyStages, ["policy"]);
  assert.deepEqual(stack.stages.map(({ stageId, baseBranch, position }) => ({ stageId, baseBranch, position })), [{ stageId: "api", baseBranch: "main", position: 1 }]);
  // Every command that reports on the stack counts the empty stage as finalized and names it.
  const counted = /2 finalized stage\(s\) \(1 empty: policy\)/;
  assert.match(repository.semantic("validate", "--publish"), counted);
  const flowValidation = repository.flow("validate", "--publish", "--stack");
  assert.match(flowValidation, counted);
  assert.match(flowValidation, /^Skipped empty stage\(s\): policy$/m);
  assert.match(repository.flow("status"), /^Stages: 2 finalized stage\(s\) \(1 empty: policy\), 0 working stage\(s\)$/m);
  assert.deepEqual(JSON.parse(repository.flow("status", "--json")).emptyStages, ["policy"]);
  const stackReport = repository.semantic("validate-stack");
  assert.match(stackReport, /^Local stage stack valid \(1 stage\(s\) to prepare of 2 finalized stage\(s\) \(1 empty: policy\)\):$/m);
  assert.match(stackReport, /^Skipped empty stage\(s\): policy$/m);
  // Restacking again keeps it empty, and says so without a reason that no longer applies.
  repository.commitFile("other.txt", "other\n", "Other work");
  const again = repository.semantic("restack", "--base", "main");
  assert.match(again, /Stage\(s\) policy stay empty\./);
  assert.doesNotMatch(again, /now change nothing/);
  assert.match(repository.git("show", "-s", "--format=%B", policy), marker);
  repository.semantic("validate", "--publish");
  // Once the target no longer contains them, the stage's changes come back, after garbage collection too.
  repository.git("gc", "--quiet", "--prune=now");
  repository.git("rm", "--quiet", "policy.txt");
  repository.git("commit", "--quiet", "-m", "Revert the policy");
  const revived = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.deepEqual(revived.stages.map(({ id, emptied }) => ({ id, emptied })), [{ id: "policy", emptied: false }, { id: "api", emptied: false }]);
  assert.deepEqual(repository.artifact.stage("policy").change.files.map((file) => file.path), ["policy.txt"]);
  assert.equal(repository.git("show", `${policy}:policy.txt`), "policy");
  repository.semantic("validate", "--publish");
});

test("a stage the target fast-forwarded to is emptied, and preparing an all-empty stack is refused", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  const head = finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", head);
  const result = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.deepEqual(result.stages.map(({ id, emptied }) => ({ id, emptied })), [{ id: "policy", emptied: true }]);
  repository.semantic("validate", "--publish");
  repository.expectSemanticFailure("Every stage of test-implementation is empty", "prepare-branch", "--branch", "review/policy");
  // A target that fast-forwarded to the stage and then reverted it gets the stage's changes back.
  repository.git("revert", "--quiet", "--no-edit", head);
  const reverted = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.deepEqual(reverted.stages.map(({ id, emptied }) => ({ id, emptied })), [{ id: "policy", emptied: false }]);
  assert.equal(repository.git("show", "semantic-flow/test-implementation/stages/policy:policy.txt"), "policy");
});

test("a correction that drops every change of a stage says so when the stage replays onto an advanced target", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  const policy = "semantic-flow/test-implementation/stages/policy";
  repository.git("switch", policy);
  repository.git("rm", "--quiet", "policy.txt");
  repository.git("commit", "--quiet", "--no-verify", "-m", "Drop the policy");
  repository.git("switch", "main");
  repository.commitFile("other.txt", "other\n", "Other work");
  const restacked = repository.semantic("restack", "--base", "main");
  assert.match(restacked, /Stage\(s\) policy now change nothing, because a conflict resolution or a correction dropped their changes\./);
  assert.match(repository.git("show", "-s", "--format=%B", policy), /^Semantic-Flow-Empty: resolved$/m);
});

test("a correction to an emptied stage warns that its replaced commit no longer comes back", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  const head = finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  repository.git("switch", "main");
  repository.git("merge", "--quiet", "--ff-only", head);
  repository.semantic("restack", "--base", "main");
  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("docs.txt", "docs\n", "Correct policy");
  const corrected = repository.result(process.execPath, [...semanticCli, "restack", "--from", "policy"]);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.match(corrected.stderr, new RegExp(`stage policy was empty in place of ${head}; its correction now defines the stage`));
});

test("restack rebuilds a finalized stage's commit message after its title or summary changes", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy", title: "Add policy", summary: "Define the policy." });
  // A second author's commit makes the folded stage carry a co-author trailer.
  repository.commitFile("policy-notes.txt", "notes\n", "Note the policy\n\nCo-authored-by: Bob Pair <bob@example.test>");
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  beginStage(repository, { id: "api", title: "Add API", summary: "Expose the policy.", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "api.txt", contents: "api\n" });
  const policy = "semantic-flow/test-implementation/stages/policy";
  const api = "semantic-flow/test-implementation/stages/api";
  const show = (format, ref) => repository.git("show", "-s", `--format=${format}`, ref);
  const originalPolicy = repository.git("rev-parse", policy);
  const identity = show("%an <%ae> %aI|%cn <%ce> %cI", policy);
  assert.equal(show("%B", policy), "Add policy\n\nDefine the policy.\n\nCo-authored-by: Bob Pair <bob@example.test>");

  const updated = repository.semantic("stage", "set", "--finalized", "--id", "policy", "--title", "Add the access policy", "--summary", "Define who may read orders.");
  assert.match(updated, /commit message takes the new title and summary at the next restack/);
  // Nothing moves until the restack.
  assert.equal(repository.git("rev-parse", policy), originalPolicy);
  repository.git("switch", policy);
  const result = JSON.parse(repository.semantic("restack", "--from", "policy", "--json"));
  assert.deepEqual(result.stages.map(({ id, rewritten }) => ({ id, rewritten })), [{ id: "policy", rewritten: true }, { id: "api", rewritten: true }]);
  const expected = "Add the access policy\n\nDefine who may read orders.\n\nCo-authored-by: Bob Pair <bob@example.test>";
  assert.equal(show("%B", policy), expected);
  // Only the message changed: the tree, parent, authors and dates are the stage commit's.
  assert.equal(repository.git("rev-parse", `${policy}^{tree}`), repository.git("rev-parse", `${originalPolicy}^{tree}`));
  assert.equal(repository.git("rev-parse", `${policy}^`), repository.git("rev-parse", `${originalPolicy}^`));
  assert.equal(show("%an <%ae> %aI|%cn <%ce> %cI", policy), identity);
  assert.equal(repository.git("rev-parse", `${api}^`), repository.git("rev-parse", policy));
  assert.equal(show("%B", api), "Add API\n\nExpose the policy.");
  repository.semantic("validate", "--publish");
  // A restack with nothing to change rewrites nothing.
  const again = JSON.parse(repository.semantic("restack", "--from", "policy", "--json"));
  assert.equal(again.rewrittenBranches, 0);

  // A replayed stage takes its current title too, and an emptied one keeps its marker.
  repository.semantic("stage", "set", "--finalized", "--id", "api", "--title", "Serve the policy");
  repository.git("switch", "main");
  repository.commitFile("policy.txt", "policy\n", "Land the policy elsewhere");
  repository.commitFile("policy-notes.txt", "notes\n", "Land the notes elsewhere");
  const emptied = repository.git("rev-parse", policy);
  repository.semantic("stage", "set", "--finalized", "--id", "policy", "--summary", "Define who may change orders.");
  const restacked = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.deepEqual(restacked.stages.map(({ id, emptied }) => ({ id, emptied })), [{ id: "policy", emptied: true }, { id: "api", emptied: false }]);
  assert.equal(show("%B", policy), `Add the access policy\n\nDefine who may change orders.\n\nSemantic-Flow-Empty: ${emptied}\nCo-authored-by: Bob Pair <bob@example.test>`);
  assert.equal(show("%B", api), "Serve the policy\n\nExpose the policy.");
  // A later title change reaches the empty stage's commit and keeps the marker.
  repository.semantic("stage", "set", "--finalized", "--id", "policy", "--title", "Add the order policy");
  repository.commitFile("other.txt", "other\n", "Other work");
  repository.semantic("restack", "--base", "main");
  assert.equal(show("%B", policy), `Add the order policy\n\nDefine who may change orders.\n\nSemantic-Flow-Empty: ${emptied}\nCo-authored-by: Bob Pair <bob@example.test>`);
  repository.semantic("validate", "--publish");
});

test("a rebuilt stage message keeps its trailers under any trailer separator and gains none from its summary", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy", title: "Add policy", summary: "Define the policy." });
  repository.commitFile("policy-notes.txt", "notes\n", "Note the policy\n\nCo-authored-by: Bob Pair <bob@example.test>");
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  beginStage(repository, { id: "api", title: "Add API", summary: "Expose the policy.", dependencies: ["policy"] });
  finalizeStage(repository, { id: "api", file: "api.txt", contents: "api\n" });
  const policy = "semantic-flow/test-implementation/stages/policy";
  const api = "semantic-flow/test-implementation/stages/api";
  // Under another trailer separator the colon trailers still count.
  repository.git("config", "trailer.separators", "=");
  repository.semantic("stage", "set", "--finalized", "--id", "policy", "--title", "Add the access policy");
  // A summary that ends in a trailer-like paragraph gives no credit.
  repository.semantic("stage", "set", "--finalized", "--id", "api", "--summary", "Expose the policy, crediting like this:\n\nCo-authored-by: Example Person <example@example.test>");
  // A summary that quotes a real trailer mid-text keeps the trailer.
  repository.semantic("stage", "set", "--finalized", "--id", "policy", "--summary", "Define the policy.\nCo-authored-by: Bob Pair <bob@example.test>\nsaid so.");
  repository.git("switch", "main");
  repository.commitFile("other.txt", "other\n", "Other work");
  repository.semantic("restack", "--base", "main");
  const policyMessage = "Add the access policy\n\nDefine the policy.\nCo-authored-by: Bob Pair <bob@example.test>\nsaid so.\n\nCo-authored-by: Bob Pair <bob@example.test>";
  const apiMessage = "Add API\n\nExpose the policy, crediting like this:\n\nCo-authored-by: Example Person <example@example.test>";
  assert.equal(repository.git("show", "-s", "--format=%B", policy), policyMessage);
  assert.equal(repository.git("show", "-s", "--format=%B", api), apiMessage);
  // A second restack rewrites nothing.
  assert.equal(JSON.parse(repository.semantic("restack", "--base", "main", "--json")).rewrittenBranches, 0);
  assert.equal(repository.git("show", "-s", "--format=%B", api), apiMessage);
  assert.equal(repository.git("show", "-s", "--format=%B", policy), policyMessage);
  // A correction credited with the configured separator keeps the stage's colon co-author too.
  repository.git("switch", policy);
  repository.commitFile("policy.txt", "policy fixed\n", "Fix the policy\n\nCo-authored-by=Carol Fixer <carol@example.test>");
  repository.semantic("restack", "--from", "policy");
  assert.match(repository.git("show", "-s", "--format=%B", policy), /Co-authored-by: Bob Pair <bob@example\.test>\nCo-authored-by: Carol Fixer <carol@example\.test>$/);
  repository.semantic("validate", "--publish");
});

test("restack keeps non-ASCII names and messages under another log output encoding", (t) => {
  const repository = createRepository(t);
  repository.git("config", "user.name", "Zoë Lindqvist");
  repository.git("config", "i18n.logOutputEncoding", "ISO-8859-1");
  repository.git("config", "i18n.commitEncoding", "ISO-8859-1");
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { file: "menu.txt", contents: "crème\n" });
  repository.git("switch", "main");
  repository.commitFile("other.txt", "other\n", "Advance main");
  repository.semantic("restack", "--base", "main");
  const branch = "semantic-flow/test-implementation/stages/implementation";
  const show = (format) => repository.git("-c", "i18n.logOutputEncoding=UTF-8", "show", "-s", `--format=${format}`, branch);
  assert.equal(show("%an|%cn"), "Zoë Lindqvist|Zoë Lindqvist");
  assert.equal(repository.git("rev-parse", `${branch}^`), repository.git("rev-parse", "main"));
  assert.doesNotMatch(show("%B"), /\uFFFD/);
});

test("a stage resolved to nothing at a conflict stays empty in later restacks", (t) => {
  const { repository } = conflictingStack(t);
  const worktree = conflictWorktree(repository.expectSemanticFailure("stopped at a conflict", "restack", "--from", "policy"));
  // The resolution keeps the lower stages' version: the API stage's change is dropped.
  gitIn(worktree, "checkout", "--ours", "--", "shared.txt");
  gitIn(worktree, "add", "shared.txt");
  const continued = repository.semantic("restack", "--continue");
  assert.match(continued, /Stage\(s\) api now change nothing, because a conflict resolution or a correction dropped their changes\./);
  assert.equal(repository.artifact.stage("api").change.files.length, 0);
  const api = "semantic-flow/test-implementation/stages/api";
  assert.match(repository.git("show", "-s", "--format=%B", api), /^Semantic-Flow-Empty: resolved$/m);
  repository.semantic("validate", "--publish");
  repository.git("switch", "main");
  repository.commitFile("other.txt", "other\n", "Other work");
  const again = JSON.parse(repository.semantic("restack", "--base", "main", "--json"));
  assert.equal(again.stages.find(({ id }) => id === "api").emptied, true);
  assert.match(repository.git("show", "-s", "--format=%B", api), /^Semantic-Flow-Empty: resolved$/m);
});

test("restack applies the finalized net stage diff", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, {
    id: "policy",
    file: "shared.txt",
    contents: "original\n",
  });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  repository.write("shared.txt", "temporary\n");
  repository.write("persistence.txt", "persistence\n");
  repository.git("add", "shared.txt", "persistence.txt");
  repository.git("commit", "-m", "Implement persistence");
  organizeStage(repository, { id: "persistence" });
  repository.semantic("stage", "finish", "--id", "persistence");

  repository.commitFile("shared.txt", "original\n", "Restore shared file");
  const organization = {
    $schema:
      "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
    nodes: [
      {
        id: "implementation-change",
        description: "Implement the persistence behavior.",
        changes: [
          {
            path: "persistence.txt",
            classification: "behavior",
          },
        ],
      },
    ],
    itemLinks: [],
  };
  repository.write(
    "organization.json",
    `${JSON.stringify(organization, null, 2)}\n`,
  );
  try {
    repository.semantic(
      "stage",
      "organize",
      "--stage",
      "persistence",
      "--file",
      "organization.json",
      "--finalized",
    );
  } finally {
    repository.remove("organization.json");
  }

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("shared.txt", "revised\n", "Address policy feedback");
  repository.semantic("restack", "--from", "policy");

  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:shared.txt",
    ),
    "revised",
  );
  assert.equal(
    repository.git(
      "show",
      "semantic-flow/test-implementation/stages/persistence:persistence.txt",
    ),
    "persistence",
  );
  repository.semantic("validate", "--publish");
});

test("feedback can remove a finalized stage file before restacking", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  repository.write("keep.txt", "keep v1\n");
  repository.write("obsolete.txt", "obsolete\n");
  repository.git("add", "keep.txt", "obsolete.txt");
  repository.git("commit", "-m", "Implement policy");
  const organization = {
    $schema:
      "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
    nodes: [
      {
        id: "policy-change",
        description: "Implement the policy.",
        changes: ["keep.txt", "obsolete.txt"].map((path) => ({
          path,
          classification: "behavior",
        })),
      },
    ],
    itemLinks: [],
  };
  repository.write("organization.json", `${JSON.stringify(organization, null, 2)}\n`);
  repository.semantic(
    "stage",
    "organize",
    "--stage",
    "policy",
    "--file",
    "organization.json",
  );
  repository.remove("organization.json");
  repository.semantic("stage", "finish", "--id", "policy");

  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  finalizeStage(repository, {
    id: "persistence",
    file: "persistence.txt",
    contents: "persistence v1\n",
  });

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.write("keep.txt", "keep v2\n");
  repository.remove("obsolete.txt");
  repository.git("add", "-A");
  const correctedPolicy = repository.git(
    "commit",
    "-m",
    "Address policy feedback",
  );
  assert.match(correctedPolicy, /Address policy feedback/);

  repository.semantic(
    "stage",
    "record",
    "--stage",
    "policy",
    "--finalized",
    "--kind",
    "decision",
    "--item-id",
    "remove-obsolete-file",
    "--category",
    "engineering",
    "--summary",
    "Remove the obsolete file.",
    "--rationale",
    "The feedback showed that the file is unnecessary.",
    "--node-ref",
    "policy-change",
  );

  const revisedOrganization = {
    ...organization,
    nodes: [
      {
        ...organization.nodes[0],
        changes: [
          {
            path: "keep.txt",
            classification: "behavior",
          },
        ],
      },
    ],
    itemLinks: [
      {
        collection: "decisions",
        itemId: "remove-obsolete-file",
        nodeRefs: ["policy-change"],
      },
    ],
  };
  repository.write(
    "organization.json",
    `${JSON.stringify(revisedOrganization, null, 2)}\n`,
  );
  repository.semantic(
    "stage",
    "organize",
    "--stage",
    "policy",
    "--file",
    "organization.json",
    "--finalized",
  );
  repository.remove("organization.json");

  const policy = repository.artifact.stage("policy");
  assert.equal(
    policy.change.headRevision,
    repository.git("rev-parse", "HEAD"),
  );
  assert.deepEqual(policy.change.files, [
    {
      path: "keep.txt",
      kind: "added",
    },
  ]);

  // Until restacking, the stage above keeps building on the earlier policy head.
  const pending = repository.artifact.readJson("manifest.json").stages[1];
  assert.equal(pending.id, "persistence");
  assert.equal(pending.baseRevision, repository.artifact.stage("persistence").change.baseRevision);
  assert.notEqual(pending.baseRevision, policy.change.headRevision);
  repository.expectSemanticFailure(/Stage persistence still builds on [0-9a-f]{40}, not on the head [0-9a-f]{40} of stage policy; .*restack --from policy/, "validate");

  repository.semantic("restack", "--from", "policy");
  assert.deepEqual(Object.keys(repository.artifact.readJson("manifest.json").stages[1]).sort(), ["headRevision", "id"]);
  repository.semantic("validate", "--publish");
});

test("restack rebases every stage branch onto an advanced target", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const originalBase = repository.git("rev-parse", "HEAD");
  beginStage(repository, { id: "policy" });
  const policy = finalizeStage(repository, { id: "policy" });
  beginStage(repository, {
    id: "persistence",
    dependencies: ["policy"],
  });
  const persistence = finalizeStage(repository, { id: "persistence" });

  repository.expectSemanticFailure("restack requires --from", "restack");
  repository.git("switch", "main");
  const newBase = repository.commitFile(
    "base-update.txt",
    "new base\n",
    "Advance base",
  );
  // The target is checked, not deleted: a hook that refuses deleting it lets the restack through.
  const hooks = path.resolve(repository.root, repository.git("rev-parse", "--git-path", "hooks"));
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "reference-transaction"),
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\n',
    { mode: 0o755 });
  const targetReflog = repository.git("reflog", "--format=%H", "refs/heads/main");
  repository.semantic("restack", "--base", "main");
  assert.equal(repository.git("reflog", "--format=%H", "refs/heads/main"), targetReflog);
  const rebasedPolicy = repository.git(
    "rev-parse",
    "semantic-flow/test-implementation/stages/policy",
  );
  const rebasedPersistence = repository.git(
    "rev-parse",
    "semantic-flow/test-implementation/stages/persistence",
  );
  assert.equal(
    repository.artifact.readJson("manifest.json").baseRevision,
    newBase,
  );
  assert.equal(
    repository.artifact.stage("policy").change.headRevision,
    rebasedPolicy,
  );
  assert.equal(
    repository.artifact.stage("persistence").change.headRevision,
    rebasedPersistence,
  );
  assert.notEqual(rebasedPolicy, policy);
  assert.notEqual(rebasedPersistence, persistence);
  assert.notEqual(newBase, originalBase);
  repository.semantic("validate", "--publish");
});

/** Every stored file of the artifact except the manifest, with its bytes. */
function storedDocuments(repository) {
  return new Map(
    repository.artifact
      .list()
      .filter((file) => file !== "manifest.json")
      .map((file) => [file, repository.artifact.readBytes(file)]),
  );
}

/** Asserts the derived change of every stage follows from the manifest and Git. */
function assertDerivedStack(repository, branchPrefix) {
  const { manifest, stages } = repository.artifact.implementation();
  const stored = repository.artifact.readJson("manifest.json");
  let baseBranch = manifest.targetBranch, baseRevision = manifest.baseRevision;
  for (const [index, id] of manifest.stages.entries()) {
    const { change } = stages[id];
    const branch = `${branchPrefix}/stages/${id}`;
    assert.deepEqual(stored.stages[index], { id, headRevision: change.headRevision });
    assert.equal(change.branch, branch);
    assert.equal(change.baseBranch, baseBranch);
    assert.equal(change.baseRevision, baseRevision);
    assert.equal(change.headRevision, repository.git("rev-parse", branch));
    assert.deepEqual(
      change.files.map(({ path, kind }) => `${kind} ${path}`),
      repository
        .git("diff", "--name-status", "--no-renames", baseRevision, change.headRevision)
        .split("\n")
        .map((line) => {
          const [status, path] = line.split("\t");
          return `${{ A: "added", M: "modified", D: "deleted" }[status]} ${path}`;
        }),
    );
    baseBranch = branch;
    baseRevision = change.headRevision;
  }
  return stored;
}

test("restack rewrites only the manifest and the stage inventories follow from Git", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy v1\n" });
  beginStage(repository, { id: "persistence", dependencies: ["policy"] });
  finalizeStage(repository, { id: "persistence", file: "persistence.txt", contents: "persistence v1\n" });
  const prefix = "semantic-flow/test-implementation";
  const documents = storedDocuments(repository);
  // review.json holds the private review ID.
  assert.deepEqual([...documents.keys()], ["requirements/story.json", "review.json", "stages/persistence.json", "stages/policy.json"]);
  for (const [file, bytes] of documents) {
    if (file.endsWith(".json")) assert.equal("change" in JSON.parse(bytes), false, file);
  }
  const initial = assertDerivedStack(repository, prefix);

  // An edited stage branch moves the heads of it and every stage above it.
  repository.git("switch", `${prefix}/stages/policy`);
  repository.commitFile("policy.txt", "policy v2\n", "Revise policy");
  repository.semantic("restack", "--from", "policy");
  assert.deepEqual(storedDocuments(repository), documents);
  const edited = assertDerivedStack(repository, prefix);
  assert.equal(edited.baseRevision, initial.baseRevision);
  for (const index of [0, 1]) {
    assert.notEqual(edited.stages[index].headRevision, initial.stages[index].headRevision);
  }
  assert.deepEqual(
    repository.artifact.stage("policy").change.files.map(({ path }) => path),
    ["policy.txt"],
  );

  // An advanced target changes the base revision and every head, not the stage files.
  repository.git("switch", "main");
  const newBase = repository.commitFile("base-update.txt", "new base\n", "Advance base");
  repository.semantic("restack", "--base", "main");
  assert.deepEqual(storedDocuments(repository), documents);
  const rebased = assertDerivedStack(repository, prefix);
  assert.equal(rebased.baseRevision, newBase);
  for (const index of [0, 1]) {
    assert.notEqual(rebased.stages[index].headRevision, edited.stages[index].headRevision);
  }
  assert.deepEqual(
    repository.artifact.stage("policy").change.files.map(({ path }) => path),
    ["policy.txt"],
  );
  assert.equal(repository.git("show", `${prefix}/stages/persistence:policy.txt`), "policy v2");
  repository.semantic("validate");
});

test("finishing folds a stage's commits into one with a generated message and co-authors", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { title: "Add checks", summary: "Check the input before use." });
  repository.write("first.txt", "first\n");
  repository.git("add", "first.txt");
  repository.git("commit", "--author", "Ada Author <ada@example.test>", "-m", "First part");
  repository.commitFile("second.txt", "second\n", "Second part\n\nCo-authored-by: Bob Pair <bob@example.test>");
  repository.commitFile("third.txt", "third\n", "Third part\n\nCo-authored-by: Ada Author <ADA@example.test>");
  // Only the trailer block credits anyone; this line is part of the body.
  repository.commitFile("fourth.txt", "fourth\n", "Fourth part\n\nFor example:\nCo-authored-by: Example Person <example@example.test>\n\nNo trailers here.");
  // A malformed trailer value is ignored whole, whatever bytes it holds.
  repository.commitFile("fifth.txt", "fifth\n", "Fifth part\n\nCo-authored-by: Bad >\u0002Fake <fake@example.test>");
  repository.semantic("stage", "record", "--kind", "risk", "--item-id", "risk", "--summary", "May reject input",
    "--code-path", "second.txt", "--code-start", "1");
  const workHead = repository.git("rev-parse", "HEAD");
  organizeStage(repository);
  // A malformed option fails before the branch is rewritten.
  repository.expectSemanticFailure("Option --json is a flag", "stage", "finish", "--json=no");
  assert.equal(repository.git("rev-parse", "HEAD"), workHead);
  repository.semantic("stage", "finish");

  const head = repository.git("rev-parse", "HEAD");
  assert.notEqual(head, workHead);
  assert.equal(repository.git("rev-parse", `${head}^`), repository.git("rev-parse", "main"));
  assert.equal(repository.git("rev-parse", `${head}^{tree}`), repository.git("rev-parse", `${workHead}^{tree}`));
  assert.equal(repository.git("symbolic-ref", "--short", "HEAD"), "semantic-flow/test-implementation/stages/implementation");
  assert.equal(repository.git("status", "--porcelain"), "");
  assert.equal(
    repository.git("show", "-s", "--format=%an <%ae>%n%B", head),
    "Semantic Flow Test <semantic-flow@example.invalid>\nAdd checks\n\nCheck the input before use.\n\nCo-authored-by: Ada Author <ada@example.test>\nCo-authored-by: Bob Pair <bob@example.test>",
  );
  const stage = repository.artifact.stage("implementation");
  assert.equal(stage.change.headRevision, head);
  // A code target captured before the fold points at the folded commit.
  assert.equal(stage.risks[0].codeTarget.revision, head);
  // The folded commits stay reachable from the artifact for targets that keep their revision.
  repository.git("merge-base", "--is-ancestor", workHead, "refs/semantic-review/active/test-implementation");
  repository.semantic("validate", "--publish");

  // A finalized stage of several commits is rejected.
  repository.git("commit", "--allow-empty", "-m", "Fourth part");
  const extra = repository.git("rev-parse", "HEAD");
  const manifest = repository.artifact.readJson("manifest.json");
  manifest.stages[0].headRevision = extra;
  repository.artifact.write("manifest.json", manifest);
  repository.expectSemanticFailure("has 2 commits", "validate");
});

/** Gives a finalized stage one node with the given paths. */
function organizeFinalized(repository, id, paths, failure = undefined) {
  const organization = {
    $schema: "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
    nodes: [{
      id: "implementation-change",
      description: "Implement the stage behavior.",
      changes: paths.map((path) => ({ path, classification: "behavior" })),
    }],
    itemLinks: [],
  };
  const input = `.organization-${id}.json`;
  repository.write(input, `${JSON.stringify(organization, null, 2)}\n`);
  try {
    const args = ["stage", "organize", "--finalized", "--stage", id, "--file", input];
    return failure ? repository.expectSemanticFailure(failure, ...args) : repository.semantic(...args);
  } finally {
    repository.remove(input);
  }
}

function plannedPaths(repository, id) {
  return JSON.parse(repository.semantic("stage", "plan", "--finalized", "--stage", id)).files.map((file) => file.path);
}

test("a finalized stage that a restack gave an unowned file is organized again", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository, { id: "policy" });
  finalizeStage(repository, { id: "policy", file: "policy.txt", contents: "policy\n" });
  beginStage(repository, { id: "persistence", dependencies: ["policy"] });
  finalizeStage(repository, { id: "persistence", file: "persistence.txt", contents: "persistence\n" });

  repository.git("switch", "semantic-flow/test-implementation/stages/policy");
  repository.commitFile("rules.txt", "rules\n", "Add the rules");
  repository.semantic("restack", "--from", "policy");
  repository.expectSemanticFailure(
    /Stage policy does not assign changed path rules\.txt to a node\.\nOrganize stage policy again: .*implementation stage plan --finalized --stage policy/,
    "validate",
  );

  assert.deepEqual(plannedPaths(repository, "policy").sort(), ["policy.txt", "rules.txt"]);
  organizeFinalized(repository, "policy", ["policy.txt", "rules.txt"]);
  repository.semantic("validate", "--publish");
});

test("finalized stages that a target change left unorganized are organized one at a time", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  const prefix = "semantic-flow/test-implementation/stages";
  const finalizeTwoFiles = (id, files) => {
    for (const file of files) repository.write(file, `${file}\n`);
    repository.git("add", ...files);
    repository.git("commit", "--quiet", "-m", `Implement ${id}`);
    organizeStage(repository, { id });
    repository.semantic("stage", "finish", "--id", id);
  };
  beginStage(repository, { id: "a" });
  finalizeTwoFiles("a", ["a.txt", "a-more.txt"]);
  beginStage(repository, { id: "b", dependencies: ["a"] });
  finalizeTwoFiles("b", ["b.txt", "b-more.txt"]);

  // The target already makes one change of each stage, so their nodes name paths the stages no longer change.
  repository.git("switch", "main");
  for (const file of ["a.txt", "b.txt"]) repository.write(file, `${file}\n`);
  repository.git("add", "a.txt", "b.txt");
  repository.git("commit", "--quiet", "-m", "Make the same changes on the target");
  repository.semantic("restack", "--base", "main");
  repository.expectSemanticFailure(/Stage a node implementation-change references unchanged path a\.txt\./, "validate");

  repository.git("switch", `${prefix}/a`);
  assert.deepEqual(plannedPaths(repository, "a"), ["a-more.txt"]);
  organizeFinalized(repository, "a", ["a-more.txt"]);
  repository.expectSemanticFailure(/Stage b node implementation-change references unchanged path b\.txt\./, "validate");

  repository.git("switch", `${prefix}/b`);
  assert.deepEqual(plannedPaths(repository, "b"), ["b-more.txt"]);
  // Organizing checks the stage itself against its diff.
  organizeFinalized(repository, "b", ["b.txt", "b-more.txt"], "Stage b node implementation-change references unchanged path b.txt.");
  organizeFinalized(repository, "b", ["b-more.txt"]);
  repository.semantic("validate", "--publish");
});
