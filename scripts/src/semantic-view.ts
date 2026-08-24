/**
 * Semantic Flow review viewer launcher.
 *
 * Reads a repository's `.semantic-review` artifact, reconstructs the review
 * data model (stages, nodes, project-grouped files, full-context diffs), and
 * serves the bundled Cinema viewer on localhost.
 *
 * Usage: node semantic-view.mjs [review] [project-path]
 * The optional leading `review` token is accepted and ignored so the launch
 * reads naturally ("semantic-view review").
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_ROWS = 900; // per-file diff row cap to keep the payload sane
const DEFAULT_PORT = 4180;
const HOST = "127.0.0.1";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`semantic-view: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function locateViewerDir() {
  const candidates = [
    path.resolve(scriptDir, "..", "viewer"),
    path.resolve(scriptDir, "..", "..", "viewer"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  fail("bundled viewer assets were not found next to this script.");
  return "";
}

function resolveRepositoryRoot(args) {
  const positional = args.filter((a) => a !== "review");
  if (positional.length > 1) {
    fail("usage: semantic-view [review] [project-path]");
  }
  const start = path.resolve(process.cwd(), positional[0] ?? ".");
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".semantic-review", "manifest.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail(
    `no .semantic-review/manifest.json found in ${start} or any parent directory.`,
  );
  return "";
}

function gitCapture(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function humanizeId(id) {
  return id
    .split("-")
    .map((word) => (word.length ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

// Convention-based grouping of changed files by the owning language project.
const PROJECT_GLOBS = [
  "*.csproj",
  "*.vbproj",
  "*.fsproj",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

function buildProjectIndex(repoRoot) {
  let listed = "";
  try {
    listed = gitCapture(repoRoot, ["--no-pager", "ls-files", "--", ...PROJECT_GLOBS]);
  } catch {
    return [];
  }
  return listed
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const slash = p.lastIndexOf("/");
      const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
      const file = slash >= 0 ? p.slice(slash + 1) : p;
      const isDotNet = /\.(cs|vb|fs)proj$/i.test(file);
      const name = isDotNet
        ? file.replace(/\.(cs|vb|fs)proj$/i, "")
        : dir
          ? dir.replace(/\/$/, "").split("/").pop()
          : "Repository root";
      return { dir, name };
    });
}

function projectFor(projects, p) {
  let best = null;
  for (const c of projects) {
    if (p.startsWith(c.dir) && (!best || c.dir.length > best.dir.length)) best = c;
  }
  if (best) return best.name;
  const seg = p.split("/");
  return seg.length > 1 ? `${seg[0]}/` : "Repository root";
}

function parseDiff(repoRoot, base, head, filePath) {
  let raw;
  try {
    raw = gitCapture(repoRoot, [
      "--no-pager",
      "diff",
      "-U100000",
      `${base}..${head}`,
      "--",
      filePath,
    ]);
  } catch {
    return null;
  }
  if (!raw.trim()) {
    return { lines: [], additions: 0, deletions: 0, binary: false, truncated: false };
  }
  const src = raw.split("\n");
  const lines = [];
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let truncated = false;
  let started = false;
  let rowCount = 0;

  for (const line of src) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }
    if (line.startsWith("Binary files")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
        started = true;
      }
      continue;
    }
    if (!started) continue;
    if (line === "" || line.startsWith("\\")) continue;
    if (rowCount >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const tag = line[0];
    const text = line.slice(1);
    if (tag === "+") {
      lines.push({ t: "add", n: newNo, s: text });
      newNo += 1;
      additions += 1;
    } else if (tag === "-") {
      lines.push({ t: "del", o: oldNo, s: text });
      oldNo += 1;
      deletions += 1;
    } else {
      lines.push({ t: "ctx", o: oldNo, n: newNo, s: text });
      oldNo += 1;
      newNo += 1;
    }
    rowCount += 1;
  }
  return { lines, additions, deletions, binary, truncated };
}

function buildInsights(stage) {
  const insights = [];
  (stage.decisions || []).forEach((d) =>
    insights.push({
      type: "decision",
      id: d.id,
      title: d.summary,
      body: d.rationale,
      meta: d.category,
      nodeRefs: d.nodeRefs || [],
    }),
  );
  (stage.assumptions || []).forEach((a) =>
    insights.push({
      type: "assumption",
      id: a.id,
      title: a.statement,
      body: a.riskIfWrong ? `If wrong: ${a.riskIfWrong}` : "",
      nodeRefs: a.nodeRefs || [],
    }),
  );
  (stage.alternatives || []).forEach((a) =>
    insights.push({
      type: "alternative",
      id: a.id,
      title: a.approach || a.summary || a.id,
      body: a.reasonRejected || a.rationale || "",
      nodeRefs: a.nodeRefs || [],
    }),
  );
  (stage.failedAttempts || []).forEach((f) =>
    insights.push({
      type: "lesson",
      id: f.id,
      title: f.approach,
      body: `Outcome: ${f.outcome} — Lesson: ${f.lesson}`,
      nodeRefs: f.nodeRefs || [],
    }),
  );
  (stage.risks || []).forEach((r) =>
    insights.push({
      type: "risk",
      id: r.id,
      title: r.summary,
      body: r.mitigation ? `Mitigation: ${r.mitigation}` : "",
      nodeRefs: r.nodeRefs || [],
    }),
  );
  (stage.validation || []).forEach((v) =>
    insights.push({
      type: "validation",
      id: v.id,
      title: v.summary,
      body: v.command || "",
      meta: v.status,
      nodeRefs: v.nodeRefs || [],
    }),
  );
  (stage.openQuestions || []).forEach((q) =>
    insights.push({
      type: "question",
      id: q.id || "q",
      title: q.question || q.summary || String(q),
      body: q.context || "",
      nodeRefs: q.nodeRefs || [],
    }),
  );
  return insights;
}

function buildReviewData(repoRoot) {
  const reviewRoot = path.join(repoRoot, ".semantic-review");
  const manifest = readJson(path.join(reviewRoot, "manifest.json"));
  const requirement = readJson(
    path.join(reviewRoot, "requirements", `${manifest.requirements[0]}.json`),
  );
  const projects = buildProjectIndex(repoRoot);

  const stages = manifest.stages.map((stageId) => {
    const s = readJson(path.join(reviewRoot, "stages", `${stageId}.json`));
    const base = s.change.baseRevision;
    const head = s.change.headRevision;
    const kindByPath = new Map(s.change.files.map((f) => [f.path, f.kind]));

    const nodes = s.nodes.map((node) => ({
      id: node.id,
      title: humanizeId(node.id),
      description: node.description,
      changes: node.changes.map((c) => ({
        path: c.path,
        classification: c.classification,
      })),
    }));

    const membershipByPath = new Map();
    nodes.forEach((node) => {
      node.changes.forEach((c) => {
        if (!membershipByPath.has(c.path)) membershipByPath.set(c.path, []);
        membershipByPath
          .get(c.path)
          .push({ nodeId: node.id, classification: c.classification });
      });
    });

    const files = s.change.files.map((f) => f.path).map((p) => {
      const diff = parseDiff(repoRoot, base, head, p);
      return {
        path: p,
        kind: kindByPath.get(p) || "modified",
        project: projectFor(projects, p),
        memberships: membershipByPath.get(p) || [],
        additions: diff ? diff.additions : 0,
        deletions: diff ? diff.deletions : 0,
        binary: diff ? diff.binary : false,
        truncated: diff ? diff.truncated : false,
        lines: diff ? diff.lines : [],
      };
    });

    return {
      id: s.id,
      title: s.title,
      summary: s.summary,
      rationale: s.rationale,
      dependsOn: s.dependsOn || [],
      requirementRefs: s.requirementRefs || [],
      branch: s.change.branch,
      baseRevision: base,
      headRevision: head,
      nodes,
      files,
      insights: buildInsights(s),
    };
  });

  return {
    reviewId: manifest.reviewId,
    title: manifest.title,
    summary: manifest.summary,
    targetBranch: manifest.targetBranch,
    baseRevision: manifest.baseRevision,
    requirement: {
      id: requirement.id,
      title: requirement.title,
      summary: requirement.summary,
      source: requirement.source,
      acceptance: (requirement.acceptanceCriteria || []).map((c) => ({
        id: c.id,
        text: c.text,
      })),
    },
    stages,
    feedback: buildFeedbackThreads(repoRoot, stages),
  };
}

export function createReviewDataScript(repoRoot) {
  return `window.SEMANTIC_REVIEW = ${JSON.stringify(buildReviewData(repoRoot))};\n`;
}

// Load submitted/resolved/approved feedback threads from the local
// `.semantic-review-feedback` store so the viewer can render the reviewer <->
// implementation-agent conversation. Draft threads stay private to the viewer
// workspace; only threads that have been submitted are surfaced here. A thread
// is flagged stale when the stage head it was anchored against has since been
// rewritten.
function buildFeedbackThreads(repoRoot, stages) {
  const feedbackRoot = path.join(repoRoot, ".semantic-review-feedback");
  const manifestPath = path.join(feedbackRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = readJson(manifestPath);
  const currentHeads = new Map(stages.map((s) => [s.id, s.headRevision]));
  const threads: Array<Record<string, any>> = [];
  for (const batchId of manifest.batches || []) {
    const batch = readJson(
      path.join(feedbackRoot, "batches", `${batchId}.json`),
    );
    for (const threadId of batch.threads || []) {
      const thread = readJson(
        path.join(feedbackRoot, "threads", `${threadId}.json`),
      );
      if (thread.status === "draft") continue;
      threads.push({
        id: thread.id,
        batchId: thread.batchId,
        batchTitle: batch.title,
        status: thread.status,
        target: thread.target,
        comments: (thread.comments || []).map((c) => ({
          id: c.id,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
        })),
        resolution: thread.resolution || null,
        assignedStageId: thread.assignedStageId || null,
        createdAt: thread.createdAt,
        anchorStale:
          Boolean(thread.target && thread.target.stageHead) &&
          currentHeads.get(thread.target.stageId) !== thread.target.stageHead,
      });
    }
  }
  return threads;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Locate the sibling review-feedback CLI produced by the skill build.
function locateFeedbackCli() {
  const candidate = path.join(scriptDir, "review-feedback.mjs");
  return fs.existsSync(candidate) ? candidate : "";
}

function readRequestBody(request, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

// Map a browser-local note (kind: stage | node | file) onto review-feedback
// target options. Nodes have no first-class feedback target, so they are
// assigned to their owning stage with the node title carried in the label.
export function mapNoteTarget(note, review) {
  if (note.kind === "stage") {
    const stage = review.stages.find((s) => s.id === note.id);
    if (!stage) throw new Error(`unknown stage "${note.id}"`);
    return { "target-kind": "stage", stage: stage.id, label: stage.title };
  }
  if (note.kind === "node") {
    const stages = note.stageId
      ? review.stages.filter((s) => s.id === note.stageId)
      : review.stages;
    if (note.stageId && stages.length === 0) {
      throw new Error(`unknown stage "${note.stageId}"`);
    }
    for (const stage of stages) {
      const node = stage.nodes.find((n) => n.id === note.id);
      if (node) {
        return { "target-kind": "stage", stage: stage.id, label: node.title };
      }
    }
    throw new Error(
      `unknown node "${note.id}"${note.stageId ? ` in stage "${note.stageId}"` : ""}`,
    );
  }
  if (note.kind === "file") {
    const match = /^f:([^:]+):(.+)$/.exec(note.id || "");
    if (!match) throw new Error(`unrecognized file id "${note.id}"`);
    const [, stageId, filePath] = match;
    const stage = review.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    return { "target-kind": "file", stage: stageId, path: filePath, label: filePath };
  }
  throw new Error(`unsupported note kind "${note.kind}"`);
}

function runFeedbackCli(feedbackCli, repoRoot, args, input?: string) {
  return execFileSync(process.execPath, [feedbackCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function cliErrorMessage(error) {
  const text = (error.stderr || error.stdout || error.message || "").toString().trim();
  const line = text.split(/\r?\n/).find((l) => l.startsWith("Error:")) || text.split(/\r?\n/)[0];
  return (line || "feedback command failed").replace(/^Error:\s*/, "");
}

