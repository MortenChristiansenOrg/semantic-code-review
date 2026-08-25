#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  commandOptionNames,
  renderCliHelp,
  reviewFeedbackApi,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  option,
  parseArguments,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";
import { git, gitRaw } from "./shared/git.js";
import { readJson, writeJson } from "./shared/json.js";

const MANIFEST_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/manifest.schema.json";
const BATCH_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/batch.schema.json";
const THREAD_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/thread.schema.json";
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const feedbackSchemaDirectory =
  process.env.SEMANTIC_REVIEW_FEEDBACK_SCHEMA_DIR ??
  path.resolve(
    skillDirectory,
    "references",
    "feedback-schema",
  );
const semanticCli = path.join(scriptDirectory, "semantic-review.mjs");

const HELP = renderCliHelp(reviewFeedbackApi);

function repositoryRoot() {
  return path.resolve(git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }));
}

function pathsFor(root) {
  const feedback = path.join(root, ".semantic-review-feedback");
  const gitLock = git(
    ["rev-parse", "--git-path", "semantic-review-feedback.lock"],
    { cwd: root },
  );
  return {
    root,
    semantic: path.join(root, ".semantic-review"),
    feedback,
    feedbackManifest: path.join(feedback, "manifest.json"),
    batches: path.join(feedback, "batches"),
    threads: path.join(feedback, "threads"),
    lock: path.isAbsolute(gitLock) ? gitLock : path.resolve(root, gitLock),
  };
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function withFeedbackLock(paths, action) {
  const lock = paths.lock;
  const owner = path.join(lock, "owner.json");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      writeJson(owner, {
        pid: process.pid,
        createdAt: new Date().toISOString(),
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = !processIsAlive(readJson(owner).pid);
      } catch {
        stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000;
      }
      if (stale) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        fail("Timed out waiting for another feedback mutation to finish.");
      }
      sleep(25);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function listJsonIds(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

function semanticArtifact(paths) {
  if (!fs.existsSync(path.join(paths.semantic, "manifest.json"))) {
    fail("No active .semantic-review artifact exists.");
  }
  const manifest = readJson(path.join(paths.semantic, "manifest.json"));
  const requirements = new Map<string, any>(
    manifest.requirements.map((id) => [
      id,
      readJson(path.join(paths.semantic, "requirements", `${id}.json`)),
    ]),
  );
  const stages = new Map<string, any>(
    manifest.stages.map((id) => [
      id,
      readJson(path.join(paths.semantic, "stages", `${id}.json`)),
    ]),
  );
  return { manifest, requirements, stages };
}

function schemaValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  for (const file of [
    "common.schema.json",
    "manifest.schema.json",
    "batch.schema.json",
    "thread.schema.json",
  ]) {
    const fullPath = path.join(feedbackSchemaDirectory, file);
    if (!fs.existsSync(fullPath)) fail(`Missing feedback schema ${fullPath}.`);
    ajv.addSchema(readJson(fullPath));
  }
  return ajv;
}

function validateDocument(ajv, value, file) {
  const validator = ajv.getSchema(value?.$schema);
  if (!validator) fail(`${file}: unsupported or missing $schema.`);
  if (!validator(value)) {
    fail(
      validator.errors
        .map(
          (error) =>
            `${file}${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        )
        .join("\n"),
    );
  }
}

function loadFeedback(paths, { required = true } = {}) {
  if (!fs.existsSync(paths.feedbackManifest)) {
    if (required) fail("No .semantic-review-feedback manifest exists.");
    return null;
  }
  const manifest = readJson(paths.feedbackManifest);
  const batches = new Map();
  const threads = new Map();
  for (const id of manifest.batches ?? []) {
    const batch = readJson(path.join(paths.batches, `${id}.json`));
    batches.set(id, batch);
    for (const threadId of batch.threads ?? []) {
      if (threads.has(threadId)) {
        fail(`Feedback thread ${threadId} appears in multiple batches.`);
      }
      threads.set(
        threadId,
        readJson(path.join(paths.threads, `${threadId}.json`)),
      );
    }
  }
  return { manifest, batches, threads };
}

function collectionExists(stage, collection, itemId) {
  return Array.isArray(stage[collection]) &&
    stage[collection].some((item) => item.id === itemId);
}

function lineCountAtRevision(root, revision, repositoryPath) {
  const contents = gitRaw(["show", `${revision}:${repositoryPath}`], {
    cwd: root,
    encoding: "buffer",
  });
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

function validateLineTarget(target, stage, root) {
  const file = stage.change.files.find(
    (candidate) =>
      candidate.path === target.path || candidate.previousPath === target.path,
  );
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

function validateTarget(target, semantic, root) {
  const requirement = target.requirementId
    ? semantic.requirements.get(target.requirementId)
    : undefined;
  if (
    ["requirement", "criterion"].includes(target.kind) &&
    !requirement
  ) {
    fail(`Feedback target requirement ${target.requirementId} does not exist.`);
  }
  if (
    target.kind === "criterion" &&
    !requirement.acceptanceCriteria.some(
      (criterion) => criterion.id === target.criterionId,
    )
  ) {
    fail(
      `Feedback target criterion ${target.requirementId}#${target.criterionId} does not exist.`,
    );
  }

  if (["stage", "context", "file", "line"].includes(target.kind)) {
    const stage = semantic.stages.get(target.stageId);
    if (!stage) fail(`Feedback target stage ${target.stageId} does not exist.`);
    if (
      target.stageBranch === stage.change.branch &&
      target.stageHead === stage.change.headRevision
    ) {
      if (
        target.kind === "context" &&
        !collectionExists(stage, target.collection, target.itemId)
      ) {
        fail(
          `Feedback context ${target.stageId}/${target.collection}/${target.itemId} does not exist.`,
        );
      }
      const changedFile =
        ["file", "line"].includes(target.kind) &&
        stage.change.files.find(
          (file) =>
            file.path === target.path || file.previousPath === target.path,
        );
      if (
        ["file", "line"].includes(target.kind) &&
        !changedFile
      ) {
        fail(`Feedback path ${target.path} is not changed by ${target.stageId}.`);
      }
      if (target.kind === "line") {
        validateLineTarget(target, stage, root);
      }
    }
  }
}

function expectedBatchStatus(batch, threads) {
  if (threads.length === 0) return "draft";
  if (threads.every((thread) => thread.status === "draft")) return "draft";
  if (threads.every((thread) => thread.status === "submitted")) return "submitted";
  if (threads.every((thread) => thread.status === "approved")) return "approved";
  if (
    threads.every((thread) =>
      ["resolved", "approved"].includes(thread.status),
    )
  ) {
    return "resolved";
  }
  return "addressing";
}

function validateFeedback(
  paths,
  { quiet = false, allowStaleResolutions = false } = {},
) {
  const semantic = semanticArtifact(paths);
  const feedback = loadFeedback(paths);
  const ajv = schemaValidator();
  validateDocument(ajv, feedback.manifest, paths.feedbackManifest);
  if (feedback.manifest.reviewId !== semantic.manifest.reviewId) {
    fail("Feedback reviewId does not match the active semantic review.");
  }

  const listedBatches = new Set(feedback.manifest.batches);
  for (const id of listJsonIds(paths.batches)) {
    if (!listedBatches.has(id)) fail(`Unlisted feedback batch ${id}.`);
  }
  const listedThreads = new Set(feedback.threads.keys());
  for (const id of listJsonIds(paths.threads)) {
    if (!listedThreads.has(id)) fail(`Unlisted feedback thread ${id}.`);
  }

  for (const [id, batch] of feedback.batches) {
    validateDocument(ajv, batch, path.join(paths.batches, `${id}.json`));
    if (batch.id !== id) fail(`Batch ${id} has internal ID ${batch.id}.`);
    const batchThreads = batch.threads.map((threadId) => {
      const thread = feedback.threads.get(threadId);
      if (!thread) fail(`Batch ${id} references missing thread ${threadId}.`);
      return thread;
    });
    const expected = expectedBatchStatus(batch, batchThreads);
    if (batch.status !== expected) {
      fail(`Batch ${id} status ${batch.status} should be ${expected}.`);
    }
  }

  for (const [id, thread] of feedback.threads) {
    validateDocument(ajv, thread, path.join(paths.threads, `${id}.json`));
    if (thread.id !== id) {
      fail(`Feedback thread ${id} has internal ID ${thread.id}.`);
    }
    const batch = feedback.batches.get(thread.batchId);
    if (!batch?.threads.includes(id)) {
      fail(`Feedback thread ${id} is not indexed by batch ${thread.batchId}.`);
    }
    const commentIds = new Set();
    if (thread.comments[0]?.author !== "user") {
      fail(`Feedback thread ${id} must begin with a user comment.`);
    }
    for (const comment of thread.comments) {
      if (commentIds.has(comment.id)) {
        fail(`Feedback thread ${id} repeats comment ID ${comment.id}.`);
      }
      commentIds.add(comment.id);
    }
    validateTarget(thread.target, semantic, paths.root);
    if (
      thread.assignedStageId &&
      !semantic.stages.has(thread.assignedStageId)
    ) {
      fail(
        `Feedback thread ${id} is assigned to missing stage ${thread.assignedStageId}.`,
      );
    }
    if (thread.status !== "draft" && !thread.assignedStageHead) {
      fail(`Feedback thread ${id} has no submission stage snapshot.`);
    }
    if (thread.resolution?.stageId) {
      const stage = semantic.stages.get(thread.resolution.stageId);
      if (!stage) {
        fail(`Resolution stage ${thread.resolution.stageId} is missing.`);
      }
      if (thread.resolution.stageId !== thread.assignedStageId) {
        fail(
          `Resolution ${id} uses stage ${thread.resolution.stageId}, not assigned stage ${thread.assignedStageId}.`,
        );
      }
      if (thread.resolution.previousHead !== thread.assignedStageHead) {
        fail(
          `Resolution ${id} previous head does not match its submission snapshot.`,
        );
      }
      if (
        !allowStaleResolutions &&
        stage.change.headRevision !== thread.resolution.rewrittenHead
      ) {
        fail(
          `Resolution ${id} points to stale rewritten head ${thread.resolution.rewrittenHead}. ` +
            `Stage ${thread.resolution.stageId} now points to ${stage.change.headRevision}, likely after a restack. ` +
            `Rebind with:\nresolution rebind --stage ${thread.resolution.stageId} ` +
            `--previous-head ${thread.resolution.rewrittenHead} --rewritten-head ${stage.change.headRevision}`,
        );
      }
      if (!SHA1_PATTERN.test(thread.resolution.previousHead)) {
        fail(`Resolution ${id} has invalid previousHead.`);
      }
    }
  }

  if (!quiet) {
    console.log(
      `Feedback validation passed: ${feedback.batches.size} batch(es), ${feedback.threads.size} thread(s).`,
    );
  }
  return { semantic, feedback };
}

function ensureExcluded(root) {
  const exclude = git(["rev-parse", "--git-path", "info/exclude"], { cwd: root });
  const resolved = path.isAbsolute(exclude) ? exclude : path.resolve(root, exclude);
  const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
  if (!content.split(/\r?\n/).includes(".semantic-review-feedback/")) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(
      resolved,
      `${content && !content.endsWith("\n") ? "\n" : ""}.semantic-review-feedback/\n`,
      "utf8",
    );
  }
}

function initialize(paths, options) {
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, "init"));
  if (fs.existsSync(paths.feedbackManifest)) fail("Feedback state already exists.");
  if (
    fs.existsSync(paths.feedback) &&
    fs.readdirSync(paths.feedback).length > 0
  ) {
    fail(
      `${paths.feedback} already contains files but has no manifest. Inspect or remove it before initialization.`,
    );
  }
  const semantic = semanticArtifact(paths);
  ensureExcluded(paths.root);
  try {
    writeJson(paths.feedbackManifest, {
      $schema: MANIFEST_SCHEMA,
      formatVersion: "0.1",
      reviewId: semantic.manifest.reviewId,
      batches: [],
    });
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(paths.feedback, { recursive: true, force: true });
    throw error;
  }
  console.log(`Initialized feedback for ${semantic.manifest.reviewId}.`);
}

