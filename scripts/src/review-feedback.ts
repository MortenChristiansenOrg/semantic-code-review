#!/usr/bin/env node

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
  flag,
  option,
  parseArguments,
  type Options,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";
import { git, gitRaw } from "./shared/git.js";
import { readJson, writeJson } from "./shared/json.js";

const MANIFEST_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/manifest.schema.json";
const THREAD_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/thread.schema.json";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const feedbackSchemaDirectory =
  process.env.SEMANTIC_REVIEW_FEEDBACK_SCHEMA_DIR ??
  path.resolve(skillDirectory, "references", "feedback-schema");
const HELP = renderCliHelp(reviewFeedbackApi);

function repositoryRoot() {
  return path.resolve(
    git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }),
  );
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
  if (manifest.formatVersion !== "0.1" || !Array.isArray(manifest.threads)) {
    fail(
      "This feedback workspace uses an unsupported v0.1 layout.",
    );
  }
  const threads = new Map();
  for (const id of manifest.threads ?? []) {
    threads.set(id, readJson(path.join(paths.threads, `${id}.json`)));
  }
  return { manifest, threads };
}

function collectionExists(stage, collection, itemId) {
  return Array.isArray(stage[collection]) &&
    stage[collection].some((item) => item.id === itemId);
}

function renamedPathBetween(root, fromRevision, toRevision, repositoryPath) {
  const raw = git([
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
  const specification = target.specificationId
    ? semantic.requirements.get(target.specificationId)
    : undefined;
  if (["specification", "criterion"].includes(target.kind) && !specification) {
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

  if (["stage", "node", "insight", "file", "line"].includes(target.kind)) {
    const stage = semantic.stages.get(target.stageId);
    if (!stage) fail(`Feedback target stage ${target.stageId} does not exist.`);
    if (
      target.stageBranch === stage.change.branch &&
      target.stageHead === stage.change.headRevision
    ) {
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
      const changedFile =
        ["file", "line"].includes(target.kind) &&
        stage.change.files.find(
          (file) =>
            file.path === target.path || file.previousPath === target.path,
        );
      if (["file", "line"].includes(target.kind) && !changedFile) {
        fail(`Feedback path ${target.path} is not changed by ${target.stageId}.`);
      }
      if (target.kind === "line") {
        validateLineTarget(target, stage, root);
      }
    }
  }
}

function validateFeedback(
  paths,
  { quiet = false, requireResolved = false } = {},
) {
  const semantic = semanticArtifact(paths);
  const feedback = loadFeedback(paths);
  const ajv = schemaValidator();
  validateDocument(ajv, feedback.manifest, paths.feedbackManifest);
  if (feedback.manifest.implementationId !== semantic.manifest.implementationId) {
    fail("Feedback implementationId does not match the active semantic implementation.");
  }

  const listedThreads = new Set(feedback.manifest.threads);
  for (const id of listJsonIds(paths.threads)) {
    if (!listedThreads.has(id)) fail(`Unlisted feedback thread ${id}.`);
  }

  for (const [id, thread] of feedback.threads) {
    validateDocument(ajv, thread, path.join(paths.threads, `${id}.json`));
    if (thread.id !== id) {
      fail(`Feedback thread ${id} has internal ID ${thread.id}.`);
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
    if (!semantic.stages.has(thread.assignedStageId)) {
      fail(
        `Feedback thread ${id} is assigned to missing stage ${thread.assignedStageId}.`,
      );
    }
  }

  if (requireResolved) {
    const open = [...feedback.threads.values()]
      .filter((thread) => thread.status === "open")
      .map((thread) => thread.id);
    if (open.length) {
      fail(`Unresolved feedback threads: ${open.join(", ")}.`);
    }
  }

  if (!quiet) {
    console.log(
      `Feedback validation passed: ${feedback.threads.size} thread(s).`,
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
  if (fs.existsSync(paths.feedback) && fs.readdirSync(paths.feedback).length > 0) {
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
      implementationId: semantic.manifest.implementationId,
      threads: [],
    });
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(paths.feedback, { recursive: true, force: true });
    throw error;
  }
  console.log(`Initialized feedback for ${semantic.manifest.implementationId}.`);
}

function buildTarget(options, semantic, root) {
  const kind = option(options, "target-kind", { required: true });
  const target: Record<string, any> = {
    kind,
    label: option(options, "label", { required: true }),
  };
  if (["specification", "criterion"].includes(kind)) {
    target.specificationId = option(options, "specification", { required: true });
  }
  if (kind === "criterion") {
    target.criterionId = option(options, "criterion", { required: true });
  }
  if (["stage", "node", "insight", "file", "line"].includes(kind)) {
    target.stageId = option(options, "stage", { required: true });
    const stage = semantic.stages.get(target.stageId);
    if (!stage) fail(`Stage ${target.stageId} does not exist.`);
    target.stageBranch = stage.change.branch;
    target.stageHead = stage.change.headRevision;
  }
  if (kind === "node") {
    target.nodeId = option(options, "node", { required: true });
  }
  if (kind === "insight") {
    target.collection = option(options, "collection", { required: true });
    target.itemId = option(options, "item", { required: true });
  }
  if (["file", "line"].includes(kind)) {
    target.path = option(options, "path", { required: true });
  }
  if (kind === "line") {
    target.side = option(options, "side", { required: true });
    const line = Number(option(options, "line", { required: true }));
    if (!Number.isInteger(line) || line < 1) {
      fail("--line must be a positive integer.");
    }
    target.line = line;
  }
  validateTarget(target, semantic, root);
  return target;
}

function writeThread(paths, thread) {
  writeJson(path.join(paths.threads, `${thread.id}.json`), thread);
}

function createThread(paths, options, semantic, knownIds, ajv) {
  const id = option(options, "id", { required: true });
  if (knownIds.has(id)) fail(`Feedback thread ${id} already exists.`);
  const target = buildTarget(options, semantic, paths.root);
  const assignedStageId =
    option(options, "assigned-stage") ?? target.stageId;
  const assignedStage = semantic.stages.get(assignedStageId);
  if (!assignedStage) {
    fail("Feedback threads require a valid assigned stage.");
  }
  const now = new Date().toISOString();
  const thread = {
    $schema: THREAD_SCHEMA,
    id,
    status: "open",
    comments: [
      {
        id: option(options, "comment-id", { required: true }),
        author: "user",
        body: option(options, "body", { required: true }),
        createdAt: now,
      },
    ],
    target,
    assignedStageId,
    stageHead: assignedStage.change.headRevision,
    createdAt: now,
  };
  validateDocument(ajv, thread, "Feedback thread input");
  knownIds.add(id);
  return thread;
}

function addThreads(paths, optionSets: Options[]) {
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const ajv = schemaValidator();
  const knownIds = new Set(feedback.threads.keys());
  const threads = optionSets.map((options) =>
    createThread(paths, options, semantic, knownIds, ajv),
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

function addThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add"),
  );
  const [thread] = addThreads(paths, [options]);
  console.log(`Added feedback thread ${thread.id}.`);
}

function batchThreadOptions(value, index): Options {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Feedback thread batch item ${index + 1} must be an object.`);
  }
  const options: Options = new Map();
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") {
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

function addThreadBatch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread add-batch"),
  );
  const raw = option(options, "threads", { required: true })!;
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    fail("--threads must contain a JSON array.");
  }
  if (!Array.isArray(values) || values.length === 0) {
    fail("--threads must contain a non-empty JSON array.");
  }
  const threads = addThreads(
    paths,
    values.map((value, index) => batchThreadOptions(value, index)),
  );
  console.log(`Added ${threads.length} feedback thread(s).`);
}

function refreshableTarget(target, semantic, root) {
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
    let changedFile = stage.change.files.find(
      (file) =>
        file.path === target.path || file.previousPath === target.path,
    );
    if (!changedFile) {
      const renamedPath = renamedPathBetween(
        root,
        target.stageHead,
        stage.change.headRevision,
        target.path,
      );
      changedFile = renamedPath
        ? stage.change.files.find(
            (file) =>
              file.path === renamedPath || file.previousPath === renamedPath,
          )
        : null;
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

function refreshPendingAnchor(paths, semantic, thread) {
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

function nextFeedback(paths, options) {
  assertKnownOptions(options, commandOptionNames(reviewFeedbackApi, "next"));
  const json = flag(options, "json");
  const compact = flag(options, "compact");
  if (compact && !json) fail("--compact requires --json.");
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const awaiting = [...feedback.threads.values()].filter(
    (thread) =>
      thread.status === "open" &&
      thread.comments[thread.comments.length - 1]?.author !== "agent",
  );
  const reanchored = new Set();
  const originals = new Map();
  for (const thread of awaiting) {
    originals.set(thread.id, structuredClone(thread));
    if (refreshPendingAnchor(paths, semantic, thread)) reanchored.add(thread.id);
  }
  if (reanchored.size) {
    const ajv = schemaValidator();
    for (const thread of awaiting) {
      if (!reanchored.has(thread.id)) continue;
      validateDocument(
        ajv,
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
  const groups = [];
  for (const stageId of semantic.manifest.stages) {
    const threads = awaiting.filter(
      (thread) => thread.assignedStageId === stageId,
    );
    if (threads.length) {
      const stage = semantic.stages.get(stageId);
      groups.push(
        compact
          ? {
              stageId,
              stageBranch: stage.change.branch,
              threads: threads.map((thread) => {
                const {
                  stageBranch: _targetBranch,
                  stageHead: targetHead,
                  ...target
                } = thread.target;
                const targetStage = target.stageId
                  ? semantic.stages.get(target.stageId)
                  : null;
                return {
                  id: thread.id,
                  stale:
                    thread.stageHead !== stage.change.headRevision ||
                    Boolean(
                      targetHead &&
                        targetStage &&
                        targetHead !== targetStage.change.headRevision,
                    ),
                  ...(reanchored.has(thread.id) ? { reanchored: true } : {}),
                  comments: thread.comments.map(({ author, body }) => ({
                    author,
                    body,
                  })),
                  target,
                };
              }),
            }
          : {
              stageId,
              stageBranch: stage.change.branch,
              stageHead: stage.change.headRevision,
              threads: threads.map((thread) => ({
                id: thread.id,
                stageHead: thread.stageHead,
                comments: thread.comments,
                target: thread.target,
              })),
            },
      );
    }
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
      }
    }
  }
}

function replyThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply"),
  );
  const [{ id, commentId }] = replyThreads(paths, [options]);
  console.log(`Added reply ${commentId} to feedback thread ${id}.`);
}

function applyReply(options, feedback) {
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
  if (!["user", "agent"].includes(author)) {
    fail("--author must be user or agent.");
  }
  thread.comments.push({
    id: commentId,
    author,
    body: option(options, "body", { required: true }),
    createdAt: new Date().toISOString(),
  });
  if (thread.status === "resolved") {
    thread.status = "open";
    delete thread.resolvedAt;
  }
  return { id, commentId, thread };
}

function replyThreads(paths, optionSets: Options[]) {
  const { feedback } = validateFeedback(paths, { quiet: true });
  const originals = new Map();
  for (const options of optionSets) {
    const id = option(options, "id", { required: true });
    const thread = feedback.threads.get(id);
    if (thread && !originals.has(id)) {
      originals.set(id, structuredClone(thread));
    }
  }
  const replies = optionSets.map((options) => applyReply(options, feedback));
  try {
    for (const id of originals.keys()) {
      writeThread(paths, feedback.threads.get(id));
    }
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    for (const [id, thread] of originals) writeThread(paths, thread);
    throw error;
  }
  return replies;
}

function batchReplyOptions(value, index): Options {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Feedback reply batch item ${index + 1} must be an object.`);
  }
  const options: Options = new Map();
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") {
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

function replyThreadBatch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread reply-batch"),
  );
  const raw = option(options, "replies", { required: true })!;
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    fail("--replies must contain a JSON array.");
  }
  if (!Array.isArray(values) || values.length === 0) {
    fail("--replies must contain a non-empty JSON array.");
  }
  const replies = replyThreads(
    paths,
    values.map((value, index) => batchReplyOptions(value, index)),
  );
  console.log(`Added ${replies.length} feedback reply/replies.`);
}

