#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  commandOptionNames,
  renderCliHelp,
  reviewFeedbackApi,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  flag,
  option,
  parseArguments,
  repeatedOption,
  type Options,
} from "./shared/arguments.js";
import {
  FEEDBACK_MANIFEST_SCHEMA_ID,
  INSIGHT_COLLECTIONS,
  THREAD_SCHEMA_ID,
  isFeedbackId,
  type Comment,
  type CommentAuthor,
  type FeedbackManifest,
  type FileChange,
  type ImplementationManifest,
  type InsightCollection,
  type LineTarget,
  type Specification,
  type Stage,
  type Target,
  type TargetKind,
  type Thread,
} from "./shared/documents.js";
import { fail } from "./shared/errors.js";
import { factCache, withValidationContext } from "./shared/validation-context.js";
import { git, gitRaw } from "./shared/git.js";
import { locateLineAnchors } from "./shared/line-anchors.js";
import { shownStageFiles } from "./shared/stage-files.js";
import { parseJson, readJson } from "./shared/json.js";
import { errorMessage, isRecord, isStringArray } from "./shared/narrow.js";
import { parseDocument } from "./shared/schema-validation.js";
import { activeImplementationId, readArtifact } from "./shared/artifact-store.js";
import { loadImplementation } from "./shared/implementation.js";
import { atomicJson, readReview, readReviewArtifact, registerReview, relocateReview, reviewId, reviewDirectory, touchReview, withReviewLock } from "./shared/review-store.js";

import { isDeepStrictEqual } from "node:util";
import { attachmentReferences, resolveAttachment, storeAttachment, validateAttachmentReferences, MAX_ATTACHMENT_BYTES, type Attachment } from "./shared/review-attachments.js";
import { awaitsAgentReply, latestUserCommentId } from "./shared/feedback-awaiting.js";
import { addRequest, claimActive, claimedThreadIds, claimedThrough, createClaim, liveSession, readAgentState, recordAgentReplies, roundThrough, sendInProgress, touchAgent, updateAgentState, type ClaimedThread } from "./shared/agent-session.js";

const renamedPathFacts = factCache<string | null>();
const renameMapFacts = factCache<string | null>();
const lineCountFacts = factCache<number>();

/** A viewer session that asks for feedback changes on behalf of its reviewer. */
export interface FeedbackRequester {
  reviewId: string;
  generation: string;
}

/** Locations of one review's artifact and feedback state. */
interface FeedbackPaths {
  root: string;
  /** The viewer session a change is made for; it must still be the current one. */
  requester: FeedbackRequester | null;
  implementationId: string;
  reviewId: string;
  feedback: string;
  feedbackManifest: string;
  threads: string;
}

/** The validated implementation artifact feedback targets refer to. */
interface SemanticArtifact {
  manifest: ImplementationManifest;
  requirements: Map<string, Specification>;
  stages: Map<string, Stage>;
}

/** The validated feedback manifest and its threads, keyed by thread ID. */
interface Feedback {
  manifest: FeedbackManifest;
  threads: Map<string, Thread>;
}

type ResolvedAttachment = ReturnType<typeof resolveAttachment>;
type ResolvedComment = Omit<Comment, "attachments"> & { attachments: ResolvedAttachment[] };
type AgentReply = { threadId: string; claimId?: string };


function commentAttachments(paths: FeedbackPaths, options: Options): Attachment[] { return attachmentReferences(paths.reviewId, repeatedOption(options, "attachments")); }
function commentInput(paths: FeedbackPaths, options: Options): { body: string; attachments: Attachment[] } {
  const body = option(options, "body") || "", attachments = commentAttachments(paths, options);
  if (!body.trim() && !attachments.length) fail("A message requires text or at least one attachment.");
  return { body, attachments };
}
function agentComments(paths: FeedbackPaths, comments: Comment[]): ResolvedComment[] { return comments.map((comment) => ({ ...comment, attachments: (comment.attachments || []).map((attachment) => resolveAttachment(paths.reviewId, attachment.id)) })); }
/** Whether the innermost locked feedback operation wrote a document. */
let feedbackWritten = false;
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicJson(file, value);
  feedbackWritten = true;
}

const HELP = renderCliHelp(reviewFeedbackApi);

function repositoryRoot(): string {
  const root: unknown = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (typeof root !== "string") fail("Cannot determine the repository root.");
  return path.resolve(root);
}

function pathsFor(root: string, requester: FeedbackRequester | null = null): FeedbackPaths {
  // A remote review's checkout has no active artifact; its projection names the
  // review, so feedback commands reach the remote review's own refusal.
  const snapshot = readReviewArtifact(root)?.files;
  if (!snapshot) fail("No active semantic implementation exists.");
  // Only the identity is needed here; commands that use the artifact validate it.
  const implementationId = activeImplementationId(root, snapshot);
  const id = reviewId(root, implementationId);
  // A review found from a new location records it when the old one no longer works.
  relocateReview(id, root);
  return reviewPaths(root, implementationId, id, requester);
}

/** The feedback paths of review id, which the implementation in root has. */
function reviewPaths(root: string, implementationId: string, id: string, requester: FeedbackRequester | null): FeedbackPaths {
  const feedback = path.join(reviewDirectory(id), "feedback");
  return {
    root,
    requester,
    implementationId,
    reviewId: id,
    feedback,
    feedbackManifest: path.join(feedback, "manifest.json"),
    threads: path.join(feedback, "threads"),
  };
}

function withFeedbackLock<T>(paths: FeedbackPaths, action: () => T): T {
  const recordFile = path.join(reviewDirectory(paths.reviewId), "review.json");
  const generation = fs.existsSync(recordFile) ? readReview(paths.reviewId).generation : null;
  return withReviewLock(paths.reviewId, () => {
    const { requester } = paths;
    if (requester && (paths.reviewId !== requester.reviewId || readReview(paths.reviewId).generation !== requester.generation)) fail("The initiating review was deleted or replaced.");
    if (generation && readReview(paths.reviewId).generation !== generation) fail("The review session changed. Retry from the current review.");
    // A review deleted before this command registered it must not be written again.
    if (!generation && reviewId(paths.root, paths.implementationId) !== paths.reviewId) fail("The review was deleted. Retry the command.");
    // The lock is reentrant, so an enclosing operation's write flag is kept.
    const enclosingWrote = feedbackWritten;
    feedbackWritten = false;
    try {
      const result = action();
      if (feedbackWritten && fs.existsSync(recordFile)) touchReview(paths.reviewId);
      return result;
    } finally {
      feedbackWritten = enclosingWrote || feedbackWritten;
    }
  });
}