function createBatch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "batch create"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  if (feedback.batches.has(id)) fail(`Batch ${id} already exists.`);
  const now = new Date().toISOString();
  const batch = {
    $schema: BATCH_SCHEMA,
    id,
    title: option(options, "title", { required: true }),
    status: "draft",
    threads: [],
    createdAt: now,
  };
  validateDocument(schemaValidator(), batch, "Feedback batch input");
  const oldManifest = structuredClone(feedback.manifest);
  feedback.manifest.batches.push(id);
  const file = path.join(paths.batches, `${id}.json`);
  try {
    writeJson(file, batch);
    writeJson(paths.feedbackManifest, feedback.manifest);
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    writeJson(paths.feedbackManifest, oldManifest);
    throw error;
  }
  console.log(`Created feedback batch ${id}.`);
}

function buildTarget(options, semantic, root) {
  const kind = option(options, "target-kind", { required: true });
  const target: Record<string, any> = {
    kind,
    label: option(options, "label", { required: true }),
  };
  if (["requirement", "criterion"].includes(kind)) {
    target.requirementId = option(options, "requirement", { required: true });
  }
  if (kind === "criterion") {
    target.criterionId = option(options, "criterion", { required: true });
  }
  if (["stage", "context", "file", "line"].includes(kind)) {
    target.stageId = option(options, "stage", { required: true });
    const stage = semantic.stages.get(target.stageId);
    if (!stage) fail(`Stage ${target.stageId} does not exist.`);
    target.stageBranch = stage.change.branch;
    target.stageHead = stage.change.headRevision;
  }
  if (kind === "context") {
    target.collection = option(options, "collection", { required: true });
    target.itemId = option(options, "item", { required: true });
  }
  if (["file", "line"].includes(kind)) {
    target.path = option(options, "path", { required: true });
  }
  if (kind === "line") {
    target.side = option(options, "side", { required: true });
    const line = Number(option(options, "line", { required: true }));
    if (!Number.isInteger(line) || line < 1) fail("--line must be a positive integer.");
    target.line = line;
  }
  validateTarget(target, semantic, root);
  return target;
}

function addThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add"),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const batchId = option(options, "batch", { required: true });
  const batch = feedback.batches.get(batchId);
  if (!batch) fail(`Batch ${batchId} does not exist.`);
  if (batch.status !== "draft") fail(`Batch ${batchId} is not editable.`);
  const id = option(options, "id", { required: true });
  if (feedback.threads.has(id)) fail(`Feedback thread ${id} already exists.`);
  const thread: Record<string, any> = {
    $schema: THREAD_SCHEMA,
    id,
    batchId,
    status: "draft",
    comments: [
      {
        id: option(options, "comment-id", { required: true }),
        author: "user",
        body: option(options, "body", { required: true }),
        createdAt: new Date().toISOString(),
      },
    ],
    target: buildTarget(options, semantic, paths.root),
    createdAt: new Date().toISOString(),
  };
  const assignedStageId =
    option(options, "assigned-stage") ?? thread.target.stageId;
  if (assignedStageId) {
    if (!semantic.stages.has(assignedStageId)) {
      fail(`Assigned stage ${assignedStageId} does not exist.`);
    }
    thread.assignedStageId = assignedStageId;
  }
  validateDocument(schemaValidator(), thread, "Feedback thread input");
  const file = path.join(paths.threads, `${id}.json`);
  const oldBatch = structuredClone(batch);
  batch.threads.push(id);
  try {
    writeJson(file, thread);
    writeJson(path.join(paths.batches, `${batchId}.json`), batch);
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    writeJson(path.join(paths.batches, `${batchId}.json`), oldBatch);
    throw error;
  }
  console.log(`Added feedback thread ${id} to ${batchId}.`);
}

