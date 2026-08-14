import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readSemanticReview } from "./artifact-reader.mjs";
import { semanticReviewCli } from "./semantic-flow-tools.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 5 * 1024 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const PROJECT_MARKERS = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
]);
const PROJECT_EXTENSIONS = new Set([
  ".csproj",
  ".fsproj",
  ".vbproj",
  ".sln",
]);

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

function normalizedPath(value) {
  return value.replaceAll("\\", "/");
}

function projectName(directory, marker) {
  const extension = path.extname(marker).toLowerCase();
  if (PROJECT_EXTENSIONS.has(extension)) {
    return path.basename(marker, extension);
  }
  if (directory === ".") return "Repository root";
  return path.posix.basename(normalizedPath(directory));
}

async function detectProject(repositoryRoot, filePath, cache) {
  let directory = path.posix.dirname(normalizedPath(filePath));
  while (true) {
    if (!cache.has(directory)) {
      const absoluteDirectory = path.join(
        repositoryRoot,
        ...directory.split("/").filter((part) => part !== "."),
      );
      let markers = [];
      try {
        markers = (await fs.readdir(absoluteDirectory, {
          withFileTypes: true,
        }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .filter((name) => {
            const lowerName = name.toLowerCase();
            return (
              PROJECT_MARKERS.has(lowerName) ||
              PROJECT_EXTENSIONS.has(path.extname(lowerName))
            );
          })
          .sort((left, right) => {
            const leftProject = PROJECT_EXTENSIONS.has(
              path.extname(left).toLowerCase(),
            );
            const rightProject = PROJECT_EXTENSIONS.has(
              path.extname(right).toLowerCase(),
            );
            return Number(rightProject) - Number(leftProject) ||
              left.localeCompare(right);
          });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      cache.set(
        directory,
        markers[0]
          ? {
              root: directory,
              name: projectName(directory, markers[0]),
              marker: markers[0],
            }
          : undefined,
      );
    }
    const project = cache.get(directory);
    if (project) return project;
    if (directory === ".") {
      return {
        root: ".",
        name: "Repository root",
      };
    }
    directory = path.posix.dirname(directory);
  }
}

export async function annotateReviewProjects(review) {
  const cache = new Map();
  await Promise.all(
    [...review.stages, ...review.workingStages].flatMap((stage) =>
      (stage.change?.files ?? []).map(async (file) => {
        file.project = await detectProject(
          review.repositoryRoot,
          file.path,
          cache,
        );
      }),
    ),
  );
  return review;
}

function finalizedStage(review, stageId) {
  const stage = review.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new ReviewServiceError(
      "stage-not-finalized",
      `Finalized stage ${stageId} was not found.`,
      404,
    );
  }
  return stage;
}

function changedFile(stage, requestedPath) {
  const filePath = normalizedPath(requestedPath);
  const file = stage.change.files.find(
    (candidate) => normalizedPath(candidate.path) === filePath,
  );
  if (!file) {
    throw new ReviewServiceError(
      "file-not-in-stage",
      `File ${filePath} is not part of stage ${stage.id}.`,
      404,
    );
  }
  return file;
}

function languageForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".cs": "csharp",
      ".csproj": "xml",
      ".css": "css",
      ".fs": "fsharp",
      ".fsproj": "xml",
      ".html": "html",
      ".htm": "html",
      ".java": "java",
      ".js": "javascript",
      ".json": "json",
      ".jsx": "javascript",
      ".md": "markdown",
      ".mjs": "javascript",
      ".ps1": "powershell",
      ".py": "python",
      ".razor": "html",
      ".sh": "shell",
      ".sql": "sql",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".vb": "visual-basic",
      ".vbproj": "xml",
      ".xml": "xml",
      ".yaml": "yaml",
      ".yml": "yaml",
    }[extension] ?? "plain-text"
  );
}

async function readRevisionFile(repositoryRoot, revision, filePath) {
  const { stdout } = await run(
    "git",
    ["show", `${revision}:${normalizedPath(filePath)}`],
    repositoryRoot,
  );
  return stdout;
}

export async function readStageDiff({ repositoryRoot, stageId }) {
  const review = await readSemanticReview({
    repositoryRoot,
    includeWorkingStages: false,
  });
  const stage = finalizedStage(review, stageId);
  const parent = requireCommitId(
    stage.change?.baseRevision,
    "Stage parent",
  );
  const head = requireCommitId(stage.change?.headRevision, "Stage head");
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
      head,
      "--",
    ],
    repositoryRoot,
  );

  return {
    stageId,
    branch: stage.change.branch,
    baseBranch: stage.change.baseBranch,
    parent,
    head,
    diff: stdout,
  };
}

export async function readStageFileDiff({
  repositoryRoot,
  stageId,
  filePath,
}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ReviewServiceError(
      "missing-file-path",
      "A stage file path is required.",
      400,
    );
  }

  const review = await readSemanticReview({
    repositoryRoot,
    includeWorkingStages: false,
  });
  const stage = finalizedStage(review, stageId);
  const file = changedFile(stage, filePath);
  const parent = requireCommitId(
    stage.change?.baseRevision,
    "Stage parent",
  );
  const head = requireCommitId(stage.change?.headRevision, "Stage head");
  const oldPath = file.previousPath ?? file.path;
  const newPath = file.path;
  const diffPaths = [...new Set([oldPath, newPath])];
  const [{ stdout: patch }, { stdout: numstat }, oldContent, newContent] =
    await Promise.all([
      run(
        "git",
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-ext-diff",
          "--find-renames=50%",
          "--unified=3",
          parent,
          head,
          "--",
          ...diffPaths,
        ],
        repositoryRoot,
      ),
      run(
        "git",
        ["diff", "--numstat", parent, head, "--", ...diffPaths],
        repositoryRoot,
      ),
      file.kind === "added"
        ? Promise.resolve(undefined)
        : readRevisionFile(repositoryRoot, parent, oldPath),
      file.kind === "deleted"
        ? Promise.resolve(undefined)
        : readRevisionFile(repositoryRoot, head, newPath),
    ]);
  const [added = "0", deleted = "0"] = numstat.trim().split(/\s+/);
  const binary =
    added === "-" ||
    deleted === "-" ||
    /(?:Binary files|GIT binary patch)/.test(patch);

  return {
    stageId,
    path: newPath,
    previousPath: file.previousPath,
    kind: file.kind,
    language: languageForPath(newPath),
    binary,
    additions: binary ? undefined : Number(added),
    deletions: binary ? undefined : Number(deleted),
    patch,
    oldContent: binary ? undefined : oldContent,
    newContent: binary ? undefined : newContent,
  };
}

export async function validateCurrentReview({ repositoryRoot }) {
  const { stdout } = await run(
    process.execPath,
    [semanticReviewCli, "validate"],
    repositoryRoot,
  );
  return {
    status: "passed",
    summary: stdout.trim(),
  };
}