/** Keeps the reviewed feedback state stable through a workflow's final mutation. */
export function withCheckedFeedback<T>(root: string, requireResolved: boolean, action: () => T): T {
  const paths = pathsFor(root);
  return withFeedbackLock(paths, () => {
    if (fs.existsSync(paths.feedbackManifest)) {
      validateFeedback(paths, { quiet: true, requireResolved });
    } else if (fs.existsSync(paths.feedback) && fs.readdirSync(paths.feedback).length) {
      fail(`Incomplete feedback state in ${paths.feedback}: manifest.json is missing.`);
    }
    return action();
  });
}

function listJsonIds(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

function semanticArtifact(paths: FeedbackPaths): SemanticArtifact {
  const files = readArtifact(paths.root);
  if (!files) fail("No active semantic implementation exists.");
  const { manifest, requirements, stages } = loadImplementation(paths.root, files, { includeWork: false });
  if (manifest.implementationId !== paths.implementationId) fail("The active implementation changed. Retry from the current review.");
  return { manifest, requirements, stages };
}

/** Reads the feedback manifest and the unvalidated threads it lists; validateFeedback validates each thread. */
function loadFeedback(paths: FeedbackPaths): { manifest: FeedbackManifest; threads: Map<string, unknown> } {
  if (!fs.existsSync(paths.feedbackManifest)) fail("No feedback manifest exists for this review.");
  const value = readJson(paths.feedbackManifest);
  if (!isRecord(value) || value.formatVersion !== "0.1" || !Array.isArray(value.threads)) {
    fail(
      "This feedback workspace uses an unsupported v0.1 layout.",
    );
  }
  const manifest = parseDocument(FEEDBACK_MANIFEST_SCHEMA_ID, value, paths.feedbackManifest);
  const threads = new Map<string, unknown>();
  for (const id of manifest.threads) {
    threads.set(id, readJson(path.join(paths.threads, `${id}.json`)));
  }
  return { manifest, threads };
}

function collectionExists(stage: Stage, collection: InsightCollection, itemId: string): boolean {
  // Evidence can be removed, for example when a capture leaks a secret, without moving the
  // stage head. Its threads stay valid; the viewer shows them on the stage instead.
  if (collection === "evidence") return true;
  const items: readonly { id: string }[] = stage[collection];
  return items.some((item) => item.id === itemId);
}

function changedFileAt(stage: Stage, repositoryPath: string): FileChange | undefined {
  return stage.change.files.find(
    (file) => file.path === repositoryPath || file.previousPath === repositoryPath,
  );
}

function renamedPathBetween(root: string, fromRevision: string, toRevision: string, repositoryPath: string): string | null {
  return renamedPathFacts(JSON.stringify([root, fromRevision, toRevision, repositoryPath]), () => readRenamedPath(root, fromRevision, toRevision, repositoryPath));
}

function readRenamedPath(root: string, fromRevision: string, toRevision: string, repositoryPath: string): string | null {
  const raw = renameMapFacts(JSON.stringify([root, fromRevision, toRevision]), (): string | null => {
    const output: unknown = git([
      "--no-pager",
      "diff",
      "--name-status",
      "-z",
      "--find-renames=50%",
      fromRevision,
      toRevision,
    ], {
      cwd: root,
      allowFailure: true,
    });
    return typeof output === "string" ? output : null;
  });
  if (raw === null) return null;
  const fields = raw.split("\0");
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (status.startsWith("R") && previousPath === repositoryPath) {
        return currentPath;
      }
    } else {
      index += 1;
    }
  }
  return null;
}

function lineCountAtRevision(root: string, revision: string, repositoryPath: string): number {
  return lineCountFacts(JSON.stringify([root, revision, repositoryPath]), () => readLineCount(root, revision, repositoryPath));
}

function readLineCount(root: string, revision: string, repositoryPath: string): number {
  const contents: unknown = gitRaw(["show", `${revision}:${repositoryPath}`], {
    cwd: root,
    encoding: "buffer",
  });
  if (!Buffer.isBuffer(contents)) fail(`Cannot read ${repositoryPath} at ${revision}.`);
  if (contents.includes(0)) {
    fail(`Feedback line target ${repositoryPath} is binary.`);
  }
  if (contents.length === 0) return 0;
  let lineBreaks = 0;
  for (const byte of contents) {
    if (byte === 0x0a) lineBreaks += 1;
  }
  return contents.at(-1) === 0x0a ? lineBreaks : lineBreaks + 1;
}

function validateLineTarget(target: LineTarget, stage: Stage, root: string): void {
  const file = changedFileAt(stage, target.path);
  if (!file) return;

  const oldPath = file.previousPath ?? file.path;
  const snapshot =
    target.side === "old"
      ? {
          revision: stage.change.baseRevision,
          path: oldPath,
          missing: file.kind === "added",
        }
      : {
          revision: stage.change.headRevision,
          path: file.path,
          missing: file.kind === "deleted",
        };
  if (snapshot.missing || target.path !== snapshot.path) {
    fail(
      `Feedback ${target.side} line target ${target.path} does not exist on that diff side.`,
    );
  }
  const lineCount = lineCountAtRevision(root, snapshot.revision, snapshot.path);
  if (target.line > lineCount) {
    fail(
      `Feedback line ${target.line} exceeds ${snapshot.path}'s ${lineCount} line(s) on the ${target.side} side.`,
    );
  }
}