function editComment(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "comment edit"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const threadId = option(options, "thread", { required: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(threadId);
  if (!thread) fail(`Feedback thread ${threadId} does not exist.`);
  if (thread.status !== "draft") {
    fail(`Feedback thread ${threadId} is immutable after submission.`);
  }
  const comment = thread.comments.find((candidate) => candidate.id === id);
  if (!comment) fail(`Comment ${id} does not exist in thread ${threadId}.`);
  if (comment.author !== "user") {
    fail(`Assistant comment ${id} cannot be edited by the user.`);
  }
  comment.body = option(options, "body", { required: true });
  writeThread(paths, thread);
  validateFeedback(paths, { quiet: true });
  console.log(`Edited draft comment ${id} in ${threadId}.`);
}

function deleteThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread delete"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "draft") {
    fail(`Feedback thread ${id} is immutable after submission.`);
  }
  const batch = feedback.batches.get(thread.batchId);
  batch.threads = batch.threads.filter((threadId) => threadId !== id);
  writeBatch(paths, batch);
  fs.rmSync(path.join(paths.threads, `${id}.json`));
  validateFeedback(paths, { quiet: true });
  console.log(`Deleted draft feedback thread ${id}.`);
}

function assignThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread assign"),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const stageId = option(options, "stage", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "draft") {
    fail(`Feedback thread ${id} is immutable after submission.`);
  }
  if (!semantic.stages.has(stageId)) fail(`Stage ${stageId} does not exist.`);
  thread.assignedStageId = stageId;
  writeThread(paths, thread);
  validateFeedback(paths, { quiet: true });
  console.log(`Assigned feedback thread ${id} to ${stageId}.`);
}

