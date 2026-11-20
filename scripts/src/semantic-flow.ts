import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { downloadRelease, listReleases, selectRelease, upgradeNotes } from "./shared/release-client.js";
import { compareVersions, parseVersion } from "./shared/release-version.js";
import { skillFiles, unpackDistribution } from "./shared/distribution.js";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  commandOptionNames,
  renderCliHelp,
  semanticFlowApi,
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
import { git } from "./shared/git.js";
import { processFailureDetail, SUBPROCESS_MAX_BUFFER } from "./shared/subprocess.js";
import { parseJson, readJson } from "./shared/json.js";
import { readDocument } from "./shared/schema-validation.js";
import { listedStageIds, loadImplementation, type Artifact } from "./shared/implementation.js";
import { assertNoLegacyArtifact, claimedImplementation, listActiveImplementations, listJsonIds, readArtifact, readArtifactJson, requireArtifact, selectImplementation } from "./shared/artifact-store.js";
import {
  FEEDBACK_MANIFEST_SCHEMA_ID,
  THREAD_SCHEMA_ID,
} from "./shared/documents.js";
import {
  booleanField,
  errorMessage,
  isRecord,
  numberField,
  stringField,
  type JsonRecord,
} from "./shared/narrow.js";
import { withValidationContext } from "./shared/validation-context.js";
import {
  probeViewer,
  stopViewerAndWait,
  type ViewerIdentity,
} from "./shared/viewer-lifecycle.js";
import { startRemoteReview } from "./shared/remote-review.js";
import { feedbackDirectory, listReviews, readReview, registerReview, reviewDirectory, reviewId } from "./shared/review-store.js";
import { claimedThreadIds, endSession, IDLE_LIMIT_MS, liveSession, renewSessionClaims, roundAwaitingAnswer, sendInProgress, settleSessionClaims, startSession, takeResponses, updateAgentState } from "./shared/agent-session.js";
import { awaitsAgentReply } from "./shared/feedback-awaiting.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CompactThread, FeedbackGroup, PendingFeedback } from "./review-feedback.js";
import type { RestackSummary } from "./semantic-implementation.js";

/** The implementation and feedback services load only for the commands that use them. */
const implementationService = () => import("./semantic-implementation.js");
const feedbackService = () => import("./review-feedback.js");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
/** This executable; the viewer server runs as a detached copy of it. */
const cliScript = fileURLToPath(import.meta.url);
const HELP = renderCliHelp(semanticFlowApi);

/** An artifact found in a worktree. Inspection tolerates an incomplete
 * manifest, so the fields other than the implementation ID may be missing. */
interface ArtifactCandidate {
  worktree: string;
  implementationId: string;
  title?: string;
  targetBranch?: string;
  baseRevision?: string;
  currentBranch: string | null;
  finalizedStageIds: string[];
  workingStageIds: string[];
  feedbackExists: boolean;
  feedbackDirectory: string;
}

/** A candidate whose manifest has every field that acting on it requires. */
type ActiveCandidate = ArtifactCandidate & {
  title: string;
  targetBranch: string;
  baseRevision: string;
};

interface Inspection {
  repositoryRoot: string;
  candidates: ArtifactCandidate[];
  selected: ArtifactCandidate | null;
}

/** A stage group of pending feedback; threads replayed by a target restack say so. */
type PendingFeedbackStage = Omit<FeedbackGroup<CompactThread>, "threads"> & {
  threads: Array<CompactThread & { restacked?: true }>;
};

interface TargetRestack {
  previousBaseRevision: string;
  targetBranch: string;
  baseRevision: string;
  refreshedStages: number;
  rewrittenBranches: number;
  /** The restack command's per-stage entries, passed through unchanged. */
  stages: JsonRecord[];
  replayedThreadIds: string[];
}

/** The record items of a JSON array; anything else has none. */
function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The string items of a JSON array; anything else has none. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizedPath(value: string): string {
  // Native resolution also expands Windows short-path aliases (for example RUNNER~1).
  const resolved = fs.existsSync(value) ? fs.realpathSync.native(value) : path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function repositoryRoot(start: string): string {
  if (!fs.existsSync(start)) {
    fail(`Project path does not exist: ${start}.`);
  }
  const directory = fs.statSync(start).isDirectory()
    ? start
    : path.dirname(start);
  const root = git(["rev-parse", "--show-toplevel"], {
    cwd: directory,
    allowFailure: true,
  });
  if (!root) {
    fail(`No Git repository contains ${start}.`);
  }
  return path.resolve(root);
}

/** Checkouts of the repository; a bare repository's own entry has no files. */
function worktreeRoots(root: string): string[] {
  const output = git(["worktree", "list", "--porcelain", "-z"], { cwd: root });
  return output
    .split("\0\0")
    .map((entry) => entry.split("\0"))
    .filter((lines) => !lines.includes("bare"))
    .flatMap((lines) => lines.filter((line) => line.startsWith("worktree ")))
    .map((line) => path.resolve(line.slice("worktree ".length)));
}

/** The active implementation as seen from the worktree that works on it. */
function artifactCandidate(root: string, implementationId: string): ArtifactCandidate | null {
  const snapshot = readArtifact(root, implementationId);
  if (!snapshot) {
    return null;
  }
  // Inspection reports on possibly invalid artifacts, so read only what is present.
  const manifest = readArtifactJson(snapshot, "manifest.json");
  return {
    worktree: root,
    implementationId,
    title: stringField(manifest, "title"),
    targetBranch: stringField(manifest, "targetBranch"),
    baseRevision: stringField(manifest, "baseRevision"),
    currentBranch:
      git(["symbolic-ref", "--short", "HEAD"], {
        cwd: root,
        allowFailure: true,
      }) ?? null,
    finalizedStageIds: listedStageIds(manifest),
    workingStageIds: listJsonIds(snapshot, ".work/stages"),
    feedbackDirectory: feedbackDirectory(root, implementationId),
    feedbackExists: fs.existsSync(
      path.join(feedbackDirectory(root, implementationId), "manifest.json"),
    ),
  };
}

/** The validated finalized stages of the active artifact of root, with their derived data. */
function activeImplementation(root: string): Artifact {
  return loadImplementation(root, requireArtifact(root), { includeWork: false });
}

/** Narrows a candidate for commands that act on the implementation. A manifest
 * without these fields is invalid, so report it as the validation failure. */
async function activeCandidate(candidate: ArtifactCandidate): Promise<ActiveCandidate> {
  const { title, targetBranch, baseRevision } = candidate;
  if (title === undefined || targetBranch === undefined || baseRevision === undefined) {
    await validateArtifactForFeedback(candidate);
    fail(`The semantic implementation manifest in ${candidate.worktree} is incomplete.`);
  }
  return { ...candidate, title, targetBranch, baseRevision };
}

function inspect(options: Options): Inspection {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "inspect"),
  );
  const project = option(options, "project");
  const implementationId = option(options, "implementation-id");
  const root = repositoryRoot(path.resolve(project ?? process.cwd()));
  // Every worktree sees every active implementation; each is reported from the
  // worktree that has claimed it, or else from the inspected one.
  const actives = listActiveImplementations(root);
  const worktrees = worktreeRoots(root);
  // A worktree that still holds an artifact of an earlier version is reported, not
  // ignored: the inspected one always, the others when nothing else is active.
  assertNoLegacyArtifact(root);
  if (actives.length === 0) for (const worktree of worktrees) assertNoLegacyArtifact(worktree);
  const claimedIn = (worktree: string) => claimedImplementation(worktree, actives)?.implementationId;
  const claims = new Map(worktrees.map((worktree) => [worktree, claimedIn(worktree)]));
  const candidates = actives
    .map(({ implementationId }) => {
      const claiming = [...claims].filter(([, claimed]) => claimed === implementationId).map(([worktree]) => worktree);
      const worktree = claiming.find((candidate) => samePath(candidate, root)) ?? claiming[0] ?? root;
      return artifactCandidate(worktree, implementationId);
    })
    .filter((candidate): candidate is ArtifactCandidate => candidate !== null)
    .sort((left, right) => left.worktree.localeCompare(right.worktree) || left.implementationId.localeCompare(right.implementationId));
  const matching = implementationId
    ? candidates.filter((candidate) => candidate.implementationId === implementationId)
    : candidates;
  // The inspected worktree selects only the implementation it has claimed;
  // one reported from it merely because nothing claimed it is not preferred.
  const rootClaim = claimedImplementation(root, actives)?.implementationId;
  const preferred = matching.find((candidate) =>
    samePath(candidate.worktree, root) && candidate.implementationId === rootClaim,
  );
  const selected = preferred ?? (matching.length === 1 ? matching[0] : null);
  return { repositoryRoot: root, candidates, selected };
}

