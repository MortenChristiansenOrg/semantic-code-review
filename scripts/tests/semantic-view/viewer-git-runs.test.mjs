// How often a viewer request runs Git. Each Git process is slow to start on
// Windows, so a request that runs it again for every check makes the page slow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { beginStage, createRepository, finalizeStage, flowCli, initializeImplementation } from "../helpers/repository.mjs";
import { KEY_HEADER, viewerBase, viewerKey } from "../helpers/viewer-client.mjs";
import { deleteReviewData, inspectReviewStorage } from "../../src/semantic-view.ts";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* Not JSON. */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

/** Starts the review of a one-stage implementation with Git tracing every
 * process it starts to a file; stops it after the test. */
async function startTracedViewer(t) {
  const viewer = {};
  t.after(async () => {
    if (!viewer.port || exited(viewer.pid)) return;
    await send(viewer.port, { method: "POST", path: "/api/shutdown", headers: { "content-type": "application/json", [KEY_HEADER]: viewer.key }, body: {} }).catch(() => {});
    for (let attempt = 0; attempt < 100 && !exited(viewer.pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { file: "implementation.md", contents: "# Implementation\n" });
  const trace = path.join(fs.mkdtempSync(path.join(path.dirname(repository.root), "git-trace-")), "trace.log");
  const result = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(await reservePort()), GIT_TRACE: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  const url = viewerBase(/^Semantic review viewer: (\S+)$/m.exec(result.stdout)?.[1]);
  viewer.port = Number(new URL(url).port);
  viewer.key = viewerKey(viewer.port);
  const keyed = { [KEY_HEADER]: viewer.key };
  const identity = (await send(viewer.port, { path: "/api/whoami", headers: keyed })).json;
  viewer.pid = identity.processId;
  viewer.identity = identity;
  viewer.repository = repository;
  viewer.trace = trace;
  const scope = `review=${encodeURIComponent(identity.reviewId)}&generation=${encodeURIComponent(identity.generation)}`;
  viewer.scope = () => scope;
  const runs = viewer.runs = () => (fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "").split("\n").filter((line) => / trace: built-in: git /.test(line));
  /** The response to a scoped request, and the Git commands it ran. */
  viewer.get = async (route) => {
    const before = runs().length;
    const response = await send(viewer.port, { path: `${route}${route.includes("?") ? "&" : "?"}${scope}`, headers: keyed });
    return { response, git: runs().slice(before).map((line) => line.replace(/^.* trace: built-in: git /, "")) };
  };
  return viewer;
}

/** The Git commands run more than once in a list of them. */
const repeated = (commands) => commands.filter((command, index) => commands.indexOf(command) !== index);

test("a viewer request reads the active refs once, and a repeated one runs Git only for that", async (t) => {
  const viewer = await startTracedViewer(t);
  const first = await viewer.get("/api/implementation");
  assert.equal(first.response.status, 200, first.response.text);
  const stage = first.response.json.implementation.stages[0];
  const file = stage.files[0];
  const diff = `/api/diff?stage=${encodeURIComponent(stage.id)}&path=${encodeURIComponent(file.path)}&base=${file.baseRevision}&head=${stage.headRevision}`;
  const requests = [["first /api/implementation", first]];
  for (const route of ["/api/implementation", "/api/revision", "/api/revision", "/api/bootstrap", "/api/review-state", diff, diff]) {
    const result = await viewer.get(route);
    assert.equal(result.response.status, 200, `${route}: ${result.response.text}`);
    requests.push([route, result]);
  }
  for (const [route, { git }] of requests) {
    t.diagnostic(`${route}: ${git.length} Git runs: ${git.map((command) => command.split(" ")[0]).join(", ")}`);
    assert.ok(git.filter((command) => command.startsWith("for-each-ref")).length <= 1, `${route} read the active refs more than once:\n${git.join("\n")}`);
    // The first use of a snapshot reads its review identity apart from its documents.
    const once = route === "first /api/implementation" ? repeated(git).filter((command, index, all) => command !== "cat-file --batch" || all.indexOf(command) !== index) : repeated(git);
    assert.deepEqual(once, [], `${route} ran Git commands again`);
  }
  // A request after the first reads the refs and finds the snapshot it already read.
  for (const [route, { git }] of requests.slice(1, 4)) {
    assert.deepEqual(git.map((command) => command.split(" ")[0]), ["for-each-ref"], `${route}:\n${git.join("\n")}`);
  }
});

/** Moves the active ref to a snapshot like the current one, with another review
 * ID; returns the commit it held before. */
function replaceReviewId(repository, implementationId, reviewId) {
  const ref = `refs/semantic-review/active/${implementationId}`;
  const previous = repository.git("rev-parse", ref);
  const index = path.join(fs.mkdtempSync(path.join(path.dirname(repository.root), "review-index-")), "index");
  const git = (args, input) => spawnSync("git", args, { cwd: repository.root, input, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: index } }).stdout.trim();
  git(["read-tree", previous]);
  const blob = git(["hash-object", "-w", "--stdin"], `${JSON.stringify({ reviewId }, null, 2)}\n`);
  git(["update-index", "--cacheinfo", `100644,${blob},review.json`]);
  const commit = git(["commit-tree", git(["write-tree"]), "-p", previous, "-m", "Another review"]);
  repository.git("update-ref", ref, commit, previous);
  return previous;
}

test("a viewer refuses requests once the implementation names another review or is no longer active", async (t) => {
  const viewer = await startTracedViewer(t);
  const { implementationId, reviewId } = viewer.identity;
  const ref = `refs/semantic-review/active/${implementationId}`;
  assert.equal((await viewer.get("/api/revision")).response.status, 200);
  const original = replaceReviewId(viewer.repository, implementationId, reviewId.replace(/[a-f0-9]{8}$/, "00000000"));
  for (const route of ["/api/revision", "/api/implementation"]) {
    const { response } = await viewer.get(route);
    assert.equal(response.status, 409, `${route}: ${response.text}`);
    assert.match(response.json.error, /another review/);
    assert.equal(response.json.reviewUnavailable, false);
  }
  // What was read before is reused only for the snapshot it was read from.
  viewer.repository.git("update-ref", ref, original);
  assert.equal((await viewer.get("/api/revision")).response.status, 200);
  viewer.repository.git("update-ref", "-d", ref);
  const { response } = await viewer.get("/api/revision");
  assert.equal(response.status, 409, response.text);
  assert.match(response.json.error, /no longer active/);
  viewer.repository.git("update-ref", ref, original);
  assert.equal((await viewer.get("/api/revision")).response.status, 200);
});

test("a viewer refuses requests once its review is deleted", async (t) => {
  const viewer = await startTracedViewer(t);
  const { reviewId, generation } = viewer.identity;
  assert.equal((await viewer.get("/api/revision")).response.status, 200);
  assert.equal(deleteReviewData(reviewId, generation, inspectReviewStorage(reviewId, generation).fingerprint).deleted, true);
  for (const route of ["/api/revision", "/api/implementation", "/api/review-state"]) {
    const { response } = await viewer.get(route);
    assert.equal(response.status, 409, `${route}: ${response.text}`);
    assert.equal(response.json.reviewUnavailable, true, route);
  }
  // Once the viewer has retired its worker, the refusal still says why.
  const keyed = { [KEY_HEADER]: viewer.key };
  const healthy = async () => (await send(viewer.port, { path: "/api/whoami", headers: keyed })).json.healthy;
  for (let attempt = 0; attempt < 100 && await healthy(); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await healthy(), false, "The viewer did not retire its worker.");
  const { response } = await viewer.get("/api/revision");
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.reviewUnavailable, true);
  assert.match(response.json.error, /unavailable or was deleted/);
});

for (const [route, fields] of [["/api/draft-snapshots", { notes: [] }], ["/api/attachments", { data: "aGk=", filename: "note.txt", mediaType: "text/plain" }]]) {
  test(`a ${route} request whose body arrives after its review ID was replaced is refused`, async (t) => {
    const viewer = await startTracedViewer(t);
    const { implementationId, reviewId } = viewer.identity;
    const body = JSON.stringify(fields);
    const post = (hold) => new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: viewer.port, method: "POST", path: `${route}?${viewer.scope()}`, headers: {
        host: `127.0.0.1:${viewer.port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), [KEY_HEADER]: viewer.key,
      } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      request.on("error", reject);
      request.write(body.slice(0, 1));
      hold().then(() => request.end(body.slice(1)), reject);
    });
    const checked = async (before) => {
      for (let attempt = 0; attempt < 200 && viewer.runs().length === before; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      // The check read the refs before the rest of the body is sent.
      assert.ok(viewer.runs().length > before, "The request's review was not checked.");
    };
    let before = viewer.runs().length;
    const accepted = await post(() => checked(before));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    before = viewer.runs().length;
    const refused = await post(async () => {
      await checked(before);
      replaceReviewId(viewer.repository, implementationId, reviewId.replace(/[a-f0-9]{8}$/, "00000000"));
    });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /another review/);
  });
}

test("the jobs after a request body share one read of the active refs", async (t) => {
  const viewer = await startTracedViewer(t);
  const { implementationId } = viewer.identity;
  const before = viewer.runs().length;
  // A thread action reads the implementation, then acts on the thread: two jobs after the body.
  const { status } = await send(viewer.port, { method: "POST", path: `/api/feedback/reopen?${viewer.scope()}`,
    headers: { "content-type": "application/json", [KEY_HEADER]: viewer.key }, body: { implementationId, threadId: "missing" } });
  assert.equal(status, 422);
  const reads = viewer.runs().slice(before).filter((line) => / trace: built-in: git for-each-ref /.test(line));
  // One read checks the review before the body, one serves the jobs after it.
  assert.equal(reads.length, 2, reads.join("\n"));
});