function writeBatch(paths, batch) {
  writeJson(path.join(paths.batches, `${batch.id}.json`), batch);
}

function writeThread(paths, thread) {
  writeJson(path.join(paths.threads, `${thread.id}.json`), thread);
}

function updateBatchStatus(batch, feedback) {
  batch.status = expectedBatchStatus(
    batch,
    batch.threads.map((id) => feedback.threads.get(id)),
  );
  if (batch.status === "approved" && !batch.approvedAt) {
    batch.approvedAt = new Date().toISOString();
  }
}

function submitBatch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "batch submit"),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const batch = feedback.batches.get(id);
  if (!batch) fail(`Batch ${id} does not exist.`);
  if (batch.status !== "draft" || batch.threads.length === 0) {
    fail(`Batch ${id} must be a non-empty draft.`);
  }
  const now = new Date().toISOString();
  for (const threadId of batch.threads) {
    const thread = feedback.threads.get(threadId);
    const stageId = thread.assignedStageId ?? thread.target.stageId;
    const stage = semantic.stages.get(stageId);
    if (!stage) {
      fail(`Feedback thread ${threadId} requires a valid stage assignment before submission.`);
    }
    thread.assignedStageId = stageId;
    thread.assignedStageHead = stage.change.headRevision;
    thread.status = "submitted";
    writeThread(paths, thread);
  }
  batch.status = "submitted";
  batch.submittedAt = now;
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Submitted feedback batch ${id}.`);
}

function deleteBatch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "batch delete"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const batch = feedback.batches.get(id);
  if (!batch) fail(`Batch ${id} does not exist.`);
  if (batch.status !== "draft" || batch.threads.length !== 0) {
    fail(`Batch ${id} must be an empty draft to delete.`);
  }
  feedback.manifest.batches = feedback.manifest.batches.filter(
    (batchId) => batchId !== id,
  );
  fs.rmSync(path.join(paths.batches, `${id}.json`));
  writeJson(paths.feedbackManifest, feedback.manifest);
  validateFeedback(paths, { quiet: true });
  console.log(`Deleted feedback batch ${id}.`);
}

function nextFeedback(paths, options) {
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, "next"));
  const json = options.has("json");
  if (
    json &&
    (options.get("json").length !== 1 || options.get("json")[0] !== true)
  ) {
    fail("--json is a flag.");
  }
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const submitted = [...feedback.threads.values()].filter(
    (thread) => thread.status === "submitted",
  );
  const unassigned = submitted.filter(
    (thread) => !(thread.assignedStageId ?? thread.target.stageId),
  );
  if (unassigned.length) {
    fail(
      `Submitted feedback requires stage assignment: ${unassigned
        .map((thread) => thread.id)
        .join(", ")}.`,
    );
  }
  // Only surface threads awaiting an agent response. Once the agent has replied
  // (last comment authored by `assistant`) the thread is the reviewer's to
  // resolve or continue, so it drops out of the agent work queue.
  const awaiting = submitted.filter(
    (thread) =>
      thread.comments[thread.comments.length - 1]?.author !== "assistant",
  );
  const groups = [];
  for (const stageId of semantic.manifest.stages) {
    const threads = awaiting.filter(
      (thread) =>
        (thread.assignedStageId ?? thread.target.stageId) === stageId,
    );
    if (threads.length) {
      groups.push({
        stageId,
        stageBranch: semantic.stages.get(stageId).change.branch,
        stageHead: semantic.stages.get(stageId).change.headRevision,
        threads: threads.map((thread) => ({
          id: thread.id,
          assignedStageHead: thread.assignedStageHead,
          comments: thread.comments,
          target: thread.target,
        })),
      });
    }
  }
  if (json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }
  if (!groups.length) {
    console.log("No submitted feedback remains.");
    return;
  }
  for (const group of groups) {
    console.log(`${group.stageId} (${group.stageBranch} @ ${group.stageHead}):`);
    for (const thread of group.threads) {
      console.log(`  ${thread.id}:`);
      for (const comment of thread.comments) {
        console.log(`    ${comment.author}: ${comment.body}`);
      }
    }
  }
}

// Continue an open thread with a new comment. Replying to a resolved thread
// reopens it — closing a conversation is always the reviewer's decision.
function replyThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (!["submitted", "resolved"].includes(thread.status)) {
    fail(`Feedback thread ${id} is not open for replies.`);
  }
  const commentId = option(options, "comment-id", { required: true });
  if (thread.comments.some((comment) => comment.id === commentId)) {
    fail(`Comment ${commentId} already exists in thread ${id}.`);
  }
  const author = option(options, "author") || "user";
  if (!["user", "assistant"].includes(author)) {
    fail("--author must be user or assistant.");
  }
  thread.comments.push({
    id: commentId,
    author,
    body: option(options, "body", { required: true }),
    createdAt: new Date().toISOString(),
  });
  if (thread.status === "resolved") {
    thread.status = "submitted";
    delete thread.resolution;
  }
  writeThread(paths, thread);
  const batch = feedback.batches.get(thread.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Added reply ${commentId} to feedback thread ${id}.`);
}

