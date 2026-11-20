// The viewer page and its server share the types in src/shared/viewer-protocol.ts.
// The server's handlers are typed with them; this test checks what a running server
// actually sends against the same types, so a shape that drifts at a runtime
// boundary (the worker's structured clone, stored JSON) fails here. It also checks
// that a change to the protocol fails the typecheck of both the server and the
// page's request module.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { captureCodeTarget } from "../../src/semantic-view.ts";
import { beginStage, createRepository, finalizeStage, flowCli, initializeImplementation } from "../helpers/repository.mjs";
import { viewerBase, viewerFetch, viewerKey } from "../helpers/viewer-client.mjs";

const protocol = fileURLToPath(new URL("../../src/shared/viewer-protocol.ts", import.meta.url));
const scriptsRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = path.resolve(scriptsRoot, "..");

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

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

/** Stops a viewer. One that already exited is not asked again: its port may since
 * serve another test's viewer. */
async function stopViewer({ url, pid, key }) {
  if (pid !== undefined && exited(pid)) return;
  if (url) await viewerFetch(url + "api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, key).catch(() => {});
  for (let attempt = 0; pid !== undefined && attempt < 100; attempt++) {
    if (exited(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (pid !== undefined) assert.fail(`Viewer process ${pid} did not exit after shutdown`);
}

/** Registers the viewer's shutdown before any fixture cleanup: cleanup hooks run in
 * registration order, and Windows cannot remove the viewer's working directory
 * while the viewer runs. Fill in the returned record with startViewer. */
function viewerCleanup(t) {
  const viewer = {};
  t.after(() => stopViewer(viewer));
  return viewer;
}

/** Launches the review of a repository into `viewer`. The launcher may fall back to
 * another port than the requested one, so the URL is the one it reports. */
async function startViewer(viewer, repository) {
  const launch = spawnSync(process.execPath, [flowCli, "review"], {
    cwd: repository.root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: "1", SEMANTIC_VIEW_PORT: String(await reservePort()) },
  });
  viewer.pid = Number(/\(PID (\d+)\)/.exec(launch.stdout)?.[1]) || undefined;
  const printed = /^Semantic review viewer: (\S+)$/m.exec(launch.stdout)?.[1];
  assert.equal(launch.status, 0, launch.stderr);
  assert.ok(printed, launch.stdout);
  assert.match(printed, /\/#launch=[\w-]+$/);
  viewer.url = viewerBase(printed);
  viewer.key = viewerKey(new URL(viewer.url).port);
}

/** Requests that record each JSON response with the protocol type it should have. */
async function client(url) {
  const captured = [];
  // Read now: deleting the review removes its record.
  const key = viewerKey(new URL(url).port);
  const capture = async (type, route, init, status = 200) => {
    const response = await viewerFetch(url + route, init, key);
    const body = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
    captured.push({ type, route, body });
    return body;
  };
  const identity = await capture("WhoAmIResponse", "api/whoami");
  const query = `review=${encodeURIComponent(identity.reviewId)}&generation=${encodeURIComponent(identity.generation)}`;
  const scoped = (route) => `${route}${route.includes("?") ? "&" : "?"}${query}`;
  const get = (type, route, status) => capture(type, scoped(route), undefined, status);
  const post = (type, route, body, status) => capture(type, scoped(route),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, status);
  return { captured, capture, identity, get, post, target: { reviewId: identity.reviewId, generation: identity.generation } };
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
      // The compiler reports file names with forward slashes on every platform.
      const entry = path.resolve(diagnostic.file.fileName) === path.resolve(file) ? captured[line - 1] : undefined;
      return `${entry ? `${entry.route} (${entry.type})` : diagnostic.file.fileName}: ${message}`;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/** An implementation of one stage that changes a Markdown file. */
function createReviewRepository(t) {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository, { file: "implementation.md", contents: "# Implementation\n" });
  return repository;
}

test("a running viewer answers every JSON route with the shared protocol types", async (t) => {
  const viewer = viewerCleanup(t);
  const repository = createReviewRepository(t);
  await startViewer(viewer, repository);
  const { captured, capture, get, post, target } = await client(viewer.url);

  const { implementation } = await get("ImplementationResponse", "api/implementation");
  const [stage] = implementation.stages, [file] = stage.files, [ownership] = file.memberships;

  await capture("BootstrapResponse", "api/bootstrap");
  const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { code } = await capture("LaunchResponse", "api/launch", json({}));
  await capture("SessionResponse", "api/session", json({ code }));
  await capture("ApiFailure", "api/session", json({ code }), 403);
  await get("RevisionResponse", "api/revision");
  const fileQuery = { stage: stage.id, path: file.path, base: file.baseRevision, head: stage.headRevision };
  await get("DiffResponse", `api/diff?${new URLSearchParams(fileQuery)}`);
  await get("ApiFailure", "api/diff", 400);
  const content = await get("FileContentResponse", `api/file-content?${new URLSearchParams(fileQuery)}`);
  assert.equal(content.content, "# Implementation\n");
  await get("ApiFailure", `api/evidence?${new URLSearchParams({ stage: stage.id, item: "missing", index: "0" })}`, 404);

  await get("ReviewStateResponse", "api/review-state");
  const names = ["__proto__", "constructor", "prototype"];
  const changes = names.flatMap((name) => [
    { path: ["approvals", name], before: { present: false }, after: { present: true, value: { rev: null, at: 1 } } },
    { path: ["specificationOpen", name], before: { present: false }, after: { present: true, value: true } },
  ]);
  const saved = await post("ReviewStateResponse", "api/review-state", { ...target, changes });
  // Keys named like prototype properties are stored and returned as own keys.
  const query = `review=${encodeURIComponent(target.reviewId)}&generation=${encodeURIComponent(target.generation)}`;
  const reread = JSON.parse(await (await viewerFetch(`${viewer.url}api/review-state?${query}`)).text());
  for (const state of [saved.state, reread.state]) {
    for (const name of names) {
      assert.ok(Object.hasOwn(state.approvals, name) && Object.hasOwn(state.specificationOpen, name), name);
      assert.equal(state.specificationOpen[name], true);
    }
  }

  const { attachment } = await post("AttachmentUploadResponse", "api/attachments",
    { filename: "note.txt", mediaType: "text/plain", data: Buffer.from("attached\n").toString("base64") });
  await get("ApiFailure", "api/attachments/missing", 404);

  const endpoint = { stageId: stage.id, nodeId: ownership.nodeId, path: file.path, baseRevision: file.baseRevision,
    headRevision: stage.headRevision, fileRevision: file.revision, ownership };
  const { snapshotId } = await post("ApprovalSnapshotResponse", "api/approval-snapshots", endpoint);
  await post("ApprovalComparisonResponse", "api/approval-comparison", { ...endpoint, snapshotId });
  await post("DraftSnapshotsResponse", "api/draft-snapshots", { notes: [
    { kind: "line", id: `l:${stage.id}:new:1:${file.path}`, snapshot: { base: stage.baseRevision, head: stage.headRevision } },
    { kind: "stage", id: stage.id },
  ] });

  const implementationId = implementation.implementationId;
  const sent = await post("FeedbackExportResponse", "api/feedback/export", { implementationId, replies: [],
    notes: [{ ref: 0, kind: "stage", id: stage.id, body: "Check this stage.", attachments: [attachment], clientId: "note-1" }] });
  const threadId = sent.exported[0].threadId;
  await post("FeedbackExportResponse", "api/feedback/export", { implementationId, notes: [], replies: [] }, 422);
  await post("ThreadActionResponse", "api/feedback/reply", { implementationId, threadId, body: "More detail.", clientId: "reply-1" });
  await post("ThreadActionResponse", "api/feedback/resolve", { implementationId, threadId });
  await post("ThreadActionResponse", "api/feedback/reopen", { implementationId, threadId });

  repository.feedback("agent", "ask", "--id", "which-way", "--body", "Which way?", "--choice", "Left");
  const answered = await post("AgentControlResponse", "api/agent/respond", { requestId: "which-way", body: "Left" });
  assert.deepEqual(answered.agent.requests, []);
  await post("AgentControlResponse", "api/agent/stop", {});
  await post("RemoteRefreshResponse", "api/remote/refresh", {}, 409);

  await get("ReviewsResponse", "api/reviews");
  const { storage } = await post("ReviewStorageResponse", "api/reviews/storage", target);
  await post("ReviewCleanResponse", "api/reviews/clean-unused", { ...target, fingerprint: storage.fingerprint });
  // Opening the review this viewer serves reuses it, with a new launch code.
  const reopened = (await post("ReviewOpenResponse", "api/reviews/open", target)).url;
  assert.equal(viewerBase(reopened), viewer.url);
  assert.match(reopened, /#launch=[\w-]+$/);
  await post("OkResponse", "api/reviews/completion", { ...target, completed: true, expectedCompletedAt: null });
  const { storage: current } = await post("ReviewStorageResponse", "api/reviews/storage", target);
  await post("ReviewDeleteResponse", "api/reviews/delete", { ...target, fingerprint: current.fingerprint });
  await capture("ShutdownResponse", "api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  assert.deepEqual(protocolErrors(captured), []);
});

test("the viewer accepts and rejects requests as before it read them into protocol types", async (t) => {
  const viewer = viewerCleanup(t);
  const repository = createReviewRepository(t);
  await startViewer(viewer, repository);
  const { get, post, target } = await client(viewer.url);
  const { implementation } = await get("ImplementationResponse", "api/implementation");
  const [stage] = implementation.stages, [file] = stage.files, [ownership] = file.memberships;
  const implementationId = implementation.implementationId;

  // A line draft saved without a file revision has it reconstructed.
  const line = { kind: "line", id: `l:${stage.id}:new:1:${file.path}`, snapshot: { base: stage.baseRevision, head: stage.headRevision, fileRevision: null } };
  const { snapshots } = await post("DraftSnapshotsResponse", "api/draft-snapshots", { notes: [line] });
  assert.equal(snapshots[0].fileRevision, file.revision);
  // Only line drafts are checked against their snapshot.
  const sent = await post("FeedbackExportResponse", "api/feedback/export", { implementationId, replies: [], notes: [
    { ref: 0, kind: "stage", id: stage.id, body: "Stage note.", attachments: [], snapshot: { base: stage.baseRevision } },
    { ref: 1, ...line, body: "Line note.", attachments: [] },
  ] });
  assert.deepEqual(sent.skipped, []);
  const threadId = sent.exported[0].threadId;

  // Resolve and reopen ignore attachments; the implementation and thread are checked first.
  const ignored = [{ id: null }];
  await post("ThreadActionResponse", "api/feedback/resolve", { implementationId, threadId, attachments: ignored });
  await post("ThreadActionResponse", "api/feedback/reopen", { implementationId, threadId, attachments: ignored });
  await post("ApiFailure", "api/feedback/reply", { implementationId: "other", threadId, body: "Reply", attachments: ignored }, 409);
  await post("ApiFailure", "api/feedback/reply", { implementationId, body: "Reply", attachments: ignored }, 400);
  await post("ApiFailure", "api/feedback/reply", { implementationId, threadId, body: "Reply", attachments: ignored }, 422);
  // A truthy client ID that is not a string is the reply reference "0", so a retry
  // of a reply sent that way adds no second comment.
  const first = await post("ThreadActionResponse", "api/feedback/reply", { implementationId, threadId, body: "Same reply.", clientId: "0" });
  const retried = await post("ThreadActionResponse", "api/feedback/reply", { implementationId, threadId, body: "Same reply.", clientId: 42 });
  assert.equal(retried.comment.id, first.comment.id);
  const unknownStage = await post("FeedbackExportResponse", "api/feedback/export", { implementationId, replies: [], notes: [
    { ref: 0, kind: "node", id: "implementation-change", stageId: 42, body: "Which stage?", attachments: [] },
  ] }, 422);
  assert.deepEqual(unknownStage.skipped, [{ ref: 0, reason: 'unknown stage "42"' }]);

  // The shown ownership must equal the server's exactly; a missing file is reported first.
  const endpoint = { stageId: stage.id, nodeId: ownership.nodeId, path: file.path, baseRevision: file.baseRevision,
    headRevision: stage.headRevision, fileRevision: file.revision, ownership };
  const extra = await post("ApiFailure", "api/approval-snapshots", { ...endpoint, ownership: { ...ownership, other: 1 } }, 409);
  assert.match(extra.error, /ownership changed/);
  const missing = await post("ApiFailure", "api/approval-comparison", { ...endpoint, stageId: "missing", ownership: null, mode: "bogus" }, 409);
  assert.match(missing.error, /no longer exists/);
  const view = await post("ApiFailure", "api/approval-comparison", { ...endpoint, snapshotId: "", mode: "bogus" }, 409);
  assert.match(view.error, /Invalid comparison view/);

  // A state change's sides are compared exactly as sent: an absent value that names a value matches nothing.
  const named = await post("ApiFailure", "api/review-state", { ...target, changes: [
    { path: ["specificationOpen", "named"], before: { present: false, value: null }, after: { present: true, value: true } },
  ] }, 409);
  assert.match(named.error, /changed in another tab/);
  const { state } = await get("ReviewStateResponse", "api/review-state");
  assert.equal(Object.hasOwn(state.specificationOpen ?? {}, "named"), false);

  const otherReview = await post("ApiFailure", "api/review-state", { ...target, reviewId: "other", changes: null }, 409);
  assert.match(otherReview.error, /another review/);
  const page = await get("ApiFailure", `api/diff?${new URLSearchParams({ stage: stage.id, path: file.path, base: file.baseRevision, head: stage.headRevision, mode: "bogus" })}`, 422);
  assert.match(page.error, /Invalid diff page/);
});

test("a review whose artifact the viewer cannot fully read still opens", async (t) => {
  const viewer = viewerCleanup(t);
  const repository = createReviewRepository(t);
  // Content the schema rejects, as an older artifact or a remote review may hold.
  const stagePath = "stages/implementation.json";
  const stage = repository.artifact.readJson(stagePath);
  const { headRevision } = repository.artifact.stage("implementation").change;
  // The file's only change under its node has a classification this viewer does not
  // know and an ownership that is not a list.
  Object.assign(stage.nodes[0].changes[0], { classification: "mystery", hunks: "all" });
  const change = (fields) => ({ path: "implementation.md", classification: "test", ...fields });
  const span = (start, end) => ({ start, end });
  const narrowed = [
    ["no-path", [{ classification: "test" }]],
    ["hunk-zero", [change({ hunks: [0, 2] })]],
    ["no-valid-hunk", [change({ hunks: [0, -1, 1.5, "1"] })]],
    ["inverted-span", [change({ lineRanges: [{ new: span(8, 5) }] })]],
    ["partial-range", [change({ lineRanges: [{ old: span(1, 2), new: span(8, 5) }, { new: span(0, 1) }, "lines", { old: span(3, 3), new: span(4, 4) }] })]],
    ["malformed-ranges", [change({ lineRanges: { new: span(1, 1) } })]],
    ["both-selectors", [change({ hunks: [1], lineRanges: [{ new: span(1, 1) }] })]],
    ["invalid-hunks-valid-ranges", [change({ hunks: [0], lineRanges: [{ new: span(1, 1) }] })]],
  ];
  stage.nodes.push(...narrowed.map(([id, changes]) => ({ id, description: "Ownership the schema rejects.", changes })));
  // Two risks share an ID; only the first records a code target.
  const codeTarget = captureCodeTarget(repository.root, headRevision, "implementation.md", 1, 1);
  stage.risks = [{ id: "shared", summary: "Targeted", codeTarget }, { id: "shared", summary: "Untargeted" }];
  (stage.evidence ??= []).push({ id: "call", kind: "video-call", summary: "Walked through the change", inline: "transcript <ok>",
    attachments: [], specificationRefs: [], capturedAt: "2026-10-30T10:00:00Z", nodeRefs: ["implementation-change"] });
  repository.artifact.write(stagePath, JSON.stringify(stage));
  await startViewer(viewer, repository);
  const { captured, get, post } = await client(viewer.url);

  const { implementation: { stages: [served] } } = await get("ImplementationResponse", "api/implementation");
  // Only a node change without a path is left out. A change with a path keeps its file
  // under its node with its usable ownership, so the file can still be opened and
  // approved: malformed or invalid hunks and line ranges are left out, a selector that
  // keeps none owns the whole file, and hunks win over line ranges. An unknown
  // classification is kept only as recorded.
  const expected = [
    ["implementation-change", { recordedClassification: "mystery" }],
    ["no-path", undefined],
    ["hunk-zero", { classification: "test", hunks: [2] }],
    ["no-valid-hunk", { classification: "test" }],
    ["inverted-span", { classification: "test" }],
    ["partial-range", { classification: "test", lineRanges: [{ old: span(1, 2) }, { old: span(3, 3), new: span(4, 4) }] }],
    ["malformed-ranges", { classification: "test" }],
    ["both-selectors", { classification: "test", hunks: [1] }],
    ["invalid-hunks-valid-ranges", { classification: "test", lineRanges: [{ new: span(1, 1) }] }],
  ];
  assert.deepEqual(served.nodes.map((node) => [node.id, node.changes]),
    expected.map(([id, fields]) => [id, fields ? [{ path: "implementation.md", ...fields }] : []]));
  const [file] = served.files;
  assert.deepEqual(served.files.map(({ path, memberships }) => [path, memberships]),
    [["implementation.md", expected.flatMap(([nodeId, fields]) => fields ? [{ nodeId, ...fields }] : [])]]);
  await post("ApprovalSnapshotResponse", "api/approval-snapshots", { stageId: served.id, nodeId: "implementation-change", path: file.path,
    baseRevision: file.baseRevision, headRevision: served.headRevision, fileRevision: file.revision, ownership: file.memberships[0] });
  // Each insight takes the code target of its own item, not of another with its ID.
  const risks = served.insights.filter((insight) => insight.collection === "risks");
  assert.deepEqual(risks.map((risk) => [risk.title, risk.codeTarget?.status]), [["Targeted", "current"], ["Untargeted", undefined]]);
  // Evidence of an unknown kind keeps its output as generic evidence.
  const call = served.insights.find((insight) => insight.collection === "evidence" && insight.id === "call");
  assert.equal(call.meta, "video-call");
  assert.equal(call.evidence.kind, "other");
  assert.equal(call.evidence.inline, "transcript <ok>");
  assert.deepEqual(protocolErrors(captured), []);
});

test("stopping a viewer that already exited sends nothing to its port", async (t) => {
  // Another server now listens where the stopped viewer did.
  const requests = [];
  const server = http.createServer((request, response) => { requests.push(request.url); response.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await stopViewer({ url: `http://127.0.0.1:${server.address().port}/`, pid });
  assert.deepEqual(requests, []);
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

/* ---- protocol changes break the build ---------------------------------------- */

/** The two programs that use the protocol: the server, and the whole page as its
 * config lists it, so both the request module and the modules that read responses
 * are checked. */
const programs = [
  { config: path.join(scriptsRoot, "tsconfig.json"), root: path.join(scriptsRoot, "src", "semantic-view.ts") },
  { config: path.join(repositoryRoot, "viewer", "tsconfig.json"), root: null },
];
const parsedSources = new Map();

/** Type-checks the server and the page against a changed protocol source. Returns
 * each diagnostic as `<repository-relative file>: <message>`. */
function typecheckWithProtocol(source) {
  return programs.flatMap(({ config, root }) => {
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    } });
    const host = ts.createCompilerHost(parsed.options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, ...rest) => {
      if (path.resolve(fileName) === path.resolve(protocol)) return ts.createSourceFile(fileName, source, languageVersion, true);
      // Unchanged files are parsed once for all checks.
      const key = JSON.stringify([path.resolve(fileName), languageVersion]);
      if (!parsedSources.has(key)) parsedSources.set(key, read(fileName, languageVersion, ...rest));
      return parsedSources.get(key);
    };
    const program = ts.createProgram({ rootNames: root ? [root] : parsed.fileNames, options: parsed.options, host });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const file = diagnostic.file ? path.relative(repositoryRoot, path.resolve(diagnostic.file.fileName)).split(path.sep).join("/") : "(global)";
      return `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
  });
}

/** The protocol source with one declaration changed. */
function changeDeclaration(original, declaration, change) {
  const start = original.indexOf(declaration);
  assert.notEqual(start, -1, declaration);
  const end = original.indexOf("\n}", start) + 2;
  const changed = change(original.slice(start, end));
  assert.notEqual(changed, original.slice(start, end), declaration);
  return original.slice(0, start) + changed + original.slice(end);
}

test("a changed protocol fails the typecheck of the server and the page", () => {
  const original = fs.readFileSync(protocol, "utf8");
  assert.deepEqual(typecheckWithProtocol(original), []);
  const errorsIn = (errors, file, pattern) => errors.filter((error) => error.startsWith(`${file}: `) && pattern.test(error));
  const exportRequest = "export interface FeedbackExportRequest {";

  const added = typecheckWithProtocol(changeDeclaration(original, exportRequest, (block) => block.replace("{\n", "{\n  addedField: string;\n")));
  assert.ok(errorsIn(added, "scripts/src/shared/viewer-requests.ts", /addedField/).length, added.join("\n"));
  assert.ok(errorsIn(added, "viewer/src/api.ts", /addedField/).length, added.join("\n"));

  // An optional field is not required by the request type, but each builder must list it.
  const optional = typecheckWithProtocol(changeDeclaration(original, exportRequest, (block) => block.replace("{\n", "{\n  addedOptional?: string;\n")));
  assert.ok(errorsIn(optional, "viewer/src/api.ts", /addedOptional/).length, optional.join("\n"));

  // A query parameter added to one branch of a union query is listed by its builders too.
  const diffBranch = "  | { side?: undefined; line?: undefined }";
  assert.ok(original.includes(diffBranch));
  const branch = typecheckWithProtocol(original.replace(diffBranch, "  | { side?: undefined; line?: undefined; branchParameter?: string }"));
  assert.ok(errorsIn(branch, "viewer/src/api.ts", /branchParameter/).length, branch.join("\n"));
  assert.ok(errorsIn(branch, "scripts/src/semantic-view.ts", /branchParameter/).length, branch.join("\n"));

  const renamed = typecheckWithProtocol(changeDeclaration(original, exportRequest, (block) => block.replace("  notes:", "  renamedNotes:")));
  assert.ok(errorsIn(renamed, "scripts/src/shared/viewer-requests.ts", /renamedNotes|'notes'/).length, renamed.join("\n"));
  assert.ok(errorsIn(renamed, "viewer/src/api.ts", /renamedNotes|'notes'/).length, renamed.join("\n"));

  const response = typecheckWithProtocol(changeDeclaration(original, "export interface ViewerSnapshot {", (block) => block.replace("  revision:", "  renamedRevision:")));
  assert.ok(errorsIn(response, "scripts/src/semantic-view.ts", /renamedRevision|'revision'/).length, response.join("\n"));
  assert.ok(errorsIn(response, "viewer/src/polling.ts", /'revision'/).length, response.join("\n"));

  // A renamed response field fails the page modules that read it, not only the request module.
  const implementation = typecheckWithProtocol(changeDeclaration(original, "export interface ImplementationData {", (block) => block.replace("  viewerRevision:", "  renamedViewerRevision:")));
  assert.ok(errorsIn(implementation, "viewer/src/polling.ts", /'viewerRevision'/).length, implementation.join("\n"));
  const thread = typecheckWithProtocol(changeDeclaration(original, "export interface FeedbackThread {", (block) => block.replace("  anchorStale:", "  renamedAnchorStale:")));
  assert.ok(errorsIn(thread, "viewer/src/thread-models.ts", /'anchorStale'/).length, thread.join("\n"));

  const diffMode = 'export type DiffMode = "changes" | "full";';
  assert.ok(original.includes(diffMode));
  const mode = typecheckWithProtocol(original.replace(diffMode, 'export type DiffMode = "changes" | "full" | "addedMode";'));
  assert.ok(errorsIn(mode, "scripts/src/shared/viewer-requests.ts", /addedMode/).length, mode.join("\n"));
});