function printInspection(inspection: Inspection, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }
  if (inspection.candidates.length === 0) {
    console.log(
      `No active semantic implementation found in ${inspection.repositoryRoot} or its linked worktrees.`,
    );
    return;
  }
  for (const candidate of inspection.candidates) {
    const marker =
      inspection.selected &&
      samePath(candidate.worktree, inspection.selected.worktree) &&
      candidate.implementationId === inspection.selected.implementationId
        ? "*"
        : "-";
    console.log(
      `${marker} ${candidate.implementationId}: ${candidate.title}\n  worktree: ${candidate.worktree}\n  target: ${candidate.targetBranch}\n  branch: ${candidate.currentBranch ?? "(detached)"}`,
    );
  }
}

function resolveSingle(
  options: Options,
  command: string,
): ArtifactCandidate {
  const selectionOptions: Options = new Map(
    [...options].filter(([name]) => ["project", "implementation-id", "json"].includes(name)),
  );
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, command),
  );
  const inspection = inspect(selectionOptions);
  if (inspection.selected) {
    // The commands the workflow runs act on the selected implementation.
    selectImplementation(inspection.selected.implementationId);
    return inspection.selected;
  }
  const implementationId = option(selectionOptions, "implementation-id");
  if (inspection.candidates.length === 0) {
    fail(
      `No active semantic implementation found in ${inspection.repositoryRoot} or its linked worktrees.`,
    );
  }
  if (implementationId) {
    fail(`No active semantic implementation has implementation ID ${implementationId}.`);
  }
  const choices = inspection.candidates
    .map(
      (candidate) =>
        `${candidate.worktree} (${candidate.implementationId}: ${candidate.title})`,
    )
    .join("\n");
  fail(
    `Several linked worktrees contain semantic implementations. Select one with --project or --implementation-id:\n${choices}`,
  );
}

function execute(
  executable: string,
  args: string[],
  cwd: string,
  inherit = true,
): number {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(
      `Could not run ${executable}: ${result.error.message}`,
    );
  }
  return result.status ?? 1;
}

/** The outcome of a validation, reported the way the command would print it. */
interface CapturedValidation {
  passed: boolean;
  output: string;
}

function captureValidation(validate: () => string): CapturedValidation {
  try {
    return { passed: true, output: validate() };
  } catch (error) {
    return { passed: false, output: `Error: ${errorMessage(error)}` };
  }
}

async function checkImplementation(root: string): Promise<CapturedValidation> {
  const { validateImplementation } = await implementationService();
  return captureValidation(() => {
    const { message, warnings } = validateImplementation(root);
    return [message, ...warnings.map((warning) => `Warning: ${warning}`)].join("\n");
  });
}

async function checkFeedback(root: string): Promise<CapturedValidation> {
  const { validateFeedbackAt } = await feedbackService();
  return captureValidation(() => validateFeedbackAt(root));
}

async function runWorkflow(options: Options, mode: "validate" | "prepare" | "archive"): Promise<void> {
  const candidate = resolveSingle(options, mode);
  const [{ implementationWorkflow }, { withCheckedFeedback }] = await Promise.all([implementationService(), feedbackService()]);
  const result = withValidationContext(() => withCheckedFeedback(
    candidate.worktree,
    mode !== "validate" || flag(options, "publish"),
    () => implementationWorkflow(candidate.worktree, mode, options),
  ));
  if (flag(options, "json")) console.log(JSON.stringify(result));
  else {
    const summary: unknown = result;
    const stages = records(isRecord(summary) ? summary.stages : undefined);
    const workingStages = isRecord(summary) && Array.isArray(summary.workingStages) ? summary.workingStages.length : 0;
    console.log(`Artifact: ${candidate.worktree}`);
    console.log(`Semantic flow ${mode} passed: ${stages.length} finalized stage(s), ${workingStages} working stage(s).`);
    if (mode === "prepare" || flag(options, "stack")) {
      for (const stage of stages) console.log(`  ${stringField(stage, "branch")} -> ${stringField(stage, "baseBranch")} (${stringField(stage, "headRevision")})`);
      console.log(`Final cumulative head: ${stringField(summary, "finalHeadRevision")}`);
    }
  }
}

