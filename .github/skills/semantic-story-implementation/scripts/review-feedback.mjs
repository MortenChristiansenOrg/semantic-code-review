#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse, parseTree, printParseErrorCode } from "jsonc-parser";

const MANIFEST_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/manifest.schema.json";
const BATCH_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/batch.schema.json";
const ITEM_SCHEMA =
  "https://semantic-code-review.dev/schemas/feedback/v0.1/item.schema.json";
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const feedbackSchemaDirectory =
  process.env.SEMANTIC_REVIEW_FEEDBACK_SCHEMA_DIR ??
  path.resolve(
    skillDirectory,
    "..",
    "..",
    "..",
    "standard",
    "v0.1",
    "feedback-schema",
  );
const semanticCli = path.join(scriptDirectory, "semantic-review.mjs");

const HELP = `Semantic review feedback CLI

Usage:
  review-feedback.mjs init
  review-feedback.mjs batch create --id <id> --title <title>
  review-feedback.mjs comment add [target options]
  review-feedback.mjs comment edit --id <feedback-id> --body <body>
  review-feedback.mjs comment delete --id <feedback-id>
  review-feedback.mjs comment assign --id <feedback-id> --stage <stage-id>
  review-feedback.mjs batch submit --id <batch-id>
  review-feedback.mjs next [--json]
  review-feedback.mjs comment resolve --id <feedback-id> [resolution options]
  review-feedback.mjs comment approve --id <feedback-id>
  review-feedback.mjs batch approve-all --id <batch-id>
  review-feedback.mjs approve-stack --branch <branch-name>
  review-feedback.mjs validate

Comment target options:
  --target-kind requirement --requirement <id>
  --target-kind criterion --requirement <id> --criterion <id>
  --target-kind stage --stage <id>
  --target-kind context --stage <id> --collection <name> --item <id>
  --target-kind file --stage <id> --path <repository-path>
  --target-kind line --stage <id> --path <repository-path> --side <old|new> --line <n>

All comment commands also require --batch, --id, --body, and --label.`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    let name;
    let optionValue;
    if (separator > 2) {
      name = value.slice(2, separator);
      optionValue = value.slice(separator + 1);
    } else {
      name = value.slice(2);
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) {
        optionValue = true;
      } else {
        optionValue = next;
        index += 1;
      }
    }
    const existing = options.get(name) ?? [];
    existing.push(optionValue);
    options.set(name, existing);
  }
  return { positionals, options };
}

function option(options, name, { required = false, defaultValue } = {}) {
  const values = options.get(name);
  if (!values?.length) {
    if (required) fail(`Missing required option --${name}.`);
    return defaultValue;
  }
  if (values.length !== 1) fail(`Option --${name} may only be specified once.`);
  if (values[0] === true) fail(`Option --${name} requires a value.`);
  return values[0];
}

function assertKnownOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) fail(`Unknown option --${name}.`);
  }
}

function git(args, { cwd, allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.toString().trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
}

function repositoryRoot() {
  return path.resolve(git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }));
}

function pathsFor(root) {
  const feedback = path.join(root, ".semantic-review-feedback");
  return {
    root,
    semantic: path.join(root, ".semantic-review"),
    feedback,
    feedbackManifest: path.join(feedback, "manifest.json"),
    batches: path.join(feedback, "batches"),
    items: path.join(feedback, "items"),
  };
}