function validateTarget(target: Target, semantic: SemanticArtifact, root: string): void {
  if (target.kind === "specification" || target.kind === "criterion") {
    const specification = semantic.requirements.get(target.specificationId);
    if (!specification) {
      fail(`Feedback target specification ${target.specificationId} does not exist.`);
    }
    if (
      target.kind === "criterion" &&
      !specification.acceptanceCriteria.some(
        (criterion) => criterion.id === target.criterionId,
      )
    ) {
      fail(
        `Feedback target criterion ${target.specificationId}#${target.criterionId} does not exist.`,
      );
    }
    return;
  }

  const stage = semantic.stages.get(target.stageId);
  if (!stage) fail(`Feedback target stage ${target.stageId} does not exist.`);
  if (
    target.stageBranch !== stage.change.branch ||
    target.stageHead !== stage.change.headRevision
  ) {
    return;
  }
  if (
    target.kind === "node" &&
    !stage.nodes.some((node) => node.id === target.nodeId)
  ) {
    fail(`Feedback node ${target.stageId}/${target.nodeId} does not exist.`);
  }
  if (
    target.kind === "insight" &&
    !collectionExists(stage, target.collection, target.itemId)
  ) {
    fail(
      `Feedback insight ${target.stageId}/${target.collection}/${target.itemId} does not exist.`,
    );
  }
  if ((target.kind === "file" || target.kind === "line") && !changedFileAt(stage, target.path)) {
    fail(`Feedback path ${target.path} is not changed by ${target.stageId}.`);
  }
  if (target.kind === "line") {
    validateLineTarget(target, stage, root);
  }
}

function validateFeedback(
  paths: FeedbackPaths,
  { quiet = false, requireResolved = false }: { quiet?: boolean; requireResolved?: boolean } = {},
): { semantic: SemanticArtifact; feedback: Feedback } {
  const semantic = semanticArtifact(paths);
  const { manifest, threads: storedThreads } = loadFeedback(paths);
  if (manifest.implementationId !== semantic.manifest.implementationId) {
    fail("Feedback implementationId does not match the active semantic implementation.");
  }

  const listedThreads = new Set(manifest.threads);
  for (const id of listJsonIds(paths.threads)) {
    if (!listedThreads.has(id)) fail(`Unlisted feedback thread ${id}.`);
  }

  const threads = new Map<string, Thread>();
  for (const [id, value] of storedThreads) {
    const thread = parseDocument(THREAD_SCHEMA_ID, value, path.join(paths.threads, `${id}.json`));
    if (thread.id !== id) {
      fail(`Feedback thread ${id} has internal ID ${thread.id}.`);
    }
    const commentIds = new Set<string>();
    if (thread.comments[0]?.author !== "user") {
      fail(`Feedback thread ${id} must begin with a user comment.`);
    }
    for (const comment of thread.comments) {
      if (commentIds.has(comment.id)) {
        fail(`Feedback thread ${id} repeats comment ID ${comment.id}.`);
      }
      if (comment.respondsTo !== undefined) {
        const answered = thread.comments.find((item) => item.id === comment.respondsTo);
        if (comment.author !== "agent" || !commentIds.has(comment.respondsTo) || answered?.author !== "user") {
          fail(`Feedback thread ${id} comment ${comment.id} must answer an earlier user comment.`);
        }
      }
      commentIds.add(comment.id);
      validateAttachmentReferences(paths.reviewId, comment.attachments);
    }
    validateTarget(thread.target, semantic, paths.root);
    if (!semantic.stages.has(thread.assignedStageId)) {
      fail(
        `Feedback thread ${id} is assigned to missing stage ${thread.assignedStageId}.`,
      );
    }
    threads.set(id, thread);
  }

  if (requireResolved) {
    const open = [...threads.values()]
      .filter((thread) => thread.status === "open")
      .map((thread) => thread.id);
    if (open.length) {
      fail(`Unresolved feedback threads: ${open.join(", ")}.`);
    }
  }

  if (!quiet) {
    console.log(
      `Feedback validation passed: ${threads.size} thread(s).`,
    );
  }
  return { semantic, feedback: { manifest, threads } };
}

function initialize(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, "init"));
  console.log(`Initialized feedback for ${initializeFeedback(paths)}.`);
}

/** Creates empty feedback state and returns the implementation ID it belongs to. */
function initializeFeedback(paths: FeedbackPaths): string {
  if (fs.existsSync(paths.feedbackManifest)) fail("Feedback state already exists.");
  if (fs.existsSync(paths.feedback) && fs.readdirSync(paths.feedback).length > 0) {
    fail(
      `${paths.feedback} already contains files but has no manifest. Inspect or remove it before initialization.`,
    );
  }
  const semantic = semanticArtifact(paths);
  try {
    const manifest: FeedbackManifest = {
      $schema: FEEDBACK_MANIFEST_SCHEMA_ID,
      formatVersion: "0.1",
      implementationId: semantic.manifest.implementationId,
      threads: [],
    };
    writeJson(paths.feedbackManifest, manifest);
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(paths.feedback, { recursive: true, force: true });
    throw error;
  }
  return semantic.manifest.implementationId;
}

const TARGET_KINDS = ["specification", "criterion", "stage", "node", "insight", "file", "line"] as const satisfies readonly TargetKind[];

/** Builds a target from command options. Field order matches stored targets, which retries compare as JSON. */
function buildTarget(options: Options, semantic: SemanticArtifact, root: string): Target {
  const kindOption = option(options, "target-kind", { required: true });
  const label = option(options, "label", { required: true });
  const kind = TARGET_KINDS.find((candidate) => candidate === kindOption);
  if (!kind) fail(`--target-kind must be one of ${TARGET_KINDS.join(", ")}.`);
  let target: Target;
  if (kind === "specification") {
    target = { kind, label, specificationId: option(options, "specification", { required: true }) };
  } else if (kind === "criterion") {
    const specificationId = option(options, "specification", { required: true });
    target = { kind, label, specificationId, criterionId: option(options, "criterion", { required: true }) };
  } else {
    const stageId = option(options, "stage", { required: true });
    const stage = semantic.stages.get(stageId);
    if (!stage) fail(`Stage ${stageId} does not exist.`);
    const anchor = { stageId, stageBranch: stage.change.branch, stageHead: stage.change.headRevision };
    if (kind === "stage") {
      target = { kind, label, ...anchor };
    } else if (kind === "node") {
      target = { kind, label, ...anchor, nodeId: option(options, "node", { required: true }) };
    } else if (kind === "insight") {
      const collectionOption = option(options, "collection", { required: true });
      const itemId = option(options, "item", { required: true });
      const collection = INSIGHT_COLLECTIONS.find((candidate) => candidate === collectionOption);
      if (!collection) fail(`--collection must be one of ${INSIGHT_COLLECTIONS.join(", ")}.`);
      target = { kind, label, ...anchor, collection, itemId };
    } else if (kind === "file") {
      target = { kind, label, ...anchor, path: option(options, "path", { required: true }) };
    } else {
      const targetPath = option(options, "path", { required: true });
      const sideOption = option(options, "side", { required: true });
      const line = Number(option(options, "line", { required: true }));
      if (!Number.isInteger(line) || line < 1) {
        fail("--line must be a positive integer.");
      }
      if (sideOption !== "old" && sideOption !== "new") fail("--side must be old or new.");
      target = { kind, label, ...anchor, path: targetPath, side: sideOption, line };
    }
  }
  validateTarget(target, semantic, root);
  return target;
}

