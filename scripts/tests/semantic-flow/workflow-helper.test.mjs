import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  flowCli,
  initializeImplementation,
  scriptsDirectory,
} from "../helpers/repository.mjs";

function reserveViewerPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function stopViewer(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // The assertion or viewer startup may have failed before a server existed.
  }
}

test("inspect reports repositories with and without active artifacts", (t) => {
  const repository = createRepository(t, "semantic-flow-inspect-");

  const empty = JSON.parse(repository.flow("inspect", "--json"));
  assert.equal(empty.repositoryRoot, repository.root);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.selected, null);

  initializeImplementation(repository, {
    implementationId: "inspect-implementation",
    title: "Inspect implementation",
  });
  const active = JSON.parse(repository.flow("inspect", "--json"));
  assert.equal(active.selected.implementationId, "inspect-implementation");
  assert.equal(active.selected.worktree, repository.root);
  assert.deepEqual(active.selected.finalizedStageIds, []);
  assert.deepEqual(active.selected.workingStageIds, []);
});

test("validate resolves the artifact and runs both validators", (t) => {
  const repository = createRepository(t, "semantic-flow-validate-");
  initializeImplementation(repository);
  repository.feedback("init");

  const output = repository.flow("validate");
  assert.match(output, /Artifact:/);
});

test("review leaves a detached viewer running after the command exits", async (t) => {
  const repository = createRepository(t, "semantic-flow-review-");
  initializeImplementation(repository, {
    implementationId: "persistent-review",
    title: "Persistent review",
  });
  const port = await reserveViewerPort();
  t.after(() => stopViewer(port));

  const launch = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      SEMANTIC_VIEW_NO_OPEN: "1",
      SEMANTIC_VIEW_PORT: String(port),
    },
  });

  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /Semantic review viewer: http:\/\/127\.0\.0\.1:/);
  assert.match(launch.stdout, /running persistently in the background \(PID \d+\)/);

  const response = await fetch(`http://127.0.0.1:${port}/api/whoami`);
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.equal(identity.app, "semantic-flow-review-viewer");
  assert.equal(identity.implementationId, "persistent-review");
  assert.equal(identity.repositoryRoot, repository.root);
  assert.notEqual(identity.processId, launch.pid);
});

test("feedback resolves, validates, and returns compact pending work", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "pending-review",
    "--comment-id",
    "pending-review-note",
    "--body",
    "Tighten the implementation.",
    "--label",
    "Implementation",
    "--target-kind",
    "stage",
    "--stage",
    "implementation",
  );

  const result = JSON.parse(repository.flow("feedback", "--json"));
  assert.equal(result.worktree, repository.root);
  assert.equal(result.feedbackExists, true);
  assert.deepEqual(result.worktreeChanges, []);
  assert.equal(result.stages[0].stageId, "implementation");
  assert.equal(result.stages[0].threads[0].stale, false);
  assert.equal("stageHead" in result.stages[0], false);
  assert.deepEqual(result.stages[0].threads[0].comments, [
    { author: "user", body: "Tighten the implementation." },
  ]);
});

test("feedback reports an implementation with no feedback state", (t) => {
  const { repository } = createImplementationWithStages(t);

  const result = JSON.parse(repository.flow("feedback", "--json"));
  assert.equal(result.feedbackExists, false);
  assert.deepEqual(result.stages, []);
});

test("feedback automatically restacks after the target branch advances", (t) => {
  const { repository } = createImplementationWithStages(t, [
    "foundation",
    "behavior",
  ]);
  repository.feedback("init");
  repository.feedback(
    "thread",
    "add",
    "--id",
    "pending-review",
    "--comment-id",
    "pending-review-note",
    "--body",
    "Tighten the behavior.",
    "--label",
    "Behavior",
    "--target-kind",
    "stage",
    "--stage",
    "behavior",
  );

  const before = repository.readJson(".semantic-review/manifest.json");
  const behaviorBefore = repository.readJson(
    ".semantic-review/stages/behavior.json",
  );
  repository.git("switch", "main");
  const targetHead = repository.commitFile(
    "trunk.txt",
    "advanced\n",
    "Advance trunk",
  );
  repository.git("switch", behaviorBefore.change.branch);

  const result = JSON.parse(repository.flow("feedback", "--json"));
  const after = repository.readJson(".semantic-review/manifest.json");
  const foundation = repository.readJson(
    ".semantic-review/stages/foundation.json",
  );
  const behavior = repository.readJson(
    ".semantic-review/stages/behavior.json",
  );

  assert.notEqual(before.baseRevision, targetHead);
  assert.equal(after.baseRevision, targetHead);
  assert.equal(foundation.change.baseRevision, targetHead);
  assert.equal(behavior.change.baseRevision, foundation.change.headRevision);
  assert.notEqual(behavior.change.headRevision, behaviorBefore.change.headRevision);
  assert.equal(repository.git("branch", "--show-current"), behavior.change.branch);
  assert.equal(result.currentBranch, behavior.change.branch);
  assert.equal(result.targetRestack.previousBaseRevision, before.baseRevision);
  assert.equal(result.targetRestack.baseRevision, targetHead);
  assert.equal(result.targetRestack.rewrittenBranches, 2);
  assert.equal(result.stages[0].stageId, "behavior");
  assert.equal(result.stages[0].threads[0].stale, false);
  assert.equal(result.stages[0].threads[0].reanchored, true);
  assert.equal(result.stages[0].threads[0].restacked, true);
  repository.semantic("validate");
});