// Validate every note and resolve its target into review-feedback options.
// Pure over (notes, review): produces the ordered list of threads to create
// and the reasons any note was skipped, without mutating any state. Kept
// separate from the CLI mutations so a malformed payload can never leave a
// partial or orphaned draft batch behind.
export function planFeedbackThreads(notes, review) {
  const skipped: Array<{ ref: number; reason: string }> = [];
  const planned: Array<{ ref: number; body: string; target: Record<string, any> }> =
    [];
  if (!Array.isArray(notes)) return { planned, skipped };
  notes.forEach((note, index) => {
    const ref = note && Number.isInteger(note.ref) ? note.ref : index;
    if (!note || typeof note !== "object") {
      skipped.push({ ref, reason: "not an object" });
      return;
    }
    const body = typeof note.body === "string" ? note.body.trim() : "";
    if (!body) {
      skipped.push({ ref, reason: "empty body" });
      return;
    }
    let target;
    try {
      target = mapNoteTarget(note, review);
    } catch (error) {
      skipped.push({ ref, reason: error.message });
      return;
    }
    planned.push({ ref, body, target });
  });
  return { planned, skipped };
}

function exportFeedback({ repoRoot, review, feedbackCli }, notes) {
  if (!feedbackCli) {
    return { ok: false, error: "The review-feedback CLI was not found next to the viewer." };
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    return { ok: false, error: "No feedback notes to export." };
  }
  const { planned, skipped } = planFeedbackThreads(notes, review);
  if (planned.length === 0) {
    return { ok: false, error: "No notes could be exported.", skipped };
  }

  const manifest = path.join(repoRoot, ".semantic-review-feedback", "manifest.json");
  if (!fs.existsSync(manifest)) {
    runFeedbackCli(feedbackCli, repoRoot, ["init"]);
  }
  const batchId = `viewer-${Date.now().toString(36)}`;
  runFeedbackCli(
    feedbackCli,
    repoRoot,
    ["batch", "create", "--input", "-"],
    JSON.stringify({ id: batchId, title: `Reviewer feedback ${new Date().toISOString()}` }),
  );
  const exported: Array<{ ref: number; threadId: string }> = [];
  const addedThreadIds: string[] = [];
  planned.forEach((thread, index) => {
    const threadId = `${batchId}-t${String(index).padStart(3, "0")}`;
    const commentId = `${threadId}-c000`;
    try {
      runFeedbackCli(
        feedbackCli,
        repoRoot,
        ["thread", "add", "--input", "-"],
        JSON.stringify({
          batch: batchId,
          id: threadId,
          "comment-id": commentId,
          body: thread.body,
          ...thread.target,
        }),
      );
      exported.push({ ref: thread.ref, threadId });
      addedThreadIds.push(threadId);
    } catch (error) {
      skipped.push({ ref: thread.ref, reason: cliErrorMessage(error) });
    }
  });
  if (exported.length === 0) {
    discardBatch(feedbackCli, repoRoot, batchId, addedThreadIds);
    return { ok: false, error: "No notes could be exported.", skipped };
  }
  try {
    runFeedbackCli(feedbackCli, repoRoot, ["batch", "submit", "--id", batchId]);
  } catch (error) {
    // Roll the draft back so a failed submit cannot leave an invisible,
    // non-empty draft batch that blocks or confuses later exports.
    discardBatch(feedbackCli, repoRoot, batchId, addedThreadIds);
    return { ok: false, error: cliErrorMessage(error), skipped };
  }
  return { ok: true, batchId, exported, skipped };
}

