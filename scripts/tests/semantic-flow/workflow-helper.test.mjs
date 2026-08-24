import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createRepository,
  flowCli,
  initializeReview,
  scriptsDirectory,
} from "../helpers/repository.mjs";

test("inspect reports repositories with and without active artifacts", (t) => {
  const repository = createRepository(t, "semantic-flow-inspect-");

  const empty = JSON.parse(repository.flow("inspect", "--json"));
  assert.equal(empty.repositoryRoot, repository.root);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.selected, null);

  initializeReview(repository, {
    reviewId: "inspect-review",
    title: "Inspect review",
  });
  const active = JSON.parse(repository.flow("inspect", "--json"));
  assert.equal(active.selected.reviewId, "inspect-review");
  assert.equal(active.selected.worktree, repository.root);
  assert.deepEqual(active.selected.finalizedStageIds, []);
  assert.deepEqual(active.selected.workingStageIds, []);
});

test("validate resolves the artifact and runs both validators", (t) => {
  const repository = createRepository(t, "semantic-flow-validate-");
  initializeReview(repository);
  repository.feedback("init");

  const output = repository.flow("validate");
  assert.match(output, /Artifact:/);
});

test("status reports coverage, evidence, feedback, and validation", (t) => {
  const repository = createRepository(t, "semantic-flow-status-");
  initializeReview(repository);
  repository.feedback("init");

  const status = JSON.parse(repository.flow("status", "--json"));
  assert.equal(status.artifact.reviewId, "test-review");
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