/** Counts items by their status; items without a string status count as missing. */
function countStatuses(values: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const status = stringField(value, "status") ?? "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** A JSON array field of a possibly invalid document. */
function arrayField(value: unknown, key: string): unknown[] {
  const field = isRecord(value) ? value[key] : undefined;
  return Array.isArray(field) ? field : [];
}

async function status(options: Options): Promise<void> {
  const selected = resolveSingle(options, "status");
  const artifact = requireArtifact(selected.worktree, selected.implementationId);
  // Status reports on possibly invalid artifacts; the validation below reports their errors.
  const manifest = readArtifactJson(artifact, "manifest.json");
  // Another worktree may have changed the artifact since inspection: report this snapshot.
  const candidate: ArtifactCandidate = {
    ...selected,
    finalizedStageIds: listedStageIds(manifest),
    workingStageIds: listJsonIds(artifact, ".work/stages"),
  };
  const requirements = strings(arrayField(manifest, "requirements")).map((id) =>
    readArtifactJson(artifact, `requirements/${id}.json`),
  );
  const finalizedStages = listedStageIds(manifest).map((id) =>
    readArtifactJson(artifact, `stages/${id}.json`),
  );
  const workingStages = candidate.workingStageIds.map((id) =>
    readArtifactJson(artifact, `.work/stages/${id}.json`),
  );
  // Criteria without string IDs are left out here; validation reports them.
  const allCriteria = requirements.flatMap((specification) => {
    const specificationId = stringField(specification, "id");
    if (specificationId === undefined) return [];
    return strings(
      arrayField(specification, "acceptanceCriteria").map((criterion) => stringField(criterion, "id")),
    ).map((criterionId) => `${specificationId}#${criterionId}`);
  });
  const finalizedCoverage = new Set(
    finalizedStages.flatMap((stage) => strings(arrayField(stage, "specificationRefs"))),
  );
  const workingCoverage = new Set(
    workingStages.flatMap((stage) => strings(arrayField(stage, "specificationRefs"))),
  );
  const validations = [...finalizedStages, ...workingStages].flatMap(
    (stage) => arrayField(stage, "validation"),
  );

  const feedbackRoot = candidate.feedbackDirectory;
  let feedback: { exists: boolean; threads: Record<string, number> } = {
    exists: false,
    threads: {},
  };
  if (candidate.feedbackExists) {
    const feedbackManifest = readJson(
      path.join(feedbackRoot, "manifest.json"),
    );
    const threads = strings(arrayField(feedbackManifest, "threads")).map((id) =>
      readJson(path.join(feedbackRoot, "threads", `${id}.json`)),
    );
    feedback = {
      exists: true,
      threads: countStatuses(threads),
    };
  }

  const artifactValidation = await checkImplementation(candidate.worktree);
  const feedbackValidation = candidate.feedbackExists
    ? await checkFeedback(candidate.worktree)
    : null;
  const metadataBranch = `${stringField(manifest, "branchPrefix")}/metadata`;
  const metadataPublished = Boolean(
    git(["show-ref", "--verify", `refs/heads/${metadataBranch}`], {
      cwd: candidate.worktree,
      allowFailure: true,
    }),
  );

  const result = {
    artifact: candidate,
    criteria: {
      total: allCriteria.length,
      covered: allCriteria.filter((criterion) =>
        finalizedCoverage.has(criterion),
      ).length,
      inProgress: allCriteria.filter(
        (criterion) =>
          !finalizedCoverage.has(criterion) &&
          workingCoverage.has(criterion),
      ),
      missing: allCriteria.filter(
        (criterion) =>
          !finalizedCoverage.has(criterion) &&
          !workingCoverage.has(criterion),
      ),
    },
    evidence: countStatuses(validations),
    feedback,
    metadata: {
      branch: metadataBranch,
      branchExists: metadataPublished,
    },
    validation: {
      artifact: artifactValidation,
      feedback: feedbackValidation,
    },
  };

  if (flag(options, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${candidate.implementationId}: ${candidate.title}`);
  console.log(`Artifact: ${candidate.worktree}`);
  console.log(
    `Stages: ${candidate.finalizedStageIds.length} finalized, ${candidate.workingStageIds.length} working`,
  );
  console.log(
    `Criteria: ${result.criteria.covered}/${result.criteria.total} covered`,
  );
  console.log(`Evidence: ${JSON.stringify(result.evidence)}`);
  console.log(`Feedback: ${JSON.stringify(result.feedback)}`);
  console.log(
    `Metadata branch: ${metadataPublished ? metadataBranch : "absent"}`,
  );
  console.log(
    `Validation: artifact ${artifactValidation.passed ? "passed" : "failed"}, feedback ${
      feedbackValidation
        ? feedbackValidation.passed
          ? "passed"
          : "failed"
        : "absent"
    }`,
  );
  if (!artifactValidation.passed) {
    console.log(artifactValidation.output);
  }
  if (feedbackValidation && !feedbackValidation.passed) {
    console.log(feedbackValidation.output);
  }
}

interface ViewerLaunchMessage {
  type: "ready" | "error";
  message?: string;
  url?: string;
  repositoryRoot?: string;
  processId?: number;
  implementation?: {
    implementationId?: string;
    title?: string;
    stageCount: number;
    fileCount: number;
  };
}

/** The viewer's startup message, or undefined for any other IPC message. */
function viewerLaunchMessage(value: unknown): ViewerLaunchMessage | undefined {
  if (!isRecord(value) || (value.type !== "ready" && value.type !== "error")) return undefined;
  const implementation = value.implementation;
  const stageCount = numberField(implementation, "stageCount");
  const fileCount = numberField(implementation, "fileCount");
  return {
    type: value.type,
    message: stringField(value, "message"),
    url: stringField(value, "url"),
    repositoryRoot: stringField(value, "repositoryRoot"),
    processId: numberField(value, "processId"),
    // The viewer starts on artifacts that miss optional fields such as the title.
    implementation: stageCount !== undefined && fileCount !== undefined
      ? {
          implementationId: stringField(implementation, "implementationId"),
          title: stringField(implementation, "title"),
          stageCount,
          fileCount,
        }
      : undefined,
  };
}

async function review(options: Options): Promise<void> {
  const branch = option(options, "branch");
  if (branch) {
    if (option(options, "implementation-id")) fail("--branch cannot be combined with --implementation-id.");
    const remote = startRemoteReview(repositoryRoot(path.resolve(option(options, "project") || ".")), branch);
    await launchViewer(remote.repositoryRoot);
    return;
  }
  const candidate = resolveSingle(options, "review");
  await launchViewer(candidate.worktree);
}

/** Arguments that start the viewer of the installation now on disk. A downgrade
 * can install an older release, which ships the viewer as its own executable. */
function viewerCommand(worktree: string): string[] {
  const separateViewer = path.join(scriptDirectory, "semantic-view.mjs");
  return fs.existsSync(separateViewer) && releaseShips("scripts/semantic-view.mjs")
    ? [separateViewer, "review", worktree]
    : [cliScript, "viewer", "serve", worktree];
}

/** Whether the installed release lists `file`. A folder updated by copying a
 * newer release over an older one keeps files the newer release dropped. A
 * source build has no release file list, so every file on disk counts. */
function releaseShips(file: string): boolean {
  const metadata = path.join(skillDirectory, "RELEASE.json");
  if (!fs.existsSync(metadata)) return true;
  const release = readJson(metadata);
  const files = isRecord(release) ? release.files : undefined;
  return !isRecord(files) || Object.hasOwn(files, file);
}

async function launchViewer(
  worktree: string,
  { openBrowser = true, replaceExisting = true, implementationId }: { openBrowser?: boolean; replaceExisting?: boolean; implementationId?: string } = {},
): Promise<void> {
  const child = spawn(
    process.execPath,
    viewerCommand(worktree),
    {
      cwd: worktree,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        ...(!openBrowser ? { SEMANTIC_VIEW_NO_OPEN: "1" } : {}),
        ...(!replaceExisting ? { SEMANTIC_VIEW_NO_REPLACE: "1" } : {}),
        // A restarted viewer serves the implementation it served, not the one
        // its worktree now selects.
        ...(implementationId !== undefined ? { SEMANTIC_FLOW_IMPLEMENTATION_ID: implementationId } : {}),
      },
    },
  );

  const launch = await new Promise<ViewerLaunchMessage>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Semantic review viewer did not start within 15 seconds."));
    }, 15_000);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Could not start semantic review viewer: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          signal
            ? `Semantic review viewer exited from signal ${signal}.`
            : `Semantic review viewer exited with code ${code ?? 1}.`,
        ),
      );
    });
    child.on("message", (value) => {
      const message = viewerLaunchMessage(value);
      if (settled || !message) return;
      settled = true;
      clearTimeout(timeout);
      resolve(message);
    });
  });

  if (launch.type === "error") {
    fail(launch.message ?? "Semantic review viewer failed to start.");
  }
  if (
    !launch.url ||
    !launch.repositoryRoot ||
    !launch.processId ||
    !launch.implementation
  ) {
    fail("Semantic review viewer returned an invalid startup response.");
  }

  child.unref();
  console.log(`Semantic review viewer: ${launch.url}`);
  console.log(`Project: ${launch.repositoryRoot}`);
  console.log(
    `Implementation: ${launch.implementation.title ?? launch.implementation.implementationId ?? "(untitled)"} — ${launch.implementation.stageCount} stages, ${launch.implementation.fileCount} files`,
  );
  console.log(`Viewer is running persistently in the background (PID ${launch.processId}).`);
}

async function refreshAdvancedTarget(candidate: ActiveCandidate): Promise<{
  candidate: ActiveCandidate;
  targetRestack: TargetRestack | null;
}> {
  const targetHead = git(
    ["rev-parse", "--verify", `refs/heads/${candidate.targetBranch}^{commit}`],
    { cwd: candidate.worktree },
  );
  if (targetHead === candidate.baseRevision) {
    return { candidate, targetRestack: null };
  }

  const mergeBase = git(
    ["merge-base", candidate.baseRevision, targetHead],
    { cwd: candidate.worktree, allowFailure: true },
  );
  if (mergeBase !== candidate.baseRevision) {
    return { candidate, targetRestack: null };
  }
  if (candidate.workingStageIds.length > 0) {
    fail(
      `Target branch ${candidate.targetBranch} advanced, but automatic restacking requires every stage to be finalized.`,
    );
  }

  const implementation = activeImplementation(candidate.worktree);
  const { manifest } = implementation;
  const stageBranches = new Set<string>();
  const stageHeads = new Map<string, string>();
  for (const [id, stage] of implementation.stages) {
    stageBranches.add(stage.change.branch);
    stageHeads.set(id, stage.change.headRevision);
    const branchHead = git(
      ["rev-parse", "--verify", `refs/heads/${stage.change.branch}^{commit}`],
      { cwd: candidate.worktree },
    );
    if (branchHead !== stage.change.headRevision) {
      fail(
        `Target branch ${candidate.targetBranch} advanced, but stage ${id} also moved from ${stage.change.headRevision} to ${branchHead}. Automatic target restacking only handles an otherwise unchanged stage stack.`,
      );
    }
  }
  const finalStageId = manifest.stages.at(-1);
  const finalStageHead = finalStageId === undefined ? undefined : stageHeads.get(finalStageId);
  if (
    finalStageHead &&
    git(["merge-base", finalStageHead, targetHead], {
      cwd: candidate.worktree,
      allowFailure: true,
    }) === finalStageHead
  ) {
    fail(
      `Target branch ${candidate.targetBranch} already contains the final semantic stage. Archive the landed implementation instead of restacking it.`,
    );
  }

  const changes =
    git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: candidate.worktree },
    ) ?? "";
  if (changes) {
    fail(
      `Target branch ${candidate.targetBranch} advanced, but automatic restacking requires a clean worktree:\n${changes}`,
    );
  }

  const replayedThreadIds: string[] = [];
  if (candidate.feedbackExists) {
    const feedbackRoot = candidate.feedbackDirectory;
    const feedbackManifest = readDocument(FEEDBACK_MANIFEST_SCHEMA_ID, path.join(feedbackRoot, "manifest.json"));
    for (const id of feedbackManifest.threads) {
      const thread = readDocument(THREAD_SCHEMA_ID, path.join(feedbackRoot, "threads", `${id}.json`));
      const assignedHead = stageHeads.get(thread.assignedStageId);
      const targetStageId = thread.target.stageId;
      const targetHeadBefore = targetStageId
        ? stageHeads.get(targetStageId)
        : null;
      if (
        assignedHead === thread.stageHead &&
        (!targetStageId || targetHeadBefore === thread.target.stageHead)
      ) {
        replayedThreadIds.push(id);
      }
    }
  }

  const originalBranch =
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: candidate.worktree,
      allowFailure: true,
    }) ?? null;
  const originalHead = git(["rev-parse", "HEAD"], { cwd: candidate.worktree });
  const detachedStageId =
    originalBranch === null
      ? [...stageHeads].find(([, head]) => head === originalHead)?.[0] ?? null
      : null;
  const detachedAtBase =
    originalBranch === null && originalHead === candidate.baseRevision;
  if (originalBranch === null && !detachedStageId && !detachedAtBase) {
    fail(
      `Target branch ${candidate.targetBranch} advanced, but automatic restacking cannot preserve detached HEAD ${originalHead}. Check out a semantic stage or the target branch first.`,
    );
  }
  // Load the service first, so a failed import never leaves the branch detached.
  const { restackOntoTarget } = await implementationService();
  // A checked-out stage branch is detached while the restack rewrites it.
  const detachedBranch =
    originalBranch !== null && stageBranches.has(originalBranch) ? originalBranch : null;
  if (detachedBranch !== null) {
    git(["switch", "--detach"], { cwd: candidate.worktree });
  }

  let restackSummary: RestackSummary;
  try {
    restackSummary = restackOntoTarget(candidate.worktree, candidate.targetBranch);
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    fail(
      `Could not automatically restack onto advanced target branch ${candidate.targetBranch}.`,
    );
  } finally {
    if (detachedBranch !== null) {
      git(["switch", detachedBranch], { cwd: candidate.worktree });
    }
  }

  if (detachedStageId) {
    const refreshedStage = activeImplementation(candidate.worktree).stages.get(detachedStageId);
    if (!refreshedStage) fail(`Stage ${detachedStageId} disappeared during restacking.`);
    git(["switch", "--detach", refreshedStage.change.headRevision], {
      cwd: candidate.worktree,
    });
  } else if (detachedAtBase) {
    git(["switch", "--detach", targetHead], { cwd: candidate.worktree });
  }

  const found = artifactCandidate(candidate.worktree, candidate.implementationId);
  if (!found) {
    fail(`Semantic implementation disappeared from ${candidate.worktree}.`);
  }
  const refreshed = await activeCandidate(found);
  try {
    // The reviewer learns of the refresh in the viewer even when no agent reports it.
    updateAgentState(reviewId(candidate.worktree, candidate.implementationId), (state, now) => {
      state.targetRefresh = { at: new Date(now).toISOString(), targetBranch: restackSummary.targetBranch, previousBaseRevision: candidate.baseRevision, baseRevision: restackSummary.baseRevision };
    });
  } catch (error) {
    // The restack succeeded, so its summary must still reach the caller.
    console.error(`Could not record the target refresh for the viewer: ${errorMessage(error)}`);
  }
  return {
    candidate: refreshed,
    targetRestack: {
      previousBaseRevision: candidate.baseRevision,
      targetBranch: restackSummary.targetBranch,
      baseRevision: restackSummary.baseRevision,
      refreshedStages: restackSummary.refreshedStages,
      rewrittenBranches: restackSummary.rewrittenBranches,
      stages: restackSummary.stages,
      replayedThreadIds,
    },
  };
}

async function validateArtifactForFeedback(candidate: ArtifactCandidate): Promise<void> {
  const artifactValidation = await checkImplementation(candidate.worktree);
  if (!artifactValidation.passed) {
    if (artifactValidation.output) console.error(artifactValidation.output);
    fail("Semantic implementation validation failed.");
  }
}

/** Claiming marks the returned threads as one round so no other run answers them. */
async function feedbackSnapshot(candidate: ArtifactCandidate, targetRestack: TargetRestack | null, claim: { session: string | null } | null = null) {
  await validateArtifactForFeedback(candidate);

  const worktreeStatus =
    git(["status", "--short"], { cwd: candidate.worktree }) ?? "";
  const worktreeChanges = worktreeStatus
    ? worktreeStatus.split(/\r?\n/).filter(Boolean)
    : [];
  const feedbackRoot = candidate.feedbackDirectory;
  if (
    !candidate.feedbackExists &&
    fs.existsSync(feedbackRoot) &&
    fs.readdirSync(feedbackRoot).length > 0
  ) {
    fail(
      `Incomplete feedback state in ${feedbackRoot}: manifest.json is missing.`,
    );
  }
  let stages: PendingFeedbackStage[] = [];
  let claimId: string | null = null;
  let claimedElsewhere = 0;
  if (candidate.feedbackExists) {
    const { nextFeedbackAt } = await feedbackService();
    let pending: PendingFeedback<CompactThread>;
    try {
      pending = nextFeedbackAt(candidate.worktree, claim);
    } catch (error) {
      console.error(`Error: ${errorMessage(error)}`);
      fail("Feedback validation failed.");
    }
    stages = pending.stages;
    if (pending.claim) {
      claimId = pending.claim.id;
      claimedElsewhere = pending.claim.claimedElsewhere;
    }
  }
  const responses = claim && candidate.feedbackExists
    ? updateAgentState(reviewId(candidate.worktree, candidate.implementationId), (state) => takeResponses(state, claim.session))
    : [];
  if (targetRestack) {
    const replayed = new Set(targetRestack.replayedThreadIds);
    stages = stages.map((stage) => ({
      ...stage,
      threads: stage.threads.map((thread) => ({
        ...thread,
        ...(replayed.has(thread.id) ? { restacked: true as const } : {}),
      })),
    }));
  }

  return {
    worktree: candidate.worktree,
    currentBranch: candidate.currentBranch,
    worktreeChanges,
    targetRestack,
    feedbackExists: candidate.feedbackExists,
    stages,
    ...(claim ? { claim: claimId, claimedElsewhere, responses } : {}),
  };
}

const DEFAULT_WAIT_SECONDS = 540;
const WAIT_POLL_MS = 1000;
const HEARTBEAT_MS = 5000;

/** Pending feedback that no running round has claimed. Caller holds the review lock. */
function unclaimedFeedbackWaiting(candidate: ArtifactCandidate, claimed: Set<string>): boolean {
  const directory = candidate.feedbackDirectory;
  const manifest = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifest)) return false;
  return readDocument(FEEDBACK_MANIFEST_SCHEMA_ID, manifest).threads.some((id) =>
    !claimed.has(id) && awaitsAgentReply(readDocument(THREAD_SCHEMA_ID, path.join(directory, "threads", `${id}.json`))));
}

/** Listens as the review's agent until a round, an answer, a stop, or the timeout. */
async function waitForFeedback(options: Options): Promise<void> {
  if (!flag(options, "json")) fail("--wait requires --json.");
  const timeout = option(options, "timeout");
  const seconds = timeout === undefined ? DEFAULT_WAIT_SECONDS : Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) fail("--timeout must be a whole number of seconds from 1 to 86400.");
  const requested = option(options, "session");
  let candidate = await activeCandidate(resolveSingle(options, "feedback"));
  // Registration gives the implementation a new review ID when a deletion retired
  // the stored one; everything below uses the review it returns.
  const review = registerReview(candidate.worktree, candidate.implementationId, candidate.title).id;
  const directory = path.join(reviewDirectory(review), "feedback");
  if (directory !== candidate.feedbackDirectory) {
    // The session belonged to the deleted review and ended with it.
    if (requested) fail(`The review of the semantic implementation ${candidate.implementationId} was deleted, and session ${requested} with it. Wait again without --session to start a new session.`);
    candidate = { ...candidate, feedbackDirectory: directory, feedbackExists: fs.existsSync(path.join(directory, "manifest.json")) };
  }
  const print = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
  // Continuing a session first checks the round just completed. A round still waiting
  // for the reviewer's answer may hold uncommitted or unrestacked work, so skip it then.
  if (requested && !updateAgentState(review, (state, now) => roundAwaitingAnswer(state, now, requested))) {
    await validateArtifactForFeedback(candidate);
    if (candidate.feedbackExists) {
      const feedbackValidation = await checkFeedback(candidate.worktree);
      if (!feedbackValidation.passed) {
        if (feedbackValidation.output) console.error(feedbackValidation.output);
        fail("Feedback validation failed.");
      }
    }
  }
  const start = updateAgentState(review, (state, now) => {
    if (!requested) return { session: startSession(state, now).id };
    const session = liveSession(state);
    if (session?.id === requested) {
      session.heartbeatAt = new Date(now).toISOString();
      return { session: session.id };
    }
    return { stopped: state.session?.id === requested ? state.session.endReason || "stopped" : "superseded" };
  });
  if (!start.session) { print({ session: requested, stopped: true, reason: start.stopped }); return; }
  const session = start.session;
  const deadline = Date.now() + seconds * 1000;
  let heartbeat = Date.now();
  try {
    while (true) {
      const step = updateAgentState(review, (state, now): { stop?: string; responses?: unknown[]; pending?: boolean; released?: string[] } => {
        const live = liveSession(state);
        if (live?.id !== session) return { stop: state.session?.id === session ? state.session.endReason || "stopped" : "superseded" };
        if (now - heartbeat >= HEARTBEAT_MS) { live.heartbeatAt = new Date(now).toISOString(); heartbeat = now; }
        const end = (reason: string) => { endSession(state, now, reason); return { stop: reason }; };
        const idle = now - Date.parse(live.feedbackAt) >= IDLE_LIMIT_MS;
        // Answers come first: stopping must never discard a decision the reviewer already made.
        const responses = takeResponses(state, session);
        if (responses.length) {
          live.feedbackAt = new Date(now).toISOString();
          renewSessionClaims(state, now, session);
          return { responses };
        }
        if (roundAwaitingAnswer(state, now, session)) {
          // The round keeps its threads while the reviewer decides; Stop applies once it finishes.
          if (readReview(review).completedAt) return end("completed");
          if (idle) return end("idle");
          renewSessionClaims(state, now, session);
          return {};
        }
        // Threads a finished round left unanswered return to the queue after a short
        // grace, so a reply posted alongside this wait is not reissued as a new round.
        // Stop and idle apply once the round settles, like after any other round.
        const { settling, released } = settleSessionClaims(state, now, session);
        const step = (() => {
          if (live.stopRequestedAt) return settling ? {} : end("stopped");
          if (readReview(review).completedAt) return end("completed");
          if (sendInProgress(state, now)) return {};
          if (unclaimedFeedbackWaiting(candidate, claimedThreadIds(state, now))) return { pending: true };
          return idle && !settling ? end("idle") : {};
        })();
        return released.length ? { ...step, released } : step;
      });
      if (step.released) console.error(`The previous round ended without replies to ${step.released.join(", ")}; returned to the queue. Post every reply before waiting again.`);
      if (step.stop) { print({ session, stopped: true, reason: step.stop }); return; }
      if (step.responses) { print({ session, responses: step.responses }); return; }
      if (step.pending) {
        const { candidate: current, targetRestack } = await refreshAdvancedTarget(await activeCandidate(resolveSingle(options, "feedback")));
        const result = await feedbackSnapshot(current, targetRestack, { session });
        if (result.stages.length || result.responses?.length) { print({ ...result, session }); return; }
        // Another run claimed the threads first; keep listening.
      }
      if (Date.now() >= deadline) { print({ session, timedOut: true }); return; }
      await delay(WAIT_POLL_MS);
    }
  } catch (error) {
    // A first wait that fails has not reported its session, so no later wait can
    // resume it. End it so the viewer does not show an agent that is listening.
    if (!requested) {
      try {
        updateAgentState(review, (state, now) => {
          if (liveSession(state)?.id === session) endSession(state, now, "failed");
        });
      } catch {
        // Report the original failure.
      }
    }
    throw error;
  }
}

async function feedback(options: Options): Promise<void> {
  if (flag(options, "wait")) return waitForFeedback(options);
  if (options.has("session") || options.has("timeout")) fail("--session and --timeout require --wait.");
  const { candidate, targetRestack } = await refreshAdvancedTarget(await activeCandidate(resolveSingle(options, "feedback")));
  const result = await feedbackSnapshot(candidate, targetRestack, { session: null });
  const { worktreeChanges, stages } = result;
  if (flag(options, "json")) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Artifact: ${candidate.worktree}`);
  if (targetRestack) {
    console.log(
      `Target restacked: ${targetRestack.targetBranch} ${targetRestack.previousBaseRevision} -> ${targetRestack.baseRevision}`,
    );
  }
  if (worktreeChanges.length) {
    console.log(`Worktree changes:\n${worktreeChanges.join("\n")}`);
  }
  if (!candidate.feedbackExists) {
    console.log("No feedback has been sent.");
    return;
  }
  for (const response of result.responses ?? []) {
    console.log(`Reviewer answered ${response.id}: ${response.answer}`);
  }
  if (result.claimedElsewhere) console.log(`${result.claimedElsewhere} thread(s) are being answered by another agent run.`);
  if (!stages.length) {
    console.log("No feedback awaits an agent reply.");
    return;
  }
  for (const stage of stages) {
    console.log(`${stringField(stage, "stageId")} (${stringField(stage, "stageBranch")}):`);
    for (const thread of stage.threads) {
      console.log(
        `  ${stringField(thread, "id")} [${stringField(thread.target, "label")}]${thread.stale ? " (stale)" : ""}:`,
      );
      for (const comment of records(thread.comments)) {
        console.log(`    ${stringField(comment, "author")}: ${stringField(comment, "body")}`);
        for (const attachment of records(comment.attachments)) console.log(`      ${stringField(attachment, "filename")}: ${stringField(attachment, "localPath")}`);
      }
    }
  }
}

function requireCleanSyncWorktree(root: string): void {
  const changes = git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
  if (changes) fail(`Synchronization requires a clean worktree at ${root}:\n${changes}`);
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const statePath = git(["rev-parse", "--git-path", state], { cwd: root });
    if (fs.existsSync(path.resolve(root, statePath))) {
      fail(`Finish the Git operation at ${root} before synchronizing (${state}).`);
    }
  }
}

/** The branch's single configured upstream; null when it has none, undefined when ambiguous. */
function configuredUpstream(root: string, branch: string): { remote: string; branch: string } | null | undefined {
  const remote = git(["config", "--get", `branch.${branch}.remote`], { cwd: root, allowFailure: true });
  const merge = git(["config", "--get-all", `branch.${branch}.merge`], { cwd: root, allowFailure: true });
  if (!remote && !merge) return null;
  // A refspec such as `refs/heads/main:refs/heads/other` would also move another ref.
  if (!remote || !merge || merge.includes("\n") || !merge.startsWith("refs/heads/") ||
    git(["check-ref-format", merge], { cwd: root, allowFailure: true }) === null) return undefined;
  return { remote, branch: merge };
}

/** Fetches the upstream branch into a private ref and returns its commit. Only
 * configured refspecs that update remote-tracking refs apply, so the fetch itself
 * never moves a local branch, and the private ref keeps a concurrent fetch from
 * changing the result. */
function fetchUpstream(root: string, upstream: { remote: string; branch: string }): string {
  const scratch = `refs/semantic-flow/fetch/${randomUUID()}`;
  const refmaps = (git(["config", "--get-all", `remote.${upstream.remote}.fetch`], { cwd: root, allowFailure: true }) ?? "")
    .split("\n").filter((spec) => /^\+?refs\/[^:]*:refs\/remotes\//.test(spec));
  try {
    git(["fetch", "--no-tags", ...(refmaps.length ? refmaps.map((spec) => `--refmap=${spec}`) : ["--refmap="]),
      "--", upstream.remote, `+${upstream.branch}:${scratch}`], { cwd: root });
    return git(["rev-parse", "--verify", `${scratch}^{commit}`], { cwd: root });
  } finally {
    git(["update-ref", "-d", scratch], { cwd: root, allowFailure: true });
  }
}

/** Worktrees that have the branch ref checked out. */
function branchCheckouts(root: string, ref: string): string[] {
  return worktreeRoots(root).filter((worktree) => git(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktree, allowFailure: true }) === ref);
}

/** Fast-forwards a branch only if it is still at `from`. The ref moves atomically,
 * so a concurrent branch switch can never advance another branch; a clean checkout
 * of the branch then follows with its index and files, or the ref moves back. */
function fastForwardBranch(root: string, ref: string, checkout: string | undefined, from: string, to: string): void {
  const checkedOut = () => Boolean(checkout) && git(["symbolic-ref", "--quiet", "HEAD"], { cwd: checkout, allowFailure: true }) === ref;
  if (checkout) {
    requireCleanSyncWorktree(checkout);
    if (!checkedOut()) fail(`The checkout of ${ref} at ${checkout} changed; inspect it before retrying.`);
  }
  git(["update-ref", "-m", "semantic-flow: fast-forward to upstream", ref, to, from], { cwd: root });
  if (!checkout || !checkedOut()) return;
  const undo = () => git(["update-ref", "-m", "semantic-flow: undo fast-forward", ref, from, to], { cwd: root, allowFailure: true });
  if (git(["read-tree", "-m", "-u", from, to], { cwd: checkout, allowFailure: true }) === null) {
    undo();
    fail(`Could not update the files of ${checkout} to ${to}; ${ref} was left at ${from}. Inspect the checkout before retrying.`);
  }
  // Git cannot lock a checkout's branch across commands; undo a switch that raced the file update.
  if (!checkedOut()) {
    git(["read-tree", "-m", "-u", to, from], { cwd: checkout, allowFailure: true });
    undo();
    fail(`The checkout at ${checkout} switched branches while ${ref} was fast-forwarded; both were restored. Inspect it before retrying.`);
  }
}

/** Brings a target branch up to date with its upstream before new work starts from it. */
function refreshTarget(options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticFlowApi, "refresh-target"));
  const root = repositoryRoot(path.resolve(option(options, "project") ?? process.cwd()));
  const targetBranch = option(options, "target-branch", { required: true });
  const json = flag(options, "json");
  git(["check-ref-format", "--branch", targetBranch], { cwd: root });
  const targetRef = `refs/heads/${targetBranch}`;
  const revision = (ref: string) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, allowFailure: true });
  const isAncestor = (base: string, head: string): boolean =>
    git(["merge-base", "--is-ancestor", base, head], { cwd: root, allowFailure: true }) !== null;
  const previousRevision = revision(targetRef);
  if (!previousRevision) fail(`Target branch ${targetBranch} does not exist locally.`);
  const upstream = configuredUpstream(root, targetBranch);
  if (upstream === undefined) fail(`Target branch ${targetBranch} needs exactly one configured upstream branch. Fix its upstream configuration before starting new work.`);
  const checkouts = branchCheckouts(root, targetRef);
  if (checkouts.length > 1) fail(`Target branch ${targetBranch} is checked out in multiple worktrees. Free the extra checkouts before refreshing it.`);

  let upstreamRevision: string | null = null;
  let targetRevision = previousRevision;
  if (upstream) {
    upstreamRevision = fetchUpstream(root, upstream);
    if (isAncestor(previousRevision, upstreamRevision)) targetRevision = upstreamRevision;
    else if (!isAncestor(upstreamRevision, previousRevision)) {
      fail(`Target branch ${targetBranch} and its upstream ${upstream.remote} ${upstream.branch} diverged. No refs were changed; resolve the divergence before starting new work.`);
    }
  }
  if (targetRevision !== previousRevision) {
    if (revision(targetRef) !== previousRevision || JSON.stringify(branchCheckouts(root, targetRef)) !== JSON.stringify(checkouts)) {
      fail(`Target branch ${targetBranch} or its checkout changed while refreshing; inspect it before retrying.`);
    }
    fastForwardBranch(root, targetRef, checkouts[0], previousRevision, targetRevision);
  }
  const ahead = Boolean(upstreamRevision && upstreamRevision !== targetRevision);
  if (json) {
    console.log(JSON.stringify({ targetBranch, previousRevision, revision: targetRevision, upstream: upstream ? { ...upstream, revision: upstreamRevision } : null, ahead }));
  } else if (!upstream) {
    console.log(`${targetBranch} has no configured upstream; new work starts from its local head ${targetRevision}.`);
  } else if (targetRevision !== previousRevision) {
    console.log(`Fast-forwarded ${targetBranch}: ${previousRevision} -> ${targetRevision}`);
  } else {
    console.log(ahead ? `${targetBranch} is ahead of ${upstream.remote} ${upstream.branch}; its local commits were kept.` : `${targetBranch} is up to date with ${upstream.remote} ${upstream.branch}.`);
  }
}

