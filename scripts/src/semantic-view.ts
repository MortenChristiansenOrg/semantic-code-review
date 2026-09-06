/**
 * Semantic Flow review viewer launcher.
 *
 * Reads a repository's `.semantic-review` artifact, reconstructs the implementation
 * data model (stages, nodes, project-grouped files, full-context diffs), and
 * serves the bundled Cinema viewer on localhost.
 *
 * Usage: node semantic-view.mjs [review] [project-path]
 * The optional leading `review` token is accepted and ignored so the launch
 * reads naturally ("semantic-view review").
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { immutableFact, withValidationContext } from "./shared/validation-context.js";
import {
  probeViewer,
  requestViewerShutdown,
  VIEWER_APP_ID,
  VIEWER_HOST,
  viewerPort,
} from "./shared/viewer-lifecycle.js";

const MAX_ROWS = 900; // rows per page; all later rows remain available

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

function gitPathExists(repoRoot, revision, filePath) {
  return immutableFact(JSON.stringify(["viewer-path", repoRoot, revision, filePath]), () => checkGitPathExists(repoRoot, revision, filePath));
}

function checkGitPathExists(repoRoot, revision, filePath) {
  try {
    gitCapture(repoRoot, ["cat-file", "-e", `${revision}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

function renamedPathBetween(repoRoot, fromRevision, toRevision, filePath) {
  let raw;
  try {
    raw = immutableFact(JSON.stringify(["viewer-renames", repoRoot, fromRevision, toRevision]), () => gitCapture(repoRoot, [
      "--no-pager",
      "diff",
      "--name-status",
      "-z",
      "--find-renames=50%",
      fromRevision,
      toRevision,
    ]));
  } catch {
    return null;
  }

  const fields = raw.split("\0");
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (status.startsWith("R") && previousPath === filePath) return currentPath;
    } else {
      index += 1;
    }
  }
  return null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listJsonDocuments(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export function viewerSnapshot(repoRoot) {
  const semanticRoot = path.join(repoRoot, ".semantic-review");
  const feedbackRoot = path.join(repoRoot, ".semantic-review-feedback");
  const files = [
    path.join(semanticRoot, "manifest.json"),
    ...listJsonDocuments(path.join(semanticRoot, "requirements")),
    ...listJsonDocuments(path.join(semanticRoot, "stages")),
  ];
  const feedbackManifestPath = path.join(feedbackRoot, "manifest.json");
  let awaitingAgentReplies = 0;
  if (fs.existsSync(feedbackManifestPath)) {
    files.push(feedbackManifestPath);
    const manifest = readJson(feedbackManifestPath);
    for (const threadId of manifest.threads || []) {
      const file = path.join(feedbackRoot, "threads", `${threadId}.json`);
      files.push(file);
      const thread = readJson(file);
      const lastComment = thread.comments?.[thread.comments.length - 1];
      if (thread.status === "open" && lastComment?.author !== "agent") {
        awaitingAgentReplies += 1;
      }
    }
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(repoRoot, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return {
    revision: hash.digest("hex"),
    awaitingAgentReplies,
  };
}

/** Stat-based invalidation plus a periodic content scan for missed/coarse timestamp changes. */
export function createSnapshotReader(repoRoot, { now = Date.now, readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  let documents = new Map();
  let previous = null;
  let lastScan = -Infinity;
  return (force = false) => {
    const nextDocuments = new Map(documents);
    const scan = force || now() - lastScan >= 10_000;
    const seen = new Set<string>();
    let changed = !previous;
    const read = (file) => {
      const stat = fs.statSync(file, { bigint: true });
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const cached = documents.get(file);
      seen.add(file);
      if (scan || !cached || cached.stamp !== stamp) {
        const text = readFile(file);
        if (!cached || cached.text !== text) changed = true;
        nextDocuments.set(file, { stamp, text, value: JSON.parse(text) });
      }
      return nextDocuments.get(file).value;
    };
    const semantic = path.join(repoRoot, ".semantic-review");
    const feedback = path.join(repoRoot, ".semantic-review-feedback");
    read(path.join(semantic, "manifest.json"));
    for (const file of [...listJsonDocuments(path.join(semantic, "requirements")), ...listJsonDocuments(path.join(semantic, "stages"))]) read(file);
    let awaitingAgentReplies = 0;
    if (fs.existsSync(path.join(feedback, "manifest.json"))) {
      const manifest = read(path.join(feedback, "manifest.json"));
      for (const id of manifest.threads || []) {
        const thread = read(path.join(feedback, "threads", `${id}.json`));
        if (thread.status === "open" && thread.comments?.at(-1)?.author !== "agent") awaitingAgentReplies++;
      }
    }
    for (const file of nextDocuments.keys()) if (!seen.has(file)) { nextDocuments.delete(file); changed = true; }
    if (changed) {
      const hash = createHash("sha256");
      for (const file of [...seen].sort()) hash.update(path.relative(repoRoot, file)).update("\0").update(nextDocuments.get(file).text).update("\0");
      previous = { revision: hash.digest("hex"), awaitingAgentReplies };
    }
    documents = nextDocuments;
    if (scan) lastScan = now();
    return previous;
  };
}

function activeImplementationId(repoRoot) {
  return readJson(
    path.join(repoRoot, ".semantic-review", "manifest.json"),
  ).implementationId;
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

function buildProjectIndex(repoRoot, captureGit = gitCapture) {
  let listed = "";
  try {
    listed = captureGit(repoRoot, ["--no-pager", "ls-files", "--", ...PROJECT_GLOBS]);
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

function parseDiffPatch(raw, selectorRaw, stats) {
  if (!raw.trim()) {
    return {
      lines: [],
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary ?? false,
      truncated: false,
    };
  }
  const src = raw.split("\n");
  const lines = [];
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  let truncated = false;
  let started = false;
  let rowCount = 0;
  const hunkByLine = new Map();
  let selectorHunk = 0;
  let selectorOldNo = 0;
  let selectorNewNo = 0;
  let selectorStarted = false;
  for (const line of selectorRaw.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        selectorHunk += 1;
        selectorOldNo = parseInt(match[1], 10);
        selectorNewNo = parseInt(match[2], 10);
        selectorStarted = true;
      }
      continue;
    }
    if (!selectorStarted || line === "" || line.startsWith("\\")) continue;
    if (line[0] === "+") {
      hunkByLine.set(`new:${selectorNewNo}`, selectorHunk);
      selectorNewNo += 1;
    } else if (line[0] === "-") {
      hunkByLine.set(`old:${selectorOldNo}`, selectorHunk);
      selectorOldNo += 1;
    } else if (line[0] === " ") {
      selectorOldNo += 1;
      selectorNewNo += 1;
    }
  }

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
      lines.push({
        t: "add",
        n: newNo,
        s: text,
        h: hunkByLine.get(`new:${newNo}`),
      });
      newNo += 1;
    } else if (tag === "-") {
      lines.push({
        t: "del",
        o: oldNo,
        s: text,
        h: hunkByLine.get(`old:${oldNo}`),
      });
      oldNo += 1;
    } else {
      lines.push({ t: "ctx", o: oldNo, n: newNo, s: text });
      oldNo += 1;
      newNo += 1;
    }
    rowCount += 1;
  }
  return {
    lines,
    additions: stats?.additions ?? lines.filter((line) => line.t === "add").length,
    deletions: stats?.deletions ?? lines.filter((line) => line.t === "del").length,
    binary: stats?.binary ?? binary,
    truncated,
  };
}