function resolveThread(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(reviewFeedbackApi, "thread resolve"),
  );
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const thread = feedback.threads.get(id);
  if (!thread) fail(`Feedback thread ${id} does not exist.`);
  if (thread.status !== "open") {
    fail(`Feedback thread ${id} is not open.`);
  }
  const commentId = option(options, "comment-id");
  const body = option(options, "body");
  if (Boolean(commentId) !== Boolean(body)) {
    fail("--comment-id and --body must be provided together.");
  }
  const resolvedAt = new Date().toISOString();
  if (commentId) {
    if (thread.comments.some((comment) => comment.id === commentId)) {
      fail(`Comment ${commentId} already exists in thread ${id}.`);
    }
    thread.comments.push({
      id: commentId,
      author: "user",
      body,
      createdAt: resolvedAt,
    });
  }
  thread.status = "resolved";
  thread.resolvedAt = resolvedAt;
  writeThread(paths, thread);
  validateFeedback(paths, { quiet: true });
  console.log(`Resolved feedback thread ${id}.`);
}

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
  thread.status = "open";
  delete thread.resolvedAt;
  writeThread(paths, thread);
  validateFeedback(paths, { quiet: true });
  console.log(`Reopened feedback thread ${id}.`);
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
  if (command === "thread" && subcommand === "resolve") {
    return resolveThread(paths, options);
  }
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