async function sync(options: Options): Promise<void> {
  const found = resolveSingle(options, "sync");
  const local = flag(options, "local");
  const json = flag(options, "json");
  const root = found.worktree;
  const revision = (ref: string): string => git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
  const isAncestor = (base: string, head: string): boolean =>
    git(["merge-base", "--is-ancestor", base, head], { cwd: root, allowFailure: true }) !== null;

  requireCleanSyncWorktree(root);
  const [{ validateSyncStack }, { withCheckedFeedback }] = await Promise.all([implementationService(), feedbackService()]);
  withCheckedFeedback(root, false, () => validateSyncStack(root));
  const candidate = await activeCandidate(found);
  const targetRef = `refs/heads/${candidate.targetBranch}`;
  if (candidate.workingStageIds.length || !candidate.finalizedStageIds.length) {
    fail("Synchronization requires a nonempty implementation with every stage finalized. Finish the working stage before syncing.");
  }
  const stageHeads = new Map<string, string>();
  for (const [id, stage] of activeImplementation(root).stages) {
    if (revision(`refs/heads/${stage.change.branch}`) !== stage.change.headRevision) {
      fail(`Stage ${id} moved from its recorded head. Reconcile or restack the edited stages before synchronizing the target.`);
    }
    stageHeads.set(stage.change.branch, stage.change.headRevision);
  }
  const previousTargetRevision = revision(targetRef);
  if (!isAncestor(candidate.baseRevision, previousTargetRevision)) {
    fail(`Target branch ${candidate.targetBranch} diverged from the recorded implementation base. Resolve its history before synchronizing.`);
  }
  const originalHead = revision("HEAD");
  if (!candidate.currentBranch && originalHead !== candidate.baseRevision && ![...stageHeads.values()].includes(originalHead)) {
    fail(`Cannot preserve detached HEAD ${originalHead}. Check out a semantic stage or the target branch before synchronizing.`);
  }

  let remote: string | null = null;
  let remoteBranch: string | null = null;
  if (!local) {
    const upstream = configuredUpstream(root, candidate.targetBranch);
    if (!upstream) {
      fail(`Target branch ${candidate.targetBranch} needs one configured upstream. Configure its intended upstream, or use sync --local to use only its current local head.`);
    }
    ({ remote, branch: remoteBranch } = upstream);
  }

  // A target checkout may live in the operational worktree while the artifact
  // lives in a linked worktree. Never move its ref behind its index and files.
  const targetWorktrees: string[] = [];
  for (const worktree of worktreeRoots(root)) {
    const branch = git(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktree, allowFailure: true });
    if (branch === targetRef) {
      requireCleanSyncWorktree(worktree);
      targetWorktrees.push(worktree);
    }
    if (!samePath(worktree, root) && branch && stageHeads.has(branch.slice("refs/heads/".length))) {
      fail(`Stage branch ${branch} is checked out in ${worktree}. Free that checkout before synchronizing.`);
    }
  }
  if (targetWorktrees.length > 1) {
    fail(`Target branch ${candidate.targetBranch} is checked out in multiple worktrees. Free the extra checkouts before synchronizing.`);
  }

  let upstreamRevision: string | null = null;
  let targetRevision = previousTargetRevision;
  if (remote && remoteBranch) {
    upstreamRevision = fetchUpstream(root, { remote, branch: remoteBranch });
    if (isAncestor(previousTargetRevision, upstreamRevision)) {
      targetRevision = upstreamRevision;
    } else if (!isAncestor(upstreamRevision, previousTargetRevision)) {
      fail(`Target branch ${candidate.targetBranch} and its upstream ${remote} ${remoteBranch} diverged. No target or stage refs were changed; resolve the divergence before retrying.`);
    }
  }
  const finalStageHead = [...stageHeads.values()].at(-1);
  if (finalStageHead === undefined) {
    fail("Synchronization requires a nonempty implementation with every stage finalized. Finish the working stage before syncing.");
  }
  if (isAncestor(finalStageHead, targetRevision)) {
    fail(`Target branch ${candidate.targetBranch} already contains the final semantic stage. Archive the landed implementation instead of synchronizing it.`);
  }

  // Fetch may take time. Check the affected checkouts and refs again before
  // advancing the target; update-ref additionally guards an unchecked-out ref.
  requireCleanSyncWorktree(root);
  const currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, allowFailure: true }) ?? null;
  if (revision(targetRef) !== previousTargetRevision || revision("HEAD") !== originalHead || currentBranch !== candidate.currentBranch) {
    fail("Target or artifact checkout moved during synchronization; inspect the current state before retrying.");
  }
  for (const [branch, head] of stageHeads) {
    if (revision(`refs/heads/${branch}`) !== head) fail(`Stage branch ${branch} moved during synchronization; retry after inspecting it.`);
  }
  const currentTargetWorktrees = branchCheckouts(root, targetRef);
  if (JSON.stringify(currentTargetWorktrees) !== JSON.stringify(targetWorktrees)) {
    fail("Target checkouts changed during synchronization; inspect the worktrees before retrying.");
  }
  if (targetRevision !== previousTargetRevision) {
    fastForwardBranch(root, targetRef, targetWorktrees[0], previousTargetRevision, targetRevision);
  }

  try {
    if (revision(targetRef) !== targetRevision) fail("Target branch moved before restacking; retry from its current head.");
    const { candidate: refreshed, targetRestack } = await refreshAdvancedTarget(candidate);
    const snapshot = await feedbackSnapshot(refreshed, targetRestack);
    const result = {
      ...snapshot,
      targetBranch: candidate.targetBranch,
      previousTargetRevision,
      targetRevision,
      upstream: remote ? { remote, branch: remoteBranch, revision: upstreamRevision } : null,
    };
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`Artifact: ${root}`);
      console.log(`Synchronized ${candidate.targetBranch}: ${previousTargetRevision} -> ${targetRevision}`);
      console.log(`Restacked ${targetRestack?.refreshedStages ?? 0} stage(s); rewrote ${targetRestack?.rewrittenBranches ?? 0} branch(es).`);
      console.log(`Checkout: ${snapshot.currentBranch ?? "(detached)"}`);
      const stale = snapshot.stages.flatMap((stage) => stage.threads).filter((thread) => thread.stale);
      if (stale.length) console.log(`Pending feedback with stale anchors: ${stale.map((thread) => thread.id).join(", ")}`);
      if (upstreamRevision && upstreamRevision !== targetRevision) console.log("The local target is ahead of its upstream; its commits were preserved.");
    }
  } catch (error) {
    console.error(`Synchronization stopped in ${root}. Target ${candidate.targetBranch} is at ${revision(targetRef)}; the target update is retained.`);
    console.error(`For a reported restack conflict, resolve it in the reported worktree and run semantic-flow.mjs implementation restack --continue. Then restore ${candidate.currentBranch ? `branch ${candidate.currentBranch}` : `the original detached stage/base at its refreshed revision (previously ${originalHead})`} and run sync --local to validate without fetching again.`);
    throw error;
  }
}

