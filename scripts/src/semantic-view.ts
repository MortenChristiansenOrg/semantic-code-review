import { resolveCodeTarget } from "./shared/insight-targets.js";
export { captureCodeTarget, resolveCodeTarget } from "./shared/insight-targets.js";
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
import { Worker, isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { factCache, withValidationContext } from "./shared/validation-context.js";
import { SUBPROCESS_MAX_BUFFER } from "./shared/subprocess.js";
import {
  probeViewer,
  stopViewerAndWait,
  VIEWER_APP_ID,
  VIEWER_HOST,
  viewerPort,
  type ViewerIdentity,
} from "./shared/viewer-lifecycle.js";

export { registerReview, readReview, patchReviewState, reviewDirectory, reviewId, feedbackDirectory, recordViewer, listReviews, setReviewCompleted } from "./shared/review-store.js";
import { registerReview, readReview, patchReviewState, reviewDirectory, reviewDeletionPath, feedbackDirectory, reviewId, reviewHome, withReviewLock, recordViewer, listReviews, setReviewCompleted } from "./shared/review-store.js";

export { captureReviewContext, assertReviewContext, runReviewCommand } from "./shared/review-context.js";
import { captureReviewContext, assertReviewContext, runReviewCommand, spawnReviewCommand, reviewEnvironment, type ReviewContext } from "./shared/review-context.js";

export { inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles } from "./shared/review-cleanup.js";
import { inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles, pendingReviewDeletions } from "./shared/review-cleanup.js";
export { storeAttachment, resolveAttachment } from "./shared/review-attachments.js";
import { storeAttachment, resolveAttachment, imageMediaType, MAX_ATTACHMENT_BYTES } from "./shared/review-attachments.js";
export { evidenceRange } from "./shared/evidence.js";
export { captureApprovalSnapshot, compareApprovalSnapshot } from "./shared/approval-snapshots.js";
import { evidenceMediaTypeMatches, evidenceRange, resolveEvidenceFile, sha256Hex } from "./shared/evidence.js";
import { captureApprovalSnapshot, compareApprovalSnapshot, type FileEndpoint } from "./shared/approval-snapshots.js";

export { startRemoteReview, refreshRemoteReview } from "./shared/remote-review.js";
import { refreshRemoteReview } from "./shared/remote-review.js";
import { agentStatus, liveSession, markSending, readAgentState, respondToRequest, updateAgentState } from "./shared/agent-session.js";
import { awaitsAgentReply } from "./shared/feedback-awaiting.js";
import { FEEDBACK_MANIFEST_SCHEMA_ID, INSIGHT_COLLECTIONS, THREAD_SCHEMA_ID, isFeedbackId, type CodeTarget, type InsightCollection, type Thread } from "./shared/documents.js";
import { listJsonFiles, parseJson, readJson } from "./shared/json.js";
import { capturedOutput, errorCode, errorMessage, isRecord, isStringArray, numberField, stringField, type JsonRecord } from "./shared/narrow.js";
import { isDocument, parseDocument } from "./shared/schema-validation.js";
import type { StateChange } from "./shared/review-store.js";

const pathExistsFacts = factCache<boolean>();
const renameFacts = factCache<string>();
const stageStatsFacts = factCache<Map<string, FileStats>>();

const MAX_ROWS = 900; // rows per page; all later rows remain available

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const versionFile = path.resolve(scriptDir, "..", "VERSION");
const viewerReleaseVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, "utf8").trim() || "unversioned"
  : "unversioned";