function writeThread(paths: FeedbackPaths, thread: Thread): void {
  writeJson(path.join(paths.threads, `${thread.id}.json`), thread);
}

function createThread(paths: FeedbackPaths, options: Options, semantic: SemanticArtifact, knownIds: Set<string>): Thread {
  const id = option(options, "id", { required: true });
  if (knownIds.has(id)) fail(`Feedback thread ${id} already exists.`);
  const target = buildTarget(options, semantic, paths.root);
  const assignedStageId =
    option(options, "assigned-stage") ?? target.stageId;
  const assignedStage = assignedStageId === undefined ? undefined : semantic.stages.get(assignedStageId);
  if (assignedStageId === undefined || !assignedStage) {
    fail("Feedback threads require a valid assigned stage.");
  }
  const now = new Date().toISOString();
  const thread = parseDocument(THREAD_SCHEMA_ID, {
    $schema: THREAD_SCHEMA_ID,
    id,
    status: "open",
    comments: [
      {
        id: option(options, "comment-id", { required: true }),
        author: "user",
        ...commentInput(paths, options),
        createdAt: now,
      },
    ],
    target,
    assignedStageId,
    stageHead: assignedStage.change.headRevision,
    createdAt: now,
  }, "Feedback thread input");
  knownIds.add(id);
  return thread;
}

function addThreads(paths: FeedbackPaths, optionSets: Options[]): Thread[] {
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const knownIds = new Set(feedback.threads.keys());
  const threads = optionSets.map((options) =>
    createThread(paths, options, semantic, knownIds),
  );
  const oldManifest = structuredClone(feedback.manifest);
  feedback.manifest.threads.push(...threads.map((thread) => thread.id));
  const files = threads.map((thread) =>
    path.join(paths.threads, `${thread.id}.json`),
  );
  try {
    for (const thread of threads) writeThread(paths, thread);
    writeJson(paths.feedbackManifest, feedback.manifest);
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    for (const file of files) fs.rmSync(file, { force: true });
    writeJson(paths.feedbackManifest, oldManifest);
    throw error;
  }
  return threads;
}

function addThread(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add"),
  );
  const [thread] = addThreads(paths, [options]);
  console.log(`Added feedback thread ${thread.id}.`);
}

function batchThreadOptions(value: unknown, index: number): Options {
  if (!isRecord(value)) {
    fail(`Feedback thread batch item ${index + 1} must be an object.`);
  }
  const options: Options = new Map();
  for (const [name, item] of Object.entries(value)) {
    if (name === "attachments" && isStringArray(item)) {
      options.set(name, item);
    } else if (typeof item === "string") {
      options.set(name, [item]);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      options.set(name, [String(item)]);
    } else {
      fail(
        `Feedback thread batch item ${index + 1} option ${name} must be a string or finite number.`,
      );
    }
  }
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add"),
  );
  return options;
}

/** The non-empty JSON array a batch option carries; each item is narrowed separately. */
function batchItems(options: Options, name: "threads" | "replies"): unknown[] {
  const raw = option(options, name, { required: true });
  let values: unknown;
  try {
    values = parseJson(raw);
  } catch {
    fail(`--${name} must contain a JSON array.`);
  }
  if (!Array.isArray(values) || values.length === 0) {
    fail(`--${name} must contain a non-empty JSON array.`);
  }
  const items: unknown[] = values;
  return items;
}

function addThreadBatch(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add-batch"),
  );
  const values = batchItems(options, "threads");
  if (flag(options, "partial")) {
    console.log(JSON.stringify(partialFeedbackBatch(paths, values, "add")));
    return;
  }
  const threads = addThreads(
    paths,
    values.map((value, index) => batchThreadOptions(value, index)),
  );
  console.log(`Added ${threads.length} feedback thread(s).`);
}

/** Moves a copy of a pending target to its stage's current head, or returns null when it cannot follow safely. */
function refreshableTarget(target: Target, semantic: SemanticArtifact, root: string): Target | null {
  if (target.kind === "line") return null;
  if (target.kind === "specification") {
    return semantic.requirements.has(target.specificationId) ? target : null;
  }
  if (target.kind === "criterion") {
    const specification = semantic.requirements.get(target.specificationId);
    return specification?.acceptanceCriteria.some(
      (criterion) => criterion.id === target.criterionId,
    )
      ? target
      : null;
  }

  const stage = semantic.stages.get(target.stageId);
  if (!stage) return null;
  if (target.kind === "node") {
    if (!stage.nodes.some((node) => node.id === target.nodeId)) return null;
  } else if (target.kind === "insight") {
    if (!collectionExists(stage, target.collection, target.itemId)) return null;
  } else if (target.kind === "file") {
    let changedFile = changedFileAt(stage, target.path);
    if (!changedFile) {
      const renamedPath = renamedPathBetween(
        root,
        target.stageHead,
        stage.change.headRevision,
        target.path,
      );
      changedFile = renamedPath ? changedFileAt(stage, renamedPath) : undefined;
    }
    if (!changedFile) return null;
    if (
      changedFile.path !== target.path &&
      target.stageHead !== stage.change.headRevision
    ) {
      const previousPath = target.path;
      target.path = changedFile.path;
      if (target.label === previousPath) target.label = changedFile.path;
    }
  }

  target.stageBranch = stage.change.branch;
  target.stageHead = stage.change.headRevision;
  return target;
}