function schemaFormatVersion(relativePath: string): string {
  const schema = readJson(path.join(skillDirectory, relativePath));
  const properties = isRecord(schema) ? schema.properties : undefined;
  const version = stringField(isRecord(properties) ? properties.formatVersion : undefined, "const");
  if (typeof version !== "string") {
    fail(`${relativePath} does not declare a formatVersion constant.`);
  }
  return version;
}

function installedCommit(): string | null {
  const metadata = path.join(skillDirectory, "RELEASE.json");
  if (fs.existsSync(metadata)) return stringField(readJson(metadata), "sourceCommit") ?? null;
  const root = git(["rev-parse", "--show-toplevel"], {
    cwd: skillDirectory,
    allowFailure: true,
  });
  if (!root) {
    return null;
  }
  const relative = path.relative(path.resolve(root), skillDirectory);
  if (relative.split(path.sep).join("/") !== "skills/semantic-flow") {
    return null;
  }
  return (
    git(["rev-parse", "HEAD"], {
      cwd: skillDirectory,
      allowFailure: true,
    }) ?? null
  );
}

function readVersion(root: string): string {
  const file = path.join(root, "VERSION");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "unversioned";
}

function version(options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "version"),
  );
  const result = {
    skillVersion: readVersion(skillDirectory),
    artifactFormatVersion: schemaFormatVersion(
      path.join("references", "schema", "manifest.schema.json"),
    ),
    feedbackFormatVersion: schemaFormatVersion(
      path.join(
        "references",
        "feedback-schema",
        "manifest.schema.json",
      ),
    ),
    skillRoot: skillDirectory,
    sourceCommit: installedCommit(),
  };
  if (flag(options, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Skill version: ${result.skillVersion}`);
  console.log(`Artifact format: ${result.artifactFormatVersion}`);
  console.log(`Feedback format: ${result.feedbackFormatVersion}`);
  console.log(`Installed at: ${result.skillRoot}`);
  if (result.sourceCommit) {
    console.log(`Source commit: ${result.sourceCommit}`);
  }
}

function validateSourceRepository(root: string): void {
  const required = [
    path.join("skills", "semantic-flow", "SKILL.md"),
    path.join("scripts", "package.json"),
    path.join("scripts", "src", "build-skill.ts"),
    path.join("standard", "v0.1"),
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) {
      fail(`Source repository is missing ${relative}: ${root}.`);
    }
  }
}

function requiredSkillFiles(root: string): string[] {
  const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const commands = [...skill.matchAll(/`(commands\/[^`]+\.md)`/g)].map(
    (match) => match[1],
  );
  return [
    "SKILL.md",
    "VERSION",
    path.join("scripts", "API.d.ts"),
    path.join("scripts", "API.full.d.ts"),
    ...["shared", "implementation", "stages", "history", "feedback", "workflow"].map((name) => path.join("scripts", "api", `${name}.d.ts`)),
    path.join("scripts", "semantic-flow.mjs"),
    ...commands,
  ];
}

function verifySkill(root: string): string[] {
  const required = requiredSkillFiles(root);
  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) {
      fail(`Built skill is missing ${relative}: ${root}.`);
    }
  }
  return skillFiles(root);
}

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function compareSkillFiles(
  source: string,
  destination: string,
  files: string[],
): void {
  for (const relative of files) {
    if (
      fileHash(path.join(source, relative)) !==
      fileHash(path.join(destination, relative))
    ) {
      fail(`Installed skill does not match built file ${relative}.`);
    }
  }
}