function fail(message: string): never {
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

function resolveRepositoryRoot(args: string[]) {
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

function gitCapture(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: reviewEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
}

type GitCapture = typeof gitCapture;

function gitPathExists(repoRoot: string, revision: string, filePath: string): boolean {
  return pathExistsFacts(JSON.stringify([repoRoot, revision, filePath]), () => checkGitPathExists(repoRoot, revision, filePath));
}

function checkGitPathExists(repoRoot: string, revision: string, filePath: string) {
  try {
    gitCapture(repoRoot, ["cat-file", "-e", `${revision}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

function renamedPathBetween(repoRoot: string, fromRevision: string, toRevision: string, filePath: string): string | null {
  let raw: string;
  try {
    raw = renameFacts(JSON.stringify([repoRoot, fromRevision, toRevision]), () => gitCapture(repoRoot, [
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

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** The fields of a JSON object, or an empty record for any other value. */
const fieldsOf = (value: unknown): JsonRecord => isRecord(value) ? value : {};

// --- Artifact documents as the viewer reads them ---
//
// Local artifacts are validated by the CLI, but remote reviews reconstructed
// from Git history (shared/remote-review.ts) are not schema documents: they
// have no $schema, base branch or insight collections. The viewer therefore
// narrows artifact documents field by field. It fails only where it cannot
// render at all and passes display-only values through to the browser.

/** The implementation manifest fields the viewer reads. */
interface ViewerManifest {
  implementationId: string;
  title?: string;
  summary?: string;
  skillVersion?: string;
  targetBranch?: string;
  baseRevision?: string;
  requirements: string[];
  stages: string[];
}

interface ViewerSpecification {
  id?: string;
  title?: string;
  summary?: string;
  source: unknown;
  acceptanceCriteria: unknown[];
}

interface ViewerNodeChange {
  path?: string;
  classification?: unknown;
  hunks?: unknown;
  lineRanges?: unknown;
}

interface ViewerNode {
  id: string;
  description?: unknown;
  changes: ViewerNodeChange[];
}

interface StageDocumentFile {
  path: string;
  kind?: unknown;
  previousPath?: string;
  /** Set once readViewerStages has compared the file with its previous occurrence. */
  baseRevision?: string;
}

/** A stage's insight collections; items are narrowed where they are read. */
type InsightLists = Partial<Record<InsightCollection, unknown[]>>;

interface StageDocument<File extends StageDocumentFile = StageDocumentFile> extends InsightLists {
  id: string;
  title?: string;
  summary?: string;
  rationale?: string;
  dependsOn: unknown[];
  specificationRefs: unknown[];
  nodes: ViewerNode[];
  change: { branch?: string; baseRevision: string; headRevision: string; files: File[] };
}

/** A changed file compared with its last occurrence in the ordered review. */
interface ViewerFile extends StageDocumentFile {
  baseRevision: string;
  previousPaths: string[];
  previousStageId?: string;
}

type ViewerStage = StageDocument<ViewerFile>;

function requiredString(value: JsonRecord, key: string, file: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${file}: missing string ${key}.`);
  return field;
}

function readManifest(file: string): ViewerManifest {
  const value = fieldsOf(readJson(file));
  const { stages, requirements } = value;
  if (!isStringArray(stages)) throw new Error(`${file}: missing stage list.`);
  return {
    implementationId: requiredString(value, "implementationId", file),
    title: stringField(value, "title"), summary: stringField(value, "summary"), skillVersion: stringField(value, "skillVersion"),
    targetBranch: stringField(value, "targetBranch"), baseRevision: stringField(value, "baseRevision"),
    requirements: isStringArray(requirements) ? requirements : [],
    stages,
  };
}

function readSpecification(file: string): ViewerSpecification {
  const value = fieldsOf(readJson(file));
  return {
    id: stringField(value, "id"), title: stringField(value, "title"), summary: stringField(value, "summary"),
    source: value.source, acceptanceCriteria: isList(value.acceptanceCriteria) ? value.acceptanceCriteria : [],
  };
}

function readStageDocument(file: string): StageDocument {
  const value = fieldsOf(readJson(file));
  const change = fieldsOf(value.change);
  if (!isList(change.files)) throw new Error(`${file}: missing change file list.`);
  const files = change.files.map((item): StageDocumentFile => {
    const entry = fieldsOf(item);
    return { path: requiredString(entry, "path", file), kind: entry.kind, previousPath: stringField(entry, "previousPath") };
  });
  const nodes = (isList(value.nodes) ? value.nodes : []).map((item): ViewerNode => {
    const node = fieldsOf(item);
    return {
      id: requiredString(node, "id", file), description: node.description,
      changes: (isList(node.changes) ? node.changes : []).map((entry) => {
        const { classification, hunks, lineRanges } = fieldsOf(entry);
        return { path: stringField(entry, "path"), classification, hunks, lineRanges };
      }),
    };
  });
  const stage: StageDocument = {
    id: requiredString(value, "id", file),
    title: stringField(value, "title"), summary: stringField(value, "summary"), rationale: stringField(value, "rationale"),
    dependsOn: isList(value.dependsOn) ? value.dependsOn : [],
    specificationRefs: isList(value.specificationRefs) ? value.specificationRefs : [],
    nodes,
    change: {
      branch: stringField(change, "branch"),
      baseRevision: requiredString(change, "baseRevision", file),
      headRevision: requiredString(change, "headRevision", file),
      files,
    },
  };
  for (const collection of INSIGHT_COLLECTIONS) {
    const items = value[collection];
    if (isList(items)) stage[collection] = items;
  }
  return stage;
}

function manifestPath(repoRoot: string) {
  return path.join(repoRoot, ".semantic-review", "manifest.json");
}

function stagePath(repoRoot: string, stageId: string) {
  return path.join(repoRoot, ".semantic-review", "stages", `${stageId}.json`);
}

/** The implementation ID of the active manifest, failing when it has none. */
function manifestImplementationId(value: unknown): string {
  const implementationId = stringField(value, "implementationId");
  if (implementationId === undefined) throw new Error("The active .semantic-review manifest has no implementation ID.");
  return implementationId;
}

/** A file's text, or undefined when it does not exist. */
function readOptionalText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Stored thread text parsed like the revision snapshot parses it, or
 * undefined when it is not JSON (for example while it is being repaired). */
function parseStoredThread(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

/** A stored thread file, or undefined when it is missing or not JSON. The
 * viewer skips such a thread like one that fails its schema. */
function readStoredThread(file: string): unknown {
  const text = readOptionalText(file);
  return text === undefined ? undefined : parseStoredThread(text);
}

/** The viewer lists and counts a stored thread only when it passes its schema,
 * so one broken thread does not hide the others. Feedback commands and
 * validation still report it. */
function viewerThread(value: unknown): Thread | undefined {
  return isDocument(THREAD_SCHEMA_ID, value) ? value : undefined;
}

/** Whether a stored thread that the viewer lists waits for the agent. */
function threadAwaitsAgent(value: unknown): boolean {
  const thread = viewerThread(value);
  return thread !== undefined && awaitsAgentReply(thread);
}

/** Thread IDs listed by a feedback manifest that may be mid-write. IDs name
 * thread files, so an ID that breaks the feedback ID rules is skipped. */
function listedThreadIds(manifest: unknown): string[] {
  const threads = fieldsOf(manifest).threads;
  return isStringArray(threads) ? threads.filter(isFeedbackId) : [];
}

/** What the browser polls to notice artifact or feedback changes. */
interface ViewerRevision {
  revision: string;
  awaitingAgentReplies: number;
}

export function viewerSnapshot(repoRoot: string): ViewerRevision {
  const implementationId = activeImplementationId(repoRoot);
  return withReviewLock(reviewId(repoRoot, implementationId), () => {
    requireImplementation(repoRoot, implementationId);
    const snapshot = readViewerSnapshot(repoRoot, implementationId);
    requireImplementation(repoRoot, implementationId);
    return snapshot;
  });
}

function readViewerSnapshot(repoRoot: string, implementationId: string): ViewerRevision {
  const semanticRoot = path.join(repoRoot, ".semantic-review");
  const feedbackRoot = feedbackDirectory(repoRoot, implementationId);
  const files = [
    path.join(semanticRoot, "manifest.json"),
    ...listJsonFiles(path.join(semanticRoot, "requirements")),
    ...listJsonFiles(path.join(semanticRoot, "stages")),
  ];
  const feedbackManifestPath = path.join(feedbackRoot, "manifest.json");
  let awaitingAgentReplies = 0;
  if (fs.existsSync(feedbackManifestPath)) {
    files.push(feedbackManifestPath);
    for (const threadId of listedThreadIds(readJson(feedbackManifestPath))) {
      const file = path.join(feedbackRoot, "threads", `${threadId}.json`);
      const text = readOptionalText(file);
      // A missing thread leaves the hashed files, so restoring it changes the revision.
      if (text === undefined) continue;
      files.push(file);
      if (threadAwaitsAgent(parseStoredThread(text))) awaitingAgentReplies += 1;
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

interface SnapshotReaderOptions {
  now?: () => number;
  readFile?: (file: string) => string;
}

interface CachedDocument {
  stamp: string;
  text: string;
  value: unknown;
}

/** Stat-based invalidation plus a periodic content scan for missed/coarse timestamp changes. */
export function createSnapshotReader(repoRoot: string, { now = Date.now, readFile = (file: string) => fs.readFileSync(file, "utf8") }: SnapshotReaderOptions = {}) {
  let documents = new Map<string, CachedDocument>();
  let previous: ViewerRevision | null = null;
  let lastScan = -Infinity;
  return (force = false): ViewerRevision => {
    const nextDocuments = new Map(documents);
    const scan = force || now() - lastScan >= 10_000;
    const seen = new Set<string>();
    let changed = false;
    // A thread may be missing or not JSON; it reads as undefined. A missing file
    // leaves the hashed files and unparsable text is still hashed, so restoring
    // or repairing either changes the revision.
    const read = (file: string, thread = false): unknown => {
      let stat: fs.BigIntStats;
      try {
        stat = fs.statSync(file, { bigint: true });
      } catch (error) {
        if (thread && errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const cached = documents.get(file);
      seen.add(file);
      if (!scan && cached && cached.stamp === stamp) return cached.value;
      const text = readFile(file);
      if (!cached || cached.text !== text) changed = true;
      const document = { stamp, text, value: thread ? parseStoredThread(text) : parseJson(text) };
      nextDocuments.set(file, document);
      return document.value;
    };
    const semantic = path.join(repoRoot, ".semantic-review");
    const implementationId = manifestImplementationId(read(path.join(semantic, "manifest.json")));
    const feedback = feedbackDirectory(repoRoot, implementationId);
    let awaitingAgentReplies = 0;
    // Artifact writers that change several documents hold this lock, so one snapshot is never mixed.
    withReviewLock(reviewId(repoRoot, implementationId), () => {
      read(path.join(semantic, "manifest.json"));
      for (const file of [...listJsonFiles(path.join(semantic, "requirements")), ...listJsonFiles(path.join(semantic, "stages"))]) read(file);
      if (fs.existsSync(path.join(feedback, "manifest.json"))) {
        for (const id of listedThreadIds(read(path.join(feedback, "manifest.json")))) {
          if (threadAwaitsAgent(read(path.join(feedback, "threads", `${id}.json`), true))) awaitingAgentReplies++;
        }
      }
    });
    for (const file of nextDocuments.keys()) if (!seen.has(file)) { nextDocuments.delete(file); changed = true; }
    if (changed || !previous) {
      const hash = createHash("sha256");
      for (const file of [...seen].sort()) hash.update(path.relative(repoRoot, file)).update("\0").update(nextDocuments.get(file)?.text ?? "").update("\0");
      previous = { revision: hash.digest("hex"), awaitingAgentReplies };
    }
    documents = nextDocuments;
    if (scan) lastScan = now();
    return previous;
  };
}

function requireImplementation(repoRoot: string, implementationId: string) {
  if (activeImplementationId(repoRoot) !== implementationId) throw new Error("The active implementation changed; reopen the viewer.");
}

function activeImplementationId(repoRoot: string): string {
  return manifestImplementationId(readJson(manifestPath(repoRoot)));
}

function humanizeId(id: string) {
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

interface Project {
  dir: string;
  name: string;
}

function buildProjectIndex(repoRoot: string, captureGit: GitCapture = gitCapture): Project[] {
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
          ? dir.replace(/\/$/, "").split("/").at(-1) ?? ""
          : "Repository root";
      return { dir, name };
    });
}

function projectFor(projects: Project[], p: string): string {
  let best: Project | null = null;
  for (const c of projects) {
    if (p.startsWith(c.dir) && (!best || c.dir.length > best.dir.length)) best = c;
  }
  if (best) return best.name;
  const seg = p.split("/");
  return seg.length > 1 ? `${seg[0]}/` : "Repository root";
}

/** One diff row: an added (new line n), deleted (old line o) or context line,
 * with the 1-based hunk an added or deleted line belongs to. */
type DiffLine =
  | { t: "add"; n: number; s: string; h?: number }
  | { t: "del"; o: number; s: string; h?: number }
  | { t: "ctx"; o: number; n: number; s: string };

/** Git's view of one changed file in a diff range. */
interface FileStats {
  additions: number;
  deletions: number;
  binary: boolean;
  kind?: "added" | "modified" | "deleted" | "renamed";
  oldMode?: string;
  newMode?: string;
  previousPath?: string;
  oldBlob?: string;
  newBlob?: string;
}

interface ParsedDiff {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
}

type DiffMode = "changes" | "full";

/** One page of a file diff as served to the browser. */
type DiffPage = ParsedDiff & { nextOffset: number | null; mode: DiffMode; offset?: number };

function parseDiffPatch(raw: string, selectorRaw: string, stats: FileStats | undefined): ParsedDiff {
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
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  let truncated = false;
  let started = false;
  let rowCount = 0;
  const hunkByLine = new Map<string, number>();
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

/** Files follow their last occurrence in the ordered review, independently of
 * intervening stages. */
function readViewerStages(repoRoot: string, manifest: ViewerManifest = readManifest(manifestPath(repoRoot))): ViewerStage[] {
  const previous = new Map<string, { stageId: string; headRevision: string; path: string; previousPaths: string[] }>();
  return manifest.stages.map((id) => {
    const stage = readStageDocument(stagePath(repoRoot, id));
    const files = stage.change.files.map((file): ViewerFile => {
      const last = (file.previousPath && previous.get(file.previousPath)) || previous.get(file.path);
      const { previousPath: ignored, ...current } = file;
      const oldPath = last ? last.path : file.previousPath;
      const previousPaths = [...new Set([oldPath, ...(last?.previousPaths || [])].filter((item): item is string => Boolean(item) && item !== file.path))];
      return { ...current, ...(oldPath && oldPath !== file.path ? { previousPath: oldPath } : {}),
        previousPaths, baseRevision: last ? last.headRevision : stage.change.baseRevision,
        ...(last ? { previousStageId: last.stageId } : {}) };
    });
    for (const file of stage.change.files) if (file.previousPath) previous.delete(file.previousPath);
    for (const file of files) {
      previous.set(file.path, { stageId: stage.id, headRevision: stage.change.headRevision, path: file.path, previousPaths: file.previousPaths });
    }
    return { ...stage, change: { ...stage.change, files } };
  });
}

/** The revision range a diff is computed over. */
interface DiffRange {
  change: { baseRevision: string; headRevision: string };
}

/** Files diffed over one range; a file's own base overrides the range's. */
interface DiffGroup extends DiffRange {
  change: { baseRevision: string; headRevision: string; files: { path: string; baseRevision?: string }[] };
}

function fileDiffGroups(stage: DiffGroup): DiffGroup[] {
  const groups = new Map<string, DiffGroup["change"]["files"]>();
  for (const file of stage.change.files) {
    const base = file.baseRevision || stage.change.baseRevision;
    let group = groups.get(base);
    if (!group) groups.set(base, group = []);
    group.push(file);
  }
  return [...groups].map(([baseRevision, files]) => ({ change: { ...stage.change, baseRevision, files } }));
}
function stageFileStats(repoRoot: string, stage: DiffGroup, captureGit: GitCapture): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  for (const group of fileDiffGroups(stage)) {
    const grouped = buildStageStats(repoRoot, group, captureGit);
    for (const file of group.change.files) {
      const fileStats = grouped.get(file.path);
      if (fileStats) stats.set(file.path, fileStats);
    }
  }
  return stats;
}
function stageFileDiffs(repoRoot: string, stage: DiffGroup, stats: Map<string, FileStats>, captureGit: GitCapture): Map<string, ParsedDiff> {
  const diffs = new Map<string, ParsedDiff>();
  for (const group of fileDiffGroups(stage)) for (const [file, diff] of buildStageDiffs(repoRoot, group, stats, captureGit)) diffs.set(file, diff);
  return diffs;
}

function stageDiffKey(stage: ViewerStage) {
  return JSON.stringify([stage.id, stage.change.baseRevision, stage.change.headRevision, stage.change.files.map((file) => [file.path, file.previousPath, file.baseRevision])]);
}

function buildStageStats(repoRoot: string, stage: DiffRange, captureGit: GitCapture = gitCapture): Map<string, FileStats> {
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
  const stats = new Map<string, FileStats>();
  const fields = raw.split("\0");
  const blobs = new Map<string, Omit<FileStats, "additions" | "deletions" | "binary">>();
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
      kind: status.startsWith("R") ? "renamed" : status === "A" ? "added" : status === "D" ? "deleted" : "modified",
      oldMode: metadata[0] || "",
      newMode: metadata[1] || "",
      previousPath: status.startsWith("R") || status.startsWith("C") ? previousPath : undefined,
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

function decodePatchPath(value: string): string {
  const withoutTimestamp = value.replace(/\r$/, "").split("\t", 1)[0];
  if (withoutTimestamp === "/dev/null") return "";
  let decoded = withoutTimestamp;
  if (decoded.startsWith('"') && decoded.endsWith('"')) {
    try {
      const unquoted = parseJson(decoded);
      if (typeof unquoted !== "string") return "";
      decoded = unquoted;
    } catch {
      return "";
    }
  }
  return decoded.replace(/^[ab]\//, "");
}

function patchSectionPath(section: string): string {
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

function indexPatchSections(raw: string, expectedPaths: string[]): Map<string, string> {
  const expected = new Set(expectedPaths);
  const indexed = new Map<string, string>();
  const unresolved: string[] = [];
  const sections = raw
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const filePath = patchSectionPath(section);
    if (filePath && expected.has(filePath) && !indexed.has(filePath)) {
      indexed.set(filePath, section);
    } else if (!filePath) {
      unresolved.push(section);
    }
  }
  const missing = expectedPaths.filter((filePath) => !indexed.has(filePath));
  if (unresolved.length === missing.length) {
    unresolved.forEach((section, index) => indexed.set(missing[index], section));
  }
  return indexed;
}

function buildStageDiffs(repoRoot: string, stage: DiffGroup, stats: Map<string, FileStats>, captureGit: GitCapture = gitCapture): Map<string, ParsedDiff> {
  const args = (unified: number) => [
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
  const changedPaths = expectedPaths.filter((filePath) => stats.has(filePath));
  const fullByPath = indexPatchSections(full, changedPaths);
  const selectorByPath = indexPatchSections(selector, changedPaths);
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

async function* gitLines(repoRoot: string, args: string[]): AsyncGenerator<string> {
  const child = spawn("git", args, {
    cwd: repoRoot,
    env: reviewEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
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
async function pagedFileDiff(repoRoot: string, stage: DiffRange, file: ViewerFile, stats: FileStats | undefined, mode: DiffMode, offset: number,
  targetSide: "old" | "new" | null = null, targetLine: number | null = null): Promise<DiffPage> {
  const paths = [...new Set([file.previousPath, file.path].filter((item): item is string => Boolean(item)))];
  const args = (context: number) => ["-c", "core.quotePath=false", "--no-pager", "diff", "--no-ext-diff", "--find-renames=50%", `-U${context}`,
    stage.change.baseRevision, stage.change.headRevision, "--", ...paths];
  const shapes: { old: number; oldCount: number; new: number; newCount: number }[] = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let selected = false, previousPath = "";
  const selectSection = (line: string) => {
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
  const lines: DiffLine[] = [];
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
      const hunk = shapes.findIndex((shape) => {
        const [start, count] = side === "new" ? [shape.new, shape.newCount] : [shape.old, shape.oldCount];
        return number >= start && number < start + count;
      });
      lines.push(side === "new" ? { t: "add", n: number, s: text, h: hunk + 1 } : { t: "del", o: number, s: text, h: hunk + 1 });
    } else lines.push({ t: "ctx", o: oldNo++, n: newNo++, s: text });
  }
  return { lines, additions: stats?.additions ?? 0, deletions: stats?.deletions ?? 0, binary,
    truncated: false, nextOffset: more ? offset + lines.length : null, offset, mode };
}

const listOf = (value: unknown): unknown[] => isList(value) ? value : [];

function isCodeTarget(value: unknown): value is CodeTarget {
  return isRecord(value) && typeof value.path === "string" && typeof value.revision === "string" && typeof value.blobId === "string" &&
    typeof value.startLine === "number" && typeof value.endLine === "number" && typeof value.contextStartLine === "number" &&
    isStringArray(value.context);
}

interface ViewerInsight {
  type: string;
  collection: InsightCollection;
  id?: string;
  title?: string;
  body?: string;
  meta?: string;
  validationType?: string;
  nodeRefs: unknown;
  evidence?: {
    kind?: string;
    attachments: { mediaType?: string; sha256?: string; caption?: string; role?: string }[];
    inline?: string;
    reproduction?: string;
    specificationRefs: unknown;
    capturedAt?: string;
  };
  codeTarget?: ReturnType<typeof resolveCodeTarget>;
}

/** Insights are display-only, so each item is read leniently, including older
 * shapes (alternatives with summary/rationale, plain-text open questions). */
function buildInsights(stage: InsightLists & DiffRange, repoRoot: string): ViewerInsight[] {
  const insights: ViewerInsight[] = [];
  const text = stringField;
  for (const d of listOf(stage.decisions)) {
    insights.push({
      type: "decision",
      collection: "decisions",
      id: text(d, "id"),
      title: text(d, "summary"),
      body: text(d, "rationale"),
      meta: text(d, "category"),
      nodeRefs: fieldsOf(d).nodeRefs || [],
    });
  }
  for (const a of listOf(stage.assumptions)) {
    const riskIfWrong = text(a, "riskIfWrong");
    insights.push({
      type: "assumption",
      collection: "assumptions",
      id: text(a, "id"),
      title: text(a, "statement"),
      body: riskIfWrong ? `If wrong: ${riskIfWrong}` : "",
      nodeRefs: fieldsOf(a).nodeRefs || [],
    });
  }
  for (const a of listOf(stage.alternatives)) {
    insights.push({
      type: "alternative",
      collection: "alternatives",
      id: text(a, "id"),
      title: text(a, "approach") || text(a, "summary") || text(a, "id"),
      body: text(a, "reasonRejected") || text(a, "rationale") || "",
      nodeRefs: fieldsOf(a).nodeRefs || [],
    });
  }
  for (const f of listOf(stage.failedAttempts)) {
    insights.push({
      type: "lesson",
      collection: "failedAttempts",
      id: text(f, "id"),
      title: text(f, "approach"),
      body: `Outcome: ${text(f, "outcome")} — Lesson: ${text(f, "lesson")}`,
      nodeRefs: fieldsOf(f).nodeRefs || [],
    });
  }
  for (const r of listOf(stage.risks)) {
    const mitigation = text(r, "mitigation");
    insights.push({
      type: "risk",
      collection: "risks",
      id: text(r, "id"),
      title: text(r, "summary"),
      body: mitigation ? `Mitigation: ${mitigation}` : "",
      nodeRefs: fieldsOf(r).nodeRefs || [],
    });
  }
  for (const v of listOf(stage.validation)) {
    insights.push({
      type: "validation",
      collection: "validation",
      id: text(v, "id"),
      title: text(v, "summary"),
      body: text(v, "command") || "",
      meta: text(v, "status"),
      validationType: text(v, "type"),
      nodeRefs: fieldsOf(v).nodeRefs || [],
    });
  }
  for (const e of listOf(stage.evidence)) {
    const reproduction = text(e, "reproduction");
    insights.push({
      type: "evidence",
      collection: "evidence",
      id: text(e, "id"),
      title: text(e, "summary"),
      body: reproduction ? `Reproduce: ${reproduction}` : "",
      meta: text(e, "kind"),
      nodeRefs: fieldsOf(e).nodeRefs || [],
      evidence: {
        kind: text(e, "kind"),
        attachments: listOf(fieldsOf(e).attachments).map((attachment) => ({
          mediaType: text(attachment, "mediaType"), sha256: text(attachment, "sha256"), caption: text(attachment, "caption"), role: text(attachment, "role"),
        })),
        inline: text(e, "inline"),
        reproduction,
        specificationRefs: fieldsOf(e).specificationRefs || [],
        capturedAt: text(e, "capturedAt"),
      },
    });
  }
  for (const q of listOf(stage.openQuestions)) {
    insights.push({
      type: "question",
      collection: "openQuestions",
      id: text(q, "id") || "q",
      title: text(q, "question") || text(q, "summary") || String(q),
      body: text(q, "context") || "",
      nodeRefs: fieldsOf(q).nodeRefs || [],
    });
  }
  return insights.map(insight => {
    const item = listOf(stage[insight.collection]).find((candidate) => isRecord(candidate) && candidate.id === insight.id);
    const target = fieldsOf(item).codeTarget;
    return isCodeTarget(target) ? { ...insight, codeTarget: resolveCodeTarget(repoRoot, target, stage.change.headRevision) } : insight;
  });
}

function fileRevision(stage: DiffRange, file: { path: string; previousPath?: string; baseRevision?: string }, stats: FileStats | undefined): string {
  const hash = createHash("sha256")
    .update(stats?.oldBlob || file.baseRevision || stage.change.baseRevision)
    .update("\0")
    .update(stats?.newBlob || stage.change.headRevision)
    .update("\0")
    .update(file.path)
    .update("\0")
    .update(file.previousPath || "");
  // Preserve existing fingerprints for ordinary files. Missing sides are already
  // represented by zero blob IDs; non-default modes need additional identity.
  for (const side of ["oldMode", "newMode"] as const) {
    const mode = stats?.[side];
    if (mode && mode !== "100644" && mode !== "000000") hash.update(`\0${side}=${mode}`);
  }
  return hash.digest("hex");
}

/** A node's claim on a file; the browser echoes it back when approving the file. */
interface ViewerMembership {
  nodeId: string;
  classification?: unknown;
  hunks?: unknown;
  lineRanges?: unknown;
}

/** Copies a node change without absent keys, so a value echoed back through
 * JSON compares equal to the original. */
function nodeChangeFields(change: ViewerNodeChange) {
  return {
    ...(change.classification !== undefined ? { classification: change.classification } : {}),
    ...(change.hunks ? { hunks: change.hunks } : {}),
    ...(change.lineRanges ? { lineRanges: change.lineRanges } : {}),
  };
}

function buildImplementationData(repoRoot: string, statsForStage: (stage: ViewerStage) => Map<string, FileStats>, snapshot: ViewerRevision, captureGit: GitCapture) {
  const implementationRoot = path.join(repoRoot, ".semantic-review");
  const manifest = readManifest(path.join(implementationRoot, "manifest.json"));
  const specificationDocs = manifest.requirements.map((specificationId) =>
    readSpecification(path.join(implementationRoot, "requirements", `${specificationId}.json`)),
  );
  const projects = buildProjectIndex(repoRoot, captureGit);

  const stages = readViewerStages(repoRoot, manifest).map((s) => {
    const base = s.change.baseRevision;
    const head = s.change.headRevision;
    const stats = statsForStage(s);
    const previousPathByPath = new Map(
      s.change.files
        .flatMap((f) => f.previousPath ? [[f.path, f.previousPath] as const] : []),
    );

    const nodes = s.nodes.map((node) => ({
      id: node.id,
      title: humanizeId(node.id),
      description: node.description,
      changes: node.changes.map((c) => ({ path: c.path, ...nodeChangeFields(c) })),
    }));

    const membershipByPath = new Map<string | undefined, ViewerMembership[]>();
    s.nodes.forEach((node) => {
      node.changes.forEach((c) => {
        let memberships = membershipByPath.get(c.path);
        if (!memberships) membershipByPath.set(c.path, memberships = []);
        memberships.push({ nodeId: node.id, ...nodeChangeFields(c) });
      });
    });

    const files = s.change.files.map((file) => {
      const p = file.path;
      const fileStats = stats.get(p);
      const previousPath = previousPathByPath.get(p);
      return {
        path: p,
        kind: fileStats?.kind || "modified",
        baseRevision: file.baseRevision,
        previousPaths: file.previousPaths,
        ...(file.previousStageId ? { previousStageId: file.previousStageId } : {}),
        ...(previousPath !== undefined ? { previousPath } : {}),
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
      dependsOn: s.dependsOn,
      specificationRefs: s.specificationRefs,
      branch: s.change.branch,
      baseRevision: base,
      headRevision: head,
      nodes,
      files,
      insights: buildInsights(s, repoRoot),
    };
  });

  const requirements = specificationDocs.map((specification) => ({
    id: specification.id,
    title: specification.title,
    summary: specification.summary,
    source: specification.source,
    acceptance: specification.acceptanceCriteria.map((c) => ({
      id: stringField(c, "id"),
      text: stringField(c, "text"),
    })),
  }));

  const feedback = withValidationContext(() => buildFeedbackThreads(repoRoot, stages, manifest.implementationId));
  return {
    implementationId: manifest.implementationId,
    reviewId: reviewId(repoRoot, manifest.implementationId),
    remote: (() => { try { return readReview(reviewId(repoRoot, manifest.implementationId)).remote || null; } catch { return null; } })(),
    title: manifest.title,
    skillVersion: manifest.skillVersion ?? null,
    viewerReleaseVersion,
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

type ImplementationData = ReturnType<typeof buildImplementationData>;

/** Cached Git results for one stage's immutable diff range. */
interface StageRecord {
  stats: Map<string, FileStats>;
  diffs: Map<string, ParsedDiff> | null;
  stage: ViewerStage;
  pages: Map<string, Promise<DiffPage>>;
}

export function createViewerDataSource(
  repoRoot: string,
  options: { gitCapture?: GitCapture } = {},
) {
  const captureGit = options.gitCapture || gitCapture;
  const stageCache = new Map<string, StageRecord>();
  let cachedRevision = "";
  let cachedScript = "";
  let cachedData: ImplementationData | null = null;
  const snapshotReader = createSnapshotReader(repoRoot);

  const stageRecord = (stage: ViewerStage): StageRecord => {
    const key = stageDiffKey(stage);
    let record = stageCache.get(key);
    if (!record) {
      record = {
        stats: stageFileStats(repoRoot, stage, captureGit),
        diffs: null,
        stage,
        pages: new Map(),
      };
      stageCache.set(key, record);
      for (const oldest of stageCache.keys()) {
        if (stageCache.size <= 24) break;
        stageCache.delete(oldest);
      }
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

  const readStage = (stageId: string | null): ViewerStage => {
    const manifest = readManifest(manifestPath(repoRoot));
    const stage = stageId === null || !manifest.stages.includes(stageId)
      ? undefined
      : readViewerStages(repoRoot, manifest).find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    return stage;
  };

  /** The data behind the latest implementation script. */
  const implementationData = (): ImplementationData => {
    let snapshot = snapshotReader();
    // Building reads documents individually; rebuild if a write landed meanwhile.
    for (let attempt = 0; (snapshot.revision !== cachedRevision || !cachedData) && attempt < 3; attempt++) {
      const data = withValidationContext(() => buildImplementationData(
        repoRoot,
        (stage) => stageRecord(stage).stats,
        snapshot,
        captureGit,
      ));
      cachedData = data;
      cachedScript = `window.SEMANTIC_IMPLEMENTATION = ${JSON.stringify(data)};\n`;
      cachedRevision = snapshot.revision;
      snapshot = snapshotReader(true);
    }
    if (!cachedData) throw new Error("The implementation data could not be built.");
    return cachedData;
  };

  return {
    evidenceFile(stageId: string | null, itemId: string | null, index: string | null) {
      const stage = readStage(stageId);
      const item = listOf(stage.evidence).find((candidate) => isRecord(candidate) && candidate.id === itemId);
      const attachment = listOf(fieldsOf(item).attachments)[Number(index)];
      const attachmentPath = stringField(attachment, "path"), mediaType = stringField(attachment, "mediaType"), sha256 = stringField(attachment, "sha256");
      if (attachmentPath === undefined || mediaType === undefined || !evidenceMediaTypeMatches({ path: attachmentPath, mediaType })) throw new Error("Evidence attachment does not exist.");
      const { file } = resolveEvidenceFile(path.join(repoRoot, ".semantic-review"), stage.id, attachmentPath);
      const bytes = fs.readFileSync(file);
      if (sha256Hex(bytes) !== sha256) throw new Error("Evidence attachment is damaged.");
      return { mediaType, content: bytes.toString("base64") };
    },
    implementationData,
    implementationDataScript() {
      implementationData();
      return cachedScript;
    },
    snapshot: snapshotReader,
    fileContent(stageId: string | null, filePath: string | null, baseRevision: string | null, headRevision: string | null, targetPath: string | null = null) {
      const stage = readStage(stageId);
      const file = stage.change.files.find((item) => item.path === filePath);
      if (!file || file.baseRevision !== baseRevision || stage.change.headRevision !== headRevision) throw new Error("File revision changed; reload the viewer.");
      if (!/\.(md|markdown)$/i.test(file.path)) throw new Error("Preview requires a Markdown file.");
      const deleted = stageRecord(stage).stats.get(file.path)?.kind === "deleted";
      const revision = deleted ? file.baseRevision : stage.change.headRevision;
      const displayedPath = deleted ? file.previousPath || file.path : file.path;
      const resourcePath = targetPath ?? displayedPath;
      if (!resourcePath || resourcePath.includes("\\") || resourcePath.includes("\0") || resourcePath.startsWith("/") || resourcePath.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error("Invalid repository path.");
      const tree = captureGit(repoRoot, ["--literal-pathspecs", "ls-tree", "-z", revision, "--", resourcePath]);
      const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
      if (!match || match[3] !== resourcePath) throw new Error("Target unavailable at this revision.");
      const limit = 4 * 1024 * 1024;
      const size = Number(captureGit(repoRoot, ["cat-file", "-s", match[2]]));
      if (!Number.isSafeInteger(size) || size > limit) throw new Error("Preview unavailable: file exceeds 4 MiB.");
      const bytes = execFileSync("git", ["cat-file", "blob", match[2]], { cwd: repoRoot, env: reviewEnvironment(), windowsHide: true, maxBuffer: limit });
      const mediaType = imageMediaType(bytes);
      if (!mediaType && bytes.includes(0)) throw new Error("Preview unavailable for binary files.");
      return { revision, path: resourcePath, side: deleted ? "base" : "head", content: bytes.toString("base64"), mediaType: mediaType || "text/plain; charset=utf-8" };
    },
    async fileDiff(stageId: string, filePath: string, baseRevision: string, headRevision: string, mode: string = "changes", offset = 0,
      targetSide: string | null = null, targetLine: number | null = null): Promise<DiffPage> {
      if ((mode !== "changes" && mode !== "full") || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid diff page.");
      const side = targetSide === "old" || targetSide === "new" ? targetSide : null;
      if (targetSide && (!side || targetLine === null || !Number.isSafeInteger(targetLine) || targetLine < 1)) throw new Error("Invalid target line.");
      let record = [...stageCache.values()].reverse().find((record) => record.stage.id === stageId &&
        record.stage.change.headRevision === headRevision && record.stage.change.files.some((file) => file.path === filePath && file.baseRevision === baseRevision));
      if (!record) {
        const stage = readStage(stageId);
        if (!stage.change.files.some((file) => file.path === filePath)) throw new Error(`file "${filePath}" is not changed in stage "${stageId}"`);
        if (
          stage.change.files.find((file) => file.path === filePath)?.baseRevision !== baseRevision ||
          stage.change.headRevision !== headRevision
        ) {
          throw new Error(`stage "${stageId}" changed; reload the viewer`);
        }
        record = stageRecord(stage);
      }
      const current = record;
      const stage = current.stage;
      const file = stage.change.files.find((file) => file.path === filePath);
      if (!file) {
        throw new Error(`file "${filePath}" is not changed in stage "${stageId}"`);
      }
      const small = stage.change.files.length <= 40 && [...current.stats.values()].reduce((sum, stat) => sum + stat.additions + stat.deletions, 0) <= 2000;
      if (small && mode === "changes" && offset === 0 && !side) {
        try {
          if (!current.diffs) current.diffs = stageFileDiffs(repoRoot, stage, current.stats, captureGit);
          const diff = current.diffs.get(filePath);
          if (diff) return { ...diff, truncated: false, nextOffset: diff.truncated ? diff.lines.length : null, mode };
        } catch { /* An unusually wide patch uses the bounded streaming path. */ }
      }
      const key = JSON.stringify([filePath, mode, offset, side, targetLine]);
      let page = current.pages.get(key);
      if (!page) {
        page = pagedFileDiff(repoRoot, { ...stage, change: { ...stage.change, baseRevision: file.baseRevision } }, file, current.stats.get(filePath), mode, offset, side, targetLine)
          .catch((error: unknown) => { current.pages.delete(key); throw error; });
        current.pages.set(key, page);
        // Bound retained pages; in-flight consumers retain their own Promise.
        for (const oldest of current.pages.keys()) {
          if (current.pages.size <= 32) break;
          current.pages.delete(oldest);
        }
      }
      return page;
    },
  };
}

export function createImplementationDataScript(repoRoot: string) {
  return createViewerDataSource(repoRoot).implementationDataScript();
}

/** Where a file or line thread's path now is, relative to its original stage head. */
type TargetState = { state: "present" } | { state: "renamed"; path: string } | { state: "deleted" } | { state: "not-in-stage" };

// Load open and resolved feedback threads from the local feedback store. A
// thread anchor is stale when its assigned or target stage has moved.
function buildFeedbackThreads(repoRoot: string, stages: { id: string; headRevision: string }[], implementationId: string) {
  const feedbackRoot = feedbackDirectory(repoRoot, implementationId);
  const storedThreads = withReviewLock(reviewId(repoRoot, implementationId), (): Thread[] => {
    requireImplementation(repoRoot, implementationId);
    const manifestFile = path.join(feedbackRoot, "manifest.json");
    if (!fs.existsSync(manifestFile)) return [];
    const manifest = readJson(manifestFile);
    if (!isDocument(FEEDBACK_MANIFEST_SCHEMA_ID, manifest)) throw new Error("Invalid feedback manifest.");
    return manifest.threads.flatMap((id) => viewerThread(readStoredThread(path.join(feedbackRoot, "threads", `${id}.json`))) ?? []);
  });
  const currentHeads = new Map(stages.map((s) => [s.id, s.headRevision]));
  return storedThreads.map((thread) => {
    const target = thread.target;
    const currentHead = target.stageId === undefined ? undefined : currentHeads.get(target.stageId);
    let targetState: TargetState | null = null;
    if ((target.kind === "file" || target.kind === "line") && target.path && currentHead && target.stageHead) {
      if (gitPathExists(repoRoot, currentHead, target.path)) {
        targetState = { state: "present" };
      } else {
        const renamedPath = renamedPathBetween(
          repoRoot,
          target.stageHead,
          currentHead,
          target.path,
        );
        if (renamedPath && gitPathExists(repoRoot, currentHead, renamedPath)) {
          targetState = { state: "renamed", path: renamedPath };
        } else if (
          gitPathExists(repoRoot, target.stageHead, target.path)
        ) {
          targetState = { state: "deleted" };
        } else {
          targetState = { state: "not-in-stage" };
        }
      }
    }
    return {
      id: thread.id,
      status: thread.status,
      target,
      ...(targetState ? { targetState } : {}),
      comments: thread.comments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        attachments: c.attachments || [],
        createdAt: c.createdAt,
        ...(c.respondsTo ? { respondsTo: c.respondsTo } : {}),
      })),
      assignedStageId: thread.assignedStageId,
      stageHead: thread.stageHead,
      createdAt: thread.createdAt,
      resolvedAt: thread.resolvedAt || null,
      anchorStale:
        currentHeads.get(thread.assignedStageId) !== thread.stageHead ||
        Boolean(
          target.stageId &&
            currentHeads.get(target.stageId) !== target.stageHead,
        ),
    };
  });
}

const CONTENT_TYPES: Record<string, string> = {
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

function readRequestBody(request: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
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

/** A request body's fields. Bodies are untrusted: handlers narrow each field they use. */
async function readRequestFields(request: http.IncomingMessage, limit?: number): Promise<JsonRecord> {
  const payload = parseJson(await readRequestBody(request, limit));
  if (!isRecord(payload)) throw new Error("Request body must be a JSON object.");
  return payload;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

/** The implementation stages that browser notes are resolved against. */
interface FeedbackTargetStage {
  id: string;
  title?: string;
  baseRevision: string;
  headRevision: string;
  files: { path: string; revision: string }[];
  nodes: { id: string; title: string }[];
  insights: { collection: string; id?: string; title?: string }[];
}

interface FeedbackTargets {
  implementationId: string;
  stages: FeedbackTargetStage[];
}

/** review-feedback target options for one note. */
interface NoteTarget {
  "target-kind": "stage" | "node" | "file" | "line" | "insight";
  stage: string;
  label?: string;
  node?: string;
  path?: string;
  side?: string;
  line?: number;
  collection?: string;
  item?: string;
}

// Map a browser-local note (kind: stage | node | file | line) onto
// review-feedback target options. Line notes encode the diff side and line
// number in their id.
export function mapNoteTarget(note: JsonRecord, implementation: FeedbackTargets): NoteTarget {
  const noteId = stringField(note, "id") ?? "";
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
    const match = /^f:([^:]+):(.+)$/.exec(noteId);
    if (!match) throw new Error(`unrecognized file id "${note.id}"`);
    const [, stageId, filePath] = match;
    const stage = implementation.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    return { "target-kind": "file", stage: stageId, path: filePath, label: filePath };
  }
  if (note.kind === "line") {
    const match = /^l:([^:]+):(old|new):(\d+):(.+)$/.exec(noteId);
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
  if (note.kind === "insight") {
    const match = /^i:([^:]+):([^:]+):([^:]+)$/.exec(noteId);
    if (!match) throw new Error(`unrecognized insight id "${note.id}"`);
    const [, stageId, collection, item] = match;
    const insight = implementation.stages.find((s) => s.id === stageId)?.insights.find((i) => i.collection === collection && i.id === item);
    if (!insight) throw new Error(`unknown insight "${note.id}"`);
    return { "target-kind": "insight", stage: stageId, collection, item, label: insight.title };
  }
  throw new Error(`unsupported note kind "${note.kind}"`);
}

export function buildFeedbackTargetData(repoRoot: string): FeedbackTargets {
  const manifest = readManifest(manifestPath(repoRoot));
  return {
    implementationId: manifest.implementationId,
    stages: manifest.stages.map((stageId) => {
      const stage = readStageDocument(stagePath(repoRoot, stageId));
      const stats = stageFileStats(repoRoot, stage, gitCapture);
      return {
        id: stage.id,
        title: stage.title,
        baseRevision: stage.change.baseRevision,
        headRevision: stage.change.headRevision,
        files: stage.change.files.map(file => ({ path: file.path, revision: fileRevision(stage, file, stats.get(file.path)) })),
        nodes: stage.nodes.map((node) => ({
          id: node.id,
          title: humanizeId(node.id),
        })),
        insights: listOf(stage.evidence).map((item) => ({ collection: "evidence", id: stringField(item, "id"), title: stringField(item, "summary") })),
      };
    }),
  };
}

function runFeedbackCli(feedbackCli: string, context: ReviewContext, args: string[], input?: string): string {
  if (assertReviewContext(context).remote) throw new Error("Remote reviews support personal notes only.");
  return runReviewCommand(context, process.execPath, [feedbackCli, ...args], { input });
}

function feedbackContext(repoRoot: string, context: ReviewContext | null | undefined, initialize = false): ReviewContext {
  const implementation = implementationSummary(repoRoot);
  const id = reviewId(repoRoot, implementation.implementationId);
  if (context) {
    assertReviewContext(context);
    if (context.reviewId !== id) throw new Error("The feedback command belongs to another review.");
    return context;
  }
  if (initialize) registerReview(repoRoot, implementation.implementationId, implementation.title ?? "");
  return captureReviewContext(id);
}

function cliErrorMessage(error: unknown): string {
  const text = (capturedOutput(error, "stderr") || capturedOutput(error, "stdout") || stringField(error, "message") || "").toString().trim();
  const line = text.split(/\r?\n/).find((l) => l.startsWith("Error:")) || text.split(/\r?\n/)[0];
  return (line || "feedback command failed").replace(/^Error:\s*/, "");
}

// Upgrade commit-only line snapshots without moving their original anchors.
// Unavailable history stays unresolved and is conservatively rejected on export.
export function resolveLineDraftSnapshots(repoRoot: string, notes: unknown): unknown {
  if (!isList(notes)) return notes;
  return notes.map(note => {
    if (!isRecord(note) || note.kind !== "line") return note;
    const snapshot = note.snapshot;
    if (!isRecord(snapshot) || snapshot.fileRevision) return note;
    const { base, head } = snapshot;
    const match = /^l:([^:]+):(old|new):(\d+):(.+)$/.exec(stringField(note, "id") ?? "");
    if (!match || typeof base !== "string" || typeof head !== "string" || ![base, head].every(rev => /^[a-f0-9]{40,64}$/.test(rev))) return note;
    try {
      const stage = { change: { baseRevision: base, headRevision: head } };
      const stats = stageStatsFacts(JSON.stringify([repoRoot, base, head]), () => buildStageStats(repoRoot, stage));
      const fileStats = stats.get(match[4]);
      if (!fileStats) return note;
      const revision = fileRevision(stage, { path: match[4], previousPath: fileStats.previousPath }, fileStats);
      return { ...note, snapshot: { ...snapshot, fileRevision: revision } };
    } catch { return note; }
  });
}

interface SkippedNote<Ref> {
  ref: Ref;
  reason: string;
}

interface PlannedThread {
  ref: number;
  body: string;
  /** Attachment IDs as the browser sent them; review-feedback validates them. */
  attachments: unknown[];
  target: NoteTarget;
  clientId?: string;
}

/** Attachment IDs of a note or reply, as the browser sent them. */
function attachmentIdsOf(fields: JsonRecord): unknown[] {
  return isList(fields.attachments) ? fields.attachments.map((item) => fieldsOf(item).id) : [];
}

// Validate every note and resolve its target into review-feedback options.
// Pure over (notes, implementation): produces the ordered list of threads to create
// and the reasons any note was skipped, without mutating any state. Kept
// separate from the CLI mutations so a malformed payload can never leave a
// partial or orphaned draft batch behind.
export function planFeedbackThreads(notes: unknown, implementation: FeedbackTargets) {
  const skipped: SkippedNote<number>[] = [];
  const planned: PlannedThread[] = [];
  if (!isList(notes)) return { planned, skipped };
  notes.forEach((note, index) => {
    const noteRef = fieldsOf(note).ref;
    const ref = typeof noteRef === "number" && Number.isInteger(noteRef) ? noteRef : index;
    if (!note || typeof note !== "object") {
      skipped.push({ ref, reason: "not an object" });
      return;
    }
    const fields = fieldsOf(note);
    const body = typeof fields.body === "string" ? fields.body.trim() : "";
    const attachments = attachmentIdsOf(fields);
    if (!body && !attachments.length) {
      skipped.push({ ref, reason: "empty body" });
      return;
    }
    let target: NoteTarget;
    try {
      target = mapNoteTarget(fields, implementation);
      if (fields.kind === "line" && fields.snapshot) {
        const snapshot = fieldsOf(fields.snapshot);
        const stage = implementation.stages.find((stage) => stage.id === target.stage);
        const file = stage?.files?.find(file => file.path === target.path);
        const unchanged = snapshot.fileRevision
          ? file?.revision === snapshot.fileRevision
          : stage && stage.baseRevision === snapshot.base && stage.headRevision === snapshot.head;
        if (!unchanged) {
          throw new Error("The file changed since this line draft was written. Copy its text into a new note on the current diff before sending.");
        }
      }
    } catch (error) {
      skipped.push({ ref, reason: errorMessage(error) });
      return;
    }
    planned.push({ ref, body, attachments, target, ...(typeof fields.clientId === "string" ? { clientId: fields.clientId } : {}) });
  });
  return { planned, skipped };
}

/** Output of a review-feedback `--partial` batch command over `size` inputs. */
function parseBatchOutcome(output: string, size: number) {
  const value = fieldsOf(parseJson(output));
  const index = (item: unknown) => {
    const position = numberField(item, "index");
    if (position === undefined || !Number.isInteger(position) || position < 0 || position >= size) throw new Error("The feedback command returned an invalid batch result.");
    return position;
  };
  return {
    accepted: listOf(value.accepted).map(index),
    rejected: listOf(value.rejected).map((item) => ({ index: index(item), error: stringField(item, "error") ?? "" })),
  };
}

interface FeedbackCommandOptions {
  repoRoot: string;
  feedbackCli: string;
  context?: ReviewContext | null;
}

interface ExportResult {
  ok: boolean;
  error?: string;
  exported?: { ref: number; threadId: string }[];
  skipped?: SkippedNote<number>[];
}

export function exportFeedback({ repoRoot, implementation, feedbackCli, context = null }: FeedbackCommandOptions & { implementation: FeedbackTargets }, notes: unknown): ExportResult {
  const review = feedbackContext(repoRoot, context, true);
  if (assertReviewContext(review).remote) throw new Error("Remote reviews support personal notes only.");
  if (!feedbackCli) {
    return { ok: false, error: "The review-feedback CLI was not found next to the viewer." };
  }
  if (!isList(notes) || notes.length === 0) {
    return { ok: false, error: "No feedback notes to export." };
  }
  const { planned, skipped } = planFeedbackThreads(resolveLineDraftSnapshots(repoRoot, notes), implementation);
  if (planned.length === 0) {
    return { ok: false, error: "No notes could be exported.", skipped };
  }

  const manifest = path.join(feedbackDirectory(repoRoot), "manifest.json");
  if (!fs.existsSync(manifest)) {
    try { runFeedbackCli(feedbackCli, review, ["init"]); }
    catch (error) { if (!fs.existsSync(manifest)) throw error; } // Another viewer may have initialized it first.
  }
  const exportId = `viewer-${Date.now().toString(36)}`;
  const batch = planned.map((thread, index) => {
    const threadId = thread.clientId
      ? `viewer-${createHash("sha256").update(JSON.stringify([implementation.implementationId, thread.clientId, thread.target, thread.body, thread.attachments])).digest("hex").slice(0, 32)}`
      : `${exportId}-t${String(index).padStart(3, "0")}`;
    const commentId = `${threadId}-c000`;
    return {
      ref: thread.ref,
      threadId,
      input: {
        id: threadId,
        "comment-id": commentId,
        body: thread.body,
        ...(thread.attachments.length ? { attachments: thread.attachments } : {}),
        ...thread.target,
      },
    };
  });
  const result = parseBatchOutcome(runFeedbackCli(
    feedbackCli, review, ["thread", "add-batch", "--partial", "--input", "-"],
    JSON.stringify({ threads: batch.map((entry) => entry.input) }),
  ), batch.length);
  const exported = result.accepted.map((index) => ({ ref: batch[index].ref, threadId: batch[index].threadId }));
  for (const { index, error } of result.rejected) skipped.push({ ref: batch[index].ref, reason: error });
  return { ok: exported.length > 0, exported, skipped, ...(exported.length ? {} : { error: "No notes could be exported." }) };

}

interface ReplyOutcome {
  ref: string;
  threadId: string;
  comment?: Thread["comments"][number];
  status?: Thread["status"];
  resolvedAt: string | null;
}

interface ReplyResult {
  ok: boolean;
  error?: string;
  replied?: ReplyOutcome[];
  skipped?: SkippedNote<string>[];
}

export function exportFeedbackReplies({ repoRoot, feedbackCli, context = null }: FeedbackCommandOptions, drafts: unknown): ReplyResult {
  const review = feedbackContext(repoRoot, context);
  if (assertReviewContext(review).remote) throw new Error("Remote reviews support personal notes only.");
  if (!feedbackCli) {
    return { ok: false, error: "The review-feedback CLI was not found next to the viewer." };
  }
  if (!isList(drafts) || drafts.length === 0) {
    return { ok: false, error: "No feedback replies to export." };
  }
  const skipped: SkippedNote<string>[] = [];
  const batch: { ref: string; threadId: string; commentId: string; input: JsonRecord }[] = [];
  drafts.forEach((draft, index) => {
    const fields = fieldsOf(draft);
    const ref = typeof fields.ref === "string" ? fields.ref : String(index);
    const threadId = typeof fields.threadId === "string" ? fields.threadId : "";
    const body = typeof fields.body === "string" ? fields.body.trim() : "";
    if (!threadId) {
      skipped.push({ ref, reason: "thread no longer exists" });
      return;
    }
    const attachments = attachmentIdsOf(fields);
    if (!body && !attachments.length) {
      skipped.push({ ref, reason: "empty body" });
      return;
    }
    const commentId = `reply-${createHash("sha256").update(JSON.stringify([threadId, ref, body, attachments])).digest("hex").slice(0, 32)}`;
    batch.push({
      ref,
      threadId,
      commentId,
      input: {
        id: threadId,
        "comment-id": commentId,
        author: "user",
        body,
        ...(attachments.length ? { attachments } : {}),
      },
    });
  });
  if (batch.length === 0) {
    return { ok: false, error: "No feedback replies could be exported.", skipped };
  }

  const resultFor = (entry: (typeof batch)[number]): ReplyOutcome => {
    const thread = readFeedbackThread(repoRoot, entry.threadId);
    return {
      ref: entry.ref,
      threadId: entry.threadId,
      comment: thread?.comments.find((comment) => comment.id === entry.commentId),
      status: thread?.status,
      resolvedAt: thread?.resolvedAt || null,
    };
  };

  const result = parseBatchOutcome(runFeedbackCli(
    feedbackCli, review, ["thread", "reply-batch", "--partial", "--input", "-"],
    JSON.stringify({ replies: batch.map((entry) => entry.input) }),
  ), batch.length);
  const replied = result.accepted.map((index) => resultFor(batch[index]));
  for (const { index, error } of result.rejected) skipped.push({ ref: batch[index].ref, reason: error });
  return { ok: replied.length > 0, replied, skipped, ...(replied.length ? {} : { error: "No replies could be exported." }) };

}

/** One viewer send. Listening agents wait until its notes and replies are both written. */
export function sendFeedback({ repoRoot, implementation = null, feedbackCli, context = null }: FeedbackCommandOptions & { implementation?: FeedbackTargets | null }, notes: unknown, replies: unknown) {
  const hasNotes = isList(notes) && notes.length > 0;
  const hasReplies = isList(replies) && replies.length > 0;
  if (!hasNotes && !hasReplies) return { ok: false, error: "No feedback to send." };
  const review = feedbackContext(repoRoot, context, hasNotes);
  const token = randomUUID();
  updateAgentState(review.reviewId, (state, now) => markSending(state, now, token, true));
  try {
    const sent: ExportResult | null = hasNotes ? exportFeedback({ repoRoot, implementation: implementation || buildFeedbackTargetData(repoRoot), feedbackCli, context: review }, notes) : null;
    const answered: ReplyResult | null = hasReplies ? exportFeedbackReplies({ repoRoot, feedbackCli, context: review }, replies) : null;
    const ok = Boolean(sent?.ok || answered?.ok);
    return {
      ok,
      exported: sent?.exported || [], skipped: sent?.skipped || [],
      replied: answered?.replied || [], replySkipped: answered?.skipped || [],
      ...(ok ? {} : { error: sent?.error || answered?.error || "Nothing could be sent." }),
    };
  } finally {
    updateAgentState(review.reviewId, (state, now) => markSending(state, now, token, false));
  }
}

/** Reviewer controls for the listening agent. */
export function controlAgent(context: Pick<ReviewContext, "reviewId">, action: string, payload: unknown) {
  return updateAgentState(context.reviewId, (state, now) => {
    if (action === "stop") {
      const session = liveSession(state);
      if (session && !session.stopRequestedAt) session.stopRequestedAt = new Date(now).toISOString();
    } else {
      const { body: text, requestId } = fieldsOf(payload);
      const body = typeof text === "string" ? text.trim() : "";
      if (typeof requestId !== "string" || !body || body.length > 4000) throw new Error("Write an answer of up to 4000 characters.");
      respondToRequest(state, now, requestId, body);
    }
    return agentStatus(state, now);
  });
}

// Reject cross-origin drivers. A local page served by this server has no
// Origin (same-origin fetch) or an Origin matching our own host; a third-party
// web page attempting a request will carry a foreign Origin. Combined with the
// required application/json content type (which forces a CORS preflight this
// server never approves), this blocks drive-by requests from other sites.
function isTrustedRequest(request: http.IncomingMessage, port: number) {
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

/** What the HTTP handlers need from the server for one feedback request. */
interface FeedbackRequestContext {
  repoRoot: string;
  feedbackCli: string;
  jobs: ViewerWorker;
  port: number;
}

async function handleFeedbackExport(request: http.IncomingMessage, response: http.ServerResponse, context: FeedbackRequestContext) {
  try {
    if (!isTrustedRequest(request, context.port)) {
      sendJson(response, 403, {
        ok: false,
        error: "Feedback export requires a same-origin application/json request.",
      });
      return;
    }
    const raw = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = parseJson(raw || "{}");
    } catch {
      sendJson(response, 400, { ok: false, error: "Request body must be JSON." });
      return;
    }
    if (!isRecord(payload)) {
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
    const result = workerRecord(await context.jobs.call("sendFeedback", [payload.implementationId, payload.notes, payload.replies]));
    sendJson(response, result.ok ? 200 : 422, {
      ...result,
      ...workerRecord(await context.jobs.call("snapshot", [true])),
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

export function readFeedbackThread(repoRoot: string, threadId: string): Thread | null {
  const feedbackRoot = feedbackDirectory(repoRoot);
  const manifestPath = path.join(feedbackRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = readJson(manifestPath);
  if (!isDocument(FEEDBACK_MANIFEST_SCHEMA_ID, manifest)) {
    throw new Error(
      "this feedback workspace uses an unsupported v0.1 layout",
    );
  }
  if (manifest.threads.includes(threadId)) {
    const file = path.join(feedbackRoot, "threads", `${threadId}.json`);
    return parseDocument(THREAD_SCHEMA_ID, readJson(file), file);
  }
  return null;
}

// Reviewer-driven thread actions: continue (reply), close (resolve), or reopen.
// Closure is always the reviewer's decision — the agent only ever replies.
async function handleThreadAction(request: http.IncomingMessage, response: http.ServerResponse, context: FeedbackRequestContext & { implementationId: string }, action: string) {
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
    let payload: unknown;
    try {
      payload = parseJson(raw || "{}");
    } catch {
      sendJson(response, 400, { ok: false, error: "Request body must be JSON." });
      return;
    }
    const currentImplementationId = activeImplementationId(context.repoRoot);
    if (
      !isRecord(payload) ||
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
        const result = workerRecord(await context.jobs.call("exportFeedbackReplies", [context.implementationId, [{
          ref: payload.clientId || createHash("sha256").update(JSON.stringify([threadId, payload.body, payload.attachments])).digest("hex"),
          threadId, body: payload.body, attachments: payload.attachments,
        }]]));
        if (!result.ok) throw new Error(stringField(result, "error") || stringField(listOf(result.skipped)[0], "reason") || "Reply could not be sent.");
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
      ...workerRecord(await context.jobs.call("snapshot", [true])),
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: cliErrorMessage(error) });
  }
}

/** The approved file as the browser last saw it; fails when it changed since. */
function approvedFileEndpoint(input: unknown, data: ImplementationData): FileEndpoint {
  const { stageId, path: filePath, nodeId, fileRevision, ownership: shownOwnership } = fieldsOf(input);
  const stage = data.stages.find((stage) => stage.id === stageId);
  const file = stage?.files.find((file) => file.path === filePath);
  const ownership = file?.memberships.find((membership) => membership.nodeId === nodeId);
  if (!stage || !file || !ownership) throw new Error("This file review no longer exists. Refresh the viewer.");
  if (file.revision !== fileRevision || !isDeepStrictEqual(ownership, shownOwnership)) throw new Error("The file or its ownership changed. Refresh the viewer before approving or comparing it.");
  return { stageId: stage.id, nodeId: ownership.nodeId, path: file.path, previousPath: file.previousPath, previousPaths: file.previousPaths,
    baseRevision: file.baseRevision, headRevision: stage.headRevision, fileRevision: file.revision, ownership };
}

export function registeredReviews() {
  return [...listReviews().map((record) => {
    let unavailableReason = "";
    try { captureReviewContext(record.id); } catch (error) { unavailableReason = cliErrorMessage(error); }
    const { id, generation, title, implementationId, repositoryRoot, createdAt, updatedAt, completedAt, remote } = record;
    return { id, generation, title, implementationId, repositoryRoot, createdAt, updatedAt, completedAt, remote, available: !unavailableReason, unavailableReason };
  }), ...pendingReviewDeletions()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Reopen using a registry identity, with no caller-supplied path or command. */
export async function openRegisteredReview(id: string, generation: string): Promise<string> {
  const context = captureReviewContext(id);
  if (context.generation !== generation) throw new Error("The selected review was replaced. Refresh the review list.");
  const child = spawnReviewCommand(context, process.execPath, [fileURLToPath(import.meta.url), "review", context.repositoryRoot], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], environment: { SEMANTIC_VIEW_NO_OPEN: "1" },
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("The review service did not start within 15 seconds.")); }, 15_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`The review service exited before opening (${code}).`)));
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        const url = stringField(message, "url");
        if (stringField(message, "type") !== "ready" || stringField(message, "reviewId") !== id || url === undefined) {
          child.kill(); reject(new Error(stringField(message, "message") || "Invalid review service startup response."));
        } else resolve(url);
      });
    });
  } finally { child.unref(); }
}

export function reviewSessionUnavailable(context: ReviewContext) {
  try { return readReview(context.reviewId).generation !== context.generation; }
  catch (error) { return errorCode(error) === "REVIEW_UNAVAILABLE"; }
}
/** Poll directory identity cheaply; retry transient failures before accepting a baseline. */
export function reviewRetirementCheck(context: ReviewContext) {
  const directory = reviewDirectory(context.reviewId);
  const identity = () => { const stat = fs.statSync(directory, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; };
  let original: string | null | undefined;
  try { original = identity(); } catch (error) { if (errorCode(error) === "ENOENT") original = null; }
  return () => {
    if (fs.existsSync(reviewDeletionPath(context.reviewId, context.generation))) return true;
    let current: string;
    try { current = identity(); } catch (error) { return errorCode(error) === "ENOENT"; }
    if (original === null) return true;
    if (original === undefined) {
      // A new generation may have appeared while the initial identity was unreadable.
      try { if (readReview(context.reviewId).generation !== context.generation) return true; }
      catch (error) { return errorCode(error) === "REVIEW_UNAVAILABLE"; }
      original = current;
    }
    return current !== original;
  };
}
interface ViewerServerOptions {
  viewerDir: string;
  port: number;
  repoRoot: string;
  feedbackCli: string;
  implementationId: string;
  dataSource: ViewerWorker;
  viewerVersion: string;
  context: ReviewContext;
}

function serveViewer({
  viewerDir,
  port,
  repoRoot,
  feedbackCli,
  implementationId,
  dataSource,
  viewerVersion,
  context,
}: ViewerServerOptions): Promise<http.Server> {
  const review = assertReviewContext(context);
  let server: http.Server | null = null;
  let management: ViewerWorker | null = null;
  const manage = (method: string, args: unknown[]) => {
    if (!management?.healthy) management = createViewerWorker(repoRoot, context, true);
    return management.call(method, args);
  };
  const requestHandler = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${VIEWER_HOST}`);
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // Every review API request is explicitly scoped, even on a dedicated server.
    // Management/probing routes do not execute commands against the launch repo.
    if (pathname.startsWith("/api/") && !["/api/whoami", "/api/shutdown"].includes(pathname)) {
      if ((url.searchParams.get("review") !== context.reviewId || url.searchParams.get("generation") !== context.generation)) {
        sendJson(response, 409, { ok: false, error: "This request belongs to another review." }); return;
      }
      try { if (!pathname.startsWith("/api/reviews") && pathname !== "/api/review-state") assertReviewContext(context); }
      catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error), reviewUnavailable: reviewSessionUnavailable(context) }); return; }
    }

    if (review.remote && (pathname.startsWith("/api/feedback/") || pathname.startsWith("/api/agent/"))) {
      sendJson(response, 403, { ok: false, error: "Remote reviews support personal notes only." }); return;
    }
    if (pathname === "/api/remote/refresh" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Refreshing requires a same-origin request.");
        await dataSource.call("refreshRemote", [implementationId]);
        sendJson(response, 200, { ok: true });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (pathname === "/api/attachments" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Uploading requires a same-origin request.");
        const { data, filename, mediaType } = await readRequestFields(request, 29 * 1024 * 1024);
        if (typeof data !== "string" || data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || Buffer.from(data, "base64").toString("base64") !== data) throw new Error("Invalid attachment bytes or file larger than 20 MiB.");
        // storeAttachment rejects a name that is not a string; a missing type means the default.
        const type = typeof mediaType === "string" ? mediaType : mediaType ? undefined : "";
        if (type === undefined) throw new Error("Invalid attachment media type.");
        const attachment = withReviewLock(context.reviewId, () => storeAttachment(context.reviewId, context.generation, typeof filename === "string" ? filename : "", type, Buffer.from(data, "base64")));
        sendJson(response, 200, { ok: true, attachment });
      } catch (error) { sendJson(response, 400, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }
    if (pathname.startsWith("/api/attachments/") && request.method === "GET") {
      try {
        const { attachment, bytes } = withReviewLock(context.reviewId, () => {
          if (readReview(context.reviewId).generation !== context.generation) throw new Error("The review session was replaced or deleted.");
          const attachment = resolveAttachment(context.reviewId, pathname.slice("/api/attachments/".length));
          const bytes = fs.readFileSync(attachment.localPath);
          if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("Attachment content is damaged.");
          return { attachment, bytes };
        });
        const preview = url.searchParams.get("preview") === "1" && imageMediaType(bytes);
        response.writeHead(200, { "content-type": preview || "application/octet-stream", "content-length": bytes.length,
          "content-disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" });
        response.end(bytes);
      } catch (error) { sendJson(response, 404, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/draft-snapshots") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Draft snapshots require a same-origin request.");
        const payload = await readRequestFields(request);
        const notes = await dataSource.call("resolveLineDraftSnapshots", [implementationId, payload.notes]);
        if (!isList(notes)) throw new Error("Draft snapshots require a list of notes.");
        sendJson(response, 200, { ok: true, snapshots: notes.map(note => fieldsOf(note).snapshot || null) });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "POST" && ["/api/approval-snapshots", "/api/approval-comparison"].includes(pathname)) {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Approval snapshots require a same-origin request.");
        const payload = await readRequestFields(request);
        const method = pathname === "/api/approval-snapshots" ? "captureApproval" : "compareApproval";
        sendJson(response, 200, { ok: true, ...workerRecord(await dataSource.call(method, [implementationId, payload])) });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "POST" && ["/api/reviews/storage", "/api/reviews/delete", "/api/reviews/clean-unused"].includes(pathname)) {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Managing review data requires a same-origin request.");
        const payload = await readRequestFields(request);
        if (pathname === "/api/reviews/storage") sendJson(response, 200, { ok: true, storage: await manage("inspectStorage", [payload.reviewId, payload.generation]) });
        else if (pathname === "/api/reviews/delete") sendJson(response, 200, { ok: true, ...workerRecord(await manage("deleteStorage", [payload.reviewId, payload.generation, payload.fingerprint])) });
        else sendJson(response, 200, { ok: true, ...workerRecord(await manage("cleanStorage", [payload.reviewId, payload.generation, payload.fingerprint])) });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/reviews") {
      try { sendJson(response, 200, { ok: true, reviews: await manage("listReviews", []) }); }
      catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }
    if (request.method === "POST" && pathname === "/api/reviews/completion") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Changing completion requires a same-origin request.");
        const payload = await readRequestFields(request);
        await manage("setCompleted", [payload.reviewId, payload.generation, payload.completed, payload.expectedCompletedAt]);
        sendJson(response, 200, { ok: true });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/reviews/open") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Opening a review requires a same-origin request.");
        const payload = await readRequestFields(request);
        // Identities of another type fail the registry's own identity checks.
        sendJson(response, 200, { ok: true, url: await openRegisteredReview(stringField(payload, "reviewId") ?? "", stringField(payload, "generation") ?? "") });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (pathname === "/api/review-state") {
      try {
        let result: unknown;
        if (request.method === "GET") result = await dataSource.call("readReview", [implementationId, review.id]);
        else if (request.method === "POST" && isTrustedRequest(request, port)) {
          const payload = await readRequestFields(request);
          if (payload.reviewId !== review.id) throw new Error("This request belongs to another review.");
          result = await dataSource.call("patchReviewState", [implementationId, review.id, payload.generation, payload.changes]);
        } else { sendJson(response, 403, { ok: false, error: "Review state requires a same-origin request." }); return; }
        const record = workerRecord(result);
        sendJson(response, 200, { ok: true, reviewId: record.id, generation: record.generation, state: record.state });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error), reviewUnavailable: reviewSessionUnavailable(context) }); }
      return;
    }

    if (request.method === "POST" && ["/api/agent/stop", "/api/agent/respond"].includes(pathname)) {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Agent controls require a same-origin request.");
        const payload = await readRequestFields(request);
        sendJson(response, 200, { ok: true, agent: await dataSource.call("controlAgent", [implementationId, pathname.slice("/api/agent/".length), payload]) });
      } catch (error) { sendJson(response, 409, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/whoami") {
      sendJson(response, 200, {
        ok: true,
        app: VIEWER_APP_ID,
        implementationId,
        repositoryRoot: repoRoot,
        reviewId: context.reviewId,
        generation: context.generation,
        reviewHome: reviewHome(),
        port,
        skillDirectory: path.resolve(scriptDir, ".."),
        processId: process.pid,
        viewerVersion,
        viewerReleaseVersion,
        healthy: dataSource.healthy,
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/revision") {
      try {
        sendJson(response, 200, {
          ok: true,
          ...workerRecord(await dataSource.call("snapshot", [])),
        });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: cliErrorMessage(error),
        });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/evidence") {
      try {
        const result = workerRecord(await dataSource.call("evidenceFile", [url.searchParams.get("stage"), url.searchParams.get("item"), url.searchParams.get("index")]));
        const bytes = Buffer.from(workerString(result, "content"), "base64");
        const headers = { "content-type": workerString(result, "mediaType"), "accept-ranges": "bytes", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "no-store" };
        // Safari refuses to play video from a server without range support.
        const range = evidenceRange(request.headers.range, bytes.length);
        if (!range) {
          response.writeHead(200, { ...headers, "content-length": bytes.length });
          response.end(bytes);
          return;
        }
        if (range === "unsatisfiable") {
          response.writeHead(416, { ...headers, "content-range": `bytes */${bytes.length}` });
          response.end();
          return;
        }
        const { start, end } = range;
        response.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${bytes.length}` });
        response.end(bytes.subarray(start, end + 1));
      } catch (error) { sendJson(response, 404, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/file-content") {
      try {
        const result = workerRecord(await dataSource.call("fileContent", [url.searchParams.get("stage"), url.searchParams.get("path"), url.searchParams.get("base"), url.searchParams.get("head"), url.searchParams.get("target")]));
        const mediaType = workerString(result, "mediaType"), content = Buffer.from(workerString(result, "content"), "base64");
        if (url.searchParams.get("raw") === "1") {
          if (url.searchParams.get("image") === "1" && !mediaType.startsWith("image/")) throw new Error("Image unavailable at this revision.");
          response.writeHead(200, { "content-type": mediaType, "content-length": content.length, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "no-store" });
          response.end(content);
        } else sendJson(response, 200, { ok: true, ...result, content: content.toString("utf8") });
      } catch (error) { sendJson(response, 422, { ok: false, error: cliErrorMessage(error) }); }
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
          ...workerRecord(await dataSource.call("fileDiff", [stageId, filePath, baseRevision, headRevision,
            url.searchParams.get("mode") || "changes", Number(url.searchParams.get("offset") || 0),
            url.searchParams.get("side"), url.searchParams.has("line") ? Number(url.searchParams.get("line")) : null])),
        });
      } catch (error) {
        sendJson(response, 422, {
          ok: false,
          error: cliErrorMessage(error),
        });
      }
      return;
    }

    // Controlled lifecycle shutdown; launching another review never uses this.
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

    if (
      request.method === "POST" &&
      ["/api/feedback/reply", "/api/feedback/resolve", "/api/feedback/reopen"].includes(pathname)
    ) {
      const action = pathname.split("/").at(-1) ?? "";
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
        const script = workerText(await dataSource.call("implementationDataScript", []));
        const payload = parseJson(script.slice("window.SEMANTIC_IMPLEMENTATION = ".length).trim().replace(/;$/, ""));
        sendJson(response, 200, { ok: true, implementation: payload });
      } catch (error) { sendJson(response, 500, { ok: false, error: cliErrorMessage(error) }); }
      return;
    }

    if (pathname === "/implementation-data.js") {
      let script: string;
      try { script = workerText(await dataSource.call("implementationDataScript", [])); }
      catch (error) {
        const code = errorCode(error);
        if (code !== "REVIEW_UNAVAILABLE" && code !== "REVIEW_TARGET_UNAVAILABLE" && !reviewSessionUnavailable(context)) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          response.end(cliErrorMessage(error)); return;
        }
        // The saved-review manager remains usable after deletion or worktree removal.
        script = `window.SEMANTIC_IMPLEMENTATION = ${JSON.stringify({ implementationId, reviewId: context.reviewId, title: review.title, viewerReleaseVersion,
          summary: cliErrorMessage(error), stages: [], requirements: [], feedback: [], baseRevision: "", targetBranch: "" })};`;
      }
      const body = Buffer.from(script + `\nwindow.SEMANTIC_REVIEW_CONTEXT = ${JSON.stringify({ reviewId: context.reviewId, generation: context.generation })};\n`, "utf8");
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
      response.end(body); return;
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

  const httpServer = http.createServer(requestHandler);
  server = httpServer;
  httpServer.once("close", () => { if (management) void management.close(); });
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, VIEWER_HOST, () => {
      const shouldRetire = reviewRetirementCheck(context);
      const retirement = setInterval(() => {
        if (shouldRetire()) {
          clearInterval(retirement); review.state = {}; void dataSource.close();
        }
      }, 1000);
      retirement.unref(); httpServer.once("close", () => clearInterval(retirement));
      resolve(httpServer);
    });
  });
}

/** A worker result that must be an object. Results cross a structured-clone
 * boundary, so the main thread narrows what it reads from them. */
function workerRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("The viewer worker returned an invalid result.");
  return value;
}

function workerText(value: unknown): string {
  if (typeof value !== "string") throw new Error("The viewer worker returned an invalid result.");
  return value;
}

function workerString(result: JsonRecord, key: string): string {
  return workerText(result[key]);
}

function createViewerWorker(repoRoot: string, context: ReviewContext, management = false) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { repoRoot, context, management } });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const reads = new Map<string, Promise<unknown>>();
  let sequence = 0;
  let stopped = false;
  const rejectAll = (error: unknown) => {
    stopped = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear(); reads.clear();
  };
  worker.on("error", rejectAll);
  worker.on("exit", () => rejectAll(new Error("Viewer worker stopped; reopen the viewer.")));
  worker.on("message", (message: unknown) => {
    const { id, result, error, code } = fieldsOf(message);
    const request = typeof id === "number" ? pending.get(id) : undefined;
    if (!request || typeof id !== "number") return;
    pending.delete(id);
    if (error) request.reject(Object.assign(new Error(String(error)), { code })); else request.resolve(result);
  });
  return {
    get healthy() { return !stopped; },
    call(method: string, args: unknown[]): Promise<unknown> {
      if (stopped) return Promise.reject(new Error("Viewer worker is unavailable; reopen the viewer."));
      const key = ["snapshot", "fileDiff", "fileContent", "implementationDataScript"].includes(method) ? JSON.stringify([method, args]) : null;
      const shared = key ? reads.get(key) : undefined;
      if (shared) return shared;
      if (pending.size >= 64) return Promise.reject(new Error("Viewer is busy; retry after the current requests finish."));
      const id = ++sequence;
      const promise = new Promise<unknown>((resolve, reject) => {
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

type ViewerWorker = ReturnType<typeof createViewerWorker>;

// --- Worker side. Jobs arrive from this module's own main thread, but every
// argument is narrowed: most originate in HTTP request bodies or query strings.

/** The string argument at index; any other value becomes "", which every job rejects as invalid. */
function textArg(args: unknown[], index: number): string {
  const value = args[index];
  return typeof value === "string" ? value : "";
}

/** A query-string argument, which is absent (null) when not given. */
function queryArg(args: unknown[], index: number): string | null {
  const value = args[index];
  return typeof value === "string" ? value : null;
}

function stateValue(value: unknown): StateChange["before"] {
  if (!isRecord(value) || typeof value.present !== "boolean") throw new Error("Invalid state change value.");
  return Object.hasOwn(value, "value") ? { present: value.present, value: value.value } : { present: value.present };
}

/** Review state changes from the browser. patchReviewState checks their limits
 * and keys; this establishes their shape, with the same messages. */
function parseStateChanges(value: unknown): StateChange[] {
  if (!isList(value)) throw new Error("Invalid state changes.");
  return value.map((item) => {
    const { path: keys, before, after } = fieldsOf(item);
    if (!isStringArray(keys)) throw new Error("Invalid state change path.");
    return { path: keys, before: stateValue(before), after: stateValue(after) };
  });
}

function parseWorkerContext(value: unknown): ReviewContext {
  const reviewId = stringField(value, "reviewId"), generation = stringField(value, "generation");
  const repositoryRoot = stringField(value, "repositoryRoot"), implementationId = stringField(value, "implementationId");
  if (reviewId === undefined || generation === undefined || repositoryRoot === undefined || implementationId === undefined) {
    throw new Error("The viewer worker started without a review context.");
  }
  return Object.freeze({ reviewId, generation, repositoryRoot, implementationId });
}

// Management survives retirement of the launching review. Every job uses
// its explicitly selected target; no repository command is allowed here.
function runManagementJob(method: unknown, args: unknown[]) {
  if (method === "inspectStorage") return inspectReviewStorage(textArg(args, 0), textArg(args, 1));
  if (method === "deleteStorage") return deleteReviewData(textArg(args, 0), textArg(args, 1), textArg(args, 2));
  if (method === "cleanStorage") return cleanUnusedReviewFiles(textArg(args, 0), textArg(args, 1), textArg(args, 2));
  if (method === "listReviews") return registeredReviews();
  if (method === "setCompleted") {
    const [, , completed, expectedCompletedAt] = args;
    const expected = expectedCompletedAt === null ? null : typeof expectedCompletedAt === "string" ? expectedCompletedAt : undefined;
    if (typeof completed !== "boolean" || expected === undefined) throw new Error("Invalid review lifecycle change.");
    return setReviewCompleted(textArg(args, 0), textArg(args, 1), completed, expected);
  }
  throw new Error("Unknown review management operation.");
}

async function runViewerJob(root: string, context: ReviewContext, source: ReturnType<typeof createViewerDataSource>, feedbackCli: string, method: unknown, args: unknown[]): Promise<unknown> {
  const localState = method === "readReview" || method === "patchReviewState";
  // A state read returns the same record whose generation it checked.
  const record = localState ? readReview(context.reviewId) : undefined;
  if (record) {
    if (args[1] !== context.reviewId || record.generation !== context.generation) throw new Error("The review session was replaced or deleted.");
  } else assertReviewContext(context); // Includes queued repository reads and commands.
  if (method === "readReview") return record;
  if (method === "patchReviewState") return patchReviewState(context.reviewId, textArg(args, 2), parseStateChanges(args[3]));
  if (method === "snapshot") return { ...source.snapshot(args[0] === true), agent: agentStatus(readAgentState(context.reviewId), Date.now()) };
  if (method === "fileDiff") {
    const [, , , , mode, offset, , line] = args;
    return source.fileDiff(textArg(args, 0), textArg(args, 1), textArg(args, 2), textArg(args, 3), typeof mode === "string" ? mode : "",
      typeof offset === "number" ? offset : NaN, queryArg(args, 6), typeof line === "number" ? line : null);
  }
  if (method === "fileContent") return source.fileContent(queryArg(args, 0), queryArg(args, 1), queryArg(args, 2), queryArg(args, 3), queryArg(args, 4));
  if (method === "implementationDataScript") return source.implementationDataScript();
  if (method === "evidenceFile") return source.evidenceFile(queryArg(args, 0), queryArg(args, 1), queryArg(args, 2));
  if (activeImplementationId(root) !== args[0]) throw new Error("The active implementation changed; reopen the viewer.");
  if (method === "refreshRemote") return refreshRemoteReview(context.reviewId, context.generation);
  if (method === "resolveLineDraftSnapshots") return resolveLineDraftSnapshots(root, args[1]);
  if (method === "captureApproval") return captureApprovalSnapshot(context, approvedFileEndpoint(args[1], source.implementationData()));
  if (method === "compareApproval") {
    const input = fieldsOf(args[1]);
    const snapshotId = stringField(input, "snapshotId") ?? "", offset = input.offset || 0, mode = input.mode ?? "changes", scope = input.scope ?? "stage";
    // Values of the wrong type fail compareApprovalSnapshot's own checks.
    return compareApprovalSnapshot(context, snapshotId, approvedFileEndpoint(input, source.implementationData()),
      typeof offset === "number" ? offset : NaN, typeof mode === "string" ? mode : "", typeof scope === "string" ? scope : "");
  }
  if (method === "sendFeedback") return sendFeedback({ repoRoot: root, feedbackCli, context }, args[1], args[2]);
  if (method === "controlAgent") return controlAgent(context, textArg(args, 1), args[2]);
  if (method === "exportFeedbackReplies") return exportFeedbackReplies({ repoRoot: root, feedbackCli, context }, args[1]);
  if (method === "feedbackCli") {
    const commandArgs = args[1];
    if (!isStringArray(commandArgs)) throw new Error("Invalid feedback command.");
    return runFeedbackCli(feedbackCli, context, commandArgs);
  }
  throw new Error("Unknown viewer operation.");
}

function serveWorkerJobs(port: MessagePort, root: string, context: ReviewContext, management: boolean) {
  const source = management ? null : createViewerDataSource(root);
  const feedbackCli = locateFeedbackCli();
  port.on("message", async (message: unknown) => {
    const { id, method, args } = fieldsOf(message);
    try {
      const result = source ? await runViewerJob(root, context, source, feedbackCli, method, listOf(args)) : runManagementJob(method, listOf(args));
      port.postMessage({ id, result });
    } catch (error) { port.postMessage({ id, error: cliErrorMessage(error), code: errorCode(error) }); }
  });
}

const startup: unknown = workerData;
if (!isMainThread && parentPort && isRecord(startup) && typeof startup.repoRoot === "string" && startup.repoRoot) {
  serveWorkerJobs(parentPort, startup.repoRoot, parseWorkerContext(startup.context), Boolean(startup.management));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url: string) {
  if (process.env.SEMANTIC_VIEW_NO_OPEN) return;
  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore", windowsHide: true });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore", windowsHide: true });
    }
  } catch {
    // Non-fatal: the URL is printed for manual use.
  }
}

function implementationSummary(repoRoot: string) {
  const manifest = readManifest(manifestPath(repoRoot));
  const fileCount = manifest.stages.reduce((total, stageId) => {
    const stage = readStageDocument(stagePath(repoRoot, stageId));
    return total + stage.change.files.length;
  }, 0);
  return {
    implementationId: manifest.implementationId,
    title: manifest.title,
    stageCount: manifest.stages.length,
    fileCount,
  };
}

function notifyLauncher(message: object) {
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
  const registered = process.env.SEMANTIC_FLOW_REVIEW_ID
    ? readReview(process.env.SEMANTIC_FLOW_REVIEW_ID)
    : registerReview(repoRoot, implementation.implementationId, implementation.title ?? "");
  const context = captureReviewContext(registered.id);
  if (process.env.SEMANTIC_FLOW_REVIEW_ID && (reviewId(repoRoot, implementation.implementationId) !== context.reviewId || process.env.SEMANTIC_FLOW_REVIEW_ID !== context.reviewId || process.env.SEMANTIC_FLOW_REVIEW_GENERATION !== context.generation)) throw new Error("The requested review session changed before startup.");
  const dataSource = createViewerWorker(repoRoot, context);
  startupWorker = dataSource;
  const feedbackCli = locateFeedbackCli();
  const fingerprint = createHash("sha256");
  fingerprint.update(viewerReleaseVersion);
  for (const file of [fileURLToPath(import.meta.url), feedbackCli, ...["app.js", "markdown.js", "styles.css", "index.html"].map((name) => path.join(viewerDir, name))].filter(Boolean)) {
    fingerprint.update(fs.readFileSync(file));
  }
  const viewerVersion = fingerprint.digest("hex");

  let port = registered.viewer?.port || viewerPort();
  let server: http.Server | null = null;
  const fallback = 20000 + (Number.parseInt(context.reviewId.slice(-64, -56), 16) % 40000);
  const matching = (occupant: ViewerIdentity | null): occupant is ViewerIdentity => occupant !== null && occupant.reviewId === context.reviewId && occupant.generation === context.generation && occupant.reviewHome === reviewHome() && occupant.repositoryRoot === context.repositoryRoot;
  for (let attempt = 0; attempt < 40 && !server; attempt++) {
    try {
      server = await serveViewer({ viewerDir, port, repoRoot, feedbackCli, implementationId: implementation.implementationId, dataSource, viewerVersion, context });
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(errorCode(error) ?? "")) throw error;
      const occupant = await probeViewer(port);
      if (matching(occupant) && occupant.healthy !== false && occupant.viewerVersion === viewerVersion) {
        await dataSource.close();
        const url = `http://${VIEWER_HOST}:${port}/`;
        notifyLauncher({ type: "ready", url, repositoryRoot: repoRoot, reviewId: context.reviewId, processId: occupant.processId, implementation, feedbackEnabled: Boolean(feedbackCli) });
        console.log(`Reusing semantic review viewer: ${url}`);
        openBrowser(url); return;
      }
      if (process.env.SEMANTIC_VIEW_NO_REPLACE) throw new Error(`Port ${port} was occupied before the updated viewer could restart; refusing to replace it.`);
      if (matching(occupant)) {
        await stopViewerAndWait(occupant, port);
      } else {
        // A different review (or another application) keeps its port. Stable
        // fallback candidates also let concurrent launches of this review meet.
        // Windows reserves contiguous port ranges: spread retries across the
        // range instead of exhausting all attempts in the same reserved block.
        port = ((fallback - 20000 + attempt * 9973) % 40000) + 20000;
      }
    }
  }
  if (!server) throw new Error("No viewer port could be allocated. Try launching the review again.");
  recordViewer(context.reviewId, context.generation, { port, processId: process.pid, viewerVersion, skillDirectory: path.resolve(scriptDir, "..") });
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
    reviewId: context.reviewId,
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
    notifyLauncher({ type: "error", message: errorMessage(error) });
    if (process.exitCode === undefined || process.exitCode === 0) {
      console.error(`semantic-view: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  });
}