function refreshPendingAnchor(paths: FeedbackPaths, semantic: SemanticArtifact, thread: Thread): boolean {
  const before = JSON.stringify({
    stageHead: thread.stageHead,
    target: thread.target,
  });
  const target = refreshableTarget({ ...thread.target }, semantic, paths.root);
  if (!target) return false;
  const assignedStage = semantic.stages.get(thread.assignedStageId);
  if (!assignedStage) return false;
  thread.stageHead = assignedStage.change.headRevision;
  thread.target = target;
  if (before === JSON.stringify({
    stageHead: thread.stageHead,
    target: thread.target,
  })) {
    return false;
  }
  return true;
}

interface CompactComment { author: CommentAuthor; body: string; attachments?: ResolvedAttachment[] }
/** A compact target omits the anchor its stage group already states. */
type CompactTarget = Omit<Target, "stageBranch" | "stageHead">;
/** `currentLine`: where a line target's unchanged line now stands, while it is not stale. */
export interface CompactThread { id: string; stale: boolean; reanchored?: true; currentLine?: number; comments: CompactComment[]; target: CompactTarget }
interface FullThread { id: string; stageHead: string; comments: ResolvedComment[]; target: Target }
export interface FeedbackGroup<T extends CompactThread | FullThread = CompactThread | FullThread> {
  stageId: string;
  stageBranch: string;
  stageBase?: string;
  stageHead: string;
  threads: T[];
}

/** Feedback awaiting the agent; with a claim, the threads it took for one round. */
export interface PendingFeedback<T extends CompactThread | FullThread = CompactThread | FullThread> {
  stages: FeedbackGroup<T>[];
  claim?: { id: string | null; claimedElsewhere: number };
}

function nextFeedback(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, "next"));
  const json = flag(options, "json");
  const compact = flag(options, "compact");
  if (compact && !json) fail("--compact requires --json.");
  const claim = flag(options, "claim");
  const sessionId = option(options, "session") ?? null;
  if (claim && !json) fail("--claim requires --json.");
  if (sessionId && !claim) fail("--session requires --claim.");
  const pending = pendingFeedback(paths, { compact, claim, sessionId });
  const groups = pending.stages;
  if (pending.claim) {
    console.log(JSON.stringify({ claim: pending.claim.id, claimedElsewhere: pending.claim.claimedElsewhere, stages: groups }, null, compact ? undefined : 2));
    return;
  }
  if (json) {
    console.log(JSON.stringify(groups, null, compact ? undefined : 2));
    return;
  }
  if (!groups.length) {
    console.log("No open feedback remains.");
    return;
  }
  for (const group of groups) {
    console.log(`${group.stageId} (${group.stageBranch} @ ${group.stageHead}):`);
    for (const thread of group.threads) {
      console.log(`  ${thread.id}:`);
      for (const comment of thread.comments) {
        console.log(`    ${comment.author}: ${comment.body}`);
        for (const attachment of comment.attachments || []) console.log(`      ${attachment.filename}: ${attachment.localPath}`);
      }
    }
  }
}

function pendingFeedback(
  paths: FeedbackPaths,
  { compact, claim, sessionId }: { compact: boolean; claim: boolean; sessionId: string | null },
): PendingFeedback {
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  let awaiting = [...feedback.threads.values()].filter(awaitsAgentReply);
  let claimedElsewhere = 0;
  if (claim) {
    // The caller holds the review lock, so this exclusion and the claim below are one step.
    const state = readAgentState(paths.reviewId);
    if (sessionId && liveSession(state)?.id !== sessionId) fail("This interactive review session was replaced or stopped.");
    // A viewer send writes notes and replies separately; the listener takes them together.
    if (sessionId && sendInProgress(state, Date.now())) awaiting = [];
    const taken = claimedThreadIds(state, Date.now());
    claimedElsewhere = awaiting.filter((thread) => taken.has(thread.id)).length;
    awaiting = awaiting.filter((thread) => !taken.has(thread.id));
  }
  const reanchored = new Set<string>();
  const originals = new Map<string, Thread>();
  for (const thread of awaiting) {
    originals.set(thread.id, structuredClone(thread));
    if (refreshPendingAnchor(paths, semantic, thread)) reanchored.add(thread.id);
  }
  if (reanchored.size) {
    for (const thread of awaiting) {
      if (!reanchored.has(thread.id)) continue;
      parseDocument(
        THREAD_SCHEMA_ID,
        thread,
        path.join(paths.threads, `${thread.id}.json`),
      );
      validateTarget(thread.target, semantic, paths.root);
    }
    try {
      for (const thread of awaiting) {
        if (reanchored.has(thread.id)) writeThread(paths, thread);
      }
      validateFeedback(paths, { quiet: true });
    } catch (error) {
      for (const [id, thread] of originals) {
        if (reanchored.has(id)) writeThread(paths, thread);
      }
      throw error;
    }
  }
  // A line thread is current while its line still has a row in the stage's diff.
  const lineThreads = compact ? awaiting.flatMap((thread) => {
    const target = thread.target;
    const stage = target.kind === "line" ? semantic.stages.get(target.stageId) : undefined;
    return target.kind === "line" && stage ? [{ thread, target, stage }] : [];
  }) : [];
  // Files as the review shows them, as the viewer locates its lines.
  const ordered = semantic.manifest.stages.flatMap((id) => {
    const stage = semantic.stages.get(id);
    return stage ? [{ ...stage, id }] : [];
  });
  const shownFiles = new Map(shownStageFiles(ordered).map((files, index) => [ordered[index].id, files]));
  const currentLines = new Map(locateLineAnchors(paths.root, lineThreads.map(({ target, stage }) => ({
    anchor: target,
    stage: stage.change,
    file: shownFiles.get(target.stageId)?.find((file) => file.path === target.path),
  }))).map((line, index) => [lineThreads[index].thread.id, line]));
  const groups: FeedbackGroup[] = [];
  const listed: Thread[] = [];
  for (const [stageId, stage] of semantic.stages) {
    const threads = awaiting.filter(
      (thread) => thread.assignedStageId === stageId,
    );
    if (threads.length) {
      listed.push(...threads);
      groups.push(
        compact
          ? {
              stageId,
              stageBranch: stage.change.branch,
              stageBase: stage.change.baseRevision,
              stageHead: stage.change.headRevision,
              threads: threads.map((thread): CompactThread => {
                const {
                  stageBranch: _targetBranch,
                  stageHead: targetHead,
                  ...target
                } = thread.target;
                const targetStage = target.stageId
                  ? semantic.stages.get(target.stageId)
                  : null;
                const currentLine = target.kind === "line" ? currentLines.get(thread.id) ?? null : null;
                return {
                  id: thread.id,
                  stale: target.kind === "line"
                    ? currentLine === null
                    : thread.stageHead !== stage.change.headRevision ||
                      Boolean(
                        targetHead &&
                          targetStage &&
                          targetHead !== targetStage.change.headRevision,
                      ),
                  ...(reanchored.has(thread.id) ? { reanchored: true } : {}),
                  ...(currentLine !== null ? { currentLine } : {}),
                  comments: agentComments(paths, thread.comments).map(({ author, body, attachments }) => ({ author, body, ...(attachments.length ? { attachments } : {}) })),
                  target,
                };
              }),
            }
          : {
              stageId,
              stageBranch: stage.change.branch,
              stageHead: stage.change.headRevision,
              threads: threads.map((thread): FullThread => ({
                id: thread.id,
                stageHead: thread.stageHead,
                comments: agentComments(paths, thread.comments),
                target: thread.target,
              })),
            },
      );
    }
  }
  if (claim) {
    const claimed = listed.map((thread): ClaimedThread => {
      const through = latestUserCommentId(thread);
      // Awaiting threads end with an unanswered user comment.
      if (!through) fail(`Feedback thread ${thread.id} has no user comment.`);
      return { id: thread.id, through };
    });
    const claimId = updateAgentState(paths.reviewId, (state, now) =>
      createClaim(state, now, sessionId, claimed));
    return { stages: groups, claim: { id: claimId, claimedElsewhere } };
  }
  return { stages: groups };
}