function stageDiffKey(stage) {
  return `${stage.id}\0${stage.change.baseRevision}\0${stage.change.headRevision}`;
}

function buildStageStats(repoRoot, stage, captureGit = gitCapture) {
  const raw = captureGit(repoRoot, [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--find-renames=50%",
    "--raw",
    "--numstat",
    "--no-abbrev",
    "-z",
    stage.change.baseRevision,
    stage.change.headRevision,
  ]);
  const stats = new Map();
  const fields = raw.split("\0");
  const blobs = new Map();
  let index = 0;
  while (index < fields.length && fields[index].startsWith(":")) {
    const metadata = fields[index++].slice(1).split(" ");
    const status = metadata[4] || "";
    const previousPath = fields[index++] || "";
    const filePath =
      status.startsWith("R") || status.startsWith("C")
        ? fields[index++] || ""
        : previousPath;
    if (!filePath) continue;
    blobs.set(filePath, {
      oldBlob: metadata[2] || "",
      newBlob: metadata[3] || "",
    });
  }
  for (; index < fields.length && fields[index];) {
    const record = fields[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      index += 1;
      filePath = fields[index++] || "";
    }
    if (!filePath) continue;
    stats.set(filePath, {
      additions: additionsText === "-" ? 0 : Number(additionsText),
      deletions: deletionsText === "-" ? 0 : Number(deletionsText),
      binary: additionsText === "-" || deletionsText === "-",
      ...(blobs.get(filePath) || {}),
    });
  }
  return stats;
}

function decodePatchPath(value) {
  const withoutTimestamp = value.replace(/\r$/, "").split("\t", 1)[0];
  if (withoutTimestamp === "/dev/null") return "";
  let decoded = withoutTimestamp;
  if (decoded.startsWith('"') && decoded.endsWith('"')) {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return "";
    }
  }
  return decoded.replace(/^[ab]\//, "");
}

function patchSectionPath(section) {
  const current = /^\+\+\+ (.*)$/m.exec(section);
  if (current) {
    const currentPath = decodePatchPath(current[1]);
    if (currentPath) return currentPath;
  }
  const renamed = /^rename to (.*)$/m.exec(section);
  if (renamed) return renamed[1].replace(/\r$/, "");
  const previous = /^--- (.*)$/m.exec(section);
  return previous ? decodePatchPath(previous[1]) : "";
}

function indexPatchSections(raw, expectedPaths) {
  const expected = new Set(expectedPaths);
  const indexed = new Map();
  const unresolved = [];
  const sections = raw
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const filePath = patchSectionPath(section);
    if (filePath && expected.has(filePath) && !indexed.has(filePath)) {
      indexed.set(filePath, section);
    } else {
      unresolved.push(section);
    }
  }
  const missing = expectedPaths.filter((filePath) => !indexed.has(filePath));
  if (unresolved.length === missing.length) {
    unresolved.forEach((section, index) => indexed.set(missing[index], section));
  }
  return indexed;
}

function buildStageDiffs(repoRoot, stage, stats, captureGit = gitCapture) {
  const args = (unified) => [
    "-c",
    "core.quotePath=false",
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--find-renames=50%",
    `-U${unified}`,
    stage.change.baseRevision,
    stage.change.headRevision,
  ];
  const full = captureGit(repoRoot, args(3));
  const selector = captureGit(repoRoot, args(0));
  const expectedPaths = stage.change.files.map((file) => file.path);
  const fullByPath = indexPatchSections(full, expectedPaths);
  const selectorByPath = indexPatchSections(selector, expectedPaths);
  return new Map(
    expectedPaths.map((filePath) => [
      filePath,
      parseDiffPatch(
        fullByPath.get(filePath) || "",
        selectorByPath.get(filePath) || "",
        stats.get(filePath),
      ),
    ]),
  );
}

async function* gitLines(repoRoot, args) {
  const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Observe startup errors even while readline is waiting for stdout.
  completion.catch(() => {});
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let completed = false;
  try {
    for await (const line of reader) yield line;
    const code = await completion;
    completed = true;
    if (code !== 0) throw new Error(`Git diff failed: ${stderr.trim()}`);
  } finally {
    reader.close();
    if (!completed) child.kill();
    await completion.catch(() => {});
  }
}

