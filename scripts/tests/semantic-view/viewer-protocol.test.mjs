// The viewer page and its server share the types in src/shared/viewer-protocol.ts.
// The server's handlers are typed with them; this test checks what a running server
// actually sends against the same types, so a shape that drifts at a runtime
// boundary (the worker's structured clone, stored JSON) fails here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createImplementationWithStages, flowCli } from "../helpers/repository.mjs";

const protocol = fileURLToPath(new URL("../../src/shared/viewer-protocol.ts", import.meta.url));

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

async function stopViewer(url, pid) {
  await fetch(url + "api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  for (let attempt = 0; pid !== undefined && attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Type-checks each captured body as an object literal of its protocol type, which
 * also rejects fields the protocol does not declare. Returns the diagnostics. */
function protocolErrors(captured) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-protocol-"));
  try {
    const file = path.join(directory, "responses.ts");
    const lines = [`import type * as Wire from ${JSON.stringify(protocol.replace(/\.ts$/, ".js"))};`];
    captured.forEach(({ type, body }, index) => {
      // An object literal's "__proto__" key sets a prototype; the stored state's own keys are checked separately.
      lines.push(`export const response${index}: Wire.${type} = ${JSON.stringify(body).replaceAll('"__proto__":', '"proto":')};`);
    });
    fs.writeFileSync(file, lines.join("\n"));
    const program = ts.createProgram([file], {
      strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts"],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const entry = diagnostic.file.fileName === file ? captured[line - 1] : undefined;
      return `${entry ? `${entry.route} (${entry.type})` : diagnostic.file.fileName}: ${message}`;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("a running viewer answers every JSON route with the shared protocol types", async (t) => {
  const { repository } = createImplementationWithStages(t);
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/`;
  const launch = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(port) },
  });
  assert.equal(launch.status, 0, launch.stderr);
  const pid = Number(/\(PID (\d+)\)/.exec(launch.stdout)?.[1]) || undefined;
  t.after(() => stopViewer(url, pid));

  const captured = [];
  const capture = async (type, route, init, status = 200) => {
    const response = await fetch(url + route, init);
    const body = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
    captured.push({ type, route, body });
    return body;
  };
  const identity = await capture("WhoAmIResponse", "api/whoami");
  const query = `review=${encodeURIComponent(identity.reviewId)}&generation=${encodeURIComponent(identity.generation)}`;
  const get = (type, route, status) => capture(type, `${route}${route.includes("?") ? "&" : "?"}${query}`, undefined, status);
  const post = (type, route, body, status) => capture(type, `${route}?${query}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, status);

  const { implementation } = await get("ImplementationResponse", "api/implementation");
  const [stage] = implementation.stages, [file] = stage.files, [ownership] = file.memberships;
  await get("RevisionResponse", "api/revision");
  await get("DiffResponse", `api/diff?${new URLSearchParams({ stage: stage.id, path: file.path, base: file.baseRevision, head: stage.headRevision })}`);
  await get("ApiFailure", "api/diff", 400);

  const target = { reviewId: identity.reviewId, generation: identity.generation };
  await get("ReviewStateResponse", "api/review-state");
  const names = ["__proto__", "constructor", "prototype"];
  const changes = names.flatMap((name) => [
    { path: ["approvals", name], before: { present: false }, after: { present: true, value: { rev: null, at: 1 } } },
    { path: ["specificationOpen", name], before: { present: false }, after: { present: true, value: true } },
  ]);
  const saved = await post("ReviewStateResponse", "api/review-state", { ...target, changes });
  // Keys named like prototype properties are stored and returned as own keys.
  const reread = JSON.parse(await (await fetch(`${url}api/review-state?${query}`)).text());
  for (const state of [saved.state, reread.state]) {
    for (const name of names) {
      assert.ok(Object.hasOwn(state.approvals, name) && Object.hasOwn(state.specificationOpen, name), name);
      assert.equal(state.specificationOpen[name], true);
    }
  }

  const endpoint = { stageId: stage.id, nodeId: ownership.nodeId, path: file.path, baseRevision: file.baseRevision,
    headRevision: stage.headRevision, fileRevision: file.revision, ownership };
  const { snapshotId } = await post("ApprovalSnapshotResponse", "api/approval-snapshots", endpoint);
  await post("ApprovalComparisonResponse", "api/approval-comparison", { ...endpoint, snapshotId });
  await post("DraftSnapshotsResponse", "api/draft-snapshots", { notes: [
    { kind: "line", id: `l:${stage.id}:new:1:${file.path}`, snapshot: { base: stage.baseRevision, head: stage.headRevision } },
    { kind: "stage", id: stage.id },
  ] });

  const sent = await post("FeedbackExportResponse", "api/feedback/export", { implementationId: implementation.implementationId, replies: [],
    notes: [{ ref: 0, kind: "stage", id: stage.id, body: "Check this stage.", attachments: [], clientId: "note-1" }] });
  const threadId = sent.exported[0].threadId;
  await post("FeedbackExportResponse", "api/feedback/export", { implementationId: implementation.implementationId, notes: [], replies: [] }, 422);
  await post("ThreadActionResponse", "api/feedback/reply", { implementationId: implementation.implementationId, threadId, body: "More detail.", clientId: "reply-1" });
  await post("ThreadActionResponse", "api/feedback/resolve", { implementationId: implementation.implementationId, threadId });
  await post("AgentControlResponse", "api/agent/stop", {});

  await get("ReviewsResponse", "api/reviews");
  const { storage } = await post("ReviewStorageResponse", "api/reviews/storage", target);
  await post("ReviewCleanResponse", "api/reviews/clean-unused", { ...target, fingerprint: storage.fingerprint });
  await post("OkResponse", "api/reviews/completion", { ...target, completed: true, expectedCompletedAt: null });

  assert.deepEqual(protocolErrors(captured), []);
});

test("the protocol check reports a body that drifts from its type", () => {
  const errors = protocolErrors([
    { type: "RevisionResponse", route: "missing", body: { ok: true, revision: "r", awaitingAgentReplies: 0 } },
    { type: "OkResponse", route: "extra", body: { ok: true, unexpected: 1 } },
  ]);
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /^missing \(RevisionResponse\):.*agent/s);
  assert.match(errors[1], /^extra \(OkResponse\):.*unexpected/s);
});