function replyThread(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply"),
  );
  const [{ id, commentId }] = replyThreads(paths, [options]);
  console.log(`Added reply ${commentId} to feedback thread ${id}.`);
}

/** The thread reopened: open status and no resolution time, fields otherwise in place. */
function reopened(thread: Thread): Thread {
  const { resolvedAt: _resolvedAt, ...rest } = thread;
  return { ...rest, status: "open" };
}

function applyReply(paths: FeedbackPaths, options: Options, feedback: Feedback): { id: string; commentId: string; thread: Thread } {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply"),
  );
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  const commentId = option(options, "comment-id", { required: true });
  if (thread.comments.some((comment) => comment.id === commentId)) {
    fail(`Comment ${commentId} already exists in thread ${id}.`);
  }
  const author = option(options, "author") || "user";
  if (author !== "user" && author !== "agent") {
    fail("--author must be user or agent.");
  }
  // An agent reply answers what its round claimed; comments added meanwhile stay queued.
  // Naming the round fences late replies from a round that was replaced or expired.
  const claimId = option(options, "claim");
  if (claimId && author !== "agent") fail("--claim applies only to agent replies.");
  let respondsTo: string | undefined;
  if (author === "agent") {
    const state = readAgentState(paths.reviewId);
    respondsTo = claimId ? roundThrough(state, claimId, id) : claimedThrough(state, Date.now(), id) ?? latestUserCommentId(thread);
    if (!respondsTo) fail(`Feedback thread ${id} is not part of round ${claimId}.`);
  }
  thread.comments.push({
    id: commentId,
    author,
    ...commentInput(paths, options),
    createdAt: new Date().toISOString(),
    ...(respondsTo ? { respondsTo } : {}),
  });
  const replied = thread.status === "resolved" ? reopened(thread) : thread;
  feedback.threads.set(id, replied);
  return { id, commentId, thread: replied };
}

function agentReplies(optionSets: Options[]): AgentReply[] {
  return optionSets.filter((options) => option(options, "author") === "agent")
    .map((options) => ({ threadId: option(options, "id", { required: true }), claimId: option(options, "claim") }));
}

function replyThreads(paths: FeedbackPaths, optionSets: Options[]): { id: string; commentId: string; thread: Thread }[] {
  const { feedback } = validateFeedback(paths, { quiet: true });
  const originals = new Map<string, Thread>();
  for (const options of optionSets) {
    const id = option(options, "id", { required: true });
    const thread = feedback.threads.get(id);
    if (thread && !originals.has(id)) {
      originals.set(id, structuredClone(thread));
    }
  }
  const replies = optionSets.map((options) => applyReply(paths, options, feedback));
  try {
    for (const id of originals.keys()) {
      const thread = feedback.threads.get(id);
      if (thread) writeThread(paths, thread);
    }
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    for (const thread of originals.values()) writeThread(paths, thread);
    throw error;
  }
  recordReplies(paths, agentReplies(optionSets));
  return replies;
}

function batchReplyOptions(value: unknown, index: number): Options {
  if (!isRecord(value)) {
    fail(`Feedback reply batch item ${index + 1} must be an object.`);
  }
  const options: Options = new Map();
  for (const [name, item] of Object.entries(value)) {
    if (name === "attachments" && isStringArray(item)) {
      options.set(name, item);
    } else if (typeof item === "string") {
      options.set(name, [item]);
    } else {
      fail(
        `Feedback reply batch item ${index + 1} option ${name} must be a string.`,
      );
    }
  }
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply"),
  );
  return options;
}

function replyThreadBatch(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply-batch"),
  );
  const values = batchItems(options, "replies");
  // A batch-level round applies to every agent reply that does not name its own.
  const claim = option(options, "claim");
  const items = claim
    ? values.map((value) => isRecord(value) && value.author === "agent" && !("claim" in value) ? { ...value, claim } : value)
    : values;
  if (flag(options, "partial")) {
    console.log(JSON.stringify(partialFeedbackBatch(paths, items, "reply")));
    return;
  }
  const replies = replyThreads(
    paths,
    items.map((value, index) => batchReplyOptions(value, index)),
  );
  console.log(`Added ${replies.length} feedback reply/replies.`);
}

export interface PartialBatchResult {
  accepted: { index: number; id: string; commentId: string | undefined }[];
  rejected: { index: number; error: string }[];
}