// Stream one page rather than buffering unrelated files or a full large patch.
async function pagedFileDiff(repoRoot, stage, file, stats, mode, offset, targetSide = null, targetLine = null) {
  const paths = [...new Set([file.previousPath, file.path].filter(Boolean))];
  const args = (context) => ["-c", "core.quotePath=false", "--no-pager", "diff", "--no-ext-diff", "--find-renames=50%", `-U${context}`,
    stage.change.baseRevision, stage.change.headRevision, "--", ...paths];
  const shapes = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let selected = false, previousPath = "";
  const selectSection = (line) => {
    if (line.startsWith("diff --git ")) { selected = false; previousPath = ""; }
    else if (line.startsWith("--- ")) previousPath = decodePatchPath(line.slice(4));
    else if (line.startsWith("+++ ")) selected = (decodePatchPath(line.slice(4)) || previousPath) === file.path;
  };
  let selectingHeader = true;
  for await (const line of gitLines(repoRoot, args(0))) {
    if (line.startsWith("diff --git ")) selectingHeader = true;
    if (selectingHeader) selectSection(line);
    if (line.startsWith("@@")) selectingHeader = false;
    if (!selected) continue;
    const match = header.exec(line);
    if (match) shapes.push({ old: +match[1], oldCount: +(match[2] ?? 1), new: +match[3], newCount: +(match[4] ?? 1) });
  }
  const lines = [];
  let foundTarget = !targetSide;
  let oldNo = 0, newNo = 0, row = 0, started = false, more = false;
  let binary = Boolean(stats?.binary);
  for await (const line of gitLines(repoRoot, args(mode === "full" ? 2147483647 : 3))) {
    if (line.startsWith("diff --git ")) started = false;
    // Once inside a hunk, +++/--- can be actual source lines.
    if (!started) selectSection(line);
    if (!selected) continue;
    const match = header.exec(line);
    if (match) { oldNo = +match[1]; newNo = +match[3]; started = true; continue; }
    if (line.startsWith("Binary files")) binary = true;
    if (!started || !["+", "-", " "].includes(line[0])) continue;
    if (targetSide && !foundTarget && row > 0 && row % MAX_ROWS === 0) { lines.length = 0; offset = row; }
    if (targetSide && !foundTarget) {
      foundTarget = targetSide === "new" ? line[0] !== "-" && newNo === targetLine : line[0] !== "+" && oldNo === targetLine;
    }
    if (row++ < offset) {
      if (line[0] !== "+") oldNo++;
      if (line[0] !== "-") newNo++;
      continue;
    }
    if (lines.length === MAX_ROWS) { more = true; break; }
    const text = line.slice(1);
    if (line[0] === "+" || line[0] === "-") {
      const side = line[0] === "+" ? "new" : "old";
      const number = side === "new" ? newNo++ : oldNo++;
      const hunk = shapes.findIndex((shape) => number >= shape[side] && number < shape[side] + shape[`${side}Count`]);
      lines.push(side === "new" ? { t: "add", n: number, s: text, h: hunk + 1 } : { t: "del", o: number, s: text, h: hunk + 1 });
    } else lines.push({ t: "ctx", o: oldNo++, n: newNo++, s: text });
  }
  return { lines, additions: stats?.additions ?? 0, deletions: stats?.deletions ?? 0, binary,
    truncated: false, nextOffset: more ? offset + lines.length : null, offset, mode };
}

function buildInsights(stage) {
  const insights = [];
  (stage.decisions || []).forEach((d) =>
    insights.push({
      type: "decision",
      collection: "decisions",
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
      collection: "assumptions",
      id: a.id,
      title: a.statement,
      body: a.riskIfWrong ? `If wrong: ${a.riskIfWrong}` : "",
      nodeRefs: a.nodeRefs || [],
    }),
  );
  (stage.alternatives || []).forEach((a) =>
    insights.push({
      type: "alternative",
      collection: "alternatives",
      id: a.id,
      title: a.approach || a.summary || a.id,
      body: a.reasonRejected || a.rationale || "",
      nodeRefs: a.nodeRefs || [],
    }),
  );
  (stage.failedAttempts || []).forEach((f) =>
    insights.push({
      type: "lesson",
      collection: "failedAttempts",
      id: f.id,
      title: f.approach,
      body: `Outcome: ${f.outcome} — Lesson: ${f.lesson}`,
      nodeRefs: f.nodeRefs || [],
    }),
  );
  (stage.risks || []).forEach((r) =>
    insights.push({
      type: "risk",
      collection: "risks",
      id: r.id,
      title: r.summary,
      body: r.mitigation ? `Mitigation: ${r.mitigation}` : "",
      nodeRefs: r.nodeRefs || [],
    }),
  );
  (stage.validation || []).forEach((v) =>
    insights.push({
      type: "validation",
      collection: "validation",
      id: v.id,
      title: v.summary,
      body: v.command || "",
      meta: v.status,
      validationType: v.type,
      nodeRefs: v.nodeRefs || [],
    }),
  );
  (stage.openQuestions || []).forEach((q) =>
    insights.push({
      type: "question",
      collection: "openQuestions",
      id: q.id || "q",
      title: q.question || q.summary || String(q),
      body: q.context || "",
      nodeRefs: q.nodeRefs || [],
    }),
  );
  return insights;
}

function fileRevision(stage, file, stats) {
  return createHash("sha256")
    .update(stats?.oldBlob || stage.change.baseRevision)
    .update("\0")
    .update(stats?.newBlob || stage.change.headRevision)
    .update("\0")
    .update(file.path)
    .update("\0")
    .update(file.previousPath || "")
    .digest("hex");
}

