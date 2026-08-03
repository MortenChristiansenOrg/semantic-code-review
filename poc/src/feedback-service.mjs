import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { readSemanticReview } from "./artifact-reader.mjs";
import { ReviewServiceError } from "./review-service.mjs";

const execFileAsync = promisify(execFile);

function feedbackPaths(repositoryRoot) {
  const root = path.join(repositoryRoot, ".semantic-review-feedback");
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    batches: path.join(root, "batches"),
    items: path.join(root, "items"),
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function generatedId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

function feedbackCli(repositoryRoot) {
  return path.join(
    repositoryRoot,
    "skills",
    "semantic-flow",
    "scripts",
    "review-feedback.mjs",
  );
}

async function runFeedbackCommand(repositoryRoot, args) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [feedbackCli(repositoryRoot), ...args],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    return stdout.trim();
  } catch (error) {
    throw new ReviewServiceError(
      "feedback-command-failed",
      "Feedback state could not be updated.",
      422,
      (error.stderr || error.stdout || error.message)?.trim(),
    );
  }
}

export async function readFeedback({ repositoryRoot }) {
  const paths = feedbackPaths(repositoryRoot);
  try {
    await fs.access(paths.manifest);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        initialized: false,
        batches: [],
      };
    }
    throw error;
  }

  const [manifest, review] = await Promise.all([
    readJson(paths.manifest),
    readSemanticReview({ repositoryRoot }),
  ]);
  const currentCommits = new Map(
    review.stages.map((stage) => [stage.id, stage.change.commit]),
  );
  const batches = [];
  for (const batchId of manifest.batches) {
    const batch = await readJson(path.join(paths.batches, `${batchId}.json`));
    const items = [];
    for (const itemId of batch.items) {
      const item = await readJson(path.join(paths.items, `${itemId}.json`));
      items.push({
        ...item,
        anchorStale:
          Boolean(item.target.stageCommit) &&
          currentCommits.get(item.target.stageId) !== item.target.stageCommit,
      });
    }
    batches.push({ ...batch, feedbackItems: items });
  }
  return {
    initialized: true,
    reviewId: manifest.reviewId,
    batches,
  };
}

export async function initializeFeedback({ repositoryRoot }) {
  await runFeedbackCommand(repositoryRoot, ["init"]);
  return readFeedback({ repositoryRoot });
}

export async function createFeedbackBatch({ repositoryRoot, title }) {
  const id = generatedId("review");
  await runFeedbackCommand(repositoryRoot, [
    "batch",
    "create",
    "--id",
    id,
    `--title=${title}`,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function deleteFeedbackBatch({ repositoryRoot, batchId }) {
  await runFeedbackCommand(repositoryRoot, [
    "batch",
    "delete",
    "--id",
    batchId,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function addFeedbackComment({
  repositoryRoot,
  batchId,
  body,
  target,
}) {
  const id = generatedId("comment");
  const args = [
    "comment",
    "add",
    "--batch",
    batchId,
    "--id",
    id,
    `--body=${body}`,
    "--target-kind",
    target.kind,
    `--label=${target.label}`,
  ];
  const optionalArguments = [
    ["requirement", target.requirementId],
    ["criterion", target.criterionId],
    ["stage", target.stageId],
    ["collection", target.collection],
    ["item", target.itemId],
    ["path", target.path],
    ["side", target.side],
    ["line", target.line],
    ["assigned-stage", target.assignedStageId],
  ];
  for (const [name, value] of optionalArguments) {
    if (value !== undefined && value !== null && value !== "") {
      args.push(`--${name}`, String(value));
    }
  }
  await runFeedbackCommand(repositoryRoot, args);
  return readFeedback({ repositoryRoot });
}

export async function editFeedbackComment({
  repositoryRoot,
  itemId,
  body,
}) {
  await runFeedbackCommand(repositoryRoot, [
    "comment",
    "edit",
    "--id",
    itemId,
    `--body=${body}`,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function deleteFeedbackComment({ repositoryRoot, itemId }) {
  await runFeedbackCommand(repositoryRoot, [
    "comment",
    "delete",
    "--id",
    itemId,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function submitFeedbackBatch({ repositoryRoot, batchId }) {
  await runFeedbackCommand(repositoryRoot, [
    "batch",
    "submit",
    "--id",
    batchId,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function approveFeedbackItem({ repositoryRoot, itemId }) {
  await runFeedbackCommand(repositoryRoot, [
    "comment",
    "approve",
    "--id",
    itemId,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function approveAllFeedback({ repositoryRoot, batchId }) {
  await runFeedbackCommand(repositoryRoot, [
    "batch",
    "approve-all",
    "--id",
    batchId,
  ]);
  return readFeedback({ repositoryRoot });
}

export async function approveFeedbackStack({ repositoryRoot, branch }) {
  const output = await runFeedbackCommand(repositoryRoot, [
    "approve-stack",
    `--branch=${branch}`,
  ]);
  return {
    status: "approved",
    branch,
    summary: output,
  };
}
