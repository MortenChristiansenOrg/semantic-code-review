// The viewer serves only its own page: requests must name the viewer as their
// host, come from its own page, and carry its key (or, for the resources the
// browser loads by URL, its read token).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { beginStage, createRepository, finalizeStage, flowCli, initializeImplementation } from "../helpers/repository.mjs";
import { KEY_HEADER, viewerBase, viewerKey } from "../helpers/viewer-client.mjs";
import { createViewerAccess, removeLaunchFile, sweepLaunchFiles, writeLaunchFile } from "../../src/shared/viewer-access.ts";

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

/** One request with full control of its headers, including Host. */
function send(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* Not JSON. */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
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

/** Starts the review of a one-stage implementation; stops it after the test. */
async function startViewer(t) {
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
  const launch = () => {
    const result = spawnSync(process.execPath, [flowCli, "review"], {
      cwd: repository.root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(viewer.requestedPort) },
    });
    assert.equal(result.status, 0, result.stderr);
    const url = /^Semantic review viewer: (\S+)$/m.exec(result.stdout)?.[1];
    assert.ok(url, result.stdout);
    return url;
  };
  viewer.requestedPort = await reservePort();
  viewer.launchUrl = launch();
  viewer.relaunch = launch;
  viewer.url = viewerBase(viewer.launchUrl);
  viewer.port = Number(new URL(viewer.url).port);
  viewer.key = viewerKey(viewer.port);
  assert.match(viewer.key, /^[\w-]{43}$/);
  const keyed = { [KEY_HEADER]: viewer.key };
  const identity = (await send(viewer.port, { path: "/api/whoami", headers: keyed })).json;
  viewer.pid = identity.processId;
  viewer.scope = `review=${encodeURIComponent(identity.reviewId)}&generation=${encodeURIComponent(identity.generation)}`;
  viewer.get = (route, headers = keyed) => send(viewer.port, { path: route, headers });
  viewer.post = (route, body, headers = keyed) => send(viewer.port, { method: "POST", path: route, headers: { "content-type": "application/json", ...headers }, body });
  viewer.session = async (code = new URL(viewer.launchUrl).hash.slice("#launch=".length)) => viewer.post("/api/session", { code }, {});
  return viewer;
}

const refusedForKey = (response, label) => {
  assert.equal(response.status, 403, `${label}: ${response.text}`);
  assert.equal(response.json?.keyRequired, true, label);
};

test("requests that do not name the viewer as their host are refused", async (t) => {
  const viewer = await startViewer(t);
  const keyed = { [KEY_HEADER]: viewer.key };
  for (const host of ["attacker.example", `attacker.example:${viewer.port}`, `127.0.0.1:${viewer.port + 1}`, `127.0.0.1.attacker.example:${viewer.port}`]) {
    for (const route of ["/", "/index.html", "/app.js", "/api/whoami", `/api/implementation?${viewer.scope}`, "/api/bootstrap"]) {
      const response = await viewer.get(route, { ...keyed, host });
      assert.equal(response.status, 421, `${host} ${route}`);
      assert.doesNotMatch(response.text, /implementationId|<script/);
    }
  }
  // Both names of the viewer are served.
  assert.equal((await viewer.get("/", { host: `localhost:${viewer.port}` })).status, 200);
  assert.equal((await viewer.get("/", { host: `LOCALHOST:${viewer.port}` })).status, 200);
  assert.equal((await viewer.get("/api/whoami", { ...keyed, host: `localhost:${viewer.port}` })).status, 200);
});

