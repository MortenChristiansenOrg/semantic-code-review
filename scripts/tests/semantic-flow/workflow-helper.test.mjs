import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  flowCli,
  initializeImplementation,
  scriptsDirectory,
} from "../helpers/repository.mjs";
import { viewerBase, viewerFetch, viewerKey } from "../helpers/viewer-client.mjs";
import { ArtifactDraft, commitArtifact, rememberImplementation, removeArtifact, requireArtifact } from "../../src/shared/artifact-store.ts";

/** The active artifact of a worktree that is not a test repository, read and
 * written through the artifact store. */
const storedArtifact = {
  read: (root, file) => requireArtifact(root).read(file),
  write(root, file, contents) {
    const snapshot = requireArtifact(root), draft = new ArtifactDraft(snapshot);
    draft.write(file, contents);
    commitArtifact(root, snapshot, draft);
  },
  remove: (root) => removeArtifact(root, requireArtifact(root)),
};

const builtSkillVersion = fs.readFileSync(path.join(scriptsDirectory, "../VERSION"), "utf8").trim();

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

async function stopViewer(port, pid, key = viewerKey(port)) {
  try {
    await viewerFetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, key);
  } catch {
    // The assertion or viewer startup may have failed before a server existed.
  }
  if (pid !== undefined) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await delay(50);
    }
    assert.fail(`Viewer process ${pid} did not exit after shutdown`);
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

test("commands fail without writing when the active artifact has no review ID", (t) => {
  const repository = createRepository(t, "semantic-flow-no-review-id-");
  initializeImplementation(repository, { implementationId: "no-review-id" });
  repository.artifact.remove("review.json");
  const ref = () => repository.git("rev-parse", "refs/semantic-review/active/no-review-id");
  const reviews = () => { try { return fs.readdirSync(path.join(process.env.SEMANTIC_FLOW_HOME, "reviews")).sort(); } catch { return []; } };
  const before = ref(), stored = reviews();
  for (const command of ["status", "validate", "prepare", "review"]) {
    const result = repository.result(process.execPath, [flowCli, command]);
    assert.notEqual(result.status, 0, `${command} succeeded`);
    assert.match(result.stderr, /The semantic implementation no-review-id has no review identity; it was created by an unreleased development build\. Start it again\./);
    assert.equal(ref(), before, `${command} wrote the artifact`);
    assert.deepEqual(reviews(), stored, `${command} wrote review data`);
  }
  assert.equal(repository.artifact.exists("review.json"), false);
});

test("review launched from another worktree of the repository reuses the running viewer", async (t) => {
  const port = await reserveViewerPort();
  const pids = new Set();
  t.after(async () => { for (const pid of pids) await stopViewer(port, pid).catch(() => { try { process.kill(pid); } catch { /* Gone. */ } }); });
  const repository = createRepository(t, "semantic-flow-shared-viewer-");
  initializeImplementation(repository, { implementationId: "shared-viewer" });
  // The review records the main worktree, which keeps reaching it.
  repository.feedback("init");
  const linked = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "semantic-linked-")), "linked");
  t.after(() => fs.rmSync(path.dirname(linked), { recursive: true, force: true }));
  repository.git("worktree", "add", "-q", "--detach", linked);
  rememberImplementation(linked, "shared-viewer");
  const launch = () => {
    const result = spawnSync(process.execPath, [flowCli, "review"], {
      cwd: linked, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port) },
    });
    assert.equal(result.status, 0, result.stderr);
    const started = /running persistently in the background \(PID (\d+)\)/.exec(result.stdout);
    assert.ok(started, result.stdout);
    pids.add(Number(started[1]));
    return Number(started[1]);
  };
  const first = launch();
  const identity = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(identity.processId, first);
  assert.equal(identity.repositoryRoot, repository.root);
  assert.equal(launch(), first);
  assert.equal(pids.size, 1);
});