// Mark a thread resolved. Resolution is a reviewer decision: the agent never
// closes a thread, it only replies. An optional closing note and an optional
// stage-rewrite record may accompany the closure.
function resolveThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread resolve"),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "submitted") {
    fail(`Feedback thread ${id} is not open for resolution.`);
  }
  const stageId = option(options, "stage");
  const previous = option(options, "previous-head");
  const rewritten = option(options, "rewritten-head");
  const rewriteValues = [stageId, previous, rewritten];
  if (rewriteValues.some(Boolean) && !rewriteValues.every(Boolean)) {
    fail("--stage, --previous-head, and --rewritten-head must be provided together.");
  }
  const resolution: Record<string, any> = {
    resolvedAt: new Date().toISOString(),
  };
  if (stageId) {
    const expectedStageId = thread.assignedStageId ?? thread.target.stageId;
    if (stageId !== expectedStageId) {
      fail(
        `Feedback thread ${id} must be resolved in ${expectedStageId}, not ${stageId}.`,
      );
    }
    const stage = semantic.stages.get(stageId);
    if (!stage) fail(`Resolution stage ${stageId} does not exist.`);
    if (!SHA1_PATTERN.test(previous) || !SHA1_PATTERN.test(rewritten)) {
      fail("Resolution heads must be full lowercase SHA-1 IDs.");
    }
    if (stage.change.headRevision !== rewritten) {
      fail(`Stage ${stageId} currently points to ${stage.change.headRevision}, not ${rewritten}.`);
    }
    if (thread.assignedStageHead !== previous) {
      fail(
        `Feedback thread ${id} was submitted against ${thread.assignedStageHead}, not ${previous}.`,
      );
    }
    if (previous === rewritten) {
      fail("Resolution heads must show an actual stage rewrite.");
    }
    git(["cat-file", "-e", `${previous}^{commit}`], { cwd: paths.root });
    Object.assign(resolution, {
      stageId,
      previousHead: previous,
      rewrittenHead: rewritten,
    });
  }
  const commentId = option(options, "comment-id");
  const body = option(options, "body");
  if (Boolean(commentId) !== Boolean(body)) {
    fail("--comment-id and --body must be provided together.");
  }
  if (commentId) {
    if (thread.comments.some((comment) => comment.id === commentId)) {
      fail(`Comment ${commentId} already exists in thread ${id}.`);
    }
    thread.comments.push({
      id: commentId,
      author: "user",
      body,
      createdAt: resolution.resolvedAt,
    });
  }
  thread.status = "resolved";
  thread.resolution = resolution;
  writeThread(paths, thread);
  const batch = feedback.batches.get(thread.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Resolved feedback thread ${id}.`);
}

// Reopen a resolved thread so the conversation can continue.
function reopenThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reopen"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "resolved") {
    fail(`Feedback thread ${id} is not resolved.`);
  }
  thread.status = "submitted";
  delete thread.resolution;
  writeThread(paths, thread);
  const batch = feedback.batches.get(thread.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Reopened feedback thread ${id}.`);
}

function approveThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread approve"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "resolved") {
    fail(`Feedback thread ${id} is not awaiting approval.`);
  }
  thread.status = "approved";
  thread.resolution.approvedAt = new Date().toISOString();
  writeThread(paths, thread);
  const batch = feedback.batches.get(thread.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Approved feedback resolution ${id}.`);
}

function rebindResolutions(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "resolution rebind"),
  );
  const { semantic, feedback } = validateFeedback(paths, {
    quiet: true,
    allowStaleResolutions: true,
  });
  const stageId = option(options, "stage", { required: true });
  const previous = option(options, "previous-head", { required: true });
  const rewritten = option(options, "rewritten-head", { required: true });
  if (!SHA1_PATTERN.test(previous) || !SHA1_PATTERN.test(rewritten)) {
    fail("Resolution heads must be full lowercase SHA-1 IDs.");
  }
  const stage = semantic.stages.get(stageId);
  if (!stage) fail(`Resolution stage ${stageId} does not exist.`);
  if (stage.change.headRevision !== rewritten) {
    fail(`Stage ${stageId} currently points to ${stage.change.headRevision}, not ${rewritten}.`);
  }
  const matching = [...feedback.threads.values()].filter(
    (thread) =>
      thread.resolution?.stageId === stageId &&
      thread.resolution.rewrittenHead === previous,
  );
  if (matching.length === 0) {
    fail(`No resolutions for ${stageId} point to ${previous}.`);
  }
  for (const thread of matching) {
    thread.resolution.rewrittenHead = rewritten;
    writeThread(paths, thread);
  }
  validateFeedback(paths, { quiet: true });
  console.log(`Rebound ${matching.length} resolution(s) for ${stageId}.`);
}

function approveAll(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "batch approve-all"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const batch = feedback.batches.get(id);
  if (!batch) fail(`Batch ${id} does not exist.`);
  const threads = batch.threads.map((threadId) =>
    feedback.threads.get(threadId),
  );
  if (!threads.some((thread) => thread.status === "resolved")) {
    fail(`Batch ${id} has no resolved threads to approve.`);
  }
  if (
    threads.some(
      (thread) => !["resolved", "approved"].includes(thread.status),
    )
  ) {
    fail(`Batch ${id} still contains unresolved feedback.`);
  }
  const now = new Date().toISOString();
  for (const thread of threads) {
    if (thread.status === "resolved") {
      thread.status = "approved";
      thread.resolution.approvedAt = now;
      writeThread(paths, thread);
    }
  }
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Approved all threads in ${id}.`);
}