function runRequired(
  executable: string,
  args: string[],
  cwd: string,
): void {
  const status = execute(executable, args, cwd);
  if (status !== 0) {
    fail(`${executable} ${args.join(" ")} exited with code ${status}.`);
  }
}

function npmInvocation(): { executable: string; args: string[] } {
  const configured = process.env.npm_execpath;
  if (configured && fs.existsSync(configured)) {
    return { executable: process.execPath, args: [configured] };
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const names =
    process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  for (const directory of pathEntries) {
    for (const name of names) {
      const executable = path.join(directory, name);
      if (!fs.existsSync(executable)) {
        continue;
      }
      if (process.platform !== "win32") {
        return { executable, args: [] };
      }
      const cli = path.join(
        path.dirname(executable),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (fs.existsSync(cli)) {
        return { executable: process.execPath, args: [cli] };
      }
    }
  }
  fail("npm was not found on PATH.");
}

/** Replaces the installed skill with a verified copy of the built one. Once the
 * new installation is in place and verified it stays, even when the previous
 * installation cannot be deleted: that is reported as a leftover folder. */
function replaceInstalledSkill(
  builtSkill: string,
  installedSkill: string,
  requiredFiles: string[],
): void {
  const parent = path.dirname(installedSkill);
  const token = `${process.pid}-${Date.now()}`;
  const temporary = path.join(parent, `.semantic-flow-update-${token}`);
  const backup = path.join(parent, `.semantic-flow-backup-${token}`);

  fs.cpSync(builtSkill, temporary, { recursive: true });
  verifySkill(temporary);
  compareSkillFiles(builtSkill, temporary, requiredFiles);

  let installedMoved = false;
  try {
    fs.renameSync(installedSkill, backup);
    installedMoved = true;
    fs.renameSync(temporary, installedSkill);
    compareSkillFiles(builtSkill, installedSkill, requiredFiles);
  } catch (error) {
    if (installedMoved && fs.existsSync(backup)) {
      if (fs.existsSync(installedSkill)) {
        fs.rmSync(installedSkill, { recursive: true, force: true });
      }
      fs.renameSync(backup, installedSkill);
    }
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
  // Outside the rollback: a file in use, on Windows for example, can stop the
  // deletion partway, which must not touch the new installation.
  try {
    fs.rmSync(backup, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`The previous installation could not be deleted (${errorMessage(error)}). Delete ${backup} once nothing uses it.`);
  }
}

async function viewerForUpdate(): Promise<Array<ViewerIdentity & { repositoryRoot: string }>> {
  // Installation maintenance does not require a project. Only discover viewers
  // when the invocation directory provides a repository to match against.
  const targetRoot = git(["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(), allowFailure: true,
  });
  if (!targetRoot) return [];
  const roots = worktreeRoots(path.resolve(targetRoot));
  const recorded = listReviews().filter((r) => roots.some((root) => samePath(root, r.repositoryRoot))).flatMap((r) => r.viewer ? [r.viewer] : []);
  // Viewers are found through the review records, which hold their keys. Viewers
  // of older releases need no key and may run on the default port unrecorded.
  const candidates = await Promise.all([probeViewer(), ...recorded.map((viewer) => probeViewer(viewer.port, { key: viewer.key }))]);
  const found: Array<ViewerIdentity & { repositoryRoot: string }> = [];
  for (const viewer of candidates) {
    if (!viewer || typeof viewer.repositoryRoot !== "string" || found.some((item) => item.port === viewer.port)) continue;
    const viewerRoot = viewer.repositoryRoot;
    if (!roots.some((root) => samePath(root, viewerRoot))) {
      continue;
    }
    // Older viewers identify their repository but not their skill installation.
    if (viewer.skillDirectory !== undefined &&
        (typeof viewer.skillDirectory !== "string" ||
         !samePath(viewer.skillDirectory, skillDirectory))) continue;
    if (typeof viewer.implementationId !== "string" || !readArtifact(viewerRoot, viewer.implementationId)) continue;
    found.push({ ...viewer, repositoryRoot: viewerRoot });
  }
  return found;
}

async function restartViewers(viewers: Array<ViewerIdentity & { repositoryRoot: string }>) {
  const failures: unknown[] = [];
  for (const viewer of viewers) {
    try { await launchViewer(viewer.repositoryRoot, { openBrowser: false, replaceExisting: false, implementationId: viewer.implementationId }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Some review services could not restart. Reopen them from the review list.");
}

async function stopViewersForUpdate(viewers: Array<ViewerIdentity & { repositoryRoot: string }>) {
  const stopped: typeof viewers = [];
  try {
    for (const viewer of viewers) { await stopViewerAndWait(viewer); stopped.push(viewer); }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const viewer of stopped) {
      try { await launchViewer(viewer.repositoryRoot, { openBrowser: false, replaceExisting: false, implementationId: viewer.implementationId }); }
      catch (restartError) { failures.push(restartError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Stopping viewers failed; some stopped viewers could not restart.");
    throw error;
  }
}

async function updateFromSource(options: Options): Promise<void> {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "update"),
  );
  const sourceOption = option(options, "source");
  const useCurrentSource = flag(options, "use-current-source");
  const previousVersion = readVersion(skillDirectory);
  if (!sourceOption) fail("Source updates require an explicit --source.");
  const sourceRoot = repositoryRoot(path.resolve(sourceOption));
  validateSourceRepository(sourceRoot);

  const branch = git(["symbolic-ref", "--short", "HEAD"], {
    cwd: sourceRoot,
    allowFailure: true,
  });
  const upstream = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: sourceRoot, allowFailure: true },
  );
  const dirty = Boolean(git(["status", "--porcelain"], { cwd: sourceRoot }));

  if (!useCurrentSource) {
    const problems = [
      dirty ? "the source worktree is dirty" : null,
      !branch ? "the source checkout is detached" : null,
      !upstream ? "the source branch has no upstream" : null,
    ].filter(Boolean);
    if (problems.length > 0) {
      fail(
        `Cannot update source automatically because ${problems.join(
          ", ",
        )}. After explicit approval, rerun with --use-current-source.`,
      );
    }
    runRequired("git", ["pull", "--ff-only"], sourceRoot);
  }

  const sourceCommit = git(["rev-parse", "HEAD"], { cwd: sourceRoot });
  const scriptsRoot = path.join(sourceRoot, "scripts");
  const npm = npmInvocation();
  if (!fs.existsSync(path.join(scriptsRoot, "node_modules"))) {
    runRequired(
      npm.executable,
      [...npm.args, "ci", "--prefix", scriptsRoot],
      sourceRoot,
    );
  }
  runRequired(
    npm.executable,
    [...npm.args, "run", "build", "--prefix", scriptsRoot],
    sourceRoot,
  );

  const builtSkill = path.join(sourceRoot, "skills", "semantic-flow");
  const requiredFiles = verifySkill(builtSkill);

  const viewers = await viewerForUpdate();
  await stopViewersForUpdate(viewers);
  let installedVersion: string;
  try {
    if (!samePath(builtSkill, skillDirectory)) {
      replaceInstalledSkill(builtSkill, skillDirectory, requiredFiles);
    }
    installedVersion = readVersion(skillDirectory);
    compareSkillFiles(builtSkill, skillDirectory, requiredFiles);
  } catch (updateError) {
    try { await restartViewers(viewers); }
    catch (restartError) { throw new AggregateError([updateError, restartError], "Skill update failed; viewer restart also failed."); }
    throw updateError;
  }
  try { await restartViewers(viewers); }
  catch (error) { fail(`Installed ${installedVersion}, but some viewers could not restart. Run review to reopen them. ${String(error)}`); }
  console.log(`Updated semantic-flow ${previousVersion} -> ${installedVersion}.`);
  console.log(`Source: ${branch ?? "(detached)"} ${sourceCommit}`);
  console.log(`Installed at: ${skillDirectory}`);
}

async function update(options: Options): Promise<void> {
  assertKnownOptions(options, commandOptionNames(semanticFlowApi, "update"));
  const requested = option(options, "version");
  const source = option(options, "source");
  const allowDowngrade = flag(options, "allow-downgrade");
  if (source) {
    if (requested || allowDowngrade) fail("--source cannot be combined with release version options.");
    return updateFromSource(options);
  }
  if (flag(options, "use-current-source")) fail("--use-current-source requires an explicit --source.");
  if (allowDowngrade && !requested) fail("--allow-downgrade requires an explicit --version.");
  if (requested) parseVersion(requested);
  if (fs.existsSync(path.join(skillDirectory, "../../scripts/src/build-skill.ts"))) {
    fail("This is the source skill. Install a release in a separate destination; do not replace repository source files.");
  }
  const previousVersion = readVersion(skillDirectory);
  parseVersion(previousVersion);
  const releases = await listReleases();
  const release = selectRelease(releases, requested);
  const targetVersion = release.tag_name.slice(1);
  const difference = compareVersions(targetVersion, previousVersion);
  if (difference < 0 && !allowDowngrade) fail(`Installed ${previousVersion} is newer than ${targetVersion}. Use --version with --allow-downgrade only for intentional recovery.`);
  const installedMetadata = path.join(skillDirectory, "RELEASE.json");
  if (difference === 0 && fs.existsSync(installedMetadata)) {
    console.log(`semantic-flow ${previousVersion} is already current. Installed at: ${skillDirectory}`);
    return;
  }
  console.log(upgradeNotes(releases, previousVersion, targetVersion));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-flow-release-"));
  try {
    const staged = path.join(temporary, "semantic-flow");
    const metadata = await unpackDistribution(await downloadRelease(release), staged, targetVersion);
    const required = verifySkill(staged);
    const viewers = await viewerForUpdate();
    await stopViewersForUpdate(viewers);
    try {
      replaceInstalledSkill(staged, skillDirectory, required);
    } catch (error) {
      try { await restartViewers(viewers); }
      catch (restartError) { throw new AggregateError([error, restartError], "Update failed; restoring the old viewers also failed."); }
      throw error;
    }
    try { await restartViewers(viewers); }
    catch (error) { fail(`Installed ${targetVersion}, but some viewers could not restart. Run review to reopen them. ${String(error)}`); }
    console.log(`Updated semantic-flow ${previousVersion} -> ${targetVersion}.`);
    console.log(`Source commit: ${metadata.sourceCommit}`);
    console.log(`Installed at: ${skillDirectory}`);
    console.log(`Release notes: https://github.com/${metadata.repository}/releases/tag/v${targetVersion}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function dispatch(positionals: string[], options: Options): Promise<void> {
  const [command, ...extra] = positionals;
  if (extra.length > 0) {
    fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  }
  if (!command || command === "help" || flag(options, "help")) {
    console.log(HELP);
    return;
  }
  if (command === "inspect") {
    const json = flag(options, "json");
    printInspection(inspect(options), json);
    return;
  }
  if (command === "validate" || command === "prepare" || command === "archive") {
    await runWorkflow(options, command);
    return;
  }
  if (command === "status") {
    await status(options);
    return;
  }
  if (command === "review") {
    await review(options);
    return;
  }
  if (command === "feedback") {
    await feedback(options);
    return;
  }
  if (command === "sync") {
    await sync(options);
    return;
  }
  if (command === "refresh-target") {
    refreshTarget(options);
    return;
  }
  if (command === "version") {
    version(options);
    return;
  }
  if (command === "update") {
    await update(options);
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

/** Runs one workflow command line, such as `semantic-flow status`. */
export async function runWorkflowCommand(argv: string[]): Promise<void> {
  const parsed = parseArguments(argv);
  if (parsed.options.has("help") && parsed.positionals.length === 0) {
    assertKnownOptions(parsed.options, new Set(["help"]));
    flag(parsed.options, "help");
    console.log(HELP);
    return;
  }
  await dispatch(
    parsed.positionals,
    expandInputOptions(parsed.options, process.cwd()),
  );
}
