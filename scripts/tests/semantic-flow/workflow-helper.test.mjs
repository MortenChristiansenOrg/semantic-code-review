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

async function stopViewer(port, pid) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
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

  const response = await fetch(`http://127.0.0.1:${port}/api/whoami`);
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
  const reused = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  assert.equal(reused.processId, identity.processId);
  assert.match(reused.viewerVersion, /^[0-9a-f]{64}$/);
  const payload = await fetch(`http://127.0.0.1:${port}/api/implementation?review=${identity.reviewId}&generation=${identity.generation}`).then((response) => response.json());
  assert.equal(payload.ok, true);
  assert.equal(payload.implementation.implementationId, "persistent-review");

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
  repository.write(repository.feedbackPath("orphan.json"), "{}\n");

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
        const result = spawnSync(process.execPath, [
          path.join(installedSkill, "scripts", "semantic-implementation.mjs"), ...args,
        ], { cwd: target, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      },
    });
  }
  return {
    root, source, target, installedSkill, run, initialize,
    update: async (env) => {
      const child = spawn(process.execPath, [
        copiedCli, "update", "--source", source, "--use-current-source",
      ], {
        cwd: target, env: { ...process.env, ...env },
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
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/whoami`));
});

test("update restarts a matching linked-worktree viewer without changing artifacts", async (t) => {
  const port = await reserveViewerPort();
  let viewerPid;
  t.after(() => stopViewer(port, viewerPid));
  const fixture = createUpdateFixture(t);
  fixture.initialize();
  const original = fs.readFileSync(path.join(fixture.target, ".semantic-review", "manifest.json"), "utf8");
  const linked = path.join(fixture.root, "linked");
  const worktree = spawnSync("git", ["worktree", "add", "-b", "review-work", linked], {
    cwd: fixture.target, encoding: "utf8",
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  fs.renameSync(path.join(fixture.target, ".semantic-review"), path.join(linked, ".semantic-review"));
  fs.appendFileSync(path.join(fixture.source, "skills", "semantic-flow", "viewer", "styles.css"), "\n/* updated */\n");
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: "1" };
  const launch = fixture.run(["review", "--project", linked], env);
  assert.equal(launch.status, 0, launch.stderr);
  const before = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = before.processId;
  assert.equal(before.skillDirectory, fixture.installedSkill);
  const result = await fixture.update(env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const after = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = after.processId;
  assert.notEqual(after.processId, before.processId);
  assert.throws(() => process.kill(before.processId, 0), { code: "ESRCH" });
  assert.notEqual(after.viewerVersion, before.viewerVersion);
  assert.equal(after.repositoryRoot, linked);
  assert.equal(after.implementationId, before.implementationId);
  assert.equal(fs.readFileSync(path.join(linked, ".semantic-review", "manifest.json"), "utf8"), original);
  assert.ok(result.stdout.includes(`Updated semantic-flow ${builtSkillVersion} -> 9.9.9`));
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
  const identity = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
    const after = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
  const before = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
  const after = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
  const identity = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
  const identity = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
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
  const current = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((response) => response.json());
  viewerPid = current.processId;
  assert.ok(previous.messages.includes("shutdown"));
  assert.equal(current.skillDirectory, fs.realpathSync.native(fixture.installedSkill));
});

test("concurrent review services isolate commands and reopen registered worktrees", async (t) => {
  const viewers = [];
  t.after(async () => { for (const viewer of viewers) await stopViewer(viewer.port, viewer.processId); });
  const { repository: a } = createImplementationWithStages(t);
  const b = createRepository(t, "concurrent-review-b-");
  initializeImplementation(b); // Deliberately the same implementation ID.
  const linked = a.path("../", path.basename(a.root) + "-linked");
  a.git("worktree", "add", "--detach", linked, "HEAD");
  fs.cpSync(a.path(".semantic-review"), path.join(linked, ".semantic-review"), { recursive: true });
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const port = await reserveViewerPort();
  const deniedPortHook = a.path("denied-port.cjs");
  fs.writeFileSync(deniedPortHook, `const net = require('node:net'); const listen = net.Server.prototype.listen; let denied = 0; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && denied++ < 2) { process.nextTick(() => this.emit('error', Object.assign(new Error('Reserved port'), { code: 'EACCES' }))); return this; } return listen.apply(this, args); };`);
  const start = async (root, denyPorts = false) => {
    const child = spawn(process.execPath, [path.join(scriptsDirectory, "semantic-view.mjs"), "review", root], {
      cwd: a.root, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port), GIT_DIR: a.path(".git"), ...(denyPorts ? { NODE_OPTIONS: `--import=${pathToFileURL(deniedPortHook).href}` } : {}) },
    });
    const [message] = await once(child, "message");
    assert.equal(message.type, "ready", JSON.stringify(message));
    const identity = await fetch(new URL("api/whoami", message.url)).then((r) => r.json());
    viewers.push(identity); child.unref();
    return { ...identity, url: message.url };
  };
  const first = await start(a.root), second = await start(b.root), third = await start(linked, true);
  assert.equal(new Set([first.port, second.port, third.port]).size, 3);
  assert.equal(new Set([first.reviewId, second.reviewId, third.reviewId]).size, 3);
  const request = (viewer, route, body, review = viewer.reviewId) => fetch(new URL(`${route}?review=${review}&generation=${viewer.generation}`, viewer.url), {
    ...(body ? { method: "POST", headers: { "content-type": "application/json", origin: new URL(viewer.url).origin }, body: JSON.stringify(body) } : {}),
  });
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
  const preview = await fetch(previewUrl); assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await request(first, `api/attachments/${attached.attachment.id}`)).status, 404);
  assert.equal((await request(third, "api/attachments", { ...upload, filename: "../escape" })).status, 400);
  assert.equal((await request(third, "api/attachments", { ...upload, data: "https://example.test/image.png" })).status, 400);
  const payload = { implementationId: third.implementationId, notes: [{ ref: 0, kind: "stage", id: "implementation", body: "Only linked worktree", attachments: [attached.attachment], clientId: "concurrent-context" }] };
  const exports = await Promise.all([request(third, "api/feedback/export", payload), request(third, "api/feedback/export", payload)]);
  for (const result of exports) assert.equal(result.status, 200, await result.text());
  assert.equal(a.exists(a.feedbackPath("manifest.json")), false);
  assert.equal(b.exists(b.feedbackPath("manifest.json")), false);
  const module = await import(pathToFileURL(path.join(scriptsDirectory, "semantic-view.mjs")).href);
  // A management request waiting on B's lock must not block A's HTTP loop.
  const heldLock = path.join(process.env.SEMANTIC_FLOW_HOME, "locks", third.reviewId + ".lock");
  fs.mkdirSync(heldLock);
  fs.writeFileSync(path.join(heldLock, "owner-00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ pid: process.pid }));
  const blockedStorage = request(first, "api/reviews/storage", { reviewId: third.reviewId, generation: third.generation });
  try {
    await delay(150);
    const responsive = await Promise.race([request(first, "api/implementation"), delay(1500).then(() => { throw new Error("Storage lock blocked the HTTP loop"); })]);
    assert.equal(responsive.status, 200);
  } finally { fs.rmSync(heldLock, { recursive: true }); }
  assert.equal((await blockedStorage).status, 200);
  const linkedFeedback = module.feedbackDirectory(linked);
  assert.equal(fs.readdirSync(path.join(linkedFeedback, "threads")).length, 1);
  const context = module.captureReviewContext(third.reviewId);
  const oldGit = process.env.GIT_DIR;
  const oldLowerGit = process.env.git_dir;
  process.env.git_dir = a.path(".git");
  process.env.GIT_DIR = a.path(".git");
  try {
    assert.equal(module.runReviewCommand(context, process.execPath, ["-e", "console.log(process.env.git_dir || process.env.GIT_DIR || 'clear')"]).trim(), "clear");
    assert.equal(module.runReviewCommand(context, "git", ["rev-parse", "--show-toplevel"]).trim(), linked.replaceAll("\\", "/"));
    assert.throws(() => module.runReviewCommand(context, "git", ["status"], { workingWorktree: b.root }), /another repository/);
  } finally { if (oldLowerGit === undefined) delete process.env.git_dir; else process.env.git_dir = oldLowerGit; if (oldGit === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGit; }
  const opened = await request(first, "api/reviews/open", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(opened.url, third.url);
  await stopViewer(third.port, third.processId);
  viewers.pop();
  const restarted = await request(first, "api/reviews/open", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  const recovered = await fetch(new URL("api/whoami", restarted.url)).then((r) => r.json()); viewers.push(recovered);
  assert.equal(recovered.reviewId, third.reviewId);
  assert.notEqual(recovered.processId, third.processId);
  const manifestPath = path.join(linked, ".semantic-review", "manifest.json"), originalManifest = fs.readFileSync(manifestPath);
  fs.writeFileSync(manifestPath, '{broken JSON');
  const failedBootstrap = await fetch(new URL("implementation-data.js", restarted.url));
  assert.equal(failedBootstrap.status, 500); assert.doesNotMatch(await failedBootstrap.text(), /SEMANTIC_IMPLEMENTATION/);
  fs.writeFileSync(manifestPath, originalManifest);
  assert.equal((await fetch(new URL("implementation-data.js", restarted.url))).status, 200);
  fs.rmSync(path.join(linked, ".semantic-review"), { recursive: true });
  const unavailableBootstrap = await fetch(new URL("implementation-data.js", restarted.url));
  assert.equal(unavailableBootstrap.status, 200); assert.match(await unavailableBootstrap.text(), /SEMANTIC_REVIEW_CONTEXT/);
  assert.throws(() => module.runReviewCommand(context, "git", ["status"]), /unavailable/);
  assert.equal((await request({ ...recovered, url: restarted.url }, "api/feedback/export", payload)).status, 409);
  assert.equal((await request(first, "api/implementation")).status, 200);
  const missingViewer = { ...recovered, url: restarted.url };
  const saved = await request(missingViewer, "api/review-state", { reviewId: recovered.reviewId, generation: recovered.generation, changes: [{ path: ['draft'], before: { present: false }, after: { present: true, value: 'Retain after removal' } }] });
  assert.equal(saved.status, 200, await saved.text());
  const list = await request(missingViewer, "api/reviews").then((r) => r.json());
  assert.equal(list.reviews.find((r) => r.id === recovered.reviewId).available, false);
  assert.equal((await request(missingViewer, "api/reviews/open", { reviewId: first.reviewId, generation: first.generation })).status, 200);
  const storage = await request(first, "api/reviews/storage", { reviewId: third.reviewId, generation: third.generation }).then((r) => r.json());
  assert.equal(storage.ok, true, JSON.stringify(storage)); assert.ok(storage.storage.bytes > 0);
  const deleted = await request(first, "api/reviews/delete", { reviewId: third.reviewId, generation: third.generation, fingerprint: storage.storage.fingerprint }).then((r) => r.json());
  assert.equal(deleted.deleted, true); assert.equal(deleted.cleanupPending, false);
  assert.equal((await request(missingViewer, "api/review-state")).status, 409);
  assert.equal((await request(missingViewer, "api/attachments", upload)).status, 409);
  assert.equal((await request(missingViewer, "api/review-state", { reviewId: third.reviewId, generation: third.generation, changes: [] })).status, 409);
  assert.equal((await request(missingViewer, "api/reviews")).status, 200);
  const bootstrap = await fetch(new URL("implementation-data.js", missingViewer.url)).then((r) => r.text());
  assert.match(bootstrap, /SEMANTIC_REVIEW_CONTEXT/); assert.match(bootstrap, /"stages":\[\]/);
  await delay(1200);
  assert.equal((await fetch(new URL("api/whoami", missingViewer.url)).then((r) => r.json())).healthy, false);
  assert.equal((await request(first, "api/implementation")).status, 200);

});


test('a viewer-triggered feedback init cannot recreate data deleted after its initial generation check', async (t) => {
  const { repository } = createImplementationWithStages(t); repository.feedback('init');
  const module = await import(pathToFileURL(path.join(scriptsDirectory, 'semantic-view.mjs')).href);
  const manifest = repository.readJson('.semantic-review/manifest.json');
  const id = module.reviewId(repository.root, manifest.implementationId), review = module.readReview(id);
  const record = path.join(module.reviewDirectory(id), 'review.json');
  const preload = repository.path('delete-during-read.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; import path from 'node:path'; const read = fs.readFileSync; let removed = false; fs.readFileSync = function(file, ...args) { const value = read.call(this, file, ...args); if (!removed && String(file) === ${JSON.stringify(record)}) { removed = true; fs.rmSync(path.dirname(String(file)), { recursive: true, force: true }); } return value; };`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scriptsDirectory, 'review-feedback.mjs'), 'init'], { cwd: repository.root, env: { ...process.env, SEMANTIC_FLOW_REVIEW_ID: id, SEMANTIC_FLOW_REVIEW_GENERATION: review.generation }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /deleted|unavailable/);
  assert.equal(fs.existsSync(module.reviewDirectory(id)), false);
  repository.feedback('init'); assert.notEqual(module.readReview(id).generation, review.generation);
});
