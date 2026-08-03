import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readSemanticReview } from "./artifact-reader.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 5 * 1024 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

export class ReviewServiceError extends Error {
  constructor(code, message, status = 422, details = undefined) {
    super(message);
    this.name = "ReviewServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function run(command, args, repositoryRoot) {
  try {
    return await execFileAsync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT,
      windowsHide: true,
    });
  } catch (error) {
    const exceededBuffer =
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      error.message?.includes("maxBuffer");
    throw new ReviewServiceError(
      exceededBuffer ? "command-output-too-large" : "command-failed",
      exceededBuffer
        ? "Command output exceeded the 5 MB proof-of-concept limit."
        : `${path.basename(command)} could not process the review.`,
      422,
      (error.stderr || error.stdout || error.message)?.trim(),
    );
  }
}

function requireCommitId(value, label) {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value)) {
    throw new ReviewServiceError(
      "invalid-git-revision",
      `${label} must be a full lowercase 40-character SHA-1 commit ID.`,
    );
  }
  return value;
}

export async function readStageDiff({ repositoryRoot, stageId }) {
  const review = await readSemanticReview({
    repositoryRoot,
    includeWorkingStages: false,
  });
  const index = review.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) {
    throw new ReviewServiceError(
      "stage-not-finalized",
      `Finalized stage ${stageId} was not found.`,
      404,
    );
  }

  const stage = review.stages[index];
  const parent = requireCommitId(
    index === 0
      ? review.manifest.baseRevision
      : review.stages[index - 1].change.commit,
    "Stage parent",
  );
  const commit = requireCommitId(stage.change?.commit, "Stage commit");
  const { stdout } = await run(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--find-renames=50%",
      "--unified=3",
      parent,
      commit,
      "--",
    ],
    repositoryRoot,
  );

  return {
    stageId,
    parent,
    commit,
    diff: stdout,
  };
}

export async function validateCurrentReview({ repositoryRoot }) {
  const validator = path.join(
    repositoryRoot,
    "skills",
    "semantic-flow",
    "scripts",
    "semantic-review.mjs",
  );
  const { stdout } = await run(
    process.execPath,
    [validator, "validate"],
    repositoryRoot,
  );
  return {
    status: "passed",
    summary: stdout.trim(),
  };
}