test("review launched after the recorded worktree stopped reaching the review replaces its viewer", async (t) => {
  const port = await reserveViewerPort();
  const pids = new Set();
  t.after(async () => { for (const pid of pids) await stopViewer(port, pid).catch(() => { try { process.kill(pid); } catch { /* Gone. */ } }); });
  const repository = createRepository(t, "semantic-flow-relocated-viewer-");
  initializeImplementation(repository, { implementationId: "relocated-viewer" });
  const linked = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "semantic-linked-")), "linked");
  t.after(() => fs.rmSync(path.dirname(linked), { recursive: true, force: true }));
  repository.git("worktree", "add", "-q", "--detach", linked);
  rememberImplementation(linked, "relocated-viewer");
  const launch = (cwd) => {
    const result = spawnSync(process.execPath, [flowCli, "review"], {
      cwd, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port) },
    });
    assert.equal(result.status, 0, result.stderr);
    const started = /running persistently in the background \(PID (\d+)\)/.exec(result.stdout);
    assert.ok(started, result.stdout);
    pids.add(Number(started[1]));
    return Number(started[1]);
  };
  // The review records the linked worktree, which serves it until it stops being
  // a checkout. Its folder stays: Windows cannot remove the viewer's directory.
  const first = launch(linked);
  fs.rmSync(path.join(linked, ".git"));
  const second = launch(repository.root);
  assert.notEqual(second, first);
  assert.throws(() => process.kill(first, 0), (error) => error.code === "ESRCH");
  const identity = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(identity.processId, second);
  assert.equal(identity.repositoryRoot, repository.root);
});

test("review leaves a detached viewer running after the command exits", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const repository = createRepository(t, "semantic-flow-review-");
  initializeImplementation(repository, {
    implementationId: "persistent-review",
    title: "Persistent review",
  });
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
  const started = /running persistently in the background \(PID (\d+)\)/.exec(launch.stdout);
  assert.ok(started, launch.stdout);
  viewerPid = Number(started[1]);

  const response = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`);
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.equal(identity.app, "semantic-flow-review-viewer");
  assert.equal(identity.implementationId, "persistent-review");
  assert.equal(identity.repositoryRoot, repository.root);
  assert.notEqual(identity.processId, launch.pid);
  const reopened = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port) },
  });
  assert.equal(reopened.status, 0, reopened.stderr);
  const reused = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(reused.processId, identity.processId);
  assert.match(reused.viewerVersion, /^[0-9a-f]{64}$/);
  const payload = await viewerFetch(`http://127.0.0.1:${port}/api/implementation?review=${identity.reviewId}&generation=${identity.generation}`).then((response) => response.json());
  assert.equal(payload.ok, true);
  assert.equal(payload.implementation.implementationId, "persistent-review");

});

test("review starts the viewer for a manifest without a title", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const repository = createRepository(t, "semantic-flow-review-");
  initializeImplementation(repository, { implementationId: "untitled-review" });
  const { title, ...manifest } = repository.artifact.readJson("manifest.json");
  repository.artifact.write("manifest.json", manifest);

  const launch = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port) },
  });
  const started = /running persistently in the background \(PID (\d+)\)/.exec(launch.stdout);
  if (started) viewerPid = Number(started[1]);
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /^Implementation: untitled-review — 0 stages, 0 files$/m);
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
  assert.match(result.stages[0].stageHead, /^[a-f0-9]{40}$/);
  assert.equal("stageHead" in result.stages[0].threads[0], false);
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

  const before = repository.artifact.readJson("manifest.json");
  const behaviorBefore = repository.artifact.stage("behavior");
  repository.git("switch", "main");
  const targetHead = repository.commitFile(
    "trunk.txt",
    "advanced\n",
    "Advance trunk",
  );
  repository.git("switch", behaviorBefore.change.branch);

  const result = JSON.parse(repository.flow("feedback", "--json"));
  const after = repository.artifact.readJson("manifest.json");
  const foundation = repository.artifact.stage("foundation");
  const behavior = repository.artifact.stage("behavior");

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
  const agent = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(repository.feedbackPath("manifest.json"))), "agent.json"), "utf8"));
  assert.equal(agent.targetRefresh.targetBranch, "main");
  assert.equal(agent.targetRefresh.previousBaseRevision, before.baseRevision);
  assert.equal(agent.targetRefresh.baseRevision, targetHead);
  assert.equal(result.stages[0].stageId, "behavior");
  assert.equal(result.stages[0].threads[0].stale, false);
  assert.equal(result.stages[0].threads[0].reanchored, true);
  assert.equal(result.stages[0].threads[0].restacked, true);
  repository.semantic("validate");
});

test("feedback advances a detached stage checkout during target restacking", (t) => {
  const { repository } = createImplementationWithStages(t);
  const stageBefore = repository.artifact.stage("implementation");
  repository.git("switch", "main");
  repository.commitFile("trunk.txt", "advanced\n", "Advance trunk");
  repository.git("switch", "--detach", stageBefore.change.headRevision);

  const result = JSON.parse(repository.flow("feedback", "--json"));
  const stageAfter = repository.artifact.stage("implementation");

  assert.equal(repository.git("branch", "--show-current"), "");
  assert.equal(repository.git("rev-parse", "HEAD"), stageAfter.change.headRevision);
  assert.notEqual(stageAfter.change.headRevision, stageBefore.change.headRevision);
  assert.equal(result.currentBranch, null);
});

