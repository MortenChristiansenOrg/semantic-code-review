import { resolveCodeTarget } from "./shared/insight-targets.js";
import { locateLineAnchors, storedLineTargetPath, type LineAnchorCache } from "./shared/line-anchors.js";
import { shownStageFiles } from "./shared/stage-files.js";
export { captureCodeTarget, resolveCodeTarget } from "./shared/insight-targets.js";
/**
 * Semantic Flow review viewer launcher.
 *
 * Reads a repository's `.semantic-review` artifact, reconstructs the implementation
 * data model (stages, nodes, project-grouped files, full-context diffs), and
 * serves the bundled Cinema viewer on localhost.
 *
 * Usage: node semantic-flow.mjs viewer serve [project-path] [--review <id> --generation <gen>]
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
  KEY_HEADER,
  probeViewer,
  probeViewerAccess,
  requestLaunchCode,
  stopViewerAndWait,
  VIEWER_APP_ID,
  VIEWER_HOST,
  viewerPort,
  type ViewerIdentity,
} from "./shared/viewer-lifecycle.js";
import {
  browserOpener, COMMON_HEADERS, createViewerAccess, FRESH_LINK_MESSAGE, LAUNCH_CODE_LIFETIME_MS, launchUrl, opensLaunchUrl, originFormTarget, ownApiCaller, ownHost, PAGE_HEADERS,
  sameSecret, sweepLaunchFiles, writeLaunchFile, type ViewerAccess,
} from "./shared/viewer-access.js";

export { registerReview, readReview, patchReviewState, reviewDirectory, reviewId, feedbackDirectory, recordViewer, listReviews, setReviewCompleted } from "./shared/review-store.js";
import { registerReview, readReview, readReviewArtifact, patchReviewState, reviewDirectory, feedbackDirectory, reviewId, reviewHome, withReviewLock, recordViewer, listReviews, removeOrphanedReviews, reviewDeletionConfirmed, setReviewCompleted, reviewImplementationArchived, readReviewImplementationArchived } from "./shared/review-store.js";

export { captureReviewContext, assertReviewContext, runReviewCommand } from "./shared/review-context.js";
import { captureReviewContext, assertReviewContext, isolateReviewEnvironment, spawnReviewCommand, reviewEnvironment, type ReviewContext } from "./shared/review-context.js";

export { inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles } from "./shared/review-cleanup.js";
import { inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles } from "./shared/review-cleanup.js";
export { storeAttachment, resolveAttachment } from "./shared/review-attachments.js";
import { storeAttachment, resolveAttachment, imageMediaType, MAX_ATTACHMENT_BYTES } from "./shared/review-attachments.js";
export { evidenceRange } from "./shared/evidence.js";
export { captureApprovalSnapshot, captureApprovalSnapshots, compareApprovalSnapshot } from "./shared/approval-snapshots.js";
import { evidenceMediaTypeMatches, evidenceRange, resolveEvidenceFile, sha256Hex } from "./shared/evidence.js";
import { captureApprovalSnapshots, compareApprovalSnapshot, type FileEndpoint } from "./shared/approval-snapshots.js";

export { startRemoteReview, refreshRemoteReview } from "./shared/remote-review.js";
import { prepareRemoteReview, refreshRemoteReview } from "./shared/remote-review.js";
import { agentStatus, liveSession, markSending, readAgentState, respondToRequest, updateAgentState } from "./shared/agent-session.js";
import { awaitsAgentReply } from "./shared/feedback-awaiting.js";
import { FEEDBACK_MANIFEST_SCHEMA_ID, INSIGHT_COLLECTIONS, THREAD_SCHEMA_ID, isFeedbackId, type CodeTarget, type InsightCollection, type Thread } from "./shared/documents.js";
import { parseJson, readJson } from "./shared/json.js";
import { activeImplementationId, hasFile, preloadActiveRefs, readArtifactJson, readingActiveRefsOnce, selectImplementation, type ActiveRefReads, type ArtifactSnapshot } from "./shared/artifact-store.js";
import { git, gitRaw } from "./shared/git.js";
import { diffTree, FIND_RENAMES, porcelainDiff, type DiffCommand } from "./shared/diff-settings.js";
import { readUnvalidatedImplementation, removedStageFile } from "./shared/implementation.js";
import { capturedOutput, errorCode, errorMessage, isRecord, isStringArray, numberField, stringField, type JsonRecord } from "./shared/narrow.js";
import { isDocument, parseDocument } from "./shared/schema-validation.js";
import type { ReviewRecord, ViewerRecord } from "./shared/review-store.js";
import { assertKnownOptions, flag, option, parseArguments } from "./shared/arguments.js";
import { reviewFeedback, type PartialBatchResult, type ReviewFeedback } from "./review-feedback.js";
import type * as Wire from "./shared/viewer-protocol.js";
import {
  isClassification, isEvidenceKind, isHunkNumber, lineRangeOf, parseAgentResponse, parseApprovalComparison, parseApprovalEndpoint, parseApprovalEndpoints, parseAttachmentQuery,
  parseAttachmentUpload, parseCompletion, parseDiffQuery, parseDraftSnapshotNotes, parseFeedbackExport, parseFeedbackNotes, parseFeedbackReplies,
  parseFeedbackReply, parseFileContentQuery, parseReviewTarget, parseStatePatch, parseStorageAction, parseThreadAction,
  type QueryText, type Received, type ReceivedApprovalEndpoint, type ReceivedFeedbackExport, type ReceivedQuery, type Skipped,
} from "./shared/viewer-requests.js";

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

const VIEWER_USAGE = "usage: semantic-flow viewer serve [project-path] [--review <review-id> --generation <generation>]";

function resolveRepositoryRoot(positional: string[]) {
  if (positional.length > 1) {
    fail(VIEWER_USAGE);
  }
  const start = path.resolve(process.cwd(), positional[0] ?? ".");
  const top = fs.existsSync(start) ? git(["rev-parse", "--show-toplevel"], { cwd: start, allowFailure: true }) : null;
  const root = top ? path.resolve(top) : undefined;
  if (root && readReviewArtifact(root)) return root;
  fail(`no active semantic implementation found for ${start}.`);
}

function gitCapture(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...reviewEnvironment(), ...env },
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
    raw = renameFacts(JSON.stringify([repoRoot, fromRevision, toRevision]), () => {
      const command = diffTree(["--name-status", "-z", ...FIND_RENAMES, fromRevision, toRevision, "--"], { objectIdLength: toRevision.length });
      return gitCapture(repoRoot, command.args, command.env);
    });
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
const listOf = (value: unknown): unknown[] => isList(value) ? value : [];

/** The fields of a JSON object, or an empty record for any other value. */
const fieldsOf = (value: unknown): JsonRecord => isRecord(value) ? value : {};

// --- Artifact documents as the viewer reads them ---
//
// Local artifacts are validated by the CLI, but remote reviews reconstructed
// from Git history (shared/remote-review.ts) are not schema documents: they
// have no $schema, base branch or insight collections. The viewer therefore
// narrows artifact documents field by field into the wire types it sends. It
// fails only where it cannot render at all; a missing display value becomes
// empty, an unknown classification is left out, a node change's malformed hunks or
// line ranges are left out, and only a node change without a path is left out.

/** The implementation manifest fields the viewer reads. */
interface ViewerManifest {
  implementationId: string;
  title: string;
  summary: string;
  skillVersion?: string;
  targetBranch: string;
  baseRevision: string;
  requirements: string[];
  stages: string[];
  /** The IDs of removed stages. */
  removedStages: string[];
}

interface ViewerSpecification {
  id: string;
  title: string;
  summary: string;
  source: Wire.SpecificationSource;
  acceptance: Wire.AcceptanceCriterion[];
}

type ViewerNodeChange = Wire.NodeChange;

