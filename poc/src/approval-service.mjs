import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readSemanticReview } from "./artifact-reader.mjs";
import { ReviewServiceError } from "./review-service.mjs";

const execFileAsync = promisify(execFile);
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const mutationQueues = new Map();

function approvalPaths(repositoryRoot) {
  const root = path.join(repositoryRoot, ".semantic-review-feedback");
  return {
    root,
    state: path.join(root, "approvals.json"),
  };
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requireRevision(value, label) {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value)) {
    throw new ReviewServiceError(
      "invalid-git-revision",
      `${label} must be a full lowercase 40-character SHA-1 commit ID.`,
    );
  }
  return value;
}

async function fileFingerprint(repositoryRoot, stage, file) {
  const base = requireRevision(stage.change.baseRevision, "Stage parent");
  const head = requireRevision(stage.change.headRevision, "Stage head");
  const paths = [
    ...new Set([file.previousPath, file.path].filter(Boolean).map(normalizedPath)),
  ];
  let patch;
  try {
    ({ stdout: patch } = await execFileAsync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--binary",
        "--find-renames=50%",
        base,
        head,
        "--",
        ...paths,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    throw new ReviewServiceError(
      "approval-fingerprint-failed",
      `Could not fingerprint ${file.path} in stage ${stage.id}.`,
      422,
      (error.stderr || error.stdout || error.message)?.trim(),
    );
  }
  return fingerprint({
    kind: file.kind,
    path: normalizedPath(file.path),
    previousPath: file.previousPath
      ? normalizedPath(file.previousPath)
      : undefined,
    patch,
  });
}

function approvalKey(resource) {
  return canonicalJson(resource);
}

function statusFor(record, currentFingerprint, available = true) {
  if (!available) {
    return {
      available: false,
      approved: false,
      previouslyApproved: false,
    };
  }
  return {
    available: true,
    approved: record?.fingerprint === currentFingerprint,
    previouslyApproved:
      Boolean(record) && record.fingerprint !== currentFingerprint,
    approvedAt:
      record?.fingerprint === currentFingerprint
        ? record.approvedAt
        : undefined,
  };
}

async function readState(file, reviewId) {
  let state;
  try {
    state = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        formatVersion: "0.1",
        reviewId,
        approvals: {},
      };
    }
    if (error instanceof SyntaxError) {
      throw new ReviewServiceError(
        "invalid-approval-state",
        "Review approval state contains invalid JSON.",
        422,
        error.message,
      );
    }
    throw error;
  }
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    typeof state.approvals !== "object" ||
    !state.approvals ||
    Array.isArray(state.approvals)
  ) {
    throw new ReviewServiceError(
      "invalid-approval-state",
      "Review approval state has an invalid shape.",
    );
  }
  if (state.reviewId !== reviewId) {
    return {
      formatVersion: "0.1",
      reviewId,
      approvals: {},
    };
  }
  return state;
}