// Best-effort removal of a draft batch and its draft threads.
function discardBatch(feedbackCli, repoRoot, batchId, threadIds) {
  for (const threadId of threadIds) {
    try {
      runFeedbackCli(feedbackCli, repoRoot, ["thread", "delete", "--id", threadId]);
    } catch {
      // Ignore; surfacing the original failure matters more than perfect cleanup.
    }
  }
  try {
    runFeedbackCli(feedbackCli, repoRoot, ["batch", "delete", "--id", batchId]);
  } catch {
    // Ignore.
  }
}

// Reject cross-origin drivers. A local page served by this server has no
// Origin (same-origin fetch) or an Origin matching our own host; a third-party
// web page attempting a request will carry a foreign Origin. Combined with the
// required application/json content type (which forces a CORS preflight this
// server never approves), this blocks drive-by requests from other sites.
function isTrustedRequest(request, port) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers["origin"];
  if (!origin) return true;
  const allowed = new Set([
    `http://${HOST}:${port}`,
    `http://localhost:${port}`,
  ]);
  return allowed.has(origin);
}

async function handleFeedbackExport(request, response, context) {
  try {
    if (!isTrustedRequest(request, context.port)) {
      sendJson(response, 403, {
        ok: false,
        error: "Feedback export requires a same-origin application/json request.",
      });
      return;
    }
    const raw = await readRequestBody(request);
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      sendJson(response, 400, { ok: false, error: "Request body must be JSON." });
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      sendJson(response, 400, { ok: false, error: "Request body must be a JSON object." });
      return;
    }
    const review = buildReviewData(context.repoRoot);
    if (payload.reviewId !== review.reviewId) {
      sendJson(response, 409, {
        ok: false,
        error: "This viewer is showing a different review than the one being exported.",
      });
      return;
    }
    const result = exportFeedback({ ...context, review }, payload.notes);
    sendJson(response, result.ok ? 200 : 422, result);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

function serveViewer({ viewerDir, port, repoRoot, feedbackCli }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    if (request.method === "POST" && pathname === "/api/feedback/export") {
      handleFeedbackExport(request, response, {
        repoRoot,
        feedbackCli,
        port,
      });
      return;
    }

    if (pathname === "/review-data.js") {
      try {
        const body = Buffer.from(createReviewDataScript(repoRoot), "utf8");
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": body.length,
          "cache-control": "no-store",
        });
        response.end(body);
      } catch (error) {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(`Failed to refresh review data: ${cliErrorMessage(error)}`);
      }
      return;
    }

    const safe = path
      .normalize(pathname)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const filePath = path.join(viewerDir, safe);
    if (!filePath.startsWith(viewerDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
        "content-length": content.length,
        "cache-control": "no-store",
      });
      response.end(content);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    // Non-fatal: the URL is printed for manual use.
  }
}