interface ViewerNode {
  id: string;
  description: string;
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
  title: string;
  summary: string;
  rationale: string;
  dependsOn: string[];
  specificationRefs: string[];
  nodes: ViewerNode[];
  change: { branch: string; baseRevision: string; headRevision: string; files: File[] };
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

/** A display string, or empty when it is missing. */
const displayString = (value: unknown, key: string): string => stringField(value, key) ?? "";

/** The strings of a list of IDs, or none when it is not a list. */
const stringsOf = (value: unknown): string[] => isList(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A node's change of one file, or undefined when it has no path. The page lists a
 * file under a node only through the node's changes, so a change with a path is
 * always kept and only its unusable fields are narrowed:
 * - Hunk numbers that are not positive integers and line ranges or spans that are
 *   not ordered positive integers are left out. A selector that keeps none, or that
 *   is not a list, is left out, and the change owns the whole file.
 * - The schema allows hunks or line ranges, not both. When both keep a valid entry,
 *   the hunks are kept and the line ranges left out.
 * - An unknown classification is left out and kept only as the recorded value file
 *   approval keys use. */
function readNodeChange(value: unknown): ViewerNodeChange | undefined {
  const { path: filePath, classification, hunks, lineRanges } = fieldsOf(value);
  if (typeof filePath !== "string") return undefined;
  const ownedHunks = listOf(hunks).filter(isHunkNumber);
  const ownedLineRanges = listOf(lineRanges).flatMap((range) => lineRangeOf(range) ?? []);
  return {
    path: filePath,
    ...(isClassification(classification) ? { classification } : typeof classification === "string" ? { recordedClassification: classification } : {}),
    ...(ownedHunks.length ? { hunks: ownedHunks } : ownedLineRanges.length ? { lineRanges: ownedLineRanges } : {}),
  };
}

function readManifest(document: unknown, file: string): ViewerManifest {
  const value = fieldsOf(document);
  const { stages, requirements } = value;
  if (!isStringArray(stages)) throw new Error(`${file}: missing stage list.`);
  return {
    implementationId: requiredString(value, "implementationId", file),
    title: displayString(value, "title"), summary: displayString(value, "summary"), skillVersion: stringField(value, "skillVersion"),
    targetBranch: displayString(value, "targetBranch"), baseRevision: displayString(value, "baseRevision"),
    requirements: isStringArray(requirements) ? requirements : [],
    stages,
    removedStages: listOf(value.removedStages).flatMap((entry) => {
      const id = stringField(entry, "id");
      return id === undefined ? [] : [id];
    }),
  };
}

/** A specification; one without an ID keeps the ID the manifest lists it by. */
function readSpecification(document: unknown, specificationId: string): ViewerSpecification {
  const value = fieldsOf(document);
  const url = stringField(value.source, "url");
  return {
    id: stringField(value, "id") ?? specificationId, title: displayString(value, "title"), summary: displayString(value, "summary"),
    source: { kind: displayString(value.source, "kind"), reference: displayString(value.source, "reference"), ...(url !== undefined ? { url } : {}) },
    acceptance: listOf(value.acceptanceCriteria).map((criterion) => ({ id: displayString(criterion, "id"), text: displayString(criterion, "text") })),
  };
}

function readStageDocument(document: unknown, file: string): StageDocument {
  const value = fieldsOf(document);
  const change = fieldsOf(value.change);
  if (!isList(change.files)) throw new Error(`${file}: missing change file list.`);
  const files = change.files.map((item): StageDocumentFile => {
    const entry = fieldsOf(item);
    return { path: requiredString(entry, "path", file), kind: entry.kind, previousPath: stringField(entry, "previousPath") };
  });
  const nodes = (isList(value.nodes) ? value.nodes : []).map((item): ViewerNode => {
    const node = fieldsOf(item);
    return {
      id: requiredString(node, "id", file), description: displayString(node, "description"),
      changes: listOf(node.changes).flatMap((entry) => readNodeChange(entry) ?? []),
    };
  });
  const stage: StageDocument = {
    id: requiredString(value, "id", file),
    title: displayString(value, "title"), summary: displayString(value, "summary"), rationale: displayString(value, "rationale"),
    dependsOn: stringsOf(value.dependsOn),
    specificationRefs: stringsOf(value.specificationRefs),
    nodes,
    change: {
      branch: displayString(change, "branch"),
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

/** The artifact a viewer shows, as one read found it. */
interface ViewerArtifact {
  files: ArtifactSnapshot;
  manifest: ViewerManifest;
  specification(id: string): ViewerSpecification;
  stage(id: string): StageDocument;
  /** A removed stage's title, or its ID when its document cannot be read. */
  removedStageTitle(id: string): string;
}

/** Reads the artifact of a review: the active artifact through the loader
 * that derives its stage data, or the projection of a remote review, whose
 * documents are narrowed field by field. */
function readViewerArtifact(repoRoot: string): ViewerArtifact {
  const source = readReviewArtifact(repoRoot);
  if (!source) throw new Error(`No semantic implementation exists in ${repoRoot}.`);
  const { files } = source;
  const label = (file: string) => files.describe(file);
  if (source.projection) {
    return {
      files,
      manifest: readManifest(readArtifactJson(files, "manifest.json"), label("manifest.json")),
      specification: (id) => readSpecification(readArtifactJson(files, `requirements/${id}.json`), id),
      stage: (id) => readStageDocument(readArtifactJson(files, `stages/${id}.json`), label(`stages/${id}.json`)),
      removedStageTitle: (id) => {
        const file = removedStageFile(id);
        return (/^[a-z0-9-]+$/.test(id) && hasFile(files, file) ? stringField(readArtifactJson(files, file), "title") : undefined) ?? id;
      },
    };
  }
  // The documents are narrowed field by field, as a projection's are, so an
  // artifact that validation rejects still opens.
  const model = readUnvalidatedImplementation(repoRoot, files);
  return {
    files,
    manifest: readManifest(model.manifest, label("manifest.json")),
    specification: (id) => readSpecification(model.requirements.get(id), id),
    stage: (id) => readStageDocument(model.stages.get(id), label(`stages/${id}.json`)),
    removedStageTitle: (id) => stringField(model.removedStages.get(id), "title") ?? id,
  };
}

/** The implementation ID of the artifact a review of root shows. */
function reviewedImplementationId(repoRoot: string): string {
  return activeImplementationId(repoRoot, readReviewArtifact(repoRoot)?.files);
}

/** A file's bytes, or undefined when it does not exist. */
function readOptionalFile(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
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
  const bytes = readOptionalFile(file);
  return bytes === undefined ? undefined : parseStoredThread(bytes.toString("utf8"));
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
  const implementationId = reviewedImplementationId(repoRoot);
  return withReviewLock(reviewId(repoRoot, implementationId), () => {
    requireImplementation(repoRoot, implementationId);
    const snapshot = readViewerSnapshot(repoRoot, implementationId);
    requireImplementation(repoRoot, implementationId);
    return snapshot;
  });
}

function readViewerSnapshot(repoRoot: string, implementationId: string): ViewerRevision {
  const artifact = readViewerArtifact(repoRoot).files;
  const feedbackRoot = feedbackDirectory(repoRoot, implementationId);
  const files: string[] = [];
  const feedbackManifestPath = path.join(feedbackRoot, "manifest.json");
  // Threads are hashed from the bytes they were counted from, so one removed meanwhile cannot fail the poll.
  const threadBytes = new Map<string, Buffer>();
  let awaitingAgentReplies = 0;
  if (fs.existsSync(feedbackManifestPath)) {
    files.push(feedbackManifestPath);
    for (const threadId of listedThreadIds(readJson(feedbackManifestPath))) {
      const file = path.join(feedbackRoot, "threads", `${threadId}.json`);
      const bytes = readOptionalFile(file);
      // A missing thread leaves the hashed files, so restoring it changes the revision.
      if (bytes === undefined) continue;
      files.push(file);
      threadBytes.set(file, bytes);
      if (threadAwaitsAgent(parseStoredThread(bytes.toString("utf8")))) awaitingAgentReplies += 1;
    }
  }
  const hash = createHash("sha256");
  hash.update(artifact.version).update("\0");
  for (const file of files.sort()) {
    hash.update(path.relative(repoRoot, file));
    hash.update("\0");
    hash.update(threadBytes.get(file) ?? fs.readFileSync(file));
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

/** The artifact's version plus stat-based invalidation of feedback documents
 * and a periodic content scan for missed/coarse timestamp changes. */
export function createSnapshotReader(repoRoot: string, { now = Date.now, readFile = (file: string) => fs.readFileSync(file, "utf8") }: SnapshotReaderOptions = {}) {
  let documents = new Map<string, CachedDocument>();
  let artifactVersion = "";
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
      if (!scan && cached && cached.stamp === stamp) {
        seen.add(file);
        return cached.value;
      }
      let text: string;
      try {
        text = readFile(file);
      } catch (error) {
        // Removed after the stat: it leaves the hashed files like one missing before it.
        if (thread && errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      seen.add(file);
      if (!cached || cached.text !== text) changed = true;
      const document = { stamp, text, value: thread ? parseStoredThread(text) : parseJson(text) };
      nextDocuments.set(file, document);
      return document.value;
    };
    const implementationId = reviewedImplementationId(repoRoot);
    const feedback = feedbackDirectory(repoRoot, implementationId);
    let awaitingAgentReplies = 0;
    let nextArtifactVersion = artifactVersion;
    // Artifact writers that change several documents hold this lock, so one snapshot is never mixed.
    withReviewLock(reviewId(repoRoot, implementationId), () => {
      const artifact = readReviewArtifact(repoRoot);
      if (!artifact) throw new Error(`No semantic implementation exists in ${repoRoot}.`);
      nextArtifactVersion = artifact.files.version;
      if (nextArtifactVersion !== artifactVersion) changed = true;
      if (fs.existsSync(path.join(feedback, "manifest.json"))) {
        for (const id of listedThreadIds(read(path.join(feedback, "manifest.json")))) {
          if (threadAwaitsAgent(read(path.join(feedback, "threads", `${id}.json`), true))) awaitingAgentReplies++;
        }
      }
    });
    for (const file of nextDocuments.keys()) if (!seen.has(file)) { nextDocuments.delete(file); changed = true; }
    if (changed || !previous) {
      const hash = createHash("sha256");
      hash.update(nextArtifactVersion).update("\0");
      for (const file of [...seen].sort()) hash.update(path.relative(repoRoot, file)).update("\0").update(nextDocuments.get(file)?.text ?? "").update("\0");
      previous = { revision: hash.digest("hex"), awaitingAgentReplies };
    }
    documents = nextDocuments;
    artifactVersion = nextArtifactVersion;
    if (scan) lastScan = now();
    return previous;
  };
}

function requireImplementation(repoRoot: string, implementationId: string) {
  if (reviewedImplementationId(repoRoot) !== implementationId) throw new Error("The active implementation changed; reopen the viewer.");
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
type DiffLine = Wire.DiffLine;

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

type DiffMode = Wire.DiffMode;

/** One page of a file diff as served to the browser. */
type DiffPage = Wire.ApiSuccess<Wire.DiffResponse>;

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
    if (line.startsWith("diff --git")) {
      started = false;
      continue;
    }
    // Once inside a hunk, +++/--- and the other header prefixes can be actual source lines.
    if (
      !started && (
      line.startsWith("index ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode"))
    ) {
      continue;
    }
    if (!started && line.startsWith("Binary files")) {
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

/** Each file is labelled with its last occurrence in the ordered review,
 * independently of intervening stages (see `shownStageFiles`). */
function readViewerStages(artifact: ViewerArtifact): ViewerStage[] {
  const stages = artifact.manifest.stages.map((id) => artifact.stage(id));
  const files = shownStageFiles(stages);
  return stages.map((stage, index) => ({ ...stage, change: { ...stage.change, files: files[index] } }));
}

/** The revision range a diff is computed over. */
interface DiffRange {
  change: { baseRevision: string; headRevision: string };
}

/** A stage with the files its diff shows. */
interface DiffStage extends DiffRange {
  change: { baseRevision: string; headRevision: string; files: { path: string }[] };
}

function stageDiffKey(stage: ViewerStage) {
  return JSON.stringify([stage.id, stage.change.baseRevision, stage.change.headRevision, stage.change.files.map((file) => [file.path, file.previousPath, file.baseRevision])]);
}

// A file's comparison: what the viewer shows of it, counts and fingerprints.
//
// Every file of a stage is compared over the stage's own range, from its base
// to its head, with the inventory's rename detection: the range and settings
// the inventory was derived from, so a file is paired with the file the
// inventory says it was renamed from, and any other file with itself. The
// review shows a file compared with the head of the last stage that changed it
// (`ViewerFile.baseRevision`); no stage in between changed the file's old path,
// so while each stage builds on the head of the one below, its old side there
// is the same as at the stage's base. A diff from that earlier head would see
// the files intervening stages added or deleted, and Git could pair the file
// with one of them instead.
function buildStageStats(repoRoot: string, stage: DiffRange, captureGit: GitCapture = gitCapture): Map<string, FileStats> {
  const command = diffTree(["--raw", "--numstat", "--no-abbrev", "-z", ...FIND_RENAMES, stage.change.baseRevision, stage.change.headRevision, "--"],
    { objectIdLength: stage.change.headRevision.length });
  const raw = captureGit(repoRoot, command.args, command.env);
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

function buildStageDiffs(repoRoot: string, stage: DiffStage, stats: Map<string, FileStats>, captureGit: GitCapture = gitCapture): Map<string, ParsedDiff> {
  const command = (unified: number) => diffTree(["-p", `-U${unified}`, ...FIND_RENAMES, stage.change.baseRevision, stage.change.headRevision, "--"],
    { objectIdLength: stage.change.headRevision.length });
  const capture = ({ args, env }: DiffCommand) => captureGit(repoRoot, args, env);
  const full = capture(command(3));
  const selector = capture(command(0));
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

async function* gitLines(repoRoot: string, { args, env }: DiffCommand): AsyncGenerator<string> {
  const child = spawn("git", args, {
    cwd: repoRoot,
    env: { ...reviewEnvironment(), ...env },
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

/** The modes of a regular file, an executable and a symbolic link, whose objects are blobs. */
const FILE_MODES = new Set(["100644", "100755", "120000"]);

// Stream one page rather than buffering unrelated files or a full large patch.
async function pagedFileDiff(repoRoot: string, stage: DiffRange, file: ViewerFile, stats: FileStats | undefined, mode: DiffMode, offset: number,
  targetSide: "old" | "new" | null = null, targetLine: number | null = null): Promise<DiffPage> {
  // A renamed file is diffed as the two files its stage's diff paired: named by
  // path, Git would detect renames again among the paths, and a path also
  // selects the files below a directory of that name. A submodule's object is
  // a commit, not a file, so a renamed submodule is diffed by its paths.
  const renamed = file.previousPath && stats?.kind === "renamed" && stats.oldBlob && stats.newBlob ? stats : null;
  // A file moved unchanged, or one whose stage diff found it binary, shows no lines.
  if (renamed && (renamed.binary || (renamed.oldBlob === renamed.newBlob && renamed.oldMode === renamed.newMode))) {
    return { lines: [], additions: renamed.additions, deletions: renamed.deletions, binary: renamed.binary,
      truncated: false, nextOffset: null, offset, mode };
  }
  const pair = renamed && [renamed.oldMode, renamed.newMode].every((item) => item !== undefined && FILE_MODES.has(item)) ? renamed : null;
  const paths = [...new Set([file.previousPath, file.path].filter((item): item is string => Boolean(item)))];
  const renames = file.previousPath ? FIND_RENAMES : ["--no-renames"];
  // Attributes would match the object IDs as paths, so the pair is text, as its
  // stage diff found it.
  const args = (context: number) => pair
    ? porcelainDiff("diff", [`-U${context}`, "--text", pair.oldBlob ?? "", pair.newBlob ?? "", "--"], { objectIdLength: stage.change.headRevision.length })
    : diffTree(["-p", `-U${context}`, ...renames, stage.change.baseRevision, stage.change.headRevision, "--", ...paths],
      { objectIdLength: stage.change.headRevision.length });
  const shapes: { old: number; oldCount: number; new: number; newCount: number }[] = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  // The diff of a pair holds only that file.
  let selected = Boolean(pair), previousPath = "";
  const selectSection = (line: string) => {
    if (pair) return;
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

function isCodeTarget(value: unknown): value is CodeTarget {
  return isRecord(value) && typeof value.path === "string" && typeof value.revision === "string" && typeof value.blobId === "string" &&
    typeof value.startLine === "number" && typeof value.endLine === "number" && typeof value.contextStartLine === "number" &&
    isStringArray(value.context);
}

/** An insight before its code target is resolved. */
type InsightFields = Omit<Wire.Insight, "id" | "title" | "body" | "nodeRefs"> & { id?: string; title?: string; body?: string; item: unknown };

/** Insights are display-only, so each item is read leniently, including older
 * shapes (alternatives with summary/rationale, plain-text open questions). */
function buildInsights(stage: InsightLists & DiffRange, repoRoot: string): Wire.Insight[] {
  const insights: InsightFields[] = [];
  const text = stringField;
  for (const d of listOf(stage.decisions)) {
    insights.push({
      type: "decision",
      collection: "decisions",
      item: d,
      id: text(d, "id"),
      title: text(d, "summary"),
      body: text(d, "rationale"),
      meta: text(d, "category"),
    });
  }
  for (const a of listOf(stage.assumptions)) {
    const riskIfWrong = text(a, "riskIfWrong");
    insights.push({
      type: "assumption",
      collection: "assumptions",
      item: a,
      id: text(a, "id"),
      title: text(a, "statement"),
      body: riskIfWrong ? `If wrong: ${riskIfWrong}` : "",
    });
  }
  for (const a of listOf(stage.alternatives)) {
    insights.push({
      type: "alternative",
      collection: "alternatives",
      item: a,
      id: text(a, "id"),
      title: text(a, "approach") || text(a, "summary") || text(a, "id"),
      body: text(a, "reasonRejected") || text(a, "rationale") || "",
    });
  }
  for (const f of listOf(stage.failedAttempts)) {
    insights.push({
      type: "lesson",
      collection: "failedAttempts",
      item: f,
      id: text(f, "id"),
      title: text(f, "approach"),
      body: `Outcome: ${text(f, "outcome")} — Lesson: ${text(f, "lesson")}`,
    });
  }
  for (const r of listOf(stage.risks)) {
    const mitigation = text(r, "mitigation");
    insights.push({
      type: "risk",
      collection: "risks",
      item: r,
      id: text(r, "id"),
      title: text(r, "summary"),
      body: mitigation ? `Mitigation: ${mitigation}` : "",
    });
  }
  for (const v of listOf(stage.validation)) {
    insights.push({
      type: "validation",
      collection: "validation",
      item: v,
      id: text(v, "id"),
      title: text(v, "summary"),
      body: text(v, "command") || "",
      meta: text(v, "status"),
      validationType: text(v, "type"),
    });
  }
  for (const e of listOf(stage.evidence)) {
    const reproduction = text(e, "reproduction"), kind = fieldsOf(e).kind;
    insights.push({
      type: "evidence",
      collection: "evidence",
      item: e,
      id: text(e, "id"),
      title: text(e, "summary"),
      body: reproduction ? `Reproduce: ${reproduction}` : "",
      meta: text(e, "kind"),
      // Evidence of a kind this viewer does not know is shown as generic evidence;
      // its recorded kind stays in meta.
      evidence: {
        kind: isEvidenceKind(kind) ? kind : "other",
        attachments: listOf(fieldsOf(e).attachments).map((attachment): Wire.EvidenceAttachment => {
          const caption = text(attachment, "caption"), role = text(attachment, "role");
          return {
            mediaType: displayString(attachment, "mediaType"), sha256: displayString(attachment, "sha256"),
            ...(caption !== undefined ? { caption } : {}), ...(role === "before" || role === "after" ? { role } : {}),
          };
        }),
        inline: text(e, "inline"),
        reproduction,
        specificationRefs: stringsOf(fieldsOf(e).specificationRefs),
        capturedAt: displayString(e, "capturedAt"),
      },
    });
  }
  for (const q of listOf(stage.openQuestions)) {
    insights.push({
      type: "question",
      collection: "openQuestions",
      item: q,
      id: text(q, "id") || "q",
      title: text(q, "question") || text(q, "summary") || String(q),
      body: text(q, "context") || "",
    });
  }
  return insights.map(({ item: source, ...fields }): Wire.Insight => {
    const insight: Wire.Insight = { ...fields, id: fields.id ?? "", title: fields.title ?? "", body: fields.body ?? "", nodeRefs: stringsOf(fieldsOf(source).nodeRefs) };
    // The insight's own item: another item with the same ID must not lend its target.
    const target = fieldsOf(source).codeTarget;
    return isCodeTarget(target) ? { ...insight, codeTarget: resolveCodeTarget(repoRoot, target, stage.change.headRevision) } : insight;
  });
}

/** The fingerprint of a file's comparison (see `buildStageStats`): a line
 * draft or approval made on it holds while it is the same. */
function fileRevision(stage: DiffRange, file: { path: string; previousPath?: string }, stats: FileStats | undefined): string {
  const hash = createHash("sha256")
    .update(stats?.oldBlob || stage.change.baseRevision)
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

/** Copies a node change without absent keys, so a value echoed back through
 * JSON compares equal to the original. */
function nodeChangeFields(change: ViewerNodeChange): Omit<Wire.NodeChange, "path"> {
  return {
    ...(change.classification ? { classification: change.classification } : {}),
    ...(change.recordedClassification !== undefined ? { recordedClassification: change.recordedClassification } : {}),
    ...(change.hunks ? { hunks: change.hunks } : {}),
    ...(change.lineRanges ? { lineRanges: change.lineRanges } : {}),
  };
}

/** Whether a stage changes nothing: its head is one commit on its base that
 * changes no file outside the artifact folder. Remote metadata is not trusted
 * to say so; false when the commits cannot be read. */
function changesNothing(root: string, base: string, head: string): boolean {
  // Exactly one parent, the base: a merge can hide commits behind an unchanged tree.
  // The raw commit object names its parents; replacement refs and grafts cannot hide one.
  const commit = git(["--no-replace-objects", "cat-file", "commit", head], { cwd: root, allowFailure: true });
  if (commit === null) return false;
  // Git reads parents only from the lines right after the tree line.
  const lines = commit.split("\n"), parents: string[] = [];
  if (!lines[0]?.startsWith("tree ")) return false;
  for (const line of lines.slice(1)) { if (!line.startsWith("parent ")) break; parents.push(line.slice("parent ".length)); }
  if (parents.length !== 1 || parents[0] !== base) return false;
  const command = diffTree(["--quiet", "--no-renames", base, head, "--", ".", ":(exclude).semantic-review"], { objectIdLength: head.length, literalPathspecs: false });
  return gitRaw(command.args, { cwd: root, env: command.env, allowFailure: true }) !== null;
}

function buildImplementationData(repoRoot: string, statsForStage: (stage: ViewerStage) => Map<string, FileStats>, snapshot: ViewerRevision, captureGit: GitCapture,
  lineAnchorCache?: LineAnchorCache): Wire.ImplementationData {
  const artifact = readViewerArtifact(repoRoot);
  const { manifest } = artifact;
  const requirements = manifest.requirements.map((specificationId): Wire.Requirement =>
    artifact.specification(specificationId),
  );
  const projects = buildProjectIndex(repoRoot, captureGit);

  const stages = readViewerStages(artifact).map((s): Wire.Stage => {
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

    const membershipByPath = new Map<string, Wire.FileMembership[]>();
    s.nodes.forEach((node) => {
      node.changes.forEach((c) => {
        let memberships = membershipByPath.get(c.path);
        if (!memberships) membershipByPath.set(c.path, memberships = []);
        memberships.push({ nodeId: node.id, ...nodeChangeFields(c) });
      });
    });

    const files = s.change.files.map((file): Wire.StageFile => {
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
      // Git, not the recorded file list, decides that a stage is empty.
      ...(files.length === 0 && changesNothing(repoRoot, base, head) ? { empty: true as const } : {}),
    };
  });

  const feedback = withValidationContext(() => buildFeedbackThreads(repoRoot, stages, manifest.implementationId, lineAnchorCache));
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
    // Threads of a removed stage are read-only; the page derives that from this list.
    removedStages: manifest.removedStages.map((id) => ({ id, title: artifact.removedStageTitle(id) })),
    feedback,
    viewerRevision: snapshot.revision,
    awaitingAgentReplies: snapshot.awaitingAgentReplies,
  };
}

type ImplementationData = Wire.ImplementationData;

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
  const lineAnchorCache: LineAnchorCache = new Map();
  let cachedRevision = "";
  let cachedScript: string | undefined;
  let cachedData: ImplementationData | null = null;
  const snapshotReader = createSnapshotReader(repoRoot);

  const stageRecord = (stage: ViewerStage): StageRecord => {
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
      // The newest record of a stage is the one its latest build used, which
      // fileDiff looks for first.
      stageCache.delete(key);
      stageCache.set(key, record);
    }
    return record;
  };

  const readStage = (stageId: string | null, artifact: ViewerArtifact = readViewerArtifact(repoRoot)): ViewerStage => {
    const stage = stageId === null || !artifact.manifest.stages.includes(stageId)
      ? undefined
      : readViewerStages(artifact).find((candidate) => candidate.id === stageId);
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
        lineAnchorCache,
      ));
      // Located lines are immutable facts of their inputs; keep a bounded number.
      for (const oldest of lineAnchorCache.keys()) {
        if (lineAnchorCache.size <= 4096) break;
        lineAnchorCache.delete(oldest);
      }
      cachedData = data;
      cachedScript = undefined;
      cachedRevision = snapshot.revision;
      snapshot = snapshotReader(true);
    }
    if (!cachedData) throw new Error("The implementation data could not be built.");
    return cachedData;
  };

  return {
    evidenceFile(stageId: string | null, itemId: string | null, index: string | null) {
      const artifact = readViewerArtifact(repoRoot);
      const stage = readStage(stageId, artifact);
      const item = listOf(stage.evidence).find((candidate) => isRecord(candidate) && candidate.id === itemId);
      const attachment = listOf(fieldsOf(item).attachments)[Number(index)];
      const attachmentPath = stringField(attachment, "path"), mediaType = stringField(attachment, "mediaType"), sha256 = stringField(attachment, "sha256");
      if (attachmentPath === undefined || mediaType === undefined || !evidenceMediaTypeMatches({ path: attachmentPath, mediaType })) throw new Error("Evidence attachment does not exist.");
      const { file } = resolveEvidenceFile(artifact.files, stage.id, attachmentPath);
      const bytes = artifact.files.read(file);
      if (sha256Hex(bytes) !== sha256) throw new Error("Evidence attachment is damaged.");
      return { mediaType, content: bytes.toString("base64") };
    },
    implementationData,
    /** The data as a script that sets `window.SEMANTIC_IMPLEMENTATION`; tests read it. */
    implementationDataScript() {
      const data = implementationData();
      cachedScript ??= implementationScript(data);
      return cachedScript;
    },
    snapshot: snapshotReader,
    fileContent(stageId: string | null, filePath: string | null, baseRevision: string | null, headRevision: string | null, targetPath: string | null = null) {
      const stage = readStage(stageId);
      const file = stage.change.files.find((item) => item.path === filePath);
      if (!file || file.baseRevision !== baseRevision || stage.change.headRevision !== headRevision) throw new Error("File revision changed; reload the viewer.");
      if (!/\.(md|markdown)$/i.test(file.path)) throw new Error("Preview requires a Markdown file.");
      const deleted = stageRecord(stage).stats.get(file.path)?.kind === "deleted";
      // A deleted file is shown as it was at the stage's base, as its diff shows it.
      const revision = deleted ? stage.change.baseRevision : stage.change.headRevision;
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
      // The content is base64 here; the JSON response decodes it to text.
      const content: Wire.ApiSuccess<Wire.FileContentResponse> = { revision, path: resourcePath, side: deleted ? "base" : "head", content: bytes.toString("base64"), mediaType: mediaType || "text/plain; charset=utf-8" };
      return content;
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
          if (!current.diffs) current.diffs = buildStageDiffs(repoRoot, stage, current.stats, captureGit);
          const diff = current.diffs.get(filePath);
          if (diff) return { ...diff, truncated: false, nextOffset: diff.truncated ? diff.lines.length : null, mode };
        } catch { /* An unusually wide patch uses the bounded streaming path. */ }
      }
      const key = JSON.stringify([filePath, mode, offset, side, targetLine]);
      let page = current.pages.get(key);
      if (!page) {
        page = pagedFileDiff(repoRoot, stage, file, current.stats.get(filePath), mode, offset, side, targetLine)
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

const IMPLEMENTATION_SCRIPT_PREFIX = "window.SEMANTIC_IMPLEMENTATION = JSON.parse(";

/** The page parses the data as JSON, because in an object literal a stored
 * "__proto__" key would set the prototype instead of staying an ordinary key.
 * Escaping "<" keeps the script inert even inside an HTML script element. */
function implementationScript(data: unknown): string {
  return `${IMPLEMENTATION_SCRIPT_PREFIX}${JSON.stringify(JSON.stringify(data)).replaceAll("<", "\\u003c")});\n`;
}

export function createImplementationDataScript(repoRoot: string) {
  return createViewerDataSource(repoRoot).implementationDataScript();
}

/** Where a file or line thread's path now is, relative to its original stage head. */
type TargetState = { state: "present" } | { state: "renamed"; path: string } | { state: "deleted" } | { state: "not-in-stage" };

// Load open and resolved feedback threads from the local feedback store. A line
// thread's anchor is stale when its line no longer has a row in the stage's
// current diff; another thread's when its assigned or target stage has moved.
function buildFeedbackThreads(repoRoot: string, stages: Wire.Stage[], implementationId: string, lineAnchorCache?: LineAnchorCache) {
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
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  // A target stored by the previous path of a renamed file names the file's path now.
  for (const thread of storedThreads) {
    const stage = thread.target.kind === "line" ? stageById.get(thread.target.stageId) : undefined;
    if (thread.target.kind === "line" && stage) thread.target = { ...thread.target, path: storedLineTargetPath(thread.target, stage) };
  }
  // Every line anchor is followed with one batch of Git reads.
  const lineThreads = storedThreads.flatMap((thread) => {
    const target = thread.target;
    const stage = target.kind === "line" ? stageById.get(target.stageId) : undefined;
    return target.kind === "line" && stage ? [{ thread, target, stage }] : [];
  });
  const currentLines = new Map(locateLineAnchors(repoRoot, lineThreads.map(({ target, stage }) => ({
    anchor: target,
    stage,
    file: stage.files.find((file) => file.path === target.path),
  })), { cache: lineAnchorCache }).map((line, index) => [lineThreads[index].thread.id, line]));
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
      ...(currentLines.has(thread.id) ? { currentLine: currentLines.get(thread.id) ?? null } : {}),
      anchorStale: target.kind === "line"
        ? (currentLines.get(thread.id) ?? null) === null
        : currentHeads.get(thread.assignedStageId) !== thread.stageHead ||
          Boolean(
            target.stageId &&
              currentHeads.get(target.stageId) !== target.stageHead,
          ),
    };
  });
}

/** The bundled files the viewer serves, by request path, with their content types. */
const STATIC_FILES: ReadonlyMap<string, string> = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/boot.js", "text/javascript; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/markdown.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/favicon.svg", "image/svg+xml"],
]);

/** The API routes whose GET requests the read token also authorizes: the
 * resources the browser loads by URL, which cannot send the key header. */
function readTokenRoute(pathname: string, url: URL): boolean {
  return pathname === "/api/evidence" || /^\/api\/attachments\/[^/]+$/.test(pathname) ||
    (pathname === "/api/file-content" && url.searchParams.get("raw") === "1");
}

/** Routes that need no review scope: they serve the viewer itself, not one request of its review. */
const UNSCOPED_ROUTES = new Set(["/api/whoami", "/api/shutdown", "/api/session", "/api/launch", "/api/bootstrap"]);

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

/** Sends a JSON body. Name its shared protocol type: without one, no payload is accepted. */
function sendJson<Body extends object = never>(response: http.ServerResponse, status: number, payload: NoInfer<Body>) {
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
export function mapNoteTarget(note: Pick<Wire.FeedbackNoteExport, "kind" | "id" | "stageId">, implementation: FeedbackTargets): NoteTarget {
  const noteId = note.id;
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
    const match = /^f:([^:]+):([^]+)$/.exec(noteId);
    if (!match) throw new Error(`unrecognized file id "${note.id}"`);
    const [, stageId, filePath] = match;
    const stage = implementation.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    // A label must show something; a path of only whitespace is shown quoted.
    return { "target-kind": "file", stage: stageId, path: filePath, label: filePath.trim() ? filePath : JSON.stringify(filePath) };
  }
  if (note.kind === "line") {
    const match = /^l:([^:]+):(old|new):(\d+):([^]+)$/.exec(noteId);
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
  // Callers outside the viewer server may pass any kind.
  throw new Error(`unsupported note kind "${String(note.kind)}"`);
}

export function buildFeedbackTargetData(repoRoot: string): FeedbackTargets {
  const artifact = readViewerArtifact(repoRoot);
  const { manifest } = artifact;
  return {
    implementationId: manifest.implementationId,
    stages: manifest.stages.map((stageId) => {
      const stage = artifact.stage(stageId);
      const stats = buildStageStats(repoRoot, stage);
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

/** Feedback changes for this viewer session, made in-process. */
function feedbackFor(context: ReviewContext): ReviewFeedback {
  if (assertReviewContext(context).remote) throw new Error("Remote reviews support personal notes only.");
  return reviewFeedback(context.repositoryRoot, context);
}

function feedbackContext(repoRoot: string, context: ReviewContext | null | undefined, initialize = false): ReviewContext {
  const implementation = implementationSummary(repoRoot);
  if (context) {
    assertReviewContext(context);
    if (context.reviewId !== reviewId(repoRoot, implementation.implementationId)) throw new Error("The feedback command belongs to another review.");
    return context;
  }
  // Registration may give the implementation a new review ID; use the one it returns.
  if (initialize) return captureReviewContext(registerReview(repoRoot, implementation.implementationId, implementation.title ?? "").id);
  return captureReviewContext(reviewId(repoRoot, implementation.implementationId));
}

function cliErrorMessage(error: unknown): string {
  const text = (capturedOutput(error, "stderr") || capturedOutput(error, "stdout") || stringField(error, "message") || "").toString().trim();
  const line = text.split(/\r?\n/).find((l) => l.startsWith("Error:")) || text.split(/\r?\n/)[0];
  return (line || "feedback command failed").replace(/^Error:\s*/, "");
}

// Upgrade commit-only line snapshots without moving their original anchors.
// Unavailable history stays unresolved and is conservatively rejected on export.
// Such drafts were written on pages that diffed a file from its shown base, the
// snapshot's base, so that range says what the reviewer saw. Where it pairs the
// file as its stage's own range does, the revision is the file's current one;
// where Git paired it with another file, the draft is refused.
export function resolveLineDraftSnapshots<Note>(repoRoot: string, notes: Note[]): Note[] {
  return notes.map((note): Note => {
    if (!isRecord(note) || note.kind !== "line") return note;
    const snapshot = note.snapshot;
    if (!isRecord(snapshot) || snapshot.fileRevision) return note;
    const { base, head } = snapshot;
    const match = /^l:([^:]+):(old|new):(\d+):([^]+)$/.exec(stringField(note, "id") ?? "");
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

type SkippedNote<Ref> = Skipped<Ref>;

interface PlannedThread {
  ref: number;
  body: string;
  /** Attachment IDs as the browser sent them; review-feedback validates them. */
  attachments: string[];
  target: NoteTarget;
  clientId?: string;
}

/** Attachment IDs of a note or reply. */
const attachmentIdsOf = (fields: { attachments: Wire.AttachmentRef[] }): string[] => fields.attachments.map((item) => item.id);

// Validate every note and resolve its target into review-feedback options.
// Pure over (notes, implementation): produces the ordered list of threads to create
// and the reasons any note was skipped, without mutating any state. Kept
// separate from the CLI mutations so a malformed payload can never leave a
// partial or orphaned draft batch behind.
export function planFeedbackThreads(notes: unknown, implementation: FeedbackTargets) {
  return planReceivedThreads(parseFeedbackNotes(notes), implementation);
}

function planReceivedThreads(notes: Received<Wire.FeedbackNoteExport>[], implementation: FeedbackTargets) {
  const skipped: SkippedNote<number>[] = [];
  const planned: PlannedThread[] = [];
  notes.forEach((note) => {
    if ("reason" in note) {
      skipped.push(note);
      return;
    }
    const { ref, body } = note;
    const attachments = attachmentIdsOf(note);
    let target: NoteTarget;
    try {
      target = mapNoteTarget(note, implementation);
      if (note.kind === "line" && note.snapshot) {
        const { snapshot } = note;
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
    planned.push({ ref, body, attachments, target, ...(note.clientId !== undefined ? { clientId: note.clientId } : {}) });
  });
  return { planned, skipped };
}

/** Output of a review-feedback `--partial` batch command over `size` inputs. */
function batchOutcome(result: PartialBatchResult) {
  return { accepted: result.accepted.map((item) => item.index), rejected: result.rejected };
}

interface FeedbackCommandOptions {
  repoRoot: string;
  context?: ReviewContext | null;
}

interface ExportResult {
  ok: boolean;
  error?: string;
  exported?: { ref: number; threadId: string }[];
  skipped?: SkippedNote<number>[];
}

type ExportOptions = FeedbackCommandOptions & { implementation: FeedbackTargets };

export function exportFeedback(options: ExportOptions, notes: unknown): ExportResult {
  return exportReceivedFeedback(options, parseFeedbackNotes(notes));
}

function exportReceivedFeedback({ repoRoot, implementation, context = null }: ExportOptions, notes: Received<Wire.FeedbackNoteExport>[]): ExportResult {
  const review = feedbackContext(repoRoot, context, true);
  if (assertReviewContext(review).remote) throw new Error("Remote reviews support personal notes only.");
  if (notes.length === 0) {
    return { ok: false, error: "No feedback notes to export." };
  }
  const { planned, skipped } = planReceivedThreads(resolveLineDraftSnapshots(repoRoot, notes), implementation);
  if (planned.length === 0) {
    return { ok: false, error: "No notes could be exported.", skipped };
  }

  const manifest = path.join(feedbackDirectory(repoRoot), "manifest.json");
  if (!fs.existsSync(manifest)) {
    try { feedbackFor(review).initialize(); }
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
  const result = batchOutcome(feedbackFor(review).addThreads(batch.map((entry) => entry.input)));
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

export function exportFeedbackReplies(options: FeedbackCommandOptions, drafts: unknown): ReplyResult {
  return exportReceivedReplies(options, parseFeedbackReplies(drafts));
}

function exportReceivedReplies({ repoRoot, context = null }: FeedbackCommandOptions, drafts: Received<Wire.FeedbackReplyExport>[]): ReplyResult {
  const review = feedbackContext(repoRoot, context);
  if (assertReviewContext(review).remote) throw new Error("Remote reviews support personal notes only.");
  if (drafts.length === 0) {
    return { ok: false, error: "No feedback replies to export." };
  }
  const skipped: SkippedNote<string>[] = [];
  const batch: { ref: string; threadId: string; commentId: string; input: JsonRecord }[] = [];
  drafts.forEach((draft) => {
    if ("reason" in draft) {
      skipped.push(draft);
      return;
    }
    const { ref, threadId, body } = draft;
    const attachments = attachmentIdsOf(draft);
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

  const result = batchOutcome(feedbackFor(review).replyToThreads(batch.map((entry) => entry.input)));
  const replied = result.accepted.map((index) => resultFor(batch[index]));
  for (const { index, error } of result.rejected) skipped.push({ ref: batch[index].ref, reason: error });
  return { ok: replied.length > 0, replied, skipped, ...(replied.length ? {} : { error: "No replies could be exported." }) };

}

/** The result of one send: what was written, or why nothing was. */
type FeedbackSent = ({ ok: true } & Wire.FeedbackSendResult) | ({ ok: false; error: string } & Partial<Wire.FeedbackSendResult>);

/** One viewer send. Listening agents wait until its notes and replies are both written. */
type SendOptions = FeedbackCommandOptions & { implementation?: FeedbackTargets | null };

export function sendFeedback(options: SendOptions, notes: unknown, replies: unknown): FeedbackSent {
  return sendReceivedFeedback(options, parseFeedbackNotes(notes), parseFeedbackReplies(replies));
}

function sendReceivedFeedback({ repoRoot, implementation = null, context = null }: SendOptions,
  notes: Received<Wire.FeedbackNoteExport>[], replies: Received<Wire.FeedbackReplyExport>[]): FeedbackSent {
  const hasNotes = notes.length > 0;
  const hasReplies = replies.length > 0;
  if (!hasNotes && !hasReplies) return { ok: false, error: "No feedback to send." };
  const review = feedbackContext(repoRoot, context, hasNotes);
  const token = randomUUID();
  updateAgentState(review.reviewId, (state, now) => markSending(state, now, token, true));
  try {
    const sent: ExportResult | null = hasNotes ? exportReceivedFeedback({ repoRoot, implementation: implementation || buildFeedbackTargetData(repoRoot), context: review }, notes) : null;
    const answered: ReplyResult | null = hasReplies ? exportReceivedReplies({ repoRoot, context: review }, replies) : null;
    const result: Wire.FeedbackSendResult = {
      exported: sent?.exported || [], skipped: sent?.skipped || [],
      replied: answered?.replied || [], replySkipped: answered?.skipped || [],
    };
    return sent?.ok || answered?.ok ? { ok: true, ...result } : { ok: false, ...result, error: sent?.error || answered?.error || "Nothing could be sent." };
  } finally {
    updateAgentState(review.reviewId, (state, now) => markSending(state, now, token, false));
  }
}

/** Reviewer controls for the listening agent. */
export function controlAgent(context: Pick<ReviewContext, "reviewId">, action: string, payload: unknown): Wire.AgentStatus {
  return updateAgentState(context.reviewId, (state, now) => {
    if (action === "stop") {
      const session = liveSession(state);
      if (session && !session.stopRequestedAt) session.stopRequestedAt = new Date(now).toISOString();
    } else {
      const { requestId, body } = parseAgentResponse(fieldsOf(payload));
      respondToRequest(state, now, requestId, body);
    }
    return agentStatus(state, now);
  });
}

// Every API request has already passed the Host, Origin, fetch metadata and key
// checks. POST requests also need the application/json content type, which a
// cross-origin page cannot send without a CORS preflight this server never approves.
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
  jobs: RequestJobs<ViewerJobs>;
  port: number;
  /** Answers a failed request, saying whether the implementation was archived. */
  failure: (status: number, error: unknown) => Promise<void>;
  /** What a failure adds when the implementation was archived. */
  archiveNotice: () => Promise<Pick<Wire.ApiFailure, "implementationArchived">>;
}

async function handleFeedbackExport(request: http.IncomingMessage, response: http.ServerResponse, context: FeedbackRequestContext) {
  try {
    if (!isTrustedRequest(request, context.port)) {
      await context.failure(403, new Error("Feedback export requires a same-origin application/json request."));
      return;
    }
    const raw = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = parseJson(raw || "{}");
    } catch {
      await context.failure(400, new Error("Request body must be JSON."));
      return;
    }
    if (!isRecord(payload)) {
      await context.failure(400, new Error("Request body must be a JSON object."));
      return;
    }
    const received = parseFeedbackExport(payload);
    if (received.implementationId !== await context.jobs.call("reviewedImplementationId")) {
      await context.failure(409, new Error("This viewer is showing a different implementation than the one being exported."));
      return;
    }
    const result = await context.jobs.call("sendFeedback", received);
    const snapshot = await context.jobs.call("snapshot", true);
    if (result.ok) sendJson<Wire.FeedbackExportResponse>(response, 200, { ...result, ...snapshot });
    else sendJson<Wire.FeedbackExportResponse>(response, 422, { ...result, ...snapshot, ...await context.archiveNotice() });
  } catch (error) {
    await context.failure(500, error);
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
      await context.failure(403, new Error("Thread actions require a same-origin application/json request."));
      return;
    }
    const raw = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = parseJson(raw || "{}");
    } catch {
      await context.failure(400, new Error("Request body must be JSON."));
      return;
    }
    const currentImplementationId = await context.jobs.call("reviewedImplementationId");
    const input = isRecord(payload) ? parseThreadAction(payload) : undefined;
    if (!input || input.implementationId !== context.implementationId || input.implementationId !== currentImplementationId) {
      await context.failure(409, new Error("This viewer is showing a different implementation than the one being edited."));
      return;
    }
    const { threadId } = input;
    if (!threadId) {
      await context.failure(400, new Error("A threadId is required."));
      return;
    }
    try {
      if (action === "reply") {
        const reply = parseFeedbackReply({
          ref: input.clientId || createHash("sha256").update(JSON.stringify([threadId, input.body, input.attachments])).digest("hex"),
          threadId, body: input.body, attachments: input.attachments,
        }, 0);
        const result = await context.jobs.call("exportFeedbackReplies", context.implementationId, [reply]);
        if (!result.ok) throw new Error(result.error || result.skipped?.[0]?.reason || "Reply could not be sent.");
      } else if (action === "resolve") {
        await context.jobs.call("setThreadStatus", context.implementationId, threadId, "resolved");
      } else if (action === "reopen") {
        await context.jobs.call("setThreadStatus", context.implementationId, threadId, "open");
      }
    } catch (error) {
      await context.failure(422, error);
      return;
    }
    const thread = await context.jobs.call("feedbackThread", threadId);
    if (!thread) {
      sendJson<Wire.ThreadActionResponse>(response, 200, { ok: true });
      return;
    }
    const last = thread.comments[thread.comments.length - 1];
    sendJson<Wire.ThreadActionResponse>(response, 200, {
      ok: true,
      status: thread.status,
      resolvedAt: thread.resolvedAt || null,
      comment: action === "reply" ? last : undefined,
      ...await context.jobs.call("snapshot", true),
    });
  } catch (error) {
    await context.failure(500, error);
  }
}

/** The approved file as the browser last saw it; fails when it changed since. */
function approvedFileEndpoint(input: ReceivedApprovalEndpoint, data: ImplementationData): FileEndpoint {
  const { stageId, path: filePath, nodeId, fileRevision, ownership: shownOwnership } = input;
  const stage = data.stages.find((stage) => stage.id === stageId);
  const file = stage?.files.find((file) => file.path === filePath);
  const ownership = file?.memberships.find((membership) => membership.nodeId === nodeId);
  if (!stage || !file || !ownership) throw new Error("This file review no longer exists. Refresh the viewer.");
  if (file.revision !== fileRevision || !isDeepStrictEqual(ownership, shownOwnership)) throw new Error("The file or its ownership changed. Refresh the viewer before approving or comparing it.");
  return { stageId: stage.id, nodeId: ownership.nodeId, path: file.path, previousPath: file.previousPath, previousPaths: file.previousPaths,
    // The base the file's comparison starts from (see `buildStageStats`).
    baseRevision: stage.baseRevision, headRevision: stage.headRevision, fileRevision: file.revision, ownership };
}

export function registeredReviews(): Wire.ReviewSummary[] {
  removeOrphanedReviews();
  return listReviews().map((record) => {
    let unavailableReason = "";
    // Listing doesn't make a remote review's projection again; opening it does.
    try { captureReviewContext(record.id, "unbuilt"); } catch (error) { unavailableReason = cliErrorMessage(error); }
    // Archiving ends the review; only a review that cannot be opened may have ended so.
    const archived = Boolean(unavailableReason) && reviewImplementationArchived(record);
    if (archived) unavailableReason = `Implementation ${record.implementationId} was archived.`;
    const { id, generation, title, implementationId, repositoryRoot, createdAt, updatedAt, completedAt, remote } = record;
    return { id, generation, title, implementationId, repositoryRoot, createdAt, updatedAt, completedAt, remote, available: !unavailableReason, unavailableReason, archived };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Makes a registered review ready to open and checks it, returning the context
 * to open it with. Preparing a remote review may fetch its branch, so the
 * viewer runs this in its management worker, not on the thread serving requests. */
export function prepareRegisteredReview(id: string, generation: string): ReviewContext {
  prepareRemoteReview(id, generation);
  const context = captureReviewContext(id);
  if (context.generation !== generation) throw new Error("The selected review was replaced. Refresh the review list.");
  return context;
}

/** Reopen a review that prepareRegisteredReview made ready, using its registry
 * identity, with no caller-supplied path or command. The startup timeout
 * counts from the launch, once preparing has finished. */
export async function openRegisteredReview(context: ReviewContext): Promise<string> {
  const id = context.reviewId;
  // Only the identity is checked again here, on the thread serving requests: the
  // viewer it starts reads the review, and makes its projection, itself.
  const child = spawnReviewCommand(context, process.execPath, [fileURLToPath(import.meta.url), "viewer", "serve", context.repositoryRoot, "--review", context.reviewId, "--generation", context.generation], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], environment: { SEMANTIC_VIEW_NO_OPEN: "1" }, artifactCheck: "skip",
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

/** Whether the session's review was replaced or deleted. A missing review counts
 * only once its deletion is confirmed: a deletion still under way may roll back. */
export function reviewSessionUnavailable(context: ReviewContext) {
  const replaced = () => readReview(context.reviewId).generation !== context.generation;
  try { return replaced(); }
  catch (error) {
    if (errorCode(error) !== "REVIEW_UNAVAILABLE") return false;
    if (reviewDeletionConfirmed(context.reviewId)) return true;
    // A deletion rolled back while this waited for it.
    try { return replaced(); } catch { return false; }
  }
}
/** Whether a launch of the session may replace a running viewer of the same
 * review: the review still records the worktree the launch serves. A launch that
 * read the review before another launch recorded a different worktree is
 * outdated, and the viewer of the recorded worktree is the one to keep. */
export function viewerLaunchCurrent(context: Pick<ReviewContext, "reviewId" | "generation" | "repositoryRoot">) {
  try {
    const record = readReview(context.reviewId);
    return record.generation === context.generation && record.repositoryRoot === context.repositoryRoot;
  } catch { return false; }
}
/** Poll directory identity cheaply; retry transient failures before accepting a baseline. */
export function reviewRetirementCheck(context: ReviewContext) {
  const directory = reviewDirectory(context.reviewId);
  const identity = () => { const stat = fs.statSync(directory, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; };
  let original: string | null | undefined;
  try { original = identity(); } catch (error) { if (errorCode(error) === "ENOENT") original = null; }
  return () => {
    let current: string;
    // A missing folder may be a deletion still under way, which may roll back.
    try { current = identity(); } catch (error) { return errorCode(error) === "ENOENT" && reviewDeletionConfirmed(context.reviewId); }
    if (original === null || original === undefined) {
      // A new generation may have appeared while the initial identity was missing or
      // unreadable; the same generation is the same review, moved back by a rollback.
      try { if (readReview(context.reviewId).generation !== context.generation) return true; }
      catch (error) { return errorCode(error) === "REVIEW_UNAVAILABLE" && reviewDeletionConfirmed(context.reviewId); }
      original = current;
    }
    return current !== original;
  };
}
/** How long a viewer whose implementation was archived runs on after the last
 * request of a page arrived, so that open pages, which learn it from their
 * requests, can still tell. SEMANTIC_VIEW_ARCHIVED_IDLE_MS shortens it for tests. */
function archivedViewerIdleMs(): number {
  const configured = Number(process.env.SEMANTIC_VIEW_ARCHIVED_IDLE_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 10 * 60_000;
}
/** How long a stopping archived viewer lets requests in progress finish. */
const ARCHIVED_STOP_LIMIT_MS = 30_000;
interface ViewerServerOptions {
  viewerDir: string;
  port: number;
  access: ViewerAccess;
  repoRoot: string;
  implementationId: string;
  dataSource: ViewerWorker;
  viewerVersion: string;
  context: ReviewContext;
}

function serveViewer({
  viewerDir,
  port,
  access,
  repoRoot,
  implementationId,
  dataSource,
  viewerVersion,
  context,
}: ViewerServerOptions): Promise<http.Server> {
  const review = assertReviewContext(context);
  let server: http.Server | null = null;
  // Archiving ends the review: pages are told, and the viewer stops once no
  // page has made a request for archivedViewerIdleMs. Only requests that pass
  // the host and access checks count, when they arrive.
  // Idle time uses the monotonic clock, so a change to the system clock cannot shorten or extend it.
  let wasArchived = false, lastRequestAt = performance.now();
  /** Whether the implementation was archived; once it was, it stays so. */
  const archived = async () => {
    if (!wasArchived && await readReviewImplementationArchived(review)) wasArchived = true;
    return wasArchived;
  };
  /** Ends a viewer whose implementation was archived, releasing its record first
   * so no launch looks for it on its port. Requests in progress may finish, for
   * up to ARCHIVED_STOP_LIMIT_MS. */
  const stopArchived = () => {
    try {
      const recorded = readReview(context.reviewId).viewer;
      if (recorded?.processId === process.pid && recorded.port === port) recordViewer(context.reviewId, context.generation, undefined, recorded);
    } catch { /* A deleted or replaced review records no viewer of this one. */ }
    const done = () => process.exit(0);
    if (!server) { done(); return; }
    server.close(done);
    // A connection kept alive between requests would hold the server open.
    server.closeIdleConnections();
    setTimeout(done, ARCHIVED_STOP_LIMIT_MS).unref();
  };
  let management: ManagementWorker | null = null;
  const manage = (): ManagementWorker => {
    if (!management?.healthy) management = createViewerWorker(repoRoot, context, true);
    return management;
  };
  // A worker retired with its review no longer says why; the review's own
  // check does. The worker never returns, so a reason the check gave is kept.
  let retired: { reason: unknown } | undefined;
  const retiredReason = (error: unknown): unknown => {
    if (dataSource.healthy) return error;
    if (!retired) { try { assertReviewContext(context); } catch (cause) { retired = { reason: cause }; } }
    return retired ? retired.reason : error;
  };
  const plain = (response: http.ServerResponse, status: number, text: string) => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(text);
  };
  const requestHandler = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    /** Counts the request, once it passed the host and access checks, as use of
     * the viewer when it arrived, however long its body took. */
    const arrivedAt = performance.now();
    const use = () => { lastRequestAt = Math.max(lastRequestAt, arrivedAt); };
    for (const [name, value] of Object.entries(COMMON_HEADERS)) response.setHeader(name, value);
    // The request's jobs read the active refs once, in the worker, so checking
    // its review neither runs Git again nor holds up this thread.
    const jobs = dataSource.forRequest();
    // A queued request of a connection that closes gets no response to close,
    // so the connection closing releases it too.
    const socket = request.socket;
    socket.once("close", jobs.release);
    response.once("close", () => { socket.off("close", jobs.release); jobs.release(); });
    // A body can take any time to arrive, so jobs after it check the review again.
    request.once("end", jobs.restart);
    // Only requests addressed to this viewer by its own name are served.
    if (!ownHost(request, port)) { plain(response, 421, "Misdirected request."); return; }
    const target = request.url;
    if (!originFormTarget(target)) { plain(response, 400, "Bad request."); return; }
    let url: URL;
    try { url = new URL(target, `http://${VIEWER_HOST}:${port}`); }
    catch { plain(response, 400, "Bad request."); return; }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const param = (key: string) => url.searchParams.get(key);
    // Requests of the review, as opposed to the viewer's own and the page's start.
    const reviewRoute = pathname.startsWith("/api/") && !UNSCOPED_ROUTES.has(pathname);
    /** What a failed request of the review adds when its implementation was archived. */
    const archiveNotice = async (): Promise<Pick<Wire.ApiFailure, "implementationArchived">> =>
      reviewRoute && !reviewSessionUnavailable(context) && await archived() ? { implementationArchived: true } : {};
    /** Answers a failed request. A request of the review also says when its
     * implementation was archived, which may have refused it, so every refusal
     * ends the page's review, whatever step the archive overtook. */
    const failure = async (status: number, error: unknown, extra: Pick<Wire.ApiFailure, "reviewUnavailable"> = {}) => {
      sendJson<Wire.ApiFailure>(response, status, { ok: false, error: cliErrorMessage(error), ...extra, ...extra.reviewUnavailable ? {} : await archiveNotice() });
    };
    /** Answers a request whose review check failed, saying whether the review was
     * deleted or replaced, or else whether its implementation was archived. */
    const refuse = (error: unknown) => failure(409, retiredReason(error), { reviewUnavailable: reviewSessionUnavailable(context) });

    if (pathname.startsWith("/api/")) {
      if (!ownApiCaller(request, port)) {
        sendJson<Wire.ApiFailure>(response, 403, { ok: false, error: "Only the review page can use this service." }); return;
      }
      // A launch code takes the place of the key when the page starts.
      const exchange = request.method === "POST" && pathname === "/api/session";
      const keyed = sameSecret(request.headers[KEY_HEADER], access.key);
      const readable = request.method === "GET" && readTokenRoute(pathname, url) && sameSecret(param("read"), access.read);
      if (!exchange && !keyed && !readable) {
        sendJson<Wire.ApiFailure>(response, 403, { ok: false, error: FRESH_LINK_MESSAGE, keyRequired: true }); return;
      }
      // A launch code exchange counts once the code is redeemed.
      if (keyed || readable) use();
    }

    // Every review API request is explicitly scoped, even on a dedicated server.
    // Management/probing routes do not execute commands against the launch repo.
    if (pathname.startsWith("/api/") && !UNSCOPED_ROUTES.has(pathname)) {
      const scope: QueryText<Wire.ReviewQuery> = { review: param("review"), generation: param("generation") };
      if (scope.review !== context.reviewId || scope.generation !== context.generation) {
        sendJson<Wire.ApiFailure>(response, 409, { ok: false, error: "This request belongs to another review." }); return;
      }
      // Fetching updates checks only the review's identity, as it makes the projection again.
      try { if (!pathname.startsWith("/api/reviews") && pathname !== "/api/review-state" && pathname !== "/api/remote/refresh") await jobs.call("checkReview"); }
      catch (error) { await refuse(error); return; }
    }

    if (pathname === "/api/session" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Starting a session requires an application/json request.");
        const { code } = await readRequestFields(request, 4096);
        if (!access.redeem(code)) {
          sendJson<Wire.ApiFailure>(response, 403, { ok: false, error: FRESH_LINK_MESSAGE, keyRequired: true }); return;
        }
        use();
        sendJson<Wire.SessionResponse>(response, 200, { ok: true, key: access.key, read: access.read });
      } catch (error) { failure(400, error); }
      return;
    }
    if (pathname === "/api/launch" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Launch codes require an application/json request.");
        await readRequestFields(request, 4096);
        sendJson<Wire.LaunchResponse>(response, 200, { ok: true, code: access.mintCode() });
      } catch (error) { failure(400, error); }
      return;
    }
    if (pathname === "/api/bootstrap" && request.method === "GET") {
      let implementation: Wire.ImplementationData | Wire.UnavailableImplementationData;
      try { implementation = await jobs.call("implementation"); }
      catch (error) {
        const code = errorCode(error);
        const deleted = reviewSessionUnavailable(context);
        if (code !== "REVIEW_UNAVAILABLE" && code !== "REVIEW_TARGET_UNAVAILABLE" && !deleted) { failure(500, error); return; }
        // The saved-review manager remains usable after deletion or worktree removal.
        // A page loaded after an archive shows it at once, as no poll may run in a hidden tab.
        implementation = { implementationId, reviewId: context.reviewId, title: review.title, viewerReleaseVersion,
          summary: cliErrorMessage(error), stages: [], requirements: [], feedback: [], baseRevision: "", targetBranch: "",
          ...(!deleted && await archived() ? { implementationArchived: true as const } : {}) };
      }
      sendJson<Wire.BootstrapResponse>(response, 200, { ok: true, implementation, context: { reviewId: context.reviewId, generation: context.generation } });
      return;
    }

    if (review.remote && (pathname.startsWith("/api/feedback/") || pathname.startsWith("/api/agent/"))) {
      sendJson<Wire.ApiFailure>(response, 403, { ok: false, error: "Remote reviews support personal notes only." }); return;
    }
    if (pathname === "/api/remote/refresh" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Refreshing requires a same-origin request.");
        await jobs.call("refreshRemote", implementationId);
        sendJson<Wire.RemoteRefreshResponse>(response, 200, { ok: true });
      } catch (error) { failure(409, error); }
      return;
    }

    if (pathname === "/api/attachments" && request.method === "POST") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Uploading requires a same-origin request.");
        const { data, filename, mediaType } = parseAttachmentUpload(await readRequestFields(request, 29 * 1024 * 1024), MAX_ATTACHMENT_BYTES);
        // The upload may have taken long; the review is checked again before it is stored.
        try { await jobs.call("checkReview"); } catch (error) { await refuse(error); return; }
        const attachment = withReviewLock(context.reviewId, () => storeAttachment(context.reviewId, context.generation, filename, mediaType, Buffer.from(data, "base64")));
        sendJson<Wire.AttachmentUploadResponse>(response, 200, { ok: true, attachment });
      } catch (error) { failure(400, error); }
      return;
    }
    if (pathname.startsWith("/api/attachments/") && request.method === "GET") {
      try {
        const query = parseAttachmentQuery({ preview: param("preview") });
        const { attachment, bytes } = withReviewLock(context.reviewId, () => {
          if (readReview(context.reviewId).generation !== context.generation) throw new Error("The review session was replaced or deleted.");
          const attachment = resolveAttachment(context.reviewId, pathname.slice("/api/attachments/".length));
          const bytes = fs.readFileSync(attachment.localPath);
          if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("Attachment content is damaged.");
          return { attachment, bytes };
        });
        const preview = query.preview === "1" && imageMediaType(bytes);
        response.writeHead(200, { "content-type": preview || "application/octet-stream", "content-length": bytes.length,
          "content-disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" });
        response.end(bytes);
      } catch (error) { failure(404, error); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/draft-snapshots") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Draft snapshots require a same-origin request.");
        const fields = await readRequestFields(request);
        sendJson<Wire.DraftSnapshotsResponse>(response, 200, { ok: true, snapshots: await jobs.call("resolveDraftSnapshots", implementationId, fields) });
      } catch (error) { failure(409, error); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/approval-snapshots") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Approval snapshots require a same-origin request.");
        const fields = await readRequestFields(request);
        sendJson<Wire.ApprovalSnapshotsResponse>(response, 200, { ok: true, results: await jobs.call("captureApprovals", implementationId, fields) });
      } catch (error) { failure(409, error, { reviewUnavailable: reviewSessionUnavailable(context) }); }
      return;
    }
    if (request.method === "POST" && pathname === "/api/approval-comparison") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Approval snapshots require a same-origin request.");
        const fields = await readRequestFields(request);
        sendJson<Wire.ApprovalComparisonResponse>(response, 200, { ok: true, ...await jobs.call("compareApproval", implementationId, fields) });
      } catch (error) { failure(409, error); }
      return;
    }

    if (request.method === "POST" && ["/api/reviews/storage", "/api/reviews/delete", "/api/reviews/clean-unused"].includes(pathname)) {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Managing review data requires a same-origin request.");
        const payload = await readRequestFields(request);
        if (pathname === "/api/reviews/storage") sendJson<Wire.ReviewStorageResponse>(response, 200, { ok: true, storage: await manage().call("inspectStorage", parseReviewTarget(payload)) });
        else if (pathname === "/api/reviews/delete") sendJson<Wire.ReviewDeleteResponse>(response, 200, { ok: true, ...await manage().call("deleteStorage", parseStorageAction(payload)) });
        else sendJson<Wire.ReviewCleanResponse>(response, 200, { ok: true, ...await manage().call("cleanStorage", parseStorageAction(payload)) });
      } catch (error) { failure(409, error); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/reviews") {
      try { sendJson<Wire.ReviewsResponse>(response, 200, { ok: true, reviews: await manage().call("listReviews") }); }
      catch (error) { failure(409, error); }
      return;
    }
    if (request.method === "POST" && pathname === "/api/reviews/completion") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Changing completion requires a same-origin request.");
        await manage().call("setCompleted", parseCompletion(await readRequestFields(request)));
        sendJson<Wire.OkResponse>(response, 200, { ok: true });
      } catch (error) { failure(409, error); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/reviews/open") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Opening a review requires a same-origin request.");
        // Identities of another type fail the registry's own identity checks.
        const target: Wire.ReviewOpenRequest = parseReviewTarget(await readRequestFields(request));
        const prepared = await manage().call("prepareOpen", target);
        sendJson<Wire.ReviewOpenResponse>(response, 200, { ok: true, url: await openRegisteredReview(prepared) });
      } catch (error) { failure(409, error); }
      return;
    }

    if (pathname === "/api/review-state") {
      try {
        let result: Wire.ApiSuccess<Wire.ReviewStateResponse>;
        if (request.method === "GET") result = await jobs.call("readReview", review.id);
        else if (request.method === "POST" && isTrustedRequest(request, port)) {
          // The worker reads the changes after checking the review session.
          const fields = await readRequestFields(request);
          if (fields.reviewId !== review.id) throw new Error("This request belongs to another review.");
          result = await jobs.call("patchReviewState", review.id, fields);
        } else { sendJson<Wire.ApiFailure>(response, 403, { ok: false, error: "Review state requires a same-origin request." }); return; }
        sendJson<Wire.ReviewStateResponse>(response, 200, { ok: true, ...result });
      } catch (error) { failure(409, error, { reviewUnavailable: reviewSessionUnavailable(context) }); }
      return;
    }

    if (request.method === "POST" && pathname === "/api/agent/stop") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Agent controls require a same-origin request.");
        await readRequestFields(request);
        sendJson<Wire.AgentControlResponse>(response, 200, { ok: true, agent: await jobs.call("controlAgent", implementationId, "stop") });
      } catch (error) { failure(409, error); }
      return;
    }
    if (request.method === "POST" && pathname === "/api/agent/respond") {
      try {
        if (!isTrustedRequest(request, port)) throw new Error("Agent controls require a same-origin request.");
        const fields = await readRequestFields(request);
        sendJson<Wire.AgentControlResponse>(response, 200, { ok: true, agent: await jobs.call("controlAgent", implementationId, "respond", fields) });
      } catch (error) { failure(409, error); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/whoami") {
      sendJson<Wire.WhoAmIResponse>(response, 200, {
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
        sendJson<Wire.RevisionResponse>(response, 200, {
          ok: true,
          ...await jobs.call("snapshot", false),
        });
      } catch (error) {
        failure(500, error);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/evidence") {
      try {
        const query: QueryText<Wire.EvidenceQuery> = { stage: param("stage"), item: param("item"), index: param("index") };
        const result = await jobs.call("evidenceFile", query);
        const bytes = Buffer.from(result.content, "base64");
        const headers = { "content-type": result.mediaType, "accept-ranges": "bytes", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "no-store" };
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
      } catch (error) { failure(404, error); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/file-content") {
      try {
        const query = parseFileContentQuery({ stage: param("stage"), path: param("path"), base: param("base"), head: param("head"), target: param("target"), raw: param("raw"), image: param("image") });
        const result = await jobs.call("fileContent", query);
        const content = Buffer.from(result.content, "base64");
        if (query.raw === "1") {
          if (query.image === "1" && !result.mediaType.startsWith("image/")) throw new Error("Image unavailable at this revision.");
          response.writeHead(200, { "content-type": result.mediaType, "content-length": content.length, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "no-store" });
          response.end(content);
        } else sendJson<Wire.FileContentResponse>(response, 200, { ok: true, ...result, content: content.toString("utf8") });
      } catch (error) { failure(422, error); }
      return;
    }

    if (request.method === "GET" && pathname === "/api/diff") {
      const query: QueryText<Wire.DiffQuery> = {
        stage: param("stage"), path: param("path"), base: param("base"), head: param("head"),
        mode: param("mode"), offset: param("offset"), side: param("side"), line: param("line"),
      };
      if (!query.stage || !query.path || !query.base || !query.head) {
        sendJson<Wire.ApiFailure>(response, 400, {
          ok: false,
          error: "Diff requests require stage, path, base, and head query parameters.",
        });
        return;
      }
      try {
        sendJson<Wire.DiffResponse>(response, 200, {
          ok: true,
          ...await jobs.call("fileDiff", query),
        });
      } catch (error) {
        failure(422, error);
      }
      return;
    }

    // Controlled lifecycle shutdown; launching another review never uses this.
    if (request.method === "POST" && pathname === "/api/shutdown") {
      if (!isTrustedRequest(request, port)) {
        sendJson<Wire.ApiFailure>(response, 403, {
          ok: false,
          error: "Shutdown requires a same-origin application/json request.",
        });
        return;
      }
      sendJson<Wire.ShutdownResponse>(response, 200, { ok: true });
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
        jobs,
        port,
        failure,
        archiveNotice,
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
        { repoRoot, port, implementationId, jobs, failure, archiveNotice },
        action,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/api/implementation") {
      try {
        sendJson<Wire.ImplementationResponse>(response, 200, { ok: true, implementation: await jobs.call("implementation") });
      } catch (error) { failure(500, error); }
      return;
    }

    if (pathname.startsWith("/api/")) { failure(404, new Error("Unknown request.")); return; }
    const contentType = STATIC_FILES.get(pathname);
    if (!contentType) { plain(response, 404, "Not found"); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { plain(response, 405, "Method not allowed."); return; }
    fs.readFile(path.join(viewerDir, pathname.slice(1)), (error, content) => {
      if (error) { plain(response, 404, "Not found"); return; }
      response.writeHead(200, { ...PAGE_HEADERS, "content-type": contentType, "content-length": content.length, "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : content);
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
      const idle = archivedViewerIdleMs();
      let checking = false;
      const archiveCheck = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          // Idle time runs from the last request, not from when the archive was seen.
          if (!await archived() || performance.now() - lastRequestAt < idle) return;
          clearInterval(archiveCheck); stopArchived();
        } finally { checking = false; }
      }, Math.min(60_000, Math.ceil(idle / 10)));
      archiveCheck.unref(); httpServer.once("close", () => clearInterval(archiveCheck));
      const expiry = setInterval(() => { access.expire(); sweepLaunchFiles(context.reviewId, LAUNCH_CODE_LIFETIME_MS); }, 60_000);
      expiry.unref(); httpServer.once("close", () => clearInterval(expiry));
      resolve(httpServer);
    });
  });
}

/** One job of a job table. */
type Job = (...args: never[]) => unknown;

/** The jobs a worker runs: review management, or the data jobs of the review it
 * serves. The worker picks its table by the same flag. */
type WorkerJobs<Management extends boolean> = Management extends true ? ManagementJobs : ViewerJobs;

/** Runs one job of a job table with its parameters, resolving to its result. */
type JobCall<Jobs> = <Method extends keyof Jobs & string>(method: Method, ...args: Parameters<Extract<Jobs[Method], Job>>) => Promise<Awaited<ReturnType<Extract<Jobs[Method], Job>>>>;

/** The jobs of one request. They read the active refs at most once between
 * them, so they all see the artifact as the first of them read it. */
interface RequestJobs<Jobs> {
  readonly call: JobCall<Jobs>;
  /** Makes later jobs read the active refs again. */
  readonly restart: () => void;
  /** Ends the request's reads once its running jobs finish; call it once the
   * request is answered. Later jobs read the refs again each. */
  readonly release: () => void;
}

/** A running worker of a job table. */
interface JobWorker<Jobs> {
  /** Never set: names the job table, so that a worker of one table is not accepted
   * as a worker of another. Generic `call` signatures alone compare as compatible. */
  readonly jobs?: Jobs;
  readonly healthy: boolean;
  /** Runs one job with its parameters, resolving to its result. */
  readonly call: JobCall<Jobs>;
  /** Runs the jobs of one request. */
  forRequest(): RequestJobs<Jobs>;
  close(): Promise<number>;
}

/** Runs jobs in a data worker. The flag selects the worker's job table, and with it
 * the jobs a caller can request. */
function createViewerWorker<Management extends boolean>(repoRoot: string, context: ReviewContext, management: Management): JobWorker<WorkerJobs<Management>> {
  type Jobs = WorkerJobs<Management>;
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
  /** Runs one job. The overload gives each job's result its type: the worker runs this
   * module's own job for `method` and sends back plain data, which keeps its shape
   * across the structured clone between threads. */
  function send(scope: number | undefined, method: string, args: unknown[]): Promise<unknown> {
    if (stopped) return Promise.reject(new Error("Viewer worker is unavailable; reopen the viewer."));
    // A read is shared only within its scope: another request checked its review
    // against what it read, and must get data from that snapshot.
    const key = ["snapshot", "fileDiff", "fileContent", "implementation"].includes(method) ? JSON.stringify([method, args, scope ?? null]) : null;
    const shared = key ? reads.get(key) : undefined;
    if (shared) return shared;
    if (pending.size >= 64) return Promise.reject(new Error("Viewer is busy; retry after the current requests finish."));
    const id = ++sequence;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args, scope });
    });
    if (key) {
      reads.set(key, promise);
      promise.finally(() => reads.delete(key)).catch(() => {});
    }
    return promise;
  }
  function call<Method extends keyof Jobs & string>(method: Method, ...args: Parameters<Extract<Jobs[Method], Job>>): Promise<Awaited<ReturnType<Extract<Jobs[Method], Job>>>>;
  function call(method: string, ...args: unknown[]): Promise<unknown> { return send(undefined, method, args); }
  let scopes = 0;
  return {
    get healthy() { return !stopped; },
    call,
    forRequest() {
      let current: number | undefined = ++scopes;
      // The scopes jobs were sent in, by how many of them still run. A scope
      // is released once it is no longer current and none of its jobs runs.
      const running = new Map<number, number>();
      const retire = (scope: number) => {
        if (scope === current || running.get(scope) !== 0) return;
        running.delete(scope);
        if (!stopped) worker.postMessage({ release: scope });
      };
      function scoped<Method extends keyof Jobs & string>(method: Method, ...args: Parameters<Extract<Jobs[Method], Job>>): Promise<Awaited<ReturnType<Extract<Jobs[Method], Job>>>>;
      function scoped(method: string, ...args: unknown[]): Promise<unknown> {
        const scope = current;
        if (scope === undefined) return send(undefined, method, args);
        running.set(scope, (running.get(scope) ?? 0) + 1);
        const promise = send(scope, method, args);
        const settled = () => { running.set(scope, (running.get(scope) ?? 1) - 1); retire(scope); };
        promise.then(settled, settled);
        return promise;
      }
      const leave = () => { const scope = current; current = undefined; if (scope !== undefined) retire(scope); };
      return { call: scoped, restart: () => { leave(); current = ++scopes; }, release: leave };
    },
    close() { return worker.terminate(); },
  };
}

type ViewerDataSource = ReturnType<typeof createViewerDataSource>;
type ViewerWorker = JobWorker<ViewerJobs>;
type ManagementWorker = JobWorker<ManagementJobs>;

// --- Worker side. Jobs arrive from this module's own main thread, typed by the job
// table. Their parameters are the shared protocol types the main thread parsed,
// or request fields a job parses itself after the checks that came first before.

function parseWorkerContext(value: unknown): ReviewContext {
  const reviewId = stringField(value, "reviewId"), generation = stringField(value, "generation");
  const repositoryRoot = stringField(value, "repositoryRoot"), implementationId = stringField(value, "implementationId");
  if (reviewId === undefined || generation === undefined || repositoryRoot === undefined || implementationId === undefined) {
    throw new Error("The viewer worker started without a review context.");
  }
  return Object.freeze({ reviewId, generation, repositoryRoot, implementationId });
}

// Management survives retirement of the launching review. Every job uses
// its explicitly selected target; no repository command is allowed here
// beyond checking a review and fetching a remote review's branch to open it.
const managementJobs = {
  inspectStorage: ({ reviewId, generation }: Wire.ReviewTarget): Wire.ReviewStorage => inspectReviewStorage(reviewId, generation),
  deleteStorage: ({ reviewId, generation, fingerprint }: Wire.ReviewStorageActionRequest) => deleteReviewData(reviewId, generation, fingerprint),
  cleanStorage: ({ reviewId, generation, fingerprint }: Wire.ReviewStorageActionRequest) => cleanUnusedReviewFiles(reviewId, generation, fingerprint),
  listReviews: (): Wire.ReviewSummary[] => registeredReviews(),
  prepareOpen: ({ reviewId, generation }: Wire.ReviewTarget): ReviewContext => prepareRegisteredReview(reviewId, generation),
  setCompleted: ({ reviewId, generation, completed, expectedCompletedAt }: Wire.ReviewCompletionRequest) => {
    setReviewCompleted(reviewId, generation, completed, expectedCompletedAt);
  },
};

/** The data worker's jobs for one review. Each checks that the review is still
 * the one this viewer serves; repository jobs also check the active implementation. */
function viewerJobs(root: string, context: ReviewContext, source: ViewerDataSource) {
  /** State jobs check the stored session, and return the record they checked. */
  const session = (reviewId: string) => {
    const record = readReview(context.reviewId);
    if (reviewId !== context.reviewId || record.generation !== context.generation) throw new Error("The review session was replaced or deleted.");
    return record;
  };
  const review = () => { assertReviewContext(context); }; // Includes queued repository reads and commands.
  const implementation = (implementationId: string) => {
    review();
    if (reviewedImplementationId(root) !== implementationId) throw new Error("The active implementation changed; reopen the viewer.");
  };
  const storedState = (record: ReviewRecord) => ({ reviewId: record.id, generation: record.generation, state: record.state, stateRevision: record.stateRevision, lastSaveId: record.lastSaveId ?? null });
  return {
    /** Checks that the review is still the one this viewer serves. */
    checkReview: (): void => review(),
    reviewedImplementationId: (): string => reviewedImplementationId(root),
    feedbackThread: (threadId: string): Thread | null => readFeedbackThread(root, threadId),
    readReview: (reviewId: string): ReviewStateBody => storedState(session(reviewId)),
    patchReviewState: (reviewId: string, fields: JsonRecord): ReviewStateBody => {
      session(reviewId);
      const { generation, changes, saveId } = parseStatePatch(fields);
      return storedState(patchReviewState(context.reviewId, generation, changes, saveId));
    },
    snapshot: (refresh: boolean): Wire.ViewerSnapshot => {
      review();
      return { ...source.snapshot(refresh), agent: agentStatus(readAgentState(context.reviewId), Date.now()) };
    },
    fileDiff: (query: QueryText<Wire.DiffQuery>): Promise<DiffPage> => {
      review();
      const { stage, path: filePath, base, head, mode, offset, side, line } = parseDiffQuery(query);
      return source.fileDiff(stage ?? "", filePath ?? "", base ?? "", head ?? "", mode, offset, side, line);
    },
    fileContent: (query: ReceivedQuery<Wire.FileContentQuery>) => {
      review();
      return source.fileContent(query.stage, query.path, query.base, query.head, query.target);
    },
    implementation: (): Wire.ImplementationData => { review(); return source.implementationData(); },
    evidenceFile: (query: QueryText<Wire.EvidenceQuery>) => { review(); return source.evidenceFile(query.stage, query.item, query.index); },
    // The refresh makes the projection again, so it needs the review only, not a
    // readable projection: an interrupted refresh may have left none.
    refreshRemote: (implementationId: string) => {
      assertReviewContext(context, "skip");
      if (implementationId !== context.implementationId) throw new Error("The active implementation changed; reopen the viewer.");
      refreshRemoteReview(context.reviewId, context.generation);
    },
    resolveDraftSnapshots: (implementationId: string, fields: JsonRecord): (Wire.DraftSnapshot | null)[] => {
      implementation(implementationId);
      const notes = parseDraftSnapshotNotes(fields);
      const resolved = resolveLineDraftSnapshots(root, notes.filter((note) => note !== null));
      let next = 0;
      return notes.map((note) => note ? resolved[next++].snapshot ?? null : null);
    },
    // Approval requests are read here, after the implementation check, and their
    // comparison options after the file, as each was checked before.
    /** Retains each named file's content; a file the page shows differently from
     * the server, or whose content cannot be read, fails alone. */
    captureApprovals: (implementationId: string, fields: JsonRecord): Wire.ApprovalSnapshotResult[] => {
      implementation(implementationId);
      const data = source.implementationData();
      const endpoints = parseApprovalEndpoints(fields).map((input) => {
        try { return approvedFileEndpoint(input, data); }
        catch (error) { return { error: errorMessage(error) }; }
      });
      const resolved = endpoints.filter((endpoint): endpoint is FileEndpoint => !("error" in endpoint));
      const captured = captureApprovalSnapshots(context, resolved);
      let next = 0;
      return endpoints.map((endpoint) => "error" in endpoint ? endpoint : captured[next++]);
    },
    compareApproval: (implementationId: string, fields: JsonRecord) => {
      implementation(implementationId);
      const current = approvedFileEndpoint(parseApprovalEndpoint(fields), source.implementationData());
      const { snapshotId, offset, mode, scope } = parseApprovalComparison(fields);
      return compareApprovalSnapshot(context, snapshotId, current, offset, mode, scope);
    },
    sendFeedback: (request: ReceivedFeedbackExport) => {
      implementation(request.implementationId);
      return sendReceivedFeedback({ repoRoot: root, context }, request.notes, request.replies);
    },
    /** Stops the agent, or answers its question with the request's fields. */
    controlAgent: (implementationId: string, action: "stop" | "respond", fields?: JsonRecord): Wire.AgentStatus => {
      implementation(implementationId);
      return controlAgent(context, action, fields);
    },
    exportFeedbackReplies: (implementationId: string, drafts: Received<Wire.FeedbackReplyExport>[]) => {
      implementation(implementationId);
      return exportReceivedReplies({ repoRoot: root, context }, drafts);
    },
    setThreadStatus: (implementationId: string, threadId: string, status: Wire.ThreadStatus) => {
      implementation(implementationId);
      const feedback = feedbackFor(context);
      if (status === "resolved") feedback.resolveThread(threadId);
      else feedback.reopenThread(threadId);
    },
  };
}

type ReviewStateBody = Wire.ApiSuccess<Wire.ReviewStateResponse>;
type ViewerJobs = ReturnType<typeof viewerJobs>;
type ManagementJobs = typeof managementJobs;

/** Runs one job a message names. Its parameters were typed by the main thread
 * that sent them, so only the job's name is checked here. */
function runJob(jobs: object, method: unknown, args: unknown, unknownJob: string): unknown {
  const job: unknown = typeof method === "string" && Object.hasOwn(jobs, method) ? Reflect.get(jobs, method) : undefined;
  if (typeof job !== "function" || !isList(args)) throw new Error(unknownJob);
  return Reflect.apply(job, jobs, args);
}

/** Viewer jobs that read only review data, never the active refs of a request's
 * scope. Changing review data reads whether the implementation was archived
 * from Git itself, under the review lock. */
const REF_FREE_JOBS = new Set<string>(["readReview", "patchReviewState"]);

function serveWorkerJobs(port: MessagePort, root: string, context: ReviewContext, management: boolean) {
  const jobs = management ? managementJobs : viewerJobs(root, context, createViewerDataSource(root));
  const unknownJob = management ? "Unknown review management operation." : "Unknown viewer operation.";
  // The refs each open request read. Viewer jobs only read active refs; moving
  // one, as deleting a review does, is a management job, which runs unscoped.
  // Each scope's refs are read first without blocking the worker, so a job
  // waits for Git only while other jobs run.
  const scopes = new Map<number, { reads: ActiveRefReads; preloaded: Promise<void> | undefined }>();
  // The main thread releases each scope once no job of it runs any more. The
  // cap only bounds scopes whose release was lost: one dropped too early is
  // read again.
  const MAX_SCOPES = 1024;
  const scoped = (scope: unknown) => {
    if (management || typeof scope !== "number") return undefined;
    let found = scopes.get(scope);
    if (!found) {
      scopes.set(scope, found = { reads: new Map(), preloaded: undefined });
      for (const oldest of scopes.keys()) { if (scopes.size <= MAX_SCOPES) break; scopes.delete(oldest); }
    }
    return found;
  };
  /** Reads the scope's refs first, unless the job needs none. */
  const preload = (found: { reads: ActiveRefReads; preloaded: Promise<void> | undefined }, method: unknown) => {
    if (typeof method === "string" && REF_FREE_JOBS.has(method)) return undefined;
    return found.preloaded ??= readingActiveRefsOnce(found.reads, async () => {
      for (const at of new Set([context.repositoryRoot, root])) await preloadActiveRefs(at);
    });
  };
  port.on("message", async (message: unknown) => {
    const { id, method, args, scope, release } = fieldsOf(message);
    if (release !== undefined) { if (typeof release === "number") scopes.delete(release); return; }
    try {
      const found = scoped(scope);
      if (found) await preload(found, method);
      const result = await (found ? readingActiveRefsOnce(found.reads, () => runJob(jobs, method, args, unknownJob)) : runJob(jobs, method, args, unknownJob));
      port.postMessage({ id, result });
    } catch (error) { port.postMessage({ id, error: cliErrorMessage(error), code: errorCode(error) }); }
  });
}

const startup: unknown = workerData;
if (!isMainThread && parentPort && isRecord(startup) && typeof startup.repoRoot === "string" && startup.repoRoot) {
  serveWorkerJobs(parentPort, startup.repoRoot, parseWorkerContext(startup.context), Boolean(startup.management));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const browserOpening = () => !process.env.SEMANTIC_VIEW_NO_OPEN;

/** Opens the viewer in the browser with a launch code of its own. Where other
 * users can list process arguments, the browser opens a private launch file that
 * forwards to the launch URL, so the code never appears in an argument. */
function openBrowser(reviewId: string, port: number, code: string) {
  try {
    const target = opensLaunchUrl() ? launchUrl(port, code) : writeLaunchFile(reviewId, port, code);
    const { command, args, cwd } = browserOpener(target);
    execFileSync(command, args, { cwd, stdio: "ignore", windowsHide: true });
  } catch {
    // Non-fatal: the URL is printed for manual use.
  }
}

/** Whether a process is running. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
}

/** The viewer on `port`, read with the key this review records for that port.
 * A viewer that refuses the key is not this review's, except while this review's
 * record names no viewer on that port: a concurrent launch of the same review
 * records its key right after it starts listening, so the record is read again
 * for about two seconds. A server that is no keyed viewer, and a viewer on a port
 * that another review records for its running viewer, are foreign at once. */
export async function identifyOccupant(context: Pick<ReviewContext, "reviewId">, port: number): Promise<ViewerIdentity | null> {
  const recorded = () => {
    try { const viewer = readReview(context.reviewId).viewer; return viewer?.port === port ? viewer : undefined; }
    catch { return undefined; }
  };
  const viewer = recorded();
  const probe = await probeViewerAccess(port, { key: viewer?.key });
  if (!probe.refused || viewer) return probe.identity;
  let otherReview = false;
  try { otherReview = listReviews().some((review) => review.id !== context.reviewId && review.viewer?.port === port && processAlive(review.viewer.processId)); }
  catch { /* Unreadable records name no viewer. */ }
  if (otherReview) return null;
  for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
    await delay(100);
    const next = recorded();
    if (next) return next.key ? probeViewer(port, { key: next.key }) : null;
  }
  return null;
}

/** Records this process as the review's viewer. When the record already names a
 * running viewer of the same review on another port that `reusable` accepts, a
 * concurrent launch got there first: that viewer is returned and the record is
 * left alone. The record is written only while it is unchanged since it was read
 * and the review still records the worktree this launch serves; a launch that a
 * later launch outdated fails and leaves the record to that launch's viewer. */
export async function claimViewerRecord<Running extends ViewerIdentity>(
  context: Pick<ReviewContext, "reviewId" | "generation" | "repositoryRoot">,
  viewer: ViewerRecord,
  reusable: (occupant: ViewerIdentity | null) => occupant is Running,
): Promise<Running | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = readReview(context.reviewId).viewer ?? null;
    if (current && current.port !== viewer.port && current.key && processAlive(current.processId)) {
      const occupant = await probeViewer(current.port, { key: current.key });
      if (reusable(occupant)) return occupant;
    }
    const recorded = withReviewLock(context.reviewId, () => {
      if (!viewerLaunchCurrent(context)) throw new Error("The review changed while this viewer started, so another viewer serves it now. Launch the review again to open it.");
      return recordViewer(context.reviewId, context.generation, viewer, current);
    });
    if (recorded) return null;
  }
  throw new Error("The review's viewer record kept changing during startup. Launch the review again.");
}

function implementationSummary(repoRoot: string) {
  const artifact = readViewerArtifact(repoRoot);
  const { manifest } = artifact;
  const fileCount = manifest.stages.reduce((total, stageId) => {
    const stage = artifact.stage(stageId);
    return total + stage.change.files.length;
  }, 0);
  return {
    implementationId: manifest.implementationId,
    // The launcher shows the implementation ID for a manifest without a title.
    ...(manifest.title ? { title: manifest.title } : {}),
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

let startupWorker: ViewerWorker | undefined;

/** The review session a reopened viewer must serve, as its launcher named it. */
interface RequestedReview {
  reviewId: string;
  generation: string;
}

/** Runs `semantic-flow viewer serve`: the long-running viewer server, normally
 * started detached by `semantic-flow review` or by reopening a saved review. */
export async function runViewerCommand(argv: string[]): Promise<void> {
  try {
    const { positionals, options } = parseArguments(argv);
    const [command, ...paths] = positionals;
    if (options.has("help") && (!command || command === "serve")) {
      flag(options, "help");
      assertKnownOptions(options, new Set(["help", "review", "generation"]));
      console.log(VIEWER_USAGE);
      await startupWorker?.close();
      return;
    }
    if (command !== "serve") fail(VIEWER_USAGE);
    assertKnownOptions(options, new Set(["review", "generation"]));
    const reviewOption = option(options, "review"), generation = option(options, "generation");
    if ((reviewOption === undefined) !== (generation === undefined)) fail(VIEWER_USAGE);
    const requested = reviewOption !== undefined && generation !== undefined ? { reviewId: reviewOption, generation } : null;
    // Feedback changes run in this process; Git must see only the reviewed worktree.
    isolateReviewEnvironment();
    // The viewer, its workers and the commands it runs act on the reviewed implementation.
    if (requested) selectImplementation(readReview(requested.reviewId).implementationId);
    await serve(resolveRepositoryRoot(paths), requested);
  } catch (error) {
    await startupWorker?.close();
    notifyLauncher({ type: "error", message: errorMessage(error) });
    if (process.exitCode === undefined || process.exitCode === 0) {
      console.error(`semantic-view: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

async function serve(launchRoot: string, requested: RequestedReview | null) {
  const viewerDir = locateViewerDir();
  const implementation = implementationSummary(launchRoot);
  // A direct start keeps acting on the implementation it found, whatever else becomes active later.
  if (!requested) selectImplementation(implementation.implementationId);
  const registered = requested
    ? readReview(requested.reviewId)
    : registerReview(launchRoot, implementation.implementationId, implementation.title ?? "");
  const context = captureReviewContext(registered.id);
  if (requested && (reviewId(launchRoot, implementation.implementationId) !== context.reviewId || requested.reviewId !== context.reviewId || requested.generation !== context.generation)) throw new Error("The requested review session changed before startup.");
  // All worktrees of the repository share the review. The viewer serves the one the
  // review records, whichever worktree launched it, so its identity matches the
  // review context and a later launch from any worktree finds it running.
  const repoRoot = context.repositoryRoot;
  const dataSource = createViewerWorker(repoRoot, context, false);
  startupWorker = dataSource;
  const fingerprint = createHash("sha256");
  fingerprint.update(viewerReleaseVersion);
  for (const file of [fileURLToPath(import.meta.url), ...["boot.js", "app.js", "markdown.js", "styles.css", "index.html"].map((name) => path.join(viewerDir, name))]) {
    fingerprint.update(fs.readFileSync(file));
  }
  const viewerVersion = fingerprint.digest("hex");

  const access = createViewerAccess(context.reviewId);
  let port = registered.viewer?.port || viewerPort();
  let server: http.Server | null = null;
  const fallback = 20000 + (Number.parseInt(context.reviewId.slice(-64, -56), 16) % 40000);
  // A viewer of this review is recognized by the review, not by the worktree it
  // serves: one serving a worktree the review no longer records is replaced.
  const matching = (occupant: ViewerIdentity | null): occupant is ViewerIdentity => occupant !== null && occupant.reviewId === context.reviewId && occupant.generation === context.generation && occupant.reviewHome === reviewHome();
  const reusable = (occupant: ViewerIdentity | null): occupant is ViewerIdentity & { key: string; port: number } =>
    matching(occupant) && occupant.healthy !== false && occupant.viewerVersion === viewerVersion && occupant.repositoryRoot === context.repositoryRoot && Boolean(occupant.key) && Boolean(occupant.port);
  /** Hands the launch to a running viewer of this review. */
  const reuse = async ({ port: running, key, processId }: ViewerIdentity & { key: string; port: number }) => {
    // The printed URL and the opened browser each get their own code, so
    // opening the browser does not spend the printed link.
    const code = await requestLaunchCode(running, key);
    if (!code) throw new Error(`The viewer running at http://${VIEWER_HOST}:${running}/ did not provide a link. Launch the review again.`);
    const url = launchUrl(running, code);
    // `key` is read by tests that start `viewer serve` directly (workflow-helper.test.mjs).
    notifyLauncher({ type: "ready", url, key, repositoryRoot: repoRoot, reviewId: context.reviewId, processId, implementation });
    console.log(`Reusing semantic review viewer: ${url}`);
    if (browserOpening()) {
      const browserCode = await requestLaunchCode(running, key);
      if (browserCode) openBrowser(context.reviewId, running, browserCode);
    }
  };
  for (let attempt = 0; attempt < 40 && !server; attempt++) {
    try {
      server = await serveViewer({ viewerDir, port, access, repoRoot, implementationId: implementation.implementationId, dataSource, viewerVersion, context });
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(errorCode(error) ?? "")) throw error;
      const occupant = await identifyOccupant(context, port);
      if (reusable(occupant)) {
        await dataSource.close();
        await reuse(occupant);
        return;
      }
      if (process.env.SEMANTIC_VIEW_NO_REPLACE) throw new Error(`Port ${port} was occupied before the updated viewer could restart; refusing to replace it.`);
      if (matching(occupant)) {
        // Read the review again right before stopping it: a viewer that a later
        // launch started for the worktree the review now records must stay.
        if (!viewerLaunchCurrent(context)) {
          throw new Error(`The review changed while this viewer started, so the viewer running at http://${VIEWER_HOST}:${port}/ is kept. Launch the review again to open it.`);
        }
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
  const listening: http.Server = server;
  const close = () => new Promise<void>((resolve) => { listening.close(() => resolve()); listening.closeAllConnections(); });
  let running;
  try {
    running = await claimViewerRecord(context, { port, processId: process.pid, viewerVersion, skillDirectory: path.resolve(scriptDir, ".."), key: access.key }, reusable);
  } catch (error) {
    // Without its record no launch finds this viewer: stop listening.
    await close();
    throw error;
  }
  if (running) {
    await close();
    await dataSource.close();
    await reuse(running);
    return;
  }
  // Launch files of an earlier viewer of this review hold codes it alone knew.
  sweepLaunchFiles(context.reviewId, 0);
  const url = launchUrl(port, access.mintCode());
  console.log(`Semantic review viewer: ${url}`);
  console.log(`Project: ${repoRoot}`);
  console.log(
    `Implementation: ${implementation.title} — ${implementation.stageCount} stages, ${implementation.fileCount} files`,
  );
  console.log("Press Ctrl+C to stop.");
  notifyLauncher({
    type: "ready",
    url,
    // Read by tests that start `viewer serve` directly (workflow-helper.test.mjs).
    key: access.key,
    repositoryRoot: repoRoot,
    processId: process.pid,
    reviewId: context.reviewId,
    implementation,
  });
  if (browserOpening()) openBrowser(context.reviewId, port, access.mintCode());
}