test("every kind of API route refuses a missing or wrong key", async (t) => {
  const viewer = await startViewer(t);
  const routes = [
    ["GET", `/api/implementation?${viewer.scope}`],
    ["GET", `/api/review-state?${viewer.scope}`],
    ["GET", `/api/reviews?${viewer.scope}`],
    ["POST", `/api/review-state?${viewer.scope}`],
    ["POST", `/api/feedback/export?${viewer.scope}`],
    ["POST", `/api/attachments?${viewer.scope}`],
    ["GET", "/api/whoami"],
    ["POST", "/api/shutdown"],
    ["POST", "/api/launch"],
    ["GET", "/api/bootstrap"],
  ];
  for (const headers of [{}, { [KEY_HEADER]: "wrong" }, { [KEY_HEADER]: viewer.key.slice(0, -1) + (viewer.key.endsWith("A") ? "B" : "A") }]) {
    for (const [method, route] of routes) {
      const response = method === "GET" ? await viewer.get(route, headers) : await viewer.post(route, {}, headers);
      refusedForKey(response, `${method} ${route} ${JSON.stringify(headers)}`);
    }
  }
  // The key works; the old data script is gone.
  const bootstrap = await viewer.get("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.implementation.stages.length, 1);
  assert.equal((await viewer.get("/implementation-data.js")).status, 404);
  assert.equal((await viewer.get("/api/whoami")).json.port, viewer.port);
  assert.equal(exited(viewer.pid), false);
});

test("the read token opens only the browser-loaded resources, and only with GET", async (t) => {
  const viewer = await startViewer(t);
  const { json: started } = await viewer.session();
  assert.equal(started.ok, true);
  assert.equal(started.key, viewer.key);
  const read = started.read;
  assert.notEqual(read, viewer.key);
  const { implementation } = (await viewer.get(`/api/implementation?${viewer.scope}`)).json;
  const [stage] = implementation.stages, [file] = stage.files;
  const content = new URLSearchParams({ stage: stage.id, path: file.path, base: file.baseRevision, head: stage.headRevision });
  const upload = await viewer.post(`/api/attachments?${viewer.scope}`, { filename: "note.txt", mediaType: "text/plain", data: Buffer.from("attached\n").toString("base64") });
  const attachment = upload.json.attachment;
  const withRead = (route, token = read) => `${route}${route.includes("?") ? "&" : "?"}read=${encodeURIComponent(token)}`;

  const raw = await viewer.get(withRead(`/api/file-content?${viewer.scope}&${content}&raw=1`), {});
  assert.equal(raw.status, 200);
  assert.equal(raw.text, "# Implementation\n");
  assert.match(raw.headers["content-security-policy"], /sandbox/);
  assert.equal(raw.headers["x-content-type-options"], "nosniff");
  const download = await viewer.get(withRead(`/api/attachments/${attachment.id}?${viewer.scope}`), {});
  assert.equal(download.status, 200);
  assert.equal(download.text, "attached\n");
  // Authorized, but no such evidence.
  assert.equal((await viewer.get(withRead(`/api/evidence?${viewer.scope}&stage=${stage.id}&item=missing&index=0`), {})).status, 404);

  // A wrong token, other routes and other methods are refused.
  refusedForKey(await viewer.get(withRead(`/api/file-content?${viewer.scope}&${content}&raw=1`, viewer.key), {}), "key as read token");
  refusedForKey(await viewer.get(withRead(`/api/file-content?${viewer.scope}&${content}&raw=1`, "wrong"), {}), "wrong read token");
  refusedForKey(await viewer.get(withRead(`/api/file-content?${viewer.scope}&${content}`), {}), "JSON file content");
  for (const route of [`/api/implementation?${viewer.scope}`, `/api/review-state?${viewer.scope}`, `/api/revision?${viewer.scope}`, "/api/whoami", "/api/bootstrap"]) {
    refusedForKey(await viewer.get(withRead(route), {}), route);
  }
  for (const route of [`/api/attachments?${viewer.scope}`, `/api/review-state?${viewer.scope}`, "/api/shutdown", "/api/launch"]) {
    refusedForKey(await viewer.post(withRead(route), {}, {}), `POST ${route}`);
  }
  assert.equal((await send(viewer.port, { method: "HEAD", path: withRead(`/api/attachments/${attachment.id}?${viewer.scope}`) })).status, 403, "HEAD attachment");
  assert.equal(exited(viewer.pid), false);
});

test("requests from other origins are refused even with the key", async (t) => {
  const viewer = await startViewer(t);
  const keyed = { [KEY_HEADER]: viewer.key };
  const foreign = [
    { origin: "https://attacker.example" },
    { origin: `http://127.0.0.1:${viewer.port + 1}` },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ];
  for (const headers of foreign) {
    for (const response of [
      await viewer.get(`/api/implementation?${viewer.scope}`, { ...keyed, ...headers }),
      await viewer.get("/api/bootstrap", { ...keyed, ...headers }),
      await viewer.post(`/api/review-state?${viewer.scope}`, {}, { ...keyed, ...headers }),
      await viewer.post("/api/shutdown", {}, { ...keyed, ...headers }),
      await viewer.post("/api/session", { code: "unused" }, headers),
    ]) {
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.json?.keyRequired, undefined);
    }
  }
  // A refused session request does not spend the code.
  const code = new URL(viewer.launchUrl).hash.slice("#launch=".length);
  assert.equal((await viewer.post("/api/session", { code }, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await viewer.session(code)).status, 200);
  // The viewer's own origins pass, and any site may navigate to the page itself.
  for (const origin of [`http://127.0.0.1:${viewer.port}`, `http://localhost:${viewer.port}`]) {
    assert.equal((await viewer.get("/api/bootstrap", { ...keyed, origin, "sec-fetch-site": "same-origin" })).status, 200);
  }
  assert.equal((await viewer.get("/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status, 200);
  assert.equal(exited(viewer.pid), false);
});

test("launch codes work once", async (t) => {
  const viewer = await startViewer(t);
  const first = await viewer.session();
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json).sort(), ["key", "ok", "read"]);
  refusedForKey(await viewer.session(), "spent code");
  refusedForKey(await viewer.session("not-a-code"), "unknown code");
  refusedForKey(await viewer.post("/api/session", {}, {}), "no code");
  // Launching the running review again prints a new link without restarting it.
  const relaunched = viewer.relaunch();
  assert.equal(viewerBase(relaunched), viewer.url);
  assert.notEqual(relaunched, viewer.launchUrl);
  assert.equal((await viewer.session(new URL(relaunched).hash.slice("#launch=".length))).status, 200);
  const minted = await viewer.post("/api/launch", {});
  assert.equal(minted.status, 200);
  assert.equal((await viewer.session(minted.json.code)).status, 200);
  refusedForKey(await viewer.session(minted.json.code), "spent minted code");
});

test("launch codes expire, are limited in number, and remove their launch files", (t) => {
  const reviewId = `access--test--${"a".repeat(64)}`;
  let now = 1_000_000;
  const access = createViewerAccess(reviewId, () => now);
  const expiring = access.mintCode();
  now += 10 * 60 * 1000 - 1;
  const valid = access.mintCode();
  now += 1;
  assert.equal(access.redeem(expiring), false);
  assert.equal(access.redeem(valid), true);
  assert.equal(access.redeem(valid), false);

  const codes = Array.from({ length: 17 }, () => access.mintCode());
  assert.equal(access.outstanding(), 16);
  assert.equal(access.redeem(codes[0]), false);
  assert.equal(access.redeem(codes[16]), true);

  const code = access.mintCode();
  const file = writeLaunchFile(reviewId, 29180, code);
  t.after(() => fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true }));
  const page = fs.readFileSync(file, "utf8");
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.ok(page.includes(`content="0;url=http://127.0.0.1:29180/#launch=${code}"`));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  assert.equal(access.redeem(code), true);
  assert.equal(fs.existsSync(file), false);
  const expired = access.mintCode();
  const expiredFile = writeLaunchFile(reviewId, 29180, expired);
  now += 10 * 60 * 1000;
  access.expire();
  assert.equal(fs.existsSync(expiredFile), false);
  // Files a viewer no longer knows are swept.
  const stale = writeLaunchFile(reviewId, 29180, "stale-code-from-an-earlier-viewer");
  sweepLaunchFiles(reviewId, 60_000, Date.now() + 61_000);
  assert.equal(fs.existsSync(stale), false);
  removeLaunchFile(reviewId, "never-written");
});