// Validate item inputs in memory, then write the valid subset in one transaction.
// Store/lock/artifact errors propagate; only item validation errors are skipped.
function partialFeedbackBatch(paths: FeedbackPaths, values: unknown[], mode: "add" | "reply"): PartialBatchResult {
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const originalManifest = structuredClone(feedback.manifest);
  const originals = new Map<string, Thread | undefined>();
  const changed = new Set<string>();
  const knownIds = new Set<string>(feedback.threads.keys());
  const accepted: PartialBatchResult["accepted"] = [];
  const rejected: PartialBatchResult["rejected"] = [];
  const replies: AgentReply[] = [];
  for (const [index, value] of values.entries()) {
    let id: string | undefined;
    let before: Thread | undefined;
    try {
      const options = mode === "add" ? batchThreadOptions(value, index) : batchReplyOptions(value, index);
      id = option(options, "id", { required: true });
      const current = feedback.threads.get(id);
      before = current ? structuredClone(current) : undefined;
      if (!originals.has(id)) originals.set(id, before);
      if (before) {
        const commentId = option(options, "comment-id", { required: true });
        const existing = before.comments.find((comment) => comment.id === commentId);
        if (existing) {
          const author = mode === "add" ? "user" : option(options, "author") || "user";
          const body = option(options, "body") || "";
          const attachments = commentAttachments(paths, options);
          const target = mode === "add" ? buildTarget(options, semantic, paths.root) : undefined;
          const sameTarget = !target || JSON.stringify(before.target) === JSON.stringify(target);
          const sameAssignment = !target || before.assignedStageId === (option(options, "assigned-stage") ?? target.stageId);
          if (existing.author !== author || existing.body !== body || !isDeepStrictEqual(existing.attachments || [], attachments) || !sameTarget || !sameAssignment) fail(`Comment ${commentId} already exists with different input.`);
          accepted.push({ index, id, commentId });
          continue;
        }
      }
      if (mode === "add") {
        const thread = createThread(paths, options, semantic, knownIds);
        feedback.threads.set(id, thread);
        feedback.manifest.threads.push(id);
      } else {
        const reply = applyReply(paths, options, feedback);
        parseDocument(THREAD_SCHEMA_ID, reply.thread, "Feedback reply input");
        if (option(options, "author") === "agent") replies.push({ threadId: id, claimId: option(options, "claim") });
      }
      changed.add(id);
      accepted.push({ index, id, commentId: option(options, "comment-id") });
    } catch (error) {
      if (id !== undefined) {
        if (before) feedback.threads.set(id, before);
        else feedback.threads.delete(id);
      }
      rejected.push({ index, error: errorMessage(error) });
    }
  }
  if (changed.size) {
    try {
      for (const id of changed) {
        const thread = feedback.threads.get(id);
        if (thread) writeThread(paths, thread);
      }
      if (mode === "add") writeJson(paths.feedbackManifest, feedback.manifest);
      validateFeedback(paths, { quiet: true });
    } catch (error) {
      for (const id of changed) {
        const original = originals.get(id);
        if (original) writeThread(paths, original);
        else fs.rmSync(path.join(paths.threads, `${id}.json`), { force: true });
      }
      if (mode === "add") writeJson(paths.feedbackManifest, originalManifest);
      throw error;
    }
    recordReplies(paths, replies.filter((reply) => changed.has(reply.threadId)));
  }
  return { accepted, rejected };
}

function recordReplies(paths: FeedbackPaths, replies: AgentReply[]): void {
  if (replies.length) updateAgentState(paths.reviewId, (state, now) => recordAgentReplies(state, now, replies));
}

/** Shows a question that is not about one thread in the viewer; its answer returns through `feedback`. */
function askReviewer(paths: FeedbackPaths, options: Options): void {
  const id = option(options, "id", { required: true });
  if (!isFeedbackId(id)) fail("--id must be a lowercase hyphenated identifier of at most 80 characters.");
  const body = option(options, "body", { required: true }).trim();
  if (!body || body.length > 4000) fail("--body must contain 1 to 4000 characters.");
  const choices = repeatedOption(options, "choice").map((choice) => choice.trim());
  if (choices.length > 6 || choices.some((choice) => !choice || choice.length > 200)) fail("Use at most six nonblank --choice values of up to 200 characters.");
  updateAgentState(paths.reviewId, (state, now) => addRequest(state, now, id, body, choices));
  console.log(`Asked the reviewer in the viewer (${id}). The answer is returned by the next feedback command.`);
}

/** Describes the running round's current work in the viewer. */
function reportProgress(paths: FeedbackPaths, options: Options): void {
  const body = option(options, "body", { required: true }).trim();
  if (!body || body.length > 200) fail("--body must contain 1 to 200 characters.");
  updateAgentState(paths.reviewId, (state, now) => {
    const session = liveSession(state)?.id ?? null;
    const claims = state.claims.filter((claim) => claimActive(claim, now));
    const claim = claims.filter((item) => item.sessionId === session).at(-1) ?? claims.at(-1);
    if (!claim) fail("No feedback round is in progress.");
    claim.note = body;
    touchAgent(state, now, [claim.id]);
  });
  console.log("Updated the viewer's progress note.");
}

function resolveThread(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread resolve"),
  );
  const id = option(options, "id", { required: true });
  resolveThreadById(paths, id, option(options, "comment-id"), option(options, "body"));
  console.log(`Resolved feedback thread ${id}.`);
}

function resolveThreadById(paths: FeedbackPaths, id: string, commentId: string | undefined, body: string | undefined): void {
  const { feedback } = validateFeedback(paths, { quiet: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "open") {
    fail(`Feedback thread ${id} is not open.`);
  }
  const resolvedAt = new Date().toISOString();
  if (commentId && body) {
    if (thread.comments.some((comment) => comment.id === commentId)) {
      fail(`Comment ${commentId} already exists in thread ${id}.`);
    }
    thread.comments.push({
      id: commentId,
      author: "user",
      body,
      createdAt: resolvedAt,
    });
  } else if (commentId || body) {
    fail("--comment-id and --body must be provided together.");
  }
  writeThread(paths, { ...thread, status: "resolved", resolvedAt });
  validateFeedback(paths, { quiet: true });
}

function reopenThread(paths: FeedbackPaths, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reopen"),
  );
  const id = option(options, "id", { required: true });
  reopenThreadById(paths, id);
  console.log(`Reopened feedback thread ${id}.`);
}