function approveStack(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "approve-stack"),
  );
  if (loadFeedback(paths, { required: false })) {
    const { feedback } = validateFeedback(paths, { quiet: true });
    const incomplete = [...feedback.batches.values()].filter(
      (batch) => batch.status !== "approved",
    );
    if (incomplete.length) {
      fail(
        `Cannot approve stack; incomplete batches: ${incomplete
          .map((batch) => `${batch.id}:${batch.status}`)
          .join(", ")}.`,
      );
    }
  }
  execFileSync(process.execPath, [semanticCli, "publish"], {
    cwd: paths.root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [semanticCli, "prepare-stack"], {
    cwd: paths.root,
    stdio: "inherit",
  });
  console.log("Approved semantic stack.");
}

function dispatch(paths, positionals, options) {
  const [command, subcommand, ...extra] = positionals;
  if (extra.length) fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  if (!command || command === "help" || options.has("help")) {
    const help = options.get("help");
    if (help && (help.length !== 1 || help[0] !== true)) {
      fail("--help is a flag.");
    }
    console.log(HELP);
    return;
  }
  if (command === "init" && !subcommand) return initialize(paths, options);
  if (command === "batch" && subcommand === "create") return createBatch(paths, options);
  if (command === "batch" && subcommand === "delete") return deleteBatch(paths, options);
  if (command === "thread" && subcommand === "add") return addThread(paths, options);
  if (command === "comment" && subcommand === "edit") return editComment(paths, options);
  if (command === "thread" && subcommand === "delete") return deleteThread(paths, options);
  if (command === "thread" && subcommand === "assign") return assignThread(paths, options);
  if (command === "batch" && subcommand === "submit") return submitBatch(paths, options);
  if (command === "next" && !subcommand) return nextFeedback(paths, options);
  if (command === "thread" && subcommand === "reply") return replyThread(paths, options);
  if (command === "thread" && subcommand === "resolve") return resolveThread(paths, options);
  if (command === "thread" && subcommand === "reopen") return reopenThread(paths, options);
  if (command === "resolution" && subcommand === "rebind") return rebindResolutions(paths, options);
  if (command === "thread" && subcommand === "approve") return approveThread(paths, options);
  if (command === "batch" && subcommand === "approve-all") return approveAll(paths, options);
  if (command === "approve-stack" && !subcommand) return approveStack(paths, options);
  if (command === "validate" && !subcommand) {
    assertKnownOptions(
      options,
      commandOptionNames(reviewFeedbackApi, "validate"),
    );
    validateFeedback(paths);
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

try {
  const { positionals, options: parsedOptions } = parseArguments(
    process.argv.slice(2),
  );
  const options = expandInputOptions(parsedOptions, process.cwd());
  const paths = pathsFor(repositoryRoot());
  const readOnly =
    positionals.length === 0 ||
    positionals[0] === "help" ||
    options.has("help") ||
    positionals[0] === "next" ||
    positionals[0] === "validate";
  if (readOnly) {
    dispatch(paths, positionals, options);
  } else {
    withFeedbackLock(paths, () => dispatch(paths, positionals, options));
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