test("feedback advances a detached stage checkout during target restacking", (t) => {
  const { repository } = createImplementationWithStages(t);
  const stageBefore = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
  repository.git("switch", "main");
  repository.commitFile("trunk.txt", "advanced\n", "Advance trunk");
  repository.git("switch", "--detach", stageBefore.change.headRevision);

  const result = JSON.parse(repository.flow("feedback", "--json"));
  const stageAfter = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );

  assert.equal(repository.git("branch", "--show-current"), "");
  assert.equal(repository.git("rev-parse", "HEAD"), stageAfter.change.headRevision);
  assert.notEqual(stageAfter.change.headRevision, stageBefore.change.headRevision);
  assert.equal(result.currentBranch, null);
});

test("feedback does not restack an implementation already landed on target", (t) => {
  const { repository } = createImplementationWithStages(t);
  const stage = repository.readJson(
    ".semantic-review/stages/implementation.json",
  );
  repository.git("switch", "main");
  repository.git("merge", "--ff-only", stage.change.branch);

  const result = repository.result(process.execPath, [
    flowCli,
    "feedback",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /already contains the final semantic stage/,
  );
});

test("feedback rejects incomplete feedback state", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.write(".semantic-review-feedback/orphan.json", "{}\n");

  const result = repository.result(process.execPath, [
    flowCli,
    "feedback",
    "--json",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Incomplete feedback state.*manifest\.json is missing/,
  );
});

test("status reports coverage, evidence, feedback, and validation", (t) => {
  const repository = createRepository(t, "semantic-flow-status-");
  initializeImplementation(repository);
  repository.feedback("init");

  const status = JSON.parse(repository.flow("status", "--json"));
  assert.equal(status.artifact.implementationId, "test-implementation");
  assert.equal(status.criteria.total, 1);
  assert.equal(status.criteria.covered, 0);
  assert.deepEqual(status.criteria.inProgress, []);
  assert.deepEqual(status.criteria.missing, ["story#works"]);
  assert.deepEqual(status.evidence, {});
  assert.equal(status.feedback.exists, true);
  assert.deepEqual(status.feedback.threads, {});
  assert.equal(status.validation.artifact.passed, true);
  assert.equal(status.validation.feedback.passed, true);

  beginStage(repository);
  const working = JSON.parse(repository.flow("status", "--json"));
  assert.equal(working.criteria.covered, 0);
  assert.deepEqual(working.criteria.inProgress, ["story#works"]);
  assert.deepEqual(working.criteria.missing, []);
});

test("version reports installed and schema versions", () => {
  const result = spawnSync(process.execPath, [flowCli, "version", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const version = JSON.parse(result.stdout);
  assert.match(version.skillVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(version.artifactFormatVersion, "0.1");
  assert.equal(version.feedbackFormatVersion, "0.1");
  assert.equal(
    version.skillRoot,
    path.resolve(scriptsDirectory, ".."),
  );
});

test("update rebuilds and replaces a copied installation", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-flow-update-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const builtSkill = path.resolve(scriptsDirectory, "..");
  const installedSkill = path.join(root, "installed", "semantic-flow");
  fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
  fs.cpSync(builtSkill, installedSkill, { recursive: true });

  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "skills"), { recursive: true });
  fs.cpSync(builtSkill, path.join(source, "skills", "semantic-flow"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, "skills", "semantic-flow", "VERSION"),
    "9.9.9\n",
  );
  fs.mkdirSync(path.join(source, "scripts", "src"), { recursive: true });
  fs.mkdirSync(path.join(source, "scripts", "node_modules"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, "scripts", "package.json"),
    JSON.stringify({
      name: "semantic-flow-update-fixture",
      private: true,
      scripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(99)\"",
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, "scripts", "src", "build-skill.ts"),
    "// update fixture\n",
  );
  fs.mkdirSync(path.join(source, "standard", "v0.1"), {
    recursive: true,
  });

  const target = path.join(root, "target");
  fs.mkdirSync(target);
  for (const repository of [source, target]) {
    spawnSync("git", ["init", "-b", "main"], {
      cwd: repository,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "Semantic Flow Test"], {
      cwd: repository,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repository,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
    spawnSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "fixture"], {
      cwd: repository,
      stdio: "ignore",
    });
  }
  const copiedCli = path.join(
    installedSkill,
    "scripts",
    "semantic-flow.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      copiedCli,
      "update",
      "--source",
      source,
      "--use-current-source",
    ],
    { cwd: target, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    fs.readFileSync(path.join(installedSkill, "VERSION"), "utf8"),
    "9.9.9\n",
  );
  assert.match(result.stdout, /0\.1\.0 -> 9\.9\.9/);
});