test("the page and its files are sent with a policy that blocks inline script and framing", async (t) => {
  const viewer = await startViewer(t);
  const page = await viewer.get("/", {});
  assert.equal(page.status, 200);
  const policy = page.headers["content-security-policy"];
  const directives = new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'none'"]);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|data:|blob:/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(page.headers["cross-origin-resource-policy"], "same-origin");
  // The page loads only its start script and has no inline script.
  assert.deepEqual([...page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attributes, body]) => [attributes.trim(), body]), [['src="boot.js"', ""]]);
  for (const file of ["/boot.js", "/app.js", "/markdown.js", "/styles.css", "/favicon.svg"]) {
    const response = await viewer.get(file, {});
    assert.equal(response.status, 200, file);
    assert.equal(response.headers["content-security-policy"], policy, file);
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin", file);
  }
  // API responses, including refusals, are not readable by other sites either.
  for (const response of [await viewer.get("/api/whoami"), await viewer.get("/api/whoami", {})]) {
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
  }
  // Only the bundled files are served.
  for (const route of ["/viewer/index.html", "/../review.json", "/%2e%2e/review.json", "/index.html/", "/README.md"]) {
    assert.equal((await viewer.get(route, {})).status, 404, route);
  }
  assert.equal((await send(viewer.port, { path: "http://attacker.example/" })).status, 400);
});