function findDuplicateKeys(node, file, errors) {
  if (!node) return;
  if (node.type === "object") {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (keys.has(key)) errors.push(`${file}: duplicate object key "${key}".`);
      keys.add(key);
      findDuplicateKeys(property.children?.[1], file, errors);
    }
    return;
  }
  for (const child of node.children ?? []) {
    findDuplicateKeys(child, file, errors);
  }
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) fail(`${file}: byte-order marks are invalid.`);
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length) {
    fail(
      `${file}: ${errors
        .map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`)
        .join(", ")}.`,
    );
  }
  const duplicates = [];
  findDuplicateKeys(
    parseTree(text, [], {
      allowTrailingComma: false,
      disallowComments: true,
    }),
    file,
    duplicates,
  );
  if (duplicates.length) fail(duplicates.join("\n"));
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
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
  const requirements = new Map(
    manifest.requirements.map((id) => [
      id,
      readJson(path.join(paths.semantic, "requirements", `${id}.json`)),
    ]),
  );
  const stages = new Map(
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
    "item.schema.json",
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
  const items = new Map();
  for (const id of manifest.batches ?? []) {
    const batch = readJson(path.join(paths.batches, `${id}.json`));
    batches.set(id, batch);
    for (const itemId of batch.items ?? []) {
      if (items.has(itemId)) fail(`Feedback item ${itemId} appears in multiple batches.`);
      items.set(itemId, readJson(path.join(paths.items, `${itemId}.json`)));
    }
  }
  return { manifest, batches, items };
}

function collectionExists(stage, collection, itemId) {
  return Array.isArray(stage[collection]) &&
    stage[collection].some((item) => item.id === itemId);
}

function validateTarget(target, semantic) {
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
    if (target.stageCommit === stage.change.commit) {
      if (
        target.kind === "context" &&
        !collectionExists(stage, target.collection, target.itemId)
      ) {
        fail(
          `Feedback context ${target.stageId}/${target.collection}/${target.itemId} does not exist.`,
        );
      }
      if (
        ["file", "line"].includes(target.kind) &&
        !stage.change.files.some(
          (file) =>
            file.path === target.path || file.previousPath === target.path,
        )
      ) {
        fail(`Feedback path ${target.path} is not changed by ${target.stageId}.`);
      }
    }
  }
}

function expectedBatchStatus(batch, items) {
  if (items.length === 0) return "draft";
  if (items.every((item) => item.status === "draft")) return "draft";
  if (items.every((item) => item.status === "submitted")) return "submitted";
  if (items.every((item) => item.status === "approved")) return "approved";
  if (
    items.every((item) =>
      ["addressed", "approved"].includes(item.status),
    )
  ) {
    return "resolved";
  }
  return "addressing";
}

function validateFeedback(paths, { quiet = false } = {}) {
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
  const listedItems = new Set(feedback.items.keys());
  for (const id of listJsonIds(paths.items)) {
    if (!listedItems.has(id)) fail(`Unlisted feedback item ${id}.`);
  }

  for (const [id, batch] of feedback.batches) {
    validateDocument(ajv, batch, path.join(paths.batches, `${id}.json`));
    if (batch.id !== id) fail(`Batch ${id} has internal ID ${batch.id}.`);
    const batchItems = batch.items.map((itemId) => {
      const item = feedback.items.get(itemId);
      if (!item) fail(`Batch ${id} references missing item ${itemId}.`);
      return item;
    });
    const expected = expectedBatchStatus(batch, batchItems);
    if (batch.status !== expected) {
      fail(`Batch ${id} status ${batch.status} should be ${expected}.`);
    }
  }

  for (const [id, item] of feedback.items) {
    validateDocument(ajv, item, path.join(paths.items, `${id}.json`));
    if (item.id !== id) fail(`Feedback item ${id} has internal ID ${item.id}.`);
    const batch = feedback.batches.get(item.batchId);
    if (!batch?.items.includes(id)) {
      fail(`Feedback item ${id} is not indexed by batch ${item.batchId}.`);
    }
    validateTarget(item.target, semantic);
    if (
      item.assignedStageId &&
      !semantic.stages.has(item.assignedStageId)
    ) {
      fail(
        `Feedback item ${id} is assigned to missing stage ${item.assignedStageId}.`,
      );
    }
    if (item.resolution) {
      const stage = semantic.stages.get(item.resolution.stageId);
      if (!stage) fail(`Resolution stage ${item.resolution.stageId} is missing.`);
      if (stage.change.commit !== item.resolution.rewrittenCommit) {
        fail(
          `Resolution ${id} points to stale rewritten commit ${item.resolution.rewrittenCommit}.`,
        );
      }
      if (!SHA1_PATTERN.test(item.resolution.previousCommit)) {
        fail(`Resolution ${id} has invalid previousCommit.`);
      }
    }
  }

  if (!quiet) {
    console.log(
      `Feedback validation passed: ${feedback.batches.size} batch(es), ${feedback.items.size} item(s).`,
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
  assertKnownOptions(options, new Set());
  if (fs.existsSync(paths.feedbackManifest)) fail("Feedback state already exists.");
  const semantic = semanticArtifact(paths);
  ensureExcluded(paths.root);
  writeJson(paths.feedbackManifest, {
    $schema: MANIFEST_SCHEMA,
    formatVersion: "0.1",
    reviewId: semantic.manifest.reviewId,
    batches: [],
  });
  validateFeedback(paths, { quiet: true });
  console.log(`Initialized feedback for ${semantic.manifest.reviewId}.`);
}

function createBatch(paths, options) {
  assertKnownOptions(options, new Set(["id", "title"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  if (feedback.batches.has(id)) fail(`Batch ${id} already exists.`);
  const now = new Date().toISOString();
  const batch = {
    $schema: BATCH_SCHEMA,
    id,
    title: option(options, "title", { required: true }),
    status: "draft",
    items: [],
    createdAt: now,
  };
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

function buildTarget(options, semantic) {
  const kind = option(options, "target-kind", { required: true });
  const target = {
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
    target.stageCommit = stage.change.commit;
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
  validateTarget(target, semantic);
  return target;
}

function addComment(paths, options) {
  assertKnownOptions(
    options,
    new Set([
      "batch",
      "id",
      "body",
      "label",
      "target-kind",
      "requirement",
      "criterion",
      "stage",
      "collection",
      "item",
      "path",
      "side",
      "line",
      "assigned-stage",
    ]),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const batchId = option(options, "batch", { required: true });
  const batch = feedback.batches.get(batchId);
  if (!batch) fail(`Batch ${batchId} does not exist.`);
  if (batch.status !== "draft") fail(`Batch ${batchId} is not editable.`);
  const id = option(options, "id", { required: true });
  if (feedback.items.has(id)) fail(`Feedback item ${id} already exists.`);
  const item = {
    $schema: ITEM_SCHEMA,
    id,
    batchId,
    status: "draft",
    body: option(options, "body", { required: true }),
    target: buildTarget(options, semantic),
    createdAt: new Date().toISOString(),
  };
  const assignedStageId =
    option(options, "assigned-stage") ?? item.target.stageId;
  if (assignedStageId) {
    if (!semantic.stages.has(assignedStageId)) {
      fail(`Assigned stage ${assignedStageId} does not exist.`);
    }
    item.assignedStageId = assignedStageId;
  }
  const file = path.join(paths.items, `${id}.json`);
  const oldBatch = structuredClone(batch);
  batch.items.push(id);
  try {
    writeJson(file, item);
    writeJson(path.join(paths.batches, `${batchId}.json`), batch);
    validateFeedback(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    writeJson(path.join(paths.batches, `${batchId}.json`), oldBatch);
    throw error;
  }
  console.log(`Added feedback item ${id} to ${batchId}.`);
}

function editComment(paths, options) {
  assertKnownOptions(options, new Set(["id", "body"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const item = feedback.items.get(id);
  if (!item) fail(`Feedback item ${id} does not exist.`);
  if (item.status !== "draft") fail(`Feedback item ${id} is immutable after submission.`);
  item.body = option(options, "body", { required: true });
  writeItem(paths, item);
  validateFeedback(paths, { quiet: true });
  console.log(`Edited draft feedback item ${id}.`);
}

function deleteComment(paths, options) {
  assertKnownOptions(options, new Set(["id"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const item = feedback.items.get(id);
  if (!item) fail(`Feedback item ${id} does not exist.`);
  if (item.status !== "draft") fail(`Feedback item ${id} is immutable after submission.`);
  const batch = feedback.batches.get(item.batchId);
  batch.items = batch.items.filter((itemId) => itemId !== id);
  writeBatch(paths, batch);
  fs.rmSync(path.join(paths.items, `${id}.json`));
  validateFeedback(paths, { quiet: true });
  console.log(`Deleted draft feedback item ${id}.`);
}

function assignComment(paths, options) {
  assertKnownOptions(options, new Set(["id", "stage"]));
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const stageId = option(options, "stage", { required: true });
  const item = feedback.items.get(id);
  if (!item) fail(`Feedback item ${id} does not exist.`);
  if (!["draft", "submitted"].includes(item.status)) {
    fail(`Feedback item ${id} can no longer be assigned.`);
  }
  if (item.status === "submitted" && item.assignedStageId) {
    fail(`Submitted feedback item ${id} is already assigned.`);
  }
  if (!semantic.stages.has(stageId)) fail(`Stage ${stageId} does not exist.`);
  item.assignedStageId = stageId;
  writeItem(paths, item);
  validateFeedback(paths, { quiet: true });
  console.log(`Assigned feedback item ${id} to ${stageId}.`);
}

function writeBatch(paths, batch) {
  writeJson(path.join(paths.batches, `${batch.id}.json`), batch);
}

function writeItem(paths, item) {
  writeJson(path.join(paths.items, `${item.id}.json`), item);
}

function updateBatchStatus(batch, feedback) {
  batch.status = expectedBatchStatus(
    batch,
    batch.items.map((id) => feedback.items.get(id)),
  );
  if (batch.status === "approved" && !batch.approvedAt) {
    batch.approvedAt = new Date().toISOString();
  }
}

function submitBatch(paths, options) {
  assertKnownOptions(options, new Set(["id"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const batch = feedback.batches.get(id);
  if (!batch) fail(`Batch ${id} does not exist.`);
  if (batch.status !== "draft" || batch.items.length === 0) {
    fail(`Batch ${id} must be a non-empty draft.`);
  }
  const now = new Date().toISOString();
  for (const itemId of batch.items) {
    const item = feedback.items.get(itemId);
    item.status = "submitted";
    writeItem(paths, item);
  }
  batch.status = "submitted";
  batch.submittedAt = now;
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Submitted feedback batch ${id}.`);
}