function buildImplementationData(repoRoot, statsForStage, snapshot, captureGit) {
  const implementationRoot = path.join(repoRoot, ".semantic-review");
  const manifest = readJson(path.join(implementationRoot, "manifest.json"));
  const specificationDocs = (manifest.requirements || []).map((specificationId) =>
    readJson(path.join(implementationRoot, "requirements", `${specificationId}.json`)),
  );
  const projects = buildProjectIndex(repoRoot, captureGit);

  const stages = manifest.stages.map((stageId) => {
    const s = readJson(path.join(implementationRoot, "stages", `${stageId}.json`));
    const base = s.change.baseRevision;
    const head = s.change.headRevision;
    const stats = statsForStage(s);
    const kindByPath = new Map(s.change.files.map((f) => [f.path, f.kind]));
    const previousPathByPath = new Map(
      s.change.files
        .filter((f) => f.previousPath)
        .map((f) => [f.path, f.previousPath]),
    );

    const nodes = s.nodes.map((node) => ({
      id: node.id,
      title: humanizeId(node.id),
      description: node.description,
      changes: node.changes.map((c) => ({
        path: c.path,
        classification: c.classification,
        ...(c.hunks ? { hunks: c.hunks } : {}),
        ...(c.lineRanges ? { lineRanges: c.lineRanges } : {}),
      })),
    }));

    const membershipByPath = new Map();
    nodes.forEach((node) => {
      node.changes.forEach((c) => {
        if (!membershipByPath.has(c.path)) membershipByPath.set(c.path, []);
        membershipByPath.get(c.path).push({
          nodeId: node.id,
          classification: c.classification,
          ...(c.hunks ? { hunks: c.hunks } : {}),
          ...(c.lineRanges ? { lineRanges: c.lineRanges } : {}),
        });
      });
    });

    const files = s.change.files.map((file) => {
      const p = file.path;
      const fileStats = stats.get(p);
      return {
        path: p,
        kind: kindByPath.get(p) || "modified",
        ...(previousPathByPath.has(p)
          ? { previousPath: previousPathByPath.get(p) }
          : {}),
        project: projectFor(projects, p),
        memberships: membershipByPath.get(p) || [],
        additions: fileStats?.additions ?? 0,
        deletions: fileStats?.deletions ?? 0,
        binary: fileStats?.binary ?? false,
        revision: fileRevision(s, file, fileStats),
      };
    });

    return {
      id: s.id,
      title: s.title,
      summary: s.summary,
      rationale: s.rationale,
      dependsOn: s.dependsOn || [],
      specificationRefs: s.specificationRefs || [],
      branch: s.change.branch,
      baseRevision: base,
      headRevision: head,
      nodes,
      files,
      insights: buildInsights(s),
    };
  });

  const requirements = specificationDocs.map((specification) => ({
    id: specification.id,
    title: specification.title,
    summary: specification.summary,
    source: specification.source,
    acceptance: (specification.acceptanceCriteria || []).map((c) => ({
      id: c.id,
      text: c.text,
    })),
  }));

  const feedback = withValidationContext(() => buildFeedbackThreads(repoRoot, stages));
  return {
    implementationId: manifest.implementationId,
    title: manifest.title,
    summary: manifest.summary,
    targetBranch: manifest.targetBranch,
    baseRevision: manifest.baseRevision,
    requirements,
    stages,
    feedback,
    viewerRevision: snapshot.revision,
    awaitingAgentReplies: snapshot.awaitingAgentReplies,
  };
}