function reopenThreadById(paths: FeedbackPaths, id: string): void {
  const { feedback } = validateFeedback(paths, { quiet: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "resolved") {
    fail(`Feedback thread ${id} is not resolved.`);
  }
  writeThread(paths, reopened(thread));
  validateFeedback(paths, { quiet: true });
}

function rejectExtraPositionals(positionals: string[]): void {
  const extra = positionals.slice(2);
  if (extra.length) fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
}

function printHelp(positionals: string[], options: Options): void {
  rejectExtraPositionals(positionals);
  const help = options.get("help");
  if (help && (help.length !== 1 || help[0] !== true)) {
    fail("--help is a flag.");
  }
  console.log(HELP);
}

function dispatch(paths: FeedbackPaths, positionals: string[], options: Options): void {
  rejectExtraPositionals(positionals);
  const [command, subcommand] = positionals;
  if (command === "init" && !subcommand) return initialize(paths, options);
  if (command === "thread" && subcommand === "add") {
    return addThread(paths, options);
  }
  if (command === "thread" && subcommand === "add-batch") {
    return addThreadBatch(paths, options);
  }
  if (command === "next" && !subcommand) return nextFeedback(paths, options);
  if (command === "thread" && subcommand === "reply") {
    return replyThread(paths, options);
  }
  if (command === "thread" && subcommand === "reply-batch") {
    return replyThreadBatch(paths, options);
  }
  if (command === "attachment" && subcommand === "add") {
    const file = path.resolve(process.cwd(), option(options, "file", { required: true }));
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_ATTACHMENT_BYTES) fail("Choose a local file of 20 MiB or smaller.");
    const attachment = storeAttachment(paths.reviewId, readReview(paths.reviewId).generation, path.basename(file), option(options, "media-type") || "application/octet-stream", fs.readFileSync(file));
    console.log(JSON.stringify(resolveAttachment(paths.reviewId, attachment.id), null, 2)); return;
  }
  if (command === "attachment" && subcommand === "show") {
    console.log(JSON.stringify(resolveAttachment(paths.reviewId, option(options, "id", { required: true })), null, 2)); return;
  }
  if (command === "thread" && subcommand === "resolve") {
    return resolveThread(paths, options);
  }
  if (command === "agent" && subcommand === "ask") return askReviewer(paths, options);
  if (command === "agent" && subcommand === "progress") return reportProgress(paths, options);
  if (command === "thread" && subcommand === "reopen") {
    return reopenThread(paths, options);
  }
  if (command === "validate" && !subcommand) {
    assertKnownOptions(
      options,
      commandOptionNames(reviewFeedbackApi, "validate"),
    );
    validateFeedback(paths, {
      requireResolved: flag(options, "require-resolved"),
    });
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

/** Runs one feedback operation under the review lock, as every command does. */
function feedbackOperation<T>(paths: FeedbackPaths, action: () => T): T {
  if (paths.requester && (paths.reviewId !== paths.requester.reviewId || readReview(paths.reviewId).generation !== paths.requester.generation)) {
    fail("The initiating review session changed. Reopen the viewer.");
  }
  if (fs.existsSync(path.join(reviewDirectory(paths.reviewId), "review.json")) && readReview(paths.reviewId).remote) fail("Remote reviews support personal notes only.");
  // Validation also holds the shared lock so it never observes a partial batch.
  return withFeedbackLock(paths, () => withValidationContext(action));
}

/** Runs one `semantic-flow feedback` command line in the current working directory. */
export function runFeedbackCommand(argv: string[]): void {
  const { positionals, options: parsedOptions } = parseArguments(argv);
  const options = expandInputOptions(parsedOptions, process.cwd());
  const command = positionals.join(" ");
  if (!positionals.length || positionals[0] === "help" || options.has("help")) {
    printHelp(positionals, options);
    return;
  }
  if (!reviewFeedbackApi.commands.some((entry) => entry.command === command)) fail(`Unknown command: ${command}.\n\n${HELP}`);
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, command));
  let paths = pathsFor(repositoryRoot());
  if (command === "init" && fs.existsSync(path.join(reviewDirectory(paths.reviewId), "review.json")) && readReview(paths.reviewId).remote) {
    fail("Remote reviews support personal notes only.");
  }
  if (command === "init") {
    const { manifest } = semanticArtifact(paths);
    // Registration gives the implementation a new review ID when a deletion retired
    // the stored one; feedback is initialized for the review it returns.
    paths = reviewPaths(paths.root, paths.implementationId, registerReview(paths.root, manifest.implementationId, manifest.title).id, paths.requester);
  }
  feedbackOperation(paths, () => dispatch(paths, positionals, options));
}

/** Validates the feedback of the implementation in root, as `feedback validate` does. */
export function validateFeedbackAt(root: string): string {
  const paths = pathsFor(root);
  return feedbackOperation(paths, () => `Feedback validation passed: ${validateFeedback(paths, { quiet: true }).feedback.threads.size} thread(s).`);
}

/** Pending feedback of the implementation in root, as `feedback next --json --compact` reports it. */
export function nextFeedbackAt(root: string, claim: { session: string | null } | null): PendingFeedback<CompactThread> {
  const paths = pathsFor(root);
  const pending = feedbackOperation(paths, () => pendingFeedback(paths, { compact: true, claim: claim !== null, sessionId: claim?.session ?? null }));
  const isCompact = (thread: CompactThread | FullThread): thread is CompactThread => "stale" in thread;
  return { ...pending, stages: pending.stages.map((group) => ({ ...group, threads: group.threads.filter(isCompact) })) };
}

/** Feedback changes a viewer session makes for its reviewer. Each one checks
 * that the session is still the current one for its review. */
export interface ReviewFeedback {
  initialize(): void;
  addThreads(items: unknown[]): PartialBatchResult;
  replyToThreads(items: unknown[]): PartialBatchResult;
  resolveThread(id: string): void;
  reopenThread(id: string): void;
}

export function reviewFeedback(root: string, requester: FeedbackRequester): ReviewFeedback {
  const paths = pathsFor(root, requester);
  const run = <T>(action: () => T): T => feedbackOperation(paths, action);
  return {
    initialize: () => run(() => { initializeFeedback(paths); }),
    addThreads: (items) => run(() => partialFeedbackBatch(paths, items, "add")),
    replyToThreads: (items) => run(() => partialFeedbackBatch(paths, items, "reply")),
    resolveThread: (id) => run(() => resolveThreadById(paths, id, undefined, undefined)),
    reopenThread: (id) => run(() => reopenThreadById(paths, id)),
  };
}