async function ensureExcluded(repositoryRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const value = stdout.trim();
  const exclude = path.isAbsolute(value)
    ? value
    : path.resolve(repositoryRoot, value);
  let content = "";
  try {
    content = await fs.readFile(exclude, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!content.split(/\r?\n/).includes(".semantic-review-feedback/")) {
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.appendFile(
      exclude,
      `${content && !content.endsWith("\n") ? "\n" : ""}.semantic-review-feedback/\n`,
      "utf8",
    );
  }
}

async function writeState(repositoryRoot, paths, state) {
  await ensureExcluded(repositoryRoot);
  await fs.mkdir(paths.root, { recursive: true });
  const temporary = `${paths.state}.${process.pid}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporary, paths.state);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function buildApprovalModel(repositoryRoot) {
  const review = await readSemanticReview({ repositoryRoot });
  const fileFingerprints = new Map();
  const stageModels = new Map();

  for (const stage of review.stages) {
    const files = new Map();
    await Promise.all(
      stage.change.files.map(async (file) => {
        const value = await fileFingerprint(repositoryRoot, stage, file);
        files.set(normalizedPath(file.path), value);
        fileFingerprints.set(`${stage.id}\0${normalizedPath(file.path)}`, value);
      }),
    );
    const nodes = new Map(
      stage.nodes.map((node) => [
        node.id,
        fingerprint({
          id: node.id,
          description: node.description,
          changes: node.changes.map((change) => ({
            ...change,
            path: normalizedPath(change.path),
            fileFingerprint: files.get(normalizedPath(change.path)),
          })),
        }),
      ]),
    );
    const stageFingerprint = fingerprint({
      id: stage.id,
      title: stage.title,
      summary: stage.summary,
      rationale: stage.rationale,
      dependsOn: stage.dependsOn,
      requirementRefs: stage.requirementRefs,
      nodes: [...nodes],
      decisions: stage.decisions,
      assumptions: stage.assumptions,
      alternatives: stage.alternatives,
      failedAttempts: stage.failedAttempts,
      risks: stage.risks,
      validation: stage.validation,
      openQuestions: stage.openQuestions,
      files: [...files],
    });
    stageModels.set(stage.id, {
      stage,
      files,
      nodes,
      fingerprint: stageFingerprint,
    });
  }

  const changeSetAvailable =
    review.stages.length > 0 && review.workingStages.length === 0;
  const changeSetFingerprint = fingerprint({
    manifest: {
      reviewId: review.manifest.reviewId,
      title: review.manifest.title,
      summary: review.manifest.summary,
      targetBranch: review.manifest.targetBranch,
      requirements: review.manifest.requirements,
      stages: review.manifest.stages,
    },
    requirements: review.requirements,
    stages: [...stageModels].map(([id, value]) => [id, value.fingerprint]),
  });

  return {
    review,
    stageModels,
    fileFingerprints,
    changeSetAvailable,
    changeSetFingerprint,
  };
}

function resolveResource(model, resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new ReviewServiceError(
      "invalid-approval-resource",
      "An approval resource is required.",
      400,
    );
  }
  if (resource.kind === "changeSet") {
    if (!model.changeSetAvailable) {
      throw new ReviewServiceError(
        "approval-unavailable",
        "The full change set can be approved after all working stages are finalized.",
        409,
      );
    }
    const normalized = { kind: "changeSet" };
    return {
      resource: normalized,
      key: approvalKey(normalized),
      fingerprint: model.changeSetFingerprint,
    };
  }

  const stageId =
    typeof resource.stageId === "string" ? resource.stageId : "";
  const stageModel = model.stageModels.get(stageId);
  if (!stageModel) {
    const working = model.review.workingStages.some(
      (stage) => stage.id === stageId,
    );
    throw new ReviewServiceError(
      working ? "approval-unavailable" : "approval-resource-not-found",
      working
        ? `Stage ${stageId} can be approved after it is finalized.`
        : `Stage ${stageId} was not found.`,
      working ? 409 : 404,
    );
  }
  if (resource.kind === "stage") {
    const normalized = { kind: "stage", stageId };
    return {
      resource: normalized,
      key: approvalKey(normalized),
      fingerprint: stageModel.fingerprint,
    };
  }
  if (resource.kind === "node") {
    const nodeId = typeof resource.nodeId === "string" ? resource.nodeId : "";
    const nodeFingerprint = stageModel.nodes.get(nodeId);
    if (!nodeFingerprint) {
      throw new ReviewServiceError(
        "approval-resource-not-found",
        `Node ${nodeId} was not found in stage ${stageId}.`,
        404,
      );
    }
    const normalized = { kind: "node", stageId, nodeId };
    return {
      resource: normalized,
      key: approvalKey(normalized),
      fingerprint: nodeFingerprint,
    };
  }
  if (resource.kind === "file") {
    const filePath =
      typeof resource.path === "string"
        ? normalizedPath(resource.path)
        : "";
    const fileValue = stageModel.files.get(filePath);
    if (!fileValue) {
      throw new ReviewServiceError(
        "approval-resource-not-found",
        `File ${filePath} was not found in stage ${stageId}.`,
        404,
      );
    }
    const normalized = { kind: "file", stageId, path: filePath };
    return {
      resource: normalized,
      key: approvalKey(normalized),
      fingerprint: fileValue,
    };
  }
  throw new ReviewServiceError(
    "invalid-approval-resource",
    "Approval kind must be changeSet, stage, node, or file.",
    400,
  );
}

function approvalResponse(model, state) {
  const stages = {};
  const nodes = {};
  const files = {};
  const changeSetResource = { kind: "changeSet" };
  const changeSetRecord = state.approvals[approvalKey(changeSetResource)];

  for (const [stageId, stageModel] of model.stageModels) {
    const stageResource = { kind: "stage", stageId };
    stages[stageId] = statusFor(
      state.approvals[approvalKey(stageResource)],
      stageModel.fingerprint,
    );
    nodes[stageId] = {};
    for (const [nodeId, nodeFingerprint] of stageModel.nodes) {
      const nodeResource = { kind: "node", stageId, nodeId };
      nodes[stageId][nodeId] = statusFor(
        state.approvals[approvalKey(nodeResource)],
        nodeFingerprint,
      );
    }
    files[stageId] = {};
    for (const [filePath, fileValue] of stageModel.files) {
      const fileResource = { kind: "file", stageId, path: filePath };
      files[stageId][filePath] = statusFor(
        state.approvals[approvalKey(fileResource)],
        fileValue,
      );
    }
  }
  for (const stage of model.review.workingStages) {
    stages[stage.id] = statusFor(undefined, undefined, false);
  }

  return {
    reviewId: model.review.manifest.reviewId,
    changeSet: statusFor(
      changeSetRecord,
      model.changeSetFingerprint,
      model.changeSetAvailable,
    ),
    stages,
    nodes,
    files,
  };
}

export async function readReviewApprovals({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot);
  const paths = approvalPaths(root);
  const model = await buildApprovalModel(root);
  const state = await readState(paths.state, model.review.manifest.reviewId);
  return approvalResponse(model, state);
}

export async function setReviewApproval({
  repositoryRoot,
  resource,
  approved,
}) {
  if (typeof approved !== "boolean") {
    throw new ReviewServiceError(
      "invalid-request",
      "approved must be a boolean.",
      400,
    );
  }
  const root = path.resolve(repositoryRoot);
  const previous = mutationQueues.get(root) ?? Promise.resolve();
  const mutation = previous.then(async () => {
    const paths = approvalPaths(root);
    const model = await buildApprovalModel(root);
    const resolved = resolveResource(model, resource);
    const state = await readState(paths.state, model.review.manifest.reviewId);
    if (approved) {
      state.approvals[resolved.key] = {
        fingerprint: resolved.fingerprint,
        approvedAt: new Date().toISOString(),
      };
    } else {
      delete state.approvals[resolved.key];
    }
    await writeState(root, paths, state);
    return approvalResponse(model, state);
  });
  const queued = mutation.catch(() => {});
  mutationQueues.set(root, queued);
  queued.finally(() => {
    if (mutationQueues.get(root) === queued) {
      mutationQueues.delete(root);
    }
  });
  return mutation;
}