export function createViewerDataSource(
  repoRoot,
  options: { gitCapture?: typeof gitCapture } = {},
) {
  const captureGit = options.gitCapture || gitCapture;
  const stageCache = new Map();
  let cachedRevision = "";
  let cachedScript = "";
  const snapshotReader = createSnapshotReader(repoRoot);

  const stageRecord = (stage) => {
    const key = stageDiffKey(stage);
    let record = stageCache.get(key);
    if (!record) {
      record = {
        stats: buildStageStats(repoRoot, stage, captureGit),
        diffs: null,
        stage,
        pages: new Map(),
      };
      stageCache.set(key, record);
      while (stageCache.size > 24) stageCache.delete(stageCache.keys().next().value);
    } else {
      // Inventory repairs can change metadata without changing immutable Git
      // snapshots. Keep Git statistics, but rebuild inventory-dependent patches.
      if (JSON.stringify(record.stage.change.files) !== JSON.stringify(stage.change.files)) {
        record.diffs = null;
        record.pages.clear();
      }
      record.stage = stage;
    }
    return record;
  };

  const readStage = (stageId) => {
    const implementationRoot = path.join(repoRoot, ".semantic-review");
    const manifest = readJson(path.join(implementationRoot, "manifest.json"));
    if (!manifest.stages.includes(stageId)) {
      throw new Error(`unknown stage "${stageId}"`);
    }
    return readJson(path.join(implementationRoot, "stages", `${stageId}.json`));
  };

  return {
    implementationDataScript() {
      const snapshot = snapshotReader();
      if (snapshot.revision !== cachedRevision) {
        const data = buildImplementationData(
          repoRoot,
          (stage) => stageRecord(stage).stats,
          snapshot,
          captureGit,
        );
        cachedScript = `window.SEMANTIC_IMPLEMENTATION = ${JSON.stringify(data)};\n`;
        cachedRevision = snapshot.revision;
      }
      return cachedScript;
    },
    snapshot: snapshotReader,
    async fileDiff(stageId, filePath, baseRevision, headRevision, mode = "changes", offset = 0, targetSide = null, targetLine = null) {
      if (!["changes", "full"].includes(mode) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid diff page.");
      if (targetSide && (!["old", "new"].includes(targetSide) || !Number.isSafeInteger(targetLine) || targetLine < 1)) throw new Error("Invalid target line.");
      let record = stageCache.get(
        `${stageId}\0${baseRevision}\0${headRevision}`,
      );
      let stage = record?.stage;
      if (!stage) {
        stage = readStage(stageId);
        if (
          stage.change.baseRevision !== baseRevision ||
          stage.change.headRevision !== headRevision
        ) {
          throw new Error(`stage "${stageId}" changed; reload the viewer`);
        }
        record = stageRecord(stage);
      }
      if (!stage.change.files.some((file) => file.path === filePath)) {
        throw new Error(`file "${filePath}" is not changed in stage "${stageId}"`);
      }
      const file = stage.change.files.find((file) => file.path === filePath);
      const small = stage.change.files.length <= 40 && [...record.stats.values()].reduce((sum, stat) => sum + stat.additions + stat.deletions, 0) <= 2000;
      if (small && mode === "changes" && offset === 0 && !targetSide) {
        try {
          if (!record.diffs) record.diffs = buildStageDiffs(repoRoot, stage, record.stats, captureGit);
          const diff = record.diffs.get(filePath);
          if (diff) return { ...diff, truncated: false, nextOffset: diff.truncated ? diff.lines.length : null, mode };
        } catch { /* An unusually wide patch uses the bounded streaming path. */ }
      }
      record.pages ??= new Map();
      const key = JSON.stringify([filePath, mode, offset, targetSide, targetLine]);
      if (!record.pages.has(key)) {
        record.pages.set(key, pagedFileDiff(repoRoot, stage, file, record.stats.get(filePath), mode, offset, targetSide, targetLine)
          .catch((error) => { record.pages.delete(key); throw error; }));
        // Bound retained pages; in-flight consumers retain their own Promise.
        while (record.pages.size > 32) record.pages.delete(record.pages.keys().next().value);
      }
      return record.pages.get(key);
    },
  };
}

export function createImplementationDataScript(repoRoot) {
  return createViewerDataSource(repoRoot).implementationDataScript();
}

// Load open and resolved feedback threads from the local feedback store. A
// thread anchor is stale when its assigned or target stage has moved.
function buildFeedbackThreads(repoRoot, stages) {
  const feedbackRoot = path.join(repoRoot, ".semantic-review-feedback");
  const manifestPath = path.join(feedbackRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = readJson(manifestPath);
  if (manifest.formatVersion !== "0.1" || !Array.isArray(manifest.threads)) {
    throw new Error(
      "this feedback workspace uses an unsupported v0.1 layout",
    );
  }
  const currentHeads = new Map(stages.map((s) => [s.id, s.headRevision]));
  const threads: Array<Record<string, any>> = [];
  for (const threadId of manifest.threads || []) {
    const thread = readJson(
      path.join(feedbackRoot, "threads", `${threadId}.json`),
    );
    const currentHead = currentHeads.get(thread.target?.stageId);
    const targetHead = thread.target?.stageHead;
    let targetState = null;
    if (
      ["file", "line"].includes(thread.target?.kind) &&
      thread.target?.path &&
      currentHead &&
      targetHead
    ) {
      if (gitPathExists(repoRoot, currentHead, thread.target.path)) {
        targetState = { state: "present" };
      } else {
        const renamedPath = renamedPathBetween(
          repoRoot,
          targetHead,
          currentHead,
          thread.target.path,
        );
        if (renamedPath && gitPathExists(repoRoot, currentHead, renamedPath)) {
          targetState = { state: "renamed", path: renamedPath };
        } else if (
          gitPathExists(repoRoot, targetHead, thread.target.path)
        ) {
          targetState = { state: "deleted" };
        } else {
          targetState = { state: "not-in-stage" };
        }
      }
    }
    threads.push({
      id: thread.id,
      status: thread.status,
      target: thread.target,
      ...(targetState ? { targetState } : {}),
      comments: (thread.comments || []).map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
      assignedStageId: thread.assignedStageId,
      stageHead: thread.stageHead,
      createdAt: thread.createdAt,
      resolvedAt: thread.resolvedAt || null,
      anchorStale:
        currentHeads.get(thread.assignedStageId) !== thread.stageHead ||
        Boolean(
          thread.target?.stageId &&
            currentHeads.get(thread.target.stageId) !== thread.target.stageHead,
        ),
    });
  }
  return threads;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
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

// Map a browser-local note (kind: stage | node | file | line) onto
// review-feedback target options. Line notes encode the diff side and line
// number in their id.
export function mapNoteTarget(note, implementation) {
  if (note.kind === "stage") {
    const stage = implementation.stages.find((s) => s.id === note.id);
    if (!stage) throw new Error(`unknown stage "${note.id}"`);
    return { "target-kind": "stage", stage: stage.id, label: stage.title };
  }
  if (note.kind === "node") {
    const stages = note.stageId
      ? implementation.stages.filter((s) => s.id === note.stageId)
      : implementation.stages;
    if (note.stageId && stages.length === 0) {
      throw new Error(`unknown stage "${note.stageId}"`);
    }
    for (const stage of stages) {
      const node = stage.nodes.find((n) => n.id === note.id);
      if (node) {
        return {
          "target-kind": "node",
          stage: stage.id,
          node: node.id,
          label: node.title,
        };
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
    const stage = implementation.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    return { "target-kind": "file", stage: stageId, path: filePath, label: filePath };
  }
  if (note.kind === "line") {
    const match = /^l:([^:]+):(old|new):(\d+):(.+)$/.exec(note.id || "");
    if (!match) throw new Error(`unrecognized line id "${note.id}"`);
    const [, stageId, side, line, filePath] = match;
    const stage = implementation.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    return {
      "target-kind": "line",
      stage: stageId,
      path: filePath,
      side,
      line: Number(line),
      label: `${filePath}:${line}`,
    };
  }
  throw new Error(`unsupported note kind "${note.kind}"`);
}

export function buildFeedbackTargetData(repoRoot) {
  const implementationRoot = path.join(repoRoot, ".semantic-review");
  const manifest = readJson(path.join(implementationRoot, "manifest.json"));
  return {
    implementationId: manifest.implementationId,
    stages: manifest.stages.map((stageId) => {
      const stage = readJson(
        path.join(implementationRoot, "stages", `${stageId}.json`),
      );
      return {
        id: stage.id,
        title: stage.title,
        baseRevision: stage.change.baseRevision,
        headRevision: stage.change.headRevision,
        nodes: (stage.nodes || []).map((node) => ({
          id: node.id,
          title: humanizeId(node.id),
        })),
      };
    }),
  };
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
// Pure over (notes, implementation): produces the ordered list of threads to create
// and the reasons any note was skipped, without mutating any state. Kept
// separate from the CLI mutations so a malformed payload can never leave a
// partial or orphaned draft batch behind.
export function planFeedbackThreads(notes, implementation) {
  const skipped: Array<{ ref: number; reason: string }> = [];
  const planned: Array<{ ref: number; body: string; target: Record<string, any>; clientId?: string }> =
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
      target = mapNoteTarget(note, implementation);
      if (note.kind === "line" && note.snapshot) {
        const stage = implementation.stages.find((stage) => stage.id === target.stage);
        if (!stage || stage.baseRevision !== note.snapshot.base || stage.headRevision !== note.snapshot.head) {
          throw new Error("The stage changed since this line draft was written. Copy its text into a new note on the current diff before sending.");
        }
      }
    } catch (error) {
      skipped.push({ ref, reason: error.message });
      return;
    }
    planned.push({ ref, body, target, ...(typeof note.clientId === "string" ? { clientId: note.clientId } : {}) });
  });
  return { planned, skipped };
}

export function exportFeedback({ repoRoot, implementation, feedbackCli }, notes) {
  if (!feedbackCli) {
    return { ok: false, error: "The review-feedback CLI was not found next to the viewer." };
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    return { ok: false, error: "No feedback notes to export." };
  }
  const { planned, skipped } = planFeedbackThreads(notes, implementation);
  if (planned.length === 0) {
    return { ok: false, error: "No notes could be exported.", skipped };
  }

  const manifest = path.join(repoRoot, ".semantic-review-feedback", "manifest.json");
  if (!fs.existsSync(manifest)) {
    runFeedbackCli(feedbackCli, repoRoot, ["init"]);
  }
  const exportId = `viewer-${Date.now().toString(36)}`;
  const batch = planned.map((thread, index) => {
    const threadId = thread.clientId
      ? `viewer-${createHash("sha256").update(JSON.stringify([implementation.implementationId, thread.clientId, thread.target, thread.body])).digest("hex").slice(0, 32)}`
      : `${exportId}-t${String(index).padStart(3, "0")}`;
    const commentId = `${threadId}-c000`;
    return {
      ref: thread.ref,
      threadId,
      input: {
        id: threadId,
        "comment-id": commentId,
        body: thread.body,
        ...thread.target,
      },
    };
  });
  const result = JSON.parse(runFeedbackCli(
    feedbackCli, repoRoot, ["thread", "add-batch", "--partial", "--input", "-"],
    JSON.stringify({ threads: batch.map((entry) => entry.input) }),
  ));
  const exported = result.accepted.map(({ index }) => ({ ref: batch[index].ref, threadId: batch[index].threadId }));
  for (const { index, error } of result.rejected) skipped.push({ ref: batch[index].ref, reason: error });
  return { ok: exported.length > 0, exported, skipped, ...(exported.length ? {} : { error: "No notes could be exported." }) };

}

export function exportFeedbackReplies({ repoRoot, feedbackCli }, drafts) {
  if (!feedbackCli) {
    return { ok: false, error: "The review-feedback CLI was not found next to the viewer." };
  }
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { ok: false, error: "No feedback replies to export." };
  }
  const skipped: Array<{ ref: string; reason: string }> = [];
  const batch = [];
  drafts.forEach((draft, index) => {
    const ref =
      draft && typeof draft.ref === "string" ? draft.ref : String(index);
    const threadId =
      draft && typeof draft.threadId === "string" ? draft.threadId : "";
    const body = draft && typeof draft.body === "string" ? draft.body.trim() : "";
    if (!threadId) {
      skipped.push({ ref, reason: "thread no longer exists" });
      return;
    }
    if (!body) {
      skipped.push({ ref, reason: "empty body" });
      return;
    }
    const commentId = `reply-${createHash("sha256").update(JSON.stringify([threadId, ref, body])).digest("hex").slice(0, 32)}`;
    batch.push({
      ref,
      threadId,
      commentId,
      input: {
        id: threadId,
        "comment-id": commentId,
        author: "user",
        body,
      },
    });
  });
  if (batch.length === 0) {
    return { ok: false, error: "No feedback replies could be exported.", skipped };
  }

  const resultFor = (entry) => {
    const thread = readFeedbackThread(repoRoot, entry.threadId);
    return {
      ref: entry.ref,
      threadId: entry.threadId,
      comment: thread?.comments.find((comment) => comment.id === entry.commentId),
      status: thread?.status,
      resolvedAt: thread?.resolvedAt || null,
    };
  };

  const result = JSON.parse(runFeedbackCli(
    feedbackCli, repoRoot, ["thread", "reply-batch", "--partial", "--input", "-"],
    JSON.stringify({ replies: batch.map((entry) => entry.input) }),
  ));
  const replied = result.accepted.map(({ index }) => resultFor(batch[index]));
  for (const { index, error } of result.rejected) skipped.push({ ref: batch[index].ref, reason: error });
  return { ok: replied.length > 0, replied, skipped, ...(replied.length ? {} : { error: "No replies could be exported." }) };

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
    `http://${VIEWER_HOST}:${port}`,
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
    const implementation = buildFeedbackTargetData(context.repoRoot);
    if (payload.implementationId !== implementation.implementationId) {
      sendJson(response, 409, {
        ok: false,
        error: "This viewer is showing a different implementation than the one being exported.",
      });
      return;
    }
    const result = await context.jobs.call("exportFeedback", [payload.implementationId, payload.notes]);
    sendJson(response, result.ok ? 200 : 422, {
      ...result,
      ...await context.jobs.call("snapshot", [true]),
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

async function handleFeedbackReplyBatch(request, response, context) {
  try {
    if (!isTrustedRequest(request, context.port)) {
      sendJson(response, 403, {
        ok: false,
        error: "Feedback replies require a same-origin application/json request.",
      });
      return;
    }
    if (!context.feedbackCli) {
      sendJson(response, 422, {
        ok: false,
        error: "The review-feedback CLI was not found next to the viewer.",
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
    const currentImplementationId = activeImplementationId(context.repoRoot);
    if (
      !payload ||
      payload.implementationId !== context.implementationId ||
      payload.implementationId !== currentImplementationId
    ) {
      sendJson(response, 409, {
        ok: false,
        error: "This viewer is showing a different implementation than the one being edited.",
      });
      return;
    }
    const result = await context.jobs.call("exportFeedbackReplies", [payload.implementationId, payload.replies]);
    sendJson(response, result.ok ? 200 : 422, {
      ...result,
      ...await context.jobs.call("snapshot", [true]),
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

export function readFeedbackThread(repoRoot, threadId) {
  const feedbackRoot = path.join(repoRoot, ".semantic-review-feedback");
  const manifestPath = path.join(feedbackRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = readJson(manifestPath);
  if (manifest.formatVersion !== "0.1" || !Array.isArray(manifest.threads)) {
    throw new Error(
      "this feedback workspace uses an unsupported v0.1 layout",
    );
  }
  if ((manifest.threads || []).includes(threadId)) {
    return readJson(
      path.join(feedbackRoot, "threads", `${threadId}.json`),
    );
  }
  return null;
}

// Reviewer-driven thread actions: continue (reply), close (resolve), or reopen.
// Closure is always the reviewer's decision — the agent only ever replies.
async function handleThreadAction(request, response, context, action) {
  try {
    if (!isTrustedRequest(request, context.port)) {
      sendJson(response, 403, {
        ok: false,
        error: "Thread actions require a same-origin application/json request.",
      });
      return;
    }
    if (!context.feedbackCli) {
      sendJson(response, 422, {
        ok: false,
        error: "The review-feedback CLI was not found next to the viewer.",
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
    const currentImplementationId = activeImplementationId(context.repoRoot);
    if (
      !payload ||
      payload.implementationId !== context.implementationId ||
      payload.implementationId !== currentImplementationId
    ) {
      sendJson(response, 409, {
        ok: false,
        error: "This viewer is showing a different implementation than the one being edited.",
      });
      return;
    }
    const threadId = payload.threadId;
    if (typeof threadId !== "string" || !threadId) {
      sendJson(response, 400, { ok: false, error: "A threadId is required." });
      return;
    }
    try {
      if (action === "reply") {
        const body = typeof payload.body === "string" ? payload.body.trim() : "";
        if (!body) {
          sendJson(response, 400, { ok: false, error: "A reply body is required." });
          return;
        }
        const commentId = `reply-${Date.now().toString(36)}`;
        await context.jobs.call("feedbackCli", [context.implementationId, [
          "thread", "reply",
          "--id", threadId,
          "--comment-id", commentId,
          "--author", "user",
          "--body", body,
        ]]);
      } else if (action === "resolve") {
        await context.jobs.call("feedbackCli", [context.implementationId, ["thread", "resolve", "--id", threadId]]);
      } else if (action === "reopen") {
        await context.jobs.call("feedbackCli", [context.implementationId, ["thread", "reopen", "--id", threadId]]);
      }
    } catch (error) {
      sendJson(response, 422, { ok: false, error: cliErrorMessage(error) });
      return;
    }
    const thread = readFeedbackThread(context.repoRoot, threadId);
    if (!thread) {
      sendJson(response, 200, { ok: true });
      return;
    }
    const last = thread.comments[thread.comments.length - 1];
    sendJson(response, 200, {
      ok: true,
      status: thread.status,
      resolvedAt: thread.resolvedAt || null,
      comment: action === "reply" ? last : undefined,
      ...await context.jobs.call("snapshot", [true]),
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

function serveViewer({
  viewerDir,
  port,
  repoRoot,
  feedbackCli,
  implementationId,
  dataSource,
  viewerVersion,
}) {
  let server = null;
  const requestHandler = async (request, response) => {
    const url = new URL(request.url, `http://${VIEWER_HOST}`);
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    if (request.method === "GET" && pathname === "/api/whoami") {
      sendJson(response, 200, {
        ok: true,
        app: VIEWER_APP_ID,
        implementationId,
        repositoryRoot: repoRoot,
        processId: process.pid,
        viewerVersion,
        healthy: dataSource.healthy,
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/revision") {
      try {
        sendJson(response, 200, {
          ok: true,
          ...await dataSource.call("snapshot", []),
        });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: cliErrorMessage(error),
        });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/diff") {
      const stageId = url.searchParams.get("stage");
      const filePath = url.searchParams.get("path");
      const baseRevision = url.searchParams.get("base");
      const headRevision = url.searchParams.get("head");
      if (!stageId || !filePath || !baseRevision || !headRevision) {
        sendJson(response, 400, {
          ok: false,
          error: "Diff requests require stage, path, base, and head query parameters.",
        });
        return;
      }
      try {
        sendJson(response, 200, {
          ok: true,
          ...await dataSource.call("fileDiff", [stageId, filePath, baseRevision, headRevision,
            url.searchParams.get("mode") || "changes", Number(url.searchParams.get("offset") || 0),
            url.searchParams.get("side"), url.searchParams.has("line") ? Number(url.searchParams.get("line")) : null]),
        });
      } catch (error) {
        sendJson(response, 422, {
          ok: false,
          error: cliErrorMessage(error),
        });
      }
      return;
    }

    // Lets a fresh launch reclaim the fixed port by asking the previous viewer
    // to exit, instead of drifting to a new port (which strands localStorage).
    if (request.method === "POST" && pathname === "/api/shutdown") {
      if (!isTrustedRequest(request, port)) {
        sendJson(response, 403, {
          ok: false,
          error: "Shutdown requires a same-origin application/json request.",
        });
        return;
      }
      sendJson(response, 200, { ok: true });
      setTimeout(() => {
        const done = () => process.exit(0);
        if (server) server.close(done);
        else done();
        setTimeout(done, 500).unref();
      }, 50);
      return;
    }

    if (request.method === "POST" && pathname === "/api/feedback/export") {
      handleFeedbackExport(request, response, {
        repoRoot,
        feedbackCli,
        jobs: dataSource,
        port,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/feedback/reply-batch") {
      handleFeedbackReplyBatch(request, response, {
        repoRoot,
        feedbackCli,
        jobs: dataSource,
        port,
        implementationId,
      });
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/feedback/reply", "/api/feedback/resolve", "/api/feedback/reopen"].includes(pathname)
    ) {
      const action = pathname.split("/").pop();
      handleThreadAction(
        request,
        response,
        { repoRoot, feedbackCli, port, implementationId, jobs: dataSource },
        action,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/api/implementation") {
      try {
        const script = await dataSource.call("implementationDataScript", []);
        const payload = JSON.parse(script.slice("window.SEMANTIC_IMPLEMENTATION = ".length).trim().replace(/;$/, ""));
        sendJson(response, 200, { ok: true, implementation: payload });
      } catch (error) { sendJson(response, 500, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (pathname === "/implementation-data.js") {
      try {
        const body = Buffer.from(await dataSource.call("implementationDataScript", []), "utf8");
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
        response.end(`Failed to refresh implementation data: ${cliErrorMessage(error)}`);
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
  };

  server = http.createServer(requestHandler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, VIEWER_HOST, () => resolve(server));
  });
}

function createViewerWorker(repoRoot) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { repoRoot } });
  const pending = new Map();
  const reads = new Map();
  let sequence = 0;
  let stopped = false;
  const rejectAll = (error) => {
    stopped = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear(); reads.clear();
  };
  worker.on("error", rejectAll);
  worker.on("exit", () => rejectAll(new Error("Viewer worker stopped; reopen the viewer.")));
  worker.on("message", ({ id, result, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(result);
  });
  return {
    get healthy() { return !stopped; },
    call(method, args) {
      if (stopped) return Promise.reject(new Error("Viewer worker is unavailable; reopen the viewer."));
      const key = ["snapshot", "fileDiff", "implementationDataScript"].includes(method) ? JSON.stringify([method, args]) : null;
      if (key && reads.has(key)) return reads.get(key);
      if (pending.size >= 64) return Promise.reject(new Error("Viewer is busy; retry after the current requests finish."));
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      });
      if (key) {
        reads.set(key, promise);
        promise.finally(() => reads.delete(key)).catch(() => {});
      }
      return promise;
    },
    close() { return worker.terminate(); },
  };
}

if (!isMainThread && workerData?.repoRoot) {
  const root = workerData.repoRoot;
  const source = createViewerDataSource(root);
  const feedbackCli = locateFeedbackCli();
  parentPort.on("message", async ({ id, method, args }) => {
    try {
      let result;
      if (["snapshot", "fileDiff", "implementationDataScript"].includes(method)) result = await source[method](...args);
      else {
        if (activeImplementationId(root) !== args[0]) throw new Error("The active implementation changed; reopen the viewer.");
        if (method === "exportFeedback") result = exportFeedback({ repoRoot: root, feedbackCli, implementation: buildFeedbackTargetData(root) }, args[1]);
        else if (method === "exportFeedbackReplies") result = exportFeedbackReplies({ repoRoot: root, feedbackCli }, args[1]);
        else if (method === "feedbackCli") result = runFeedbackCli(feedbackCli, root, args[1]);
        else throw new Error("Unknown viewer operation.");
      }
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: cliErrorMessage(error) }); }
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url) {
  if (process.env.SEMANTIC_VIEW_NO_OPEN) return;
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

function implementationSummary(repoRoot) {
  const implementationRoot = path.join(repoRoot, ".semantic-review");
  const manifest = readJson(path.join(implementationRoot, "manifest.json"));
  const fileCount = manifest.stages.reduce((total, stageId) => {
    const stage = readJson(
      path.join(implementationRoot, "stages", `${stageId}.json`),
    );
    return total + stage.change.files.length;
  }, 0);
  return {
    implementationId: manifest.implementationId,
    title: manifest.title,
    stageCount: manifest.stages.length,
    fileCount,
  };
}

function notifyLauncher(message) {
  if (typeof process.send !== "function") return;
  try {
    process.send(message, () => {
      if (process.connected) process.disconnect();
    });
  } catch {
    if (process.connected) process.disconnect();
  }
}

let startupWorker: ReturnType<typeof createViewerWorker> | undefined;

async function main() {
  const repoRoot = resolveRepositoryRoot(process.argv.slice(2));
  const viewerDir = locateViewerDir();
  const implementation = implementationSummary(repoRoot);
  const dataSource = createViewerWorker(repoRoot);
  startupWorker = dataSource;
  const feedbackCli = locateFeedbackCli();
  const fingerprint = createHash("sha256");
  for (const file of [fileURLToPath(import.meta.url), feedbackCli, ...["app.js", "styles.css", "index.html"].map((name) => path.join(viewerDir, name))].filter(Boolean)) {
    fingerprint.update(fs.readFileSync(file));
  }
  const viewerVersion = fingerprint.digest("hex");

  const port = viewerPort();
  let server = null;
  try {
    server = await serveViewer({
      viewerDir,
      port,
      repoRoot,
      feedbackCli,
      implementationId: implementation.implementationId,
      dataSource,
      viewerVersion,
    });
  } catch (error) {
    if (!error || error.code !== "EADDRINUSE") { await dataSource.close(); throw error; }
    // The port is taken. Reclaim it only if our own viewer is holding it;
    // never kill an unrelated app that happens to use this port.
    const occupant = await probeViewer(port);
    if (!occupant) {
      await dataSource.close();
      fail(
        `Port ${port} is in use by another application. Stop it (or free the port) and try again.`,
      );
    }
    if (occupant.healthy !== false && occupant.viewerVersion === viewerVersion && occupant.implementationId === implementation.implementationId &&
      occupant.repositoryRoot && fs.realpathSync(occupant.repositoryRoot) === fs.realpathSync(repoRoot)) {
      await dataSource.close();
      const url = `http://${VIEWER_HOST}:${port}/`;
      notifyLauncher({ type: "ready", url, repositoryRoot: repoRoot, processId: occupant.processId,
        implementation, feedbackEnabled: Boolean(feedbackCli) });
      console.log(`Reusing semantic review viewer: ${url}`);
      openBrowser(url);
      return;
    }
    console.log(`A semantic review viewer is already running on port ${port}; restarting it…`);
    await requestViewerShutdown(port);
    for (let attempt = 0; attempt < 40 && !server; attempt += 1) {
      await delay(100);
      try {
        server = await serveViewer({
          viewerDir,
          port,
          repoRoot,
          feedbackCli,
          implementationId: implementation.implementationId,
          dataSource,
          viewerVersion,
        });
      } catch (retryError) {
        if (!retryError || retryError.code !== "EADDRINUSE") throw retryError;
      }
    }
    if (!server) {
      await dataSource.close();
      fail(`Port ${port} is still busy after asking the existing viewer to stop.`);
    }
  }
  const url = `http://${VIEWER_HOST}:${port}/`;
  console.log(`Semantic review viewer: ${url}`);
  console.log(`Project: ${repoRoot}`);
  console.log(
    `Implementation: ${implementation.title} — ${implementation.stageCount} stages, ${implementation.fileCount} files`,
  );
  if (!feedbackCli) {
    console.log(
      "Note: review-feedback CLI not found; exporting reviewer feedback is disabled.",
    );
  }
  console.log("Press Ctrl+C to stop.");
  notifyLauncher({
    type: "ready",
    url,
    repositoryRoot: repoRoot,
    processId: process.pid,
    implementation,
    feedbackEnabled: Boolean(feedbackCli),
  });
  openBrowser(url);
}

const isDirectRun =
  path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);

if (isDirectRun && isMainThread) {
  main().catch(async (error) => {
    await startupWorker?.close();
    notifyLauncher({ type: "error", message: error.message });
    if (process.exitCode === undefined || process.exitCode === 0) {
      console.error(`semantic-view: ${error.message}`);
      process.exitCode = 1;
    }
  });
}