test("feedback does not restack an implementation already landed on target", (t) => {
  const { repository } = createImplementationWithStages(t);
  const stage = repository.artifact.stage("implementation");
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
  repository.writeAbsolute(repository.feedbackPath("orphan.json"), "{}\n");

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

test("status leaves criteria without IDs out of coverage", (t) => {
  const repository = createRepository(t, "semantic-flow-status-");
  initializeImplementation(repository);
  beginStage(repository);
  const stageFile = ".work/stages/implementation.json";
  const stage = repository.artifact.readJson(stageFile);
  stage.specificationRefs = ["story#undefined"];
  repository.artifact.write(stageFile, stage);
  const file = "requirements/story.json";
  const specification = repository.artifact.readJson(file);
  specification.acceptanceCriteria.push(null);
  repository.artifact.write(file, specification);

  const status = JSON.parse(repository.flow("status", "--json"));
  assert.equal(status.criteria.total, 1);
  assert.deepEqual(status.criteria.inProgress, []);
  assert.deepEqual(status.criteria.missing, ["story#works"]);
  assert.equal(status.validation.artifact.passed, false);
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

function createUpdateFixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "semantic-flow-update-test-"),
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
  function run(args, env = {}, cwd = target) {
    return spawnSync(process.execPath, [copiedCli, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, ...env },
    });
  }
  function initialize() {
    initializeImplementation({
      semantic: (...args) => {
        const result = spawnSync(process.execPath, [copiedCli, "implementation", ...args], { cwd: target, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      },
    });
  }
  return {
    root, source, target, installedSkill, run, initialize,
    update: async (env, cwd = target) => {
      const child = spawn(process.execPath, [
        copiedCli, "update", "--source", source, "--use-current-source",
      ], {
        cwd, env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [status] = await once(child, "close");
      return { status, stdout, stderr };
    },
  };
}

test("update rebuilds and replaces a copied installation", async (t) => {
  const fixture = createUpdateFixture(t);
  const port = await reserveViewerPort();
  const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    fs.readFileSync(path.join(fixture.installedSkill, "VERSION"), "utf8"),
    "9.9.9\n",
  );
  assert.ok(result.stdout.includes(`${builtSkillVersion} -> 9.9.9`));
  await assert.rejects(viewerFetch(`http://127.0.0.1:${port}/api/whoami`));
});

test("explicit source update replaces an installation outside Git", async (t) => {
  const fixture = createUpdateFixture(t);
  const port = await reserveViewerPort();
  const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port) }, fixture.root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(fixture.installedSkill, "VERSION"), "utf8"), "9.9.9\n");
  assert.match(result.stdout, /Updated semantic-flow/);
  await assert.rejects(viewerFetch(`http://127.0.0.1:${port}/api/whoami`));
});