function nextFeedback(paths, options) {
  assertKnownOptions(options, new Set(["json"]));
  const json = options.has("json");
  if (
    json &&
    (options.get("json").length !== 1 || options.get("json")[0] !== true)
  ) {
    fail("--json is a flag.");
  }
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const submitted = [...feedback.items.values()].filter(
    (item) => item.status === "submitted",
  );
  const unassigned = submitted.filter(
    (item) => !(item.assignedStageId ?? item.target.stageId),
  );
  if (unassigned.length) {
    fail(
      `Submitted feedback requires stage assignment: ${unassigned
        .map((item) => item.id)
        .join(", ")}.`,
    );
  }
  const groups = [];
  for (const stageId of semantic.manifest.stages) {
    const items = submitted.filter(
      (item) => (item.assignedStageId ?? item.target.stageId) === stageId,
    );
    if (items.length) {
      groups.push({
        stageId,
        stageCommit: semantic.stages.get(stageId).change.commit,
        items: items.map((item) => ({
          id: item.id,
          body: item.body,
          target: item.target,
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
    console.log(`${group.stageId} (${group.stageCommit}):`);
    for (const item of group.items) {
      console.log(`  ${item.id}: ${item.body}`);
    }
  }
}

function resolveComment(paths, options) {
  assertKnownOptions(
    options,
    new Set(["id", "summary", "stage", "previous", "rewritten"]),
  );
  const { semantic, feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const item = feedback.items.get(id);
  if (!item) fail(`Feedback item ${id} does not exist.`);
  if (item.status !== "submitted") fail(`Feedback item ${id} is not submitted.`);
  const stageId = option(options, "stage", { required: true });
  const stage = semantic.stages.get(stageId);
  if (!stage) fail(`Resolution stage ${stageId} does not exist.`);
  const previous = option(options, "previous", { required: true });
  const rewritten = option(options, "rewritten", { required: true });
  if (!SHA1_PATTERN.test(previous) || !SHA1_PATTERN.test(rewritten)) {
    fail("Resolution commits must be full lowercase SHA-1 IDs.");
  }
  if (stage.change.commit !== rewritten) {
    fail(`Stage ${stageId} currently points to ${stage.change.commit}, not ${rewritten}.`);
  }
  item.status = "addressed";
  item.resolution = {
    summary: option(options, "summary", { required: true }),
    stageId,
    previousCommit: previous,
    rewrittenCommit: rewritten,
    addressedAt: new Date().toISOString(),
  };
  writeItem(paths, item);
  const batch = feedback.batches.get(item.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Recorded resolution for ${id}.`);
}

function approveComment(paths, options) {
  assertKnownOptions(options, new Set(["id"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const item = feedback.items.get(id);
  if (!item) fail(`Feedback item ${id} does not exist.`);
  if (item.status !== "addressed") fail(`Feedback item ${id} is not awaiting approval.`);
  item.status = "approved";
  item.resolution.approvedAt = new Date().toISOString();
  writeItem(paths, item);
  const batch = feedback.batches.get(item.batchId);
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Approved feedback resolution ${id}.`);
}

function approveAll(paths, options) {
  assertKnownOptions(options, new Set(["id"]));
  const { feedback } = validateFeedback(paths, { quiet: true });
  const id = option(options, "id", { required: true });
  const batch = feedback.batches.get(id);
  if (!batch) fail(`Batch ${id} does not exist.`);
  const items = batch.items.map((itemId) => feedback.items.get(itemId));
  if (!items.some((item) => item.status === "addressed")) {
    fail(`Batch ${id} has no addressed resolutions to approve.`);
  }
  if (items.some((item) => !["addressed", "approved"].includes(item.status))) {
    fail(`Batch ${id} still contains unresolved feedback.`);
  }
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status === "addressed") {
      item.status = "approved";
      item.resolution.approvedAt = now;
      writeItem(paths, item);
    }
  }
  updateBatchStatus(batch, feedback);
  writeBatch(paths, batch);
  validateFeedback(paths, { quiet: true });
  console.log(`Approved all resolutions in ${id}.`);
}

function approveStack(paths, options) {
  assertKnownOptions(options, new Set(["branch"]));
  const branch = option(options, "branch", { required: true });
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
  execFileSync(process.execPath, [semanticCli, "prepare-pr", "--branch", branch], {
    cwd: paths.root,
    stdio: "inherit",
  });
  console.log(`Approved semantic stack for ${branch}.`);
}

function dispatch(paths, positionals, options) {
  const [command, subcommand, ...extra] = positionals;
  if (extra.length) fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  if (!command || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "init" && !subcommand) return initialize(paths, options);
  if (command === "batch" && subcommand === "create") return createBatch(paths, options);
  if (command === "comment" && subcommand === "add") return addComment(paths, options);
  if (command === "comment" && subcommand === "edit") return editComment(paths, options);
  if (command === "comment" && subcommand === "delete") return deleteComment(paths, options);
  if (command === "comment" && subcommand === "assign") return assignComment(paths, options);
  if (command === "batch" && subcommand === "submit") return submitBatch(paths, options);
  if (command === "next" && !subcommand) return nextFeedback(paths, options);
  if (command === "comment" && subcommand === "resolve") return resolveComment(paths, options);
  if (command === "comment" && subcommand === "approve") return approveComment(paths, options);
  if (command === "batch" && subcommand === "approve-all") return approveAll(paths, options);
  if (command === "approve-stack" && !subcommand) return approveStack(paths, options);
  if (command === "validate" && !subcommand) {
    assertKnownOptions(options, new Set());
    validateFeedback(paths);
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

try {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const paths = pathsFor(repositoryRoot());
  dispatch(paths, positionals, options);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