async function main() {
  const repoRoot = resolveRepositoryRoot(process.argv.slice(2));
  const viewerDir = locateViewerDir();
  const review = buildReviewData(repoRoot);
  const feedbackCli = locateFeedbackCli();

  let port = DEFAULT_PORT;
  let server = null;
  for (let attempt = 0; attempt < 20 && !server; attempt += 1) {
    try {
      server = await serveViewer({ viewerDir, port, repoRoot, feedbackCli });
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }
  if (!server) fail("could not bind a local port for the viewer.");

  const url = `http://${HOST}:${port}/`;
  const fileCount = review.stages.reduce((a, s) => a + s.files.length, 0);
  console.log(`Semantic review viewer: ${url}`);
  console.log(`Project: ${repoRoot}`);
  console.log(
    `Review: ${review.title} — ${review.stages.length} stages, ${fileCount} files`,
  );
  if (!feedbackCli) {
    console.log(
      "Note: review-feedback CLI not found; exporting reviewer feedback is disabled.",
    );
  }
  console.log("Press Ctrl+C to stop.");
  openBrowser(url);
}

const isDirectRun =
  path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    if (process.exitCode === undefined || process.exitCode === 0) {
      console.error(`semantic-view: ${error.message}`);
      process.exitCode = 1;
    }
  });
}