test("update restarts a matching linked-worktree viewer without changing artifacts", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const original = storedArtifact.read(fixture.target, "manifest.json");
  const linked = path.join(fixture.root, "linked");
  const worktree = spawnSync("git", ["worktree", "add", "-b", "review-work", linked], {
    cwd: fixture.target, encoding: "utf8",
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  // Every worktree of the repository sees the same artifact; the linked one now works on it.
  rememberImplementation(linked, "test-implementation");
  fs.appendFileSync(path.join(fixture.source, "skills", "semantic-flow", "viewer", "styles.css"), "\n/* updated */\n");
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" };
  const launch = fixture.run(["review", "--project", linked], env);
  assert.equal(launch.status, 0, launch.stderr);
  const before = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = before.processId;
  assert.equal(before.skillDirectory, fixture.installedSkill);
  const result = await fixture.update(env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const after = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = after.processId;
  assert.notEqual(after.processId, before.processId);
  assert.throws(() => process.kill(before.processId, 0), { code: "ESRCH" });
  assert.notEqual(after.viewerVersion, before.viewerVersion);
  assert.equal(after.repositoryRoot, linked);
  assert.equal(after.implementationId, before.implementationId);
  assert.deepEqual(storedArtifact.read(linked, "manifest.json"), original);
  assert.ok(result.stdout.includes(`Updated semantic-flow ${builtSkillVersion} -> 9.9.9`));
});

test("viewer serves its installed release version and replaces an older running release", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  // Register shutdown before the fixture cleanup: Windows locks the live cwd.
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const manifest = JSON.parse(storedArtifact.read(fixture.target, "manifest.json"));
  manifest.skillVersion = "0.2.0";
  storedArtifact.write(fixture.target, "manifest.json", JSON.stringify(manifest));
  const original = storedArtifact.read(fixture.target, "manifest.json");
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" };
  const launch = () => {
    const result = fixture.run(["review", "--project", fixture.target], env);
    assert.equal(result.status, 0, result.stderr);
  };
  const identity = () => viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then(response => response.json());
  launch();
  const before = await identity(); viewerPid = before.processId;
  assert.equal(before.viewerReleaseVersion, builtSkillVersion);
  fs.writeFileSync(path.join(fixture.installedSkill, "VERSION"), "9.9.9\n");
  launch();
  const after = await identity(); viewerPid = after.processId;
  assert.equal(after.viewerReleaseVersion, "9.9.9");
  assert.notEqual(after.processId, before.processId);
  assert.notEqual(after.viewerVersion, before.viewerVersion);
  const query = new URLSearchParams({ review: after.reviewId, generation: after.generation });
  const payload = await viewerFetch(`http://127.0.0.1:${port}/api/implementation?${query}`).then(response => response.json());
  assert.equal(payload.implementation.viewerReleaseVersion, "9.9.9");
  assert.equal(payload.implementation.skillVersion, "0.2.0");
  const bootstrap = await viewerFetch(`http://127.0.0.1:${port}/api/bootstrap`).then(response => response.json());
  assert.equal(bootstrap.implementation.viewerReleaseVersion, "9.9.9");
  assert.deepEqual(storedArtifact.read(fixture.target, "manifest.json"), original);
});

async function startUpdateViewerFixture(t, fixture, port, overrides = {}) {
  const script = path.join(fixture.root, "viewer-fixture.mjs");
  fs.writeFileSync(script, `
import http from "node:http";
const options = JSON.parse(process.argv[2]);
const identity = { app: "semantic-flow-review-viewer", implementationId: "test-implementation",
  repositoryRoot: options.repositoryRoot, processId: process.pid, ...options.identity };
let probes = 0;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/whoami") {
    if (options.replaceOnRecheck && ++probes === 2) {
      server.close();
      const replacement = http.createServer((nextRequest, nextResponse) => {
        if (nextRequest.url === "/api/shutdown") process.send({ type: "replacement-shutdown" });
        nextResponse.setHeader("content-type", "application/json");
        nextResponse.end(JSON.stringify({ ...identity, implementationId: "replacement" }));
      });
      return replacement.listen(options.port, "127.0.0.1", () => {
        response.setHeader("connection", "close");
        response.end(JSON.stringify(identity));
      });
    }
    return response.end(JSON.stringify(identity));
  }
  if (request.url !== "/api/shutdown") { response.writeHead(404); return response.end("{}"); }
  if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
    response.writeHead(403); return response.end("{}");
  }
  process.send({ type: "shutdown" });
  if (options.refuse) { response.writeHead(403); return response.end("{}"); }
  response.end("{}");
  server.close();
  if (!options.stayAlive) setTimeout(() => process.exit(0), 300);
});
setInterval(() => {}, 1000);
server.listen(options.port, "127.0.0.1", () => process.send({ type: "ready" }));
`);
  const child = spawn(process.execPath, [script, JSON.stringify({
    repositoryRoot: fixture.target, port, ...overrides,
  })], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const messages = [];
  child.on("message", (message) => messages.push(message.type));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  await once(child, "message", { signal: AbortSignal.timeout(5000) });
  return { child, messages };
}

test("update waits for a legacy viewer process to exit before restarting", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const { child } = await startUpdateViewerFixture(t, fixture, port);
  const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const identity = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = identity.processId;
  assert.notEqual(identity.processId, child.pid);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.equal(identity.skillDirectory, fixture.installedSkill);
});

for (const scenario of ["another repository", "another installation", "another implementation", "another app"]) {
  test(`update leaves a viewer for ${scenario} untouched`, async (t) => {
    const fixture = createUpdateFixture(t);
    fixture.initialize();
    const port = await reserveViewerPort();
    const identity = scenario === "another repository" ? { repositoryRoot: fixture.source } :
      scenario === "another installation" ? { skillDirectory: path.join(fixture.root, "other-skill") } :
      scenario === "another implementation" ? { implementationId: "other-implementation" } :
      { app: "another-app" };
    const { child, messages } = await startUpdateViewerFixture(t, fixture, port, { identity });
    const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port) });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const after = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
    assert.equal(after.processId, child.pid);
    assert.deepEqual(messages, ["ready"]);
  });
}

for (const scenario of ["refused shutdown", "acknowledged shutdown without exit", "failed build"]) {
  test(`update preserves the installed skill and viewer after ${scenario}`, async (t) => {
    const fixture = createUpdateFixture(t);
    fixture.initialize();
    const port = await reserveViewerPort();
    if (scenario === "failed build") {
      const manifest = path.join(fixture.source, "scripts", "package.json");
      const contents = JSON.parse(fs.readFileSync(manifest, "utf8"));
      contents.scripts.build = 'node -e "process.exit(99)"';
      fs.writeFileSync(manifest, JSON.stringify(contents));
    }
    const { child } = await startUpdateViewerFixture(t, fixture, port, {
      refuse: scenario === "refused shutdown",
      stayAlive: scenario === "acknowledged shutdown without exit",
    });
    const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port) });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.installedSkill, "VERSION"), "utf8"), `${builtSkillVersion}\n`);
    assert.equal(process.kill(child.pid, 0), true);
    if (scenario === "refused shutdown") assert.match(result.stderr, /Could not request viewer shutdown/);
    if (scenario === "acknowledged shutdown without exit") assert.match(result.stderr, /did not exit after shutdown/);
    if (scenario === "failed build") assert.match(result.stderr, /99/);
  });
}

test("update restarts the old viewer when installation replacement fails", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" };
  const launch = fixture.run(["review"], env);
  assert.equal(launch.status, 0, launch.stderr);
  const before = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = before.processId;
  const preload = path.join(fixture.root, "fail-replacement.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (source === ${JSON.stringify(fixture.installedSkill)}) throw new Error("Injected replacement failure");
  return rename(source, destination);
};
`);
  const result = await fixture.update({
    ...env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected replacement failure/);
  const after = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = after.processId;
  assert.notEqual(after.processId, before.processId);
  assert.equal(after.viewerVersion, before.viewerVersion);
  assert.equal(fs.readFileSync(path.join(fixture.installedSkill, "VERSION"), "utf8"), `${builtSkillVersion}\n`);
});

test("updated viewer restart refuses to replace a new port occupant", async (t) => {
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const port = await reserveViewerPort();
  const { child, messages } = await startUpdateViewerFixture(t, fixture, port, {
    identity: { implementationId: "another-implementation" },
  });
  const result = fixture.run(["review"], {
    SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_NO_REPLACE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to replace it/);
  const identity = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(identity.processId, child.pid);
  assert.deepEqual(messages, ["ready"]);
});

test("update never sends shutdown to a replacement on a new connection", async (t) => {
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const port = await reserveViewerPort();
  const { messages } = await startUpdateViewerFixture(t, fixture, port, { replaceOnRecheck: true });
  const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not request viewer shutdown/);
  const identity = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(identity.implementationId, "replacement");
  assert.deepEqual(messages, ["ready"]);
  assert.equal(fs.readFileSync(path.join(fixture.installedSkill, "VERSION"), "utf8"), `${builtSkillVersion}\n`);
});

test("update recognizes a matching viewer through a filesystem alias", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const alias = path.join(fixture.root, "skill-alias");
  fs.symlinkSync(fixture.installedSkill, alias, process.platform === "win32" ? "junction" : "dir");
  const previous = await startUpdateViewerFixture(t, fixture, port, { identity: { skillDirectory: alias } });
  viewerPid = previous.child.pid;
  const result = await fixture.update({ SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const current = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = current.processId;
  assert.ok(previous.messages.includes("shutdown"));
  assert.equal(current.skillDirectory, fs.realpathSync.native(fixture.installedSkill));
});

test("concurrent review services isolate commands and reopen registered worktrees", async (t) => {
  const viewers = [];
  t.after(async () => { for (const viewer of viewers) await stopViewer(viewer.port, viewer.processId, viewer.key); });
  const { repository: a } = createImplementationWithStages(t);
  const b = createRepository(t, "concurrent-review-b-");
  initializeImplementation(b); // Deliberately the same implementation ID.
  // All worktrees of a repository share its reviews, so the third review is
  // registered from a linked worktree of a third repository.
  const { repository: c } = createImplementationWithStages(t);
  const linked = c.path("../", path.basename(c.root) + "-linked");
  c.git("worktree", "add", "--detach", linked, "HEAD");
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const port = await reserveViewerPort();
  const deniedPortHook = a.path("denied-port.cjs");
  fs.writeFileSync(deniedPortHook, `const net = require('node:net'); const listen = net.Server.prototype.listen; let denied = 0; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && denied++ < 2) { process.nextTick(() => this.emit('error', Object.assign(new Error('Reserved port'), { code: 'EACCES' }))); return this; } return listen.apply(this, args); };`);
  const start = async (root, denyPorts = false) => {
    const child = spawn(process.execPath, [flowCli, "viewer", "serve", root], {
      cwd: a.root, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port), GIT_DIR: a.path(".git"), ...(denyPorts ? { NODE_OPTIONS: `--import=${pathToFileURL(deniedPortHook).href}` } : {}) },
    });
    const [message] = await once(child, "message");
    assert.equal(message.type, "ready", JSON.stringify(message));
    assert.match(message.key, /^[\w-]{43}$/);
    const identity = await viewerFetch(new URL("api/whoami", message.url), {}, message.key).then((r) => r.json());
    viewers.push({ ...identity, key: message.key }); child.unref();
    return { ...identity, url: viewerBase(message.url), key: message.key };
  };
  const first = await start(a.root), second = await start(b.root), third = await start(linked, true);
  assert.equal(new Set([first.port, second.port, third.port]).size, 3);
  assert.equal(new Set([first.reviewId, second.reviewId, third.reviewId]).size, 3);
  const request = (viewer, route, body, review = viewer.reviewId) => viewerFetch(new URL(`${route}?review=${review}&generation=${viewer.generation}`, viewer.url), {
    ...(body ? { method: "POST", headers: { "content-type": "application/json", origin: new URL(viewer.url).origin }, body: JSON.stringify(body) } : {}),
  }, viewer.key);
  assert.equal((await request(first, "api/implementation", null, third.reviewId)).status, 409);
  assert.equal((await request({ ...third, generation: "previous-session" }, "api/implementation")).status, 409);
  const implementation = await request(third, "api/implementation").then((r) => r.json());
  const stage = implementation.implementation.stages[0], file = stage.files[0];
  const approval = { stageId: stage.id, nodeId: file.memberships[0].nodeId, path: file.path, baseRevision: stage.baseRevision, headRevision: stage.headRevision, fileRevision: file.revision, ownership: file.memberships[0] };
  const snapshot = await request(third, "api/approval-snapshots", approval).then((r) => r.json());
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const comparison = await request(third, "api/approval-comparison", { ...approval, snapshotId: snapshot.snapshotId }).then((r) => r.json());
  assert.equal(comparison.ok, true, JSON.stringify(comparison)); assert.deepEqual(comparison.lines, []);
  assert.equal((await request(third, "api/approval-snapshots", { ...approval, fileRevision: 'outdated' })).status, 409);
  assert.equal((await request(third, "api/approval-snapshots", { ...approval, ownership: {} })).status, 409);
  const upload = { filename: "screenshot.png", mediaType: "image/png", data: Buffer.from([137,80,78,71,13,10,26,10]).toString("base64") };
  const attached = await request(third, "api/attachments", upload).then((r) => r.json());
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.deepEqual((await request(third, "api/attachments", upload).then((r) => r.json())).attachment, attached.attachment);
  const download = await request(third, `api/attachments/${attached.attachment.id}`);
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString("base64"), upload.data);
  const previewUrl = new URL(`api/attachments/${attached.attachment.id}?review=${third.reviewId}&generation=${third.generation}&preview=1`, third.url);
  const preview = await viewerFetch(previewUrl, {}, third.key); assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await request(first, `api/attachments/${attached.attachment.id}`)).status, 404);
  assert.equal((await request(third, "api/attachments", { ...upload, filename: "../escape" })).status, 400);
  assert.equal((await request(third, "api/attachments", { ...upload, data: "https://example.test/image.png" })).status, 400);
  const payload = { implementationId: third.implementationId, notes: [{ ref: 0, kind: "stage", id: "implementation", body: "Only linked worktree", attachments: [attached.attachment], clientId: "concurrent-context" }] };
  const exports = await Promise.all([request(third, "api/feedback/export", payload), request(third, "api/feedback/export", payload)]);
  for (const result of exports) assert.equal(result.status, 200, await result.text());
  assert.equal(a.existsAbsolute(a.feedbackPath("manifest.json")), false);
  assert.equal(b.existsAbsolute(b.feedbackPath("manifest.json")), false);
  const module = await import("../../src/semantic-view.ts");
  // A management request waiting on B's lock must not block A's HTTP loop. A's
  // data is loaded first, so the probe below does not wait for a cold load.
  assert.equal((await request(first, "api/implementation")).status, 200);
  const locks = path.join(process.env.SEMANTIC_FLOW_HOME, "locks");
  const heldLock = path.join(locks, third.reviewId + ".lock");
  fs.mkdirSync(heldLock);
  fs.writeFileSync(path.join(heldLock, "owner-00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ pid: process.pid }));
  const blockedStorage = request(first, "api/reviews/storage", { reviewId: third.reviewId, generation: third.generation });
  let storageAnswered = false;
  blockedStorage.then(() => { storageAnswered = true; }, () => { storageAnswered = true; });
  try {
    // A waiter publishes its claim next to the lock before it starts waiting.
    while (!storageAnswered && !fs.readdirSync(locks).some((name) => name.startsWith(`${third.reviewId}.lock.claim-`))) await delay(10);
    // The lock stays held until A answers, so an answer while the storage request
    // still waits shows the loop was free. No deadline: a request runs Git several
    // times, which can take seconds on a busy Windows runner.
    for (const route of ["api/whoami", "api/implementation"]) assert.equal((await request(first, route)).status, 200);
    assert.equal(storageAnswered, false, "Storage lock blocked the HTTP loop");
  } finally {
    // Moved aside before removal: removing it in place could remove a lock a waiter
    // has just taken at the same path. A waiter may briefly hold a file open in it,
    // which makes the move fail on Windows, so it is retried.
    const released = `${heldLock}-released`;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(heldLock, released); break; }
      catch (error) { if (attempt >= 40) throw error; await delay(25); }
    }
    fs.rmSync(released, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  assert.equal((await blockedStorage).status, 200);
  const linkedFeedback = module.feedbackDirectory(linked);
  assert.equal(fs.readdirSync(path.join(linkedFeedback, "threads")).length, 1);
  const context = module.captureReviewContext(third.reviewId);
  const oldGit = process.env.GIT_DIR;
  const oldLowerGit = process.env.git_dir;
  // The review's checks in this process read the review's own repository; the
  // command must still not inherit the variables.
  process.env.git_dir = c.path(".git");
  process.env.GIT_DIR = c.path(".git");
  try {
    assert.equal(module.runReviewCommand(context, process.execPath, ["-e", "console.log(process.env.git_dir || process.env.GIT_DIR || 'clear')"]).trim(), "clear");
    assert.equal(module.runReviewCommand(context, "git", ["rev-parse", "--show-toplevel"]).trim(), linked.replaceAll("\\", "/"));
    assert.throws(() => module.runReviewCommand(context, "git", ["status"], { workingWorktree: b.root }), /another repository/);
  } finally { if (oldLowerGit === undefined) delete process.env.git_dir; else process.env.git_dir = oldLowerGit; if (oldGit === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGit; }
  const opened = await request(first, "api/reviews/open", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(viewerBase(opened.url), third.url);
  await stopViewer(third.port, third.processId, third.key);
  viewers.pop();
  const restarted = await request(first, "api/reviews/open", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  const restartedKey = viewerKey(new URL(restarted.url).port);
  const recovered = await viewerFetch(new URL("api/whoami", restarted.url), {}, restartedKey).then((r) => r.json()); viewers.push({ ...recovered, key: restartedKey });
  assert.equal(recovered.reviewId, third.reviewId);
  assert.notEqual(recovered.processId, third.processId);
  const originalManifest = storedArtifact.read(linked, "manifest.json");
  // The manifest keeps the implementation ID that names the artifact, but nothing else.
  storedArtifact.write(linked, "manifest.json", '{"implementationId": "test-implementation"}');
  const bootstrapOf = (url) => viewerFetch(new URL("api/bootstrap", url), {}, restartedKey);
  const failedBootstrap = await bootstrapOf(restarted.url);
  assert.equal(failedBootstrap.status, 500); assert.equal((await failedBootstrap.json()).implementation, undefined);
  storedArtifact.write(linked, "manifest.json", originalManifest);
  assert.equal((await bootstrapOf(restarted.url)).status, 200);
  // The linked directory stays, as the restarted viewer runs in it, but it is no longer a checkout.
  fs.rmSync(path.join(linked, ".git"));
  const unavailableBootstrap = await bootstrapOf(restarted.url);
  assert.equal(unavailableBootstrap.status, 200);
  assert.deepEqual((await unavailableBootstrap.json()).context, { reviewId: recovered.reviewId, generation: recovered.generation });
  assert.throws(() => module.runReviewCommand(context, "git", ["status"]), /unavailable/);
  const missingViewer = { ...recovered, url: viewerBase(restarted.url), key: restartedKey };
  assert.equal((await request(missingViewer, "api/feedback/export", payload)).status, 409);
  assert.equal((await request(first, "api/implementation")).status, 200);
  const saved = await request(missingViewer, "api/review-state", { reviewId: recovered.reviewId, generation: recovered.generation, changes: [{ path: ['draft'], before: { present: false }, after: { present: true, value: 'Retain after removal' } }] });
  assert.equal(saved.status, 200, await saved.text());
  const list = await request(missingViewer, "api/reviews").then((r) => r.json());
  assert.equal(list.reviews.find((r) => r.id === recovered.reviewId).available, false);
  assert.equal((await request(missingViewer, "api/reviews/open", { reviewId: first.reviewId, generation: first.generation })).status, 200);
  const storage = await request(first, "api/reviews/storage", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(storage.ok, true, JSON.stringify(storage)); assert.ok(storage.storage.bytes > 0);
  const deleted = await request(first, "api/reviews/delete", { reviewId: third.reviewId, generation: third.generation, fingerprint: storage.storage.fingerprint }).then((r) => r.json());
  assert.deepEqual(deleted, { ok: true, deleted: true });
  assert.equal((await request(missingViewer, "api/review-state")).status, 409);
  assert.equal((await request(missingViewer, "api/attachments", upload)).status, 409);
  assert.equal((await request(missingViewer, "api/review-state", { reviewId: third.reviewId, generation: third.generation, changes: [] })).status, 409);
  assert.equal((await request(missingViewer, "api/reviews")).status, 200);
  const bootstrap = await bootstrapOf(missingViewer.url).then((r) => r.json());
  assert.equal(bootstrap.context.reviewId, recovered.reviewId); assert.deepEqual(bootstrap.implementation.stages, []);
  await delay(1200);
  assert.equal((await viewerFetch(new URL("api/whoami", missingViewer.url), {}, restartedKey).then((r) => r.json())).healthy, false);
  assert.equal((await request(first, "api/implementation")).status, 200);

});


test('a viewer-triggered feedback init cannot recreate data deleted after its initial generation check', async (t) => {
  const { repository } = createImplementationWithStages(t); repository.feedback('init');
  const module = await import('../../src/semantic-view.ts');
  const { reviewFeedback } = await import('../../src/review-feedback.ts');
  const manifest = repository.artifact.readJson('manifest.json');
  const id = module.reviewId(repository.root, manifest.implementationId), review = module.readReview(id);
  const context = module.captureReviewContext(id);
  const record = path.join(module.reviewDirectory(id), 'review.json');
  // The viewer initializes feedback in-process for its review session.
  const read = fs.readFileSync; let removed = false;
  const mocked = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const value = read.call(this, file, ...args);
    if (!removed && String(file) === record) { removed = true; fs.rmSync(path.dirname(String(file)), { recursive: true, force: true }); }
    return value;
  });
  assert.throws(() => reviewFeedback(repository.root, context).initialize(), /deleted|unavailable/);
  mocked.mock.restore();
  assert.equal(removed, true);
  assert.equal(fs.existsSync(module.reviewDirectory(id)), false);
  repository.feedback('init'); assert.notEqual(module.readReview(id).generation, review.generation);
});


test('a viewer feedback write that read the active refs before an archive does not change feedback after it', async (t) => {
  const { repository } = createImplementationWithStages(t); repository.feedback('init');
  repository.feedback('thread', 'add', '--id', 'routing', '--comment-id', 'routing-comment', '--body', 'Check the routing.',
    '--label', 'Implementation', '--target-kind', 'stage', '--stage', 'implementation');
  repository.feedback('thread', 'resolve', '--id', 'routing');
  const module = await import('../../src/semantic-view.ts');
  const { reviewFeedback } = await import('../../src/review-feedback.ts');
  const { activeRef, preloadActiveRefs, readingActiveRefsOnce } = await import('../../src/shared/artifact-store.ts');
  const { implementationId } = repository.artifact.readJson('manifest.json');
  const id = module.reviewId(repository.root, implementationId), context = module.captureReviewContext(id);
  const threadFile = path.join(module.reviewDirectory(id), 'feedback', 'threads', 'routing.json');
  const before = fs.readFileSync(threadFile, 'utf8');
  // A viewer request reads the active refs once; archiving then removes the
  // active ref while the request waits for the review lock.
  await readingActiveRefsOnce(new Map(), async () => {
    await preloadActiveRefs(repository.root);
    const feedback = reviewFeedback(repository.root, context);
    const removed = spawnSync('git', ['update-ref', '-d', activeRef(implementationId)], { cwd: repository.root, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
    assert.throws(() => feedback.replyToThreads([{ id: 'routing', 'comment-id': 'late-reply', body: 'One more thing.' }]), /no longer active/);
    assert.throws(() => feedback.reopenThread('routing'), /no longer active/);
  });
  assert.equal(fs.readFileSync(threadFile, 'utf8'), before);
});
