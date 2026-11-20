#!/usr/bin/env node
import { captureCodeTarget, validateCodeTarget } from "./shared/insight-targets.js";
import { assertEvidenceDirectories, ensureEvidenceAttributes, evidenceAttachmentErrors, evidenceAttachmentPath, evidenceMediaType, evidenceTreeErrors, evidenceWarnings, MAX_EVIDENCE_ATTACHMENT_BYTES, sha256Hex } from "./shared/evidence.js";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  commandOptionNames,
  renderCliHelp,
  semanticImplementationApi,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  flag,
  option,
  parseArguments,
  repeatedOption,
  splitPair,
  objectOptions,
  type Options,
} from "./shared/arguments.js";
import {
  MANIFEST_SCHEMA_ID,
  SPECIFICATION_SCHEMA_ID,
  STAGE_ORGANIZATION_SCHEMA_ID,
  STAGE_SCHEMA_ID,
  WORK_STAGE_SCHEMA_ID,
  type ChangeNode,
  type CodeTarget,
  type FileChange,
  type ImplementationManifest,
  type InsightCollection,
  type InsightItem,
  type NodeFileChange,
  type Specification,
  type Stage,
  type StageChange,
  type StageOrganization,
  type WorkStage,
} from "./shared/documents.js";
import { fail } from "./shared/errors.js";
import { factCache, withValidationContext } from "./shared/validation-context.js";
import { git, gitRaw, type GitOptions, type GitRawOptions } from "./shared/git.js";
import { processFailureDetail, SUBPROCESS_MAX_BUFFER } from "./shared/subprocess.js";
import { parseJson, readJson } from "./shared/json.js";
import {
  ArtifactDraft,
  buildArtifactTree,
  commitArtifact,
  describeArtifact,
  exportArtifactFiles,
  hasFile,
  hasIncompleteArtifact,
  listJsonIds,
  readArtifact,
  readArtifactJson,
  removeArtifact,
  requireArtifact,
  updateRefs,
  ZERO_OID,
  type ArtifactFiles,
  type ArtifactSnapshot,
  type RefUpdate,
} from "./shared/artifact-store.js";
import { errorMessage, isRecord, isStringArray, type JsonRecord } from "./shared/narrow.js";
import { parseDocument } from "./shared/schema-validation.js";
import { reviewId, withReviewLock } from "./shared/review-store.js";
import { touchAgent, updateAgentState } from "./shared/agent-session.js";

const commitFacts = factCache<string>();
const linearRangeFacts = factCache<void>();
const changedFileFacts = factCache<FileChange[]>();
const changeShapeFacts = factCache<DiffChangeShape>();

// Validation and inventory errors list item collections in this order.
const STAGE_ITEM_COLLECTIONS: readonly InsightCollection[] = [
  "decisions",
  "assumptions",
  "alternatives",
  "failedAttempts",
  "risks",
  "openQuestions",
  "validation",
  "evidence",
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");

const HELP = renderCliHelp(semanticImplementationApi);

/** The worktree a command runs in and the artifact snapshot it read there. */
interface Workspace {
  root: string;
  snapshot: ArtifactSnapshot;
}

/** A loaded implementation artifact; every document has passed its schema. */
interface Artifact {
  manifest: ImplementationManifest;
  requirements: Map<string, Specification>;
  stages: Map<string, Stage>;
  workStages: Map<string, WorkStage>;
}

/** A finalized or working stage that a command edits. */
type EditableStage = Stage | WorkStage;

function isInsightCollection(value: string): value is InsightCollection {
  return STAGE_ITEM_COLLECTIONS.some((collection) => collection === value);
}

/** Output of a Git command that may fail; undefined when it does. */
function gitOptional(args: string[], options: { cwd?: string } = {}): string | undefined {
  return git(args, { ...options, allowFailure: true }) ?? undefined;
}

function gitRawBuffer(args: string[], options: Omit<GitRawOptions, "encoding" | "allowFailure"> = {}): Buffer {
  return gitRaw(args, { ...options, encoding: "buffer" });
}

/** The explicit stage ID that editing a finalized stage requires. */
function explicitStageId(requested: string | undefined, optionName: string): string {
  if (!requested || requested === "current") {
    fail(`--finalized requires an explicit --${optionName} <stage-id>.`);
  }
  return requested;
}

function repositoryRoot(): string {
  const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (!root) {
    fail("Run this command inside a Git repository.");
  }
  return path.resolve(root);
}

function openWorkspace(root: string): Workspace {
  return { root, snapshot: requireArtifact(root) };
}

/** Where a stage document is stored in the artifact. */
function stageFile(stage: EditableStage): string {
  return stage.$schema === STAGE_SCHEMA_ID ? `stages/${stage.id}.json` : `.work/stages/${stage.id}.json`;
}

function formatPath(value: string): string {
  return value.split(path.sep).join("/");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface UnvalidatedDocument {
  id: string;
  /** How messages name the document. */
  file: string;
  value: unknown;
}

/** The validated manifest and the documents it lists, before their schema validation. */
interface UnvalidatedArtifact {
  manifest: ImplementationManifest;
  requirements: UnvalidatedDocument[];
  stages: UnvalidatedDocument[];
  workStages: UnvalidatedDocument[];
}

/** Validates the manifest, then reads every document, failing on missing files
 * and working stage ID mismatches. Only validated IDs name files. */
function readArtifactDocuments(files: ArtifactFiles, { includeWork = true }: { includeWork?: boolean } = {}): UnvalidatedArtifact {
  if (!hasFile(files, "manifest.json")) {
    fail(`No semantic implementation manifest exists at ${files.describe("manifest.json")}.`);
  }

  // Each document must carry its own kind's $schema; an unknown one keeps the
  // "unsupported schema" message of the former dispatch by $schema.
  const manifest = parseDocument(MANIFEST_SCHEMA_ID, readArtifactJson(files, "manifest.json"), files.describe("manifest.json"));
  const read = (directory: string, id: string, kind: string): UnvalidatedDocument => {
    const file = `${directory}/${id}.json`;
    if (!hasFile(files, file)) fail(`Manifest ${kind} ${id} is missing ${files.describe(file)}.`);
    return { id, file: files.describe(file), value: readArtifactJson(files, file) };
  };
  const requirementDocuments = manifest.requirements.map((id) => read("requirements", id, "specification"));
  const stageDocuments = manifest.stages.map((id) => read("stages", id, "stage"));

  const workDocuments: UnvalidatedDocument[] = [];
  if (includeWork) {
    for (const filenameId of listJsonIds(files, ".work/stages")) {
      const file = `.work/stages/${filenameId}.json`;
      const value = readArtifactJson(files, file);
      const internalId = isRecord(value) ? value.id : undefined;
      if (internalId !== filenameId) {
        fail(`Working stage file ${file} has internal ID ${String(internalId)}.`);
      }
      workDocuments.push({ id: filenameId, file: files.describe(file), value });
    }
  }
  return { manifest, requirements: requirementDocuments, stages: stageDocuments, workStages: workDocuments };
}

/** Loads the artifact and validates every document. After the manifest, every
 * file is located before any is validated, so missing files and ID mismatches
 * are reported ahead of schema errors; the first invalid document fails. */
function loadArtifact(files: ArtifactFiles, options: { includeWork?: boolean } = {}): Artifact {
  const documents = readArtifactDocuments(files, options);
  const { manifest } = documents;
  const requirements = new Map<string, Specification>();
  for (const { id, file, value } of documents.requirements) {
    requirements.set(id, parseDocument(SPECIFICATION_SCHEMA_ID, value, file));
  }
  const stages = new Map<string, Stage>();
  for (const { id, file, value } of documents.stages) {
    stages.set(id, parseDocument(STAGE_SCHEMA_ID, value, file));
  }
  const workStages = new Map<string, WorkStage>();
  for (const { id, file, value } of documents.workStages) {
    workStages.set(id, parseDocument(WORK_STAGE_SCHEMA_ID, value, file));
  }
  return { manifest, requirements, stages, workStages };
}

/** A finalized stage the manifest lists; loading guarantees its document exists. */
function finalizedStage(artifact: Pick<Artifact, "stages">, id: string): Stage {
  const stage = artifact.stages.get(id);
  if (!stage) fail(`Manifest stage ${id} is missing.`);
  return stage;
}

/** Head of the last finalized stage, or the base revision before the first. */
function stackTip(artifact: Artifact): string {
  const previousId = artifact.manifest.stages.at(-1);
  return previousId
    ? finalizedStage(artifact, previousId).change.headRevision
    : artifact.manifest.baseRevision;
}

function stageBranch(stage: EditableStage): string {
  return stage.$schema === STAGE_SCHEMA_ID ? stage.change.branch : stage.branch;
}

/** The items of one collection, read through the union of stage kinds. */
function stageItems(stage: EditableStage, collection: InsightCollection): InsightItem[] {
  return stage[collection];
}

function duplicateValues<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function reachable(
  dependencies: Map<string, string[]>,
  start: string,
  target: string,
  visited = new Set<string>(),
): boolean {
  if (start === target) {
    return true;
  }
  if (visited.has(start)) {
    return false;
  }
  visited.add(start);
  for (const next of dependencies.get(start) ?? []) {
    if (reachable(dependencies, next, target, visited)) {
      return true;
    }
  }
  return false;
}

function commitObject(root: string, revision: string): string {
  if (/^[0-9a-f]{40}$/.test(revision)) {
    return commitFacts(JSON.stringify([root, revision]), () => resolveCommitObject(root, revision));
  }
  return resolveCommitObject(root, revision);
}

function resolveCommitObject(root: string, revision: string): string {
  const commit = git(["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
  });
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail(`Revision ${revision} did not resolve to a full SHA-1 commit ID.`);
  }
  return commit;
}

function assertCleanWorkingTree(root: string, action: string): void {
  const status = git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  if (status) {
    fail(
      `${action} requires a clean worktree. Commit, stash, or remove these changes first:\n${status}`,
    );
  }
}

function commitParents(root: string, commit: string): string[] {
  const output = git(["show", "-s", "--format=%P", commit], { cwd: root });
  return output ? output.split(/\s+/) : [];
}

function branchCommit(root: string, branch: string): string {
  return commitObject(root, `refs/heads/${branch}`);
}

function currentBranch(root: string): string | undefined {
  return gitOptional(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
  });
}

function checkedOutBranches(root: string): Set<string> {
  const output = git(["worktree", "list", "--porcelain"], { cwd: root });
  return new Set(
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length)),
  );
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return gitOptional(["merge-base", ancestor, descendant], {
    cwd: root,
  }) === ancestor;
}

function assertLinearRange(root: string, base: string, head: string, label: string): void {
  linearRangeFacts(JSON.stringify([root, base, head]), () => checkLinearRange(root, base, head, label));
}

function checkLinearRange(root: string, base: string, head: string, label: string): void {
  if (!isAncestor(root, base, head)) {
    fail(`${label} head ${head} must descend from ${base}.`);
  }
  const merges = git(["rev-list", "--merges", `${base}..${head}`], {
    cwd: root,
  });
  if (merges) {
    fail(`${label} must not contain merge commits.`);
  }
}

function stageBranchName(manifest: ImplementationManifest, index: number, id: string): string {
  return `${manifest.branchPrefix}/${String(index + 1).padStart(2, "0")}-${id}`;
}

function changedFiles(root: string, parent: string, commit: string): FileChange[] {
  return changedFileFacts(JSON.stringify([root, parent, commit]), () => readChangedFiles(root, parent, commit));
}

/** Format 0.1 kind of a non-rename Git name-status code. */
function changeKind(code: string): "added" | "modified" | "deleted" | undefined {
  return code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : undefined;
}

function readChangedFiles(root: string, parent: string, commit: string): FileChange[] {
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames=50%", parent, commit],
    {
      cwd: root,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    fail(`Cannot derive changed files: ${processFailureDetail(result)}`);
  }

  const fields = result.stdout
    .toString("utf8")
    .split("\0")
    .filter((field) => field.length > 0);
  const files: FileChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    const code = status[0];

    if (code === "R") {
      const previousPath = fields[index];
      const currentPath = fields[index + 1];
      if (!previousPath || !currentPath) {
        fail(`Malformed Git rename record for commit ${commit}.`);
      }
      files.push({
        path: currentPath,
        kind: "renamed",
        previousPath,
      });
      index += 2;
      continue;
    }

    const currentPath = fields[index];
    if (!currentPath) {
      fail(`Malformed Git change record for commit ${commit}.`);
    }
    const kind = changeKind(code);
    if (!kind) {
      fail(
        `Git status ${status} for ${currentPath} is unsupported by format 0.1.`,
      );
    }
    files.push({ path: currentPath, kind });
    index += 1;
  }

  files.sort((left, right) => compareOrdinal(left.path, right.path));
  if (files.length === 0) {
    fail(`Stage head ${commit} has no changes relative to ${parent}.`);
  }
  for (const file of files) {
    if (
      file.path === ".semantic-review" ||
      file.path.startsWith(".semantic-review/") ||
      file.previousPath === ".semantic-review" ||
      file.previousPath?.startsWith(".semantic-review/")
    ) {
      fail(`Stage head ${commit} contains semantic implementation artifact files.`);
    }
  }
  return files;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface DiffChangeShape {
  binary: boolean;
  hunks: DiffHunk[];
}

function diffChangeShape(root: string, parent: string, commit: string, file: FileChange): DiffChangeShape {
  return changeShapeFacts(JSON.stringify([root, parent, commit, file]), () => readDiffChangeShape(root, parent, commit, file));
}

function readDiffChangeShape(root: string, parent: string, commit: string, file: FileChange): DiffChangeShape {
  const paths = [...new Set([file.previousPath, file.path].filter((value): value is string => Boolean(value)))];
  const patch = gitRaw(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--find-renames=50%",
      "--unified=0",
      parent,
      commit,
      "--",
      ...paths,
    ],
    { cwd: root },
  );
  const hunks: DiffHunk[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (!match) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return {
    binary: /(?:Binary files|GIT binary patch)/.test(patch),
    hunks,
  };
}

function addLines(target: Set<number>, start: number, count: number): void {
  for (let line = start; line < start + count; line += 1) {
    target.add(line);
  }
}

function sameNumberSets(left: Set<number>, right: Set<number>): boolean {
  return (
    left.size === right.size &&
    [...left].every((value) => right.has(value))
  );
}

/** Revisions whose diff the node selectors of a stage are checked against. */
interface DiffContext {
  root: string;
  baseRevision: string;
  headRevision: string;
}

const LINE_SIDES = ["old", "new"] as const;

function stageNodeErrors(stage: EditableStage, files: FileChange[], diffContext: DiffContext | undefined = undefined): string[] {
  const errors: string[] = [];
  const nodes = stage.nodes;
  const nodeIds = nodes.map((node) => node.id);
  const knownNodeIds = new Set(nodeIds);
  for (const duplicate of duplicateValues(nodeIds)) {
    errors.push(`Stage ${stage.id} repeats node ID ${duplicate}.`);
  }

  for (const collection of STAGE_ITEM_COLLECTIONS) {
    const recordName =
      collection === "validation" ? "validation evidence" : collection === "evidence" ? "evidence" : "insight";
    for (const item of stageItems(stage, collection)) {
      if (!Array.isArray(item.nodeRefs) || item.nodeRefs.length === 0) {
        errors.push(
          `Stage ${stage.id} ${collection} ${recordName} ${item.id} has no node refs.`,
        );
        continue;
      }
      for (const nodeRef of item.nodeRefs) {
        if (!knownNodeIds.has(nodeRef)) {
          errors.push(
            `Stage ${stage.id} ${collection} ${recordName} ${item.id} references missing node ${nodeRef}.`,
          );
        }
      }
    }
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const memberships = new Map<string, { node: ChangeNode; change: NodeFileChange }[]>();
  for (const node of nodes) {
    const nodePaths = node.changes.map((change) => change.path);
    for (const duplicate of duplicateValues(nodePaths)) {
      errors.push(`Stage ${stage.id} node ${node.id} repeats path ${duplicate}.`);
    }
    for (const change of node.changes) {
      if (!filesByPath.has(change.path)) {
        errors.push(
          `Stage ${stage.id} node ${node.id} references unchanged path ${change.path}.`,
        );
        continue;
      }
      const entries = memberships.get(change.path) ?? [];
      entries.push({ node, change });
      memberships.set(change.path, entries);
    }
  }

  for (const file of files) {
    const entries = memberships.get(file.path) ?? [];
    if (entries.length === 0) {
      errors.push(`Stage ${stage.id} does not assign changed path ${file.path} to a node.`);
      continue;
    }
    if (entries.length === 1) {
      const change = entries[0].change;
      if (change.hunks || change.lineRanges) {
        errors.push(
          `Stage ${stage.id} path ${file.path} belongs to one node and must use whole-file membership.`,
        );
      }
      continue;
    }

    const selectorKinds = new Set(
      entries.map(({ change }) =>
        change.hunks
          ? "hunks"
          : change.lineRanges
            ? "lineRanges"
            : "missing",
      ),
    );
    if (selectorKinds.has("missing")) {
      errors.push(
        `Stage ${stage.id} path ${file.path} belongs to multiple nodes; every membership needs hunks or lineRanges.`,
      );
      continue;
    }
    if (selectorKinds.size !== 1) {
      errors.push(
        `Stage ${stage.id} path ${file.path} must use one selector type across all node memberships.`,
      );
      continue;
    }
    if (!diffContext) continue;

    const shape = diffChangeShape(
      diffContext.root,
      diffContext.baseRevision,
      diffContext.headRevision,
      file,
    );
    if (shape.binary || shape.hunks.length === 0) {
      errors.push(
        `Stage ${stage.id} path ${file.path} cannot be split across nodes because it has no textual hunks.`,
      );
      continue;
    }

    if (selectorKinds.has("hunks")) {
      const owners = new Map<number, string>();
      for (const { node, change } of entries) {
        // Every membership of this path selects hunks (checked above).
        for (const hunk of change.hunks ?? []) {
          if (hunk > shape.hunks.length) {
            errors.push(
              `Stage ${stage.id} node ${node.id} selects missing hunk ${hunk} of ${file.path}.`,
            );
          } else if (owners.has(hunk)) {
            errors.push(
              `Stage ${stage.id} path ${file.path} hunk ${hunk} belongs to both ${owners.get(hunk)} and ${node.id}.`,
            );
          } else {
            owners.set(hunk, node.id);
          }
        }
      }
      for (let hunk = 1; hunk <= shape.hunks.length; hunk += 1) {
        if (!owners.has(hunk)) {
          errors.push(
            `Stage ${stage.id} path ${file.path} hunk ${hunk} is not assigned to a node.`,
          );
        }
      }
      continue;
    }

    const actualOld = new Set<number>();
    const actualNew = new Set<number>();
    for (const hunk of shape.hunks) {
      addLines(actualOld, hunk.oldStart, hunk.oldCount);
      addLines(actualNew, hunk.newStart, hunk.newCount);
    }
    const selectedOld = new Set<number>();
    const selectedNew = new Set<number>();
    const owners = new Map<string, string>();
    for (const { node, change } of entries) {
      // Every membership of this path selects line ranges (checked above).
      for (const range of change.lineRanges ?? []) {
        for (const side of LINE_SIDES) {
          const span = range[side];
          if (!span) continue;
          if (span.end < span.start) {
            errors.push(
              `Stage ${stage.id} node ${node.id} has an inverted ${side} line range for ${file.path}.`,
            );
            continue;
          }
          const selected = side === "old" ? selectedOld : selectedNew;
          const actual = side === "old" ? actualOld : actualNew;
          for (let line = span.start; line <= span.end; line += 1) {
            const key = `${side}:${line}`;
            if (!actual.has(line)) {
              errors.push(
                `Stage ${stage.id} node ${node.id} selects unchanged ${side} line ${line} of ${file.path}.`,
              );
            } else if (owners.has(key)) {
              errors.push(
                `Stage ${stage.id} path ${file.path} ${side} line ${line} belongs to both ${owners.get(key)} and ${node.id}.`,
              );
            } else {
              owners.set(key, node.id);
              selected.add(line);
            }
          }
        }
      }
    }
    if (!sameNumberSets(actualOld, selectedOld) || !sameNumberSets(actualNew, selectedNew)) {
      errors.push(
        `Stage ${stage.id} path ${file.path} line ranges do not cover every changed line exactly once.`,
      );
    }
  }
  return errors;
}

function sameChanges(left: FileChange[], right: FileChange[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unresolvedRefHint(criterionIds: Map<string, Set<string>>, specificationId: string): string {
  const known = criterionIds.get(specificationId);
  if (!known) {
    return ` Specification ${specificationId} does not exist.`;
  }
  if (known.size === 0) {
    return ` Specification ${specificationId} has no acceptance criteria.`;
  }
  const valid = [...known].map((id) => `${specificationId}#${id}`).join(", ");
  return ` Valid criteria: ${valid}.`;
}

function evidenceItemErrors(stage: EditableStage): string[] {
  return stage.evidence.flatMap((item) => (item.specificationRefs ?? [])
    .filter((reference) => !stage.specificationRefs.includes(reference))
    .map((reference) => `Stage ${stage.id} evidence ${item.id} references ${reference}, which the stage does not address.`));
}

interface SemanticValidationOptions {
  validateGit?: boolean;
  allowLandedTarget?: boolean;
  allowTargetDrift?: boolean;
}

function validateSemantic(
  workspace: Pick<Workspace, "root">,
  files: ArtifactFiles,
  artifact: Artifact,
  { validateGit = true, allowLandedTarget = false, allowTargetDrift = false }: SemanticValidationOptions = {},
): void {
  const errors: string[] = [];
  const { manifest, requirements, stages, workStages } = artifact;
  // Checked only in full validation: an edit prunes replaced files once it has saved.
  if (validateGit) {
    const allStages = [...stages.values(), ...workStages.values()];
    errors.push(...evidenceTreeErrors(files, allStages), ...allStages.flatMap((stage) => evidenceAttachmentErrors(files, stage)));
  }

  const specificationFiles = listJsonIds(files, "requirements");
  const stageFiles = listJsonIds(files, "stages");
  for (const id of specificationFiles) {
    if (!manifest.requirements.includes(id)) {
      errors.push(`Unlisted specification file requirements/${id}.json.`);
    }
  }
  for (const id of stageFiles) {
    if (!manifest.stages.includes(id)) {
      errors.push(`Unlisted stage file stages/${id}.json.`);
    }
  }

  const criterionIds = new Map<string, Set<string>>();
  for (const [id, specification] of requirements) {
    if (specification.id !== id) {
      errors.push(`Specification ${id} has internal ID ${specification.id}.`);
    }
    const criteria = specification.acceptanceCriteria.map((item) => item.id);
    for (const duplicate of duplicateValues(criteria)) {
      errors.push(`Specification ${id} repeats criterion ID ${duplicate}.`);
    }
    criterionIds.set(id, new Set(criteria));
  }

  const dependencies = new Map<string, string[]>();
  const seenStages = new Set<string>();
  const branches = new Set<string>();
  const heads = new Set<string>();
  for (const id of manifest.stages) {
    const stage = finalizedStage(artifact, id);
    if (stage.id !== id) {
      errors.push(`Stage ${id} has internal ID ${stage.id}.`);
    }
    dependencies.set(id, stage.dependsOn);
    for (const dependency of stage.dependsOn) {
      if (!stages.has(dependency)) {
        errors.push(`Stage ${id} depends on missing stage ${dependency}.`);
      } else if (!seenStages.has(dependency)) {
        errors.push(`Stage ${id} depends on later stage ${dependency}.`);
      }
    }
    for (const reference of stage.specificationRefs) {
      const [specificationId, criterionId] = reference.split("#", 2);
      if (!criterionIds.get(specificationId)?.has(criterionId)) {
        errors.push(
          `Stage ${id} has unresolved specification ref ${reference}.${unresolvedRefHint(criterionIds, specificationId)}`,
        );
      }
    }
    for (const collection of STAGE_ITEM_COLLECTIONS) {
      const ids = stageItems(stage, collection).map((item) => item.id);
      for (const duplicate of duplicateValues(ids)) {
        errors.push(`Stage ${id} repeats ${collection} ID ${duplicate}.`);
      }
    }
    const changedPaths = stage.change.files.map((item) => item.path);
    for (const duplicate of duplicateValues(changedPaths)) {
      errors.push(`Stage ${id} repeats changed path ${duplicate}.`);
    }
    errors.push(...stageNodeErrors(stage, stage.change.files));
    errors.push(...evidenceItemErrors(stage));
    const expectedBranch = stageBranchName(
      manifest,
      manifest.stages.indexOf(id),
      id,
    );
    if (stage.change.branch !== expectedBranch) {
      errors.push(
        `Stage ${id} branch ${stage.change.branch} should be ${expectedBranch}.`,
      );
    }
    if (branches.has(stage.change.branch)) {
      errors.push(`Stage ${id} repeats branch ${stage.change.branch}.`);
    }
    if (heads.has(stage.change.headRevision)) {
      errors.push(`Stage ${id} repeats head ${stage.change.headRevision}.`);
    }
    branches.add(stage.change.branch);
    heads.add(stage.change.headRevision);
    seenStages.add(id);
  }

  for (const [id, directDependencies] of dependencies) {
    for (const dependency of directDependencies) {
      for (const other of directDependencies) {
        if (
          dependency !== other &&
          reachable(dependencies, other, dependency)
        ) {
          errors.push(
            `Stage ${id} redundantly lists transitive dependency ${dependency}.`,
          );
        }
      }
    }
  }

  for (const [id, stage] of workStages) {
    if (stages.has(id)) {
      errors.push(`Stage ${id} exists as both working and canonical data.`);
    }
    for (const dependency of stage.dependsOn) {
      if (!stages.has(dependency)) {
        errors.push(
          `Working stage ${id} depends on missing finalized stage ${dependency}.`,
        );
      }
    }
    for (const dependency of stage.dependsOn) {
      for (const other of stage.dependsOn) {
        if (
          dependency !== other &&
          reachable(dependencies, other, dependency)
        ) {
          errors.push(
            `Working stage ${id} redundantly lists transitive dependency ${dependency}.`,
          );
        }
      }
    }
    errors.push(...evidenceItemErrors(stage));
    for (const reference of stage.specificationRefs) {
      const [specificationId, criterionId] = reference.split("#", 2);
      if (!criterionIds.get(specificationId)?.has(criterionId)) {
        errors.push(
          `Working stage ${id} has unresolved specification ref ${reference}.${unresolvedRefHint(criterionIds, specificationId)}`,
        );
      }
    }
    for (const collection of STAGE_ITEM_COLLECTIONS) {
      const ids = stageItems(stage, collection).map((item) => item.id);
      for (const duplicate of duplicateValues(ids)) {
        errors.push(
          `Working stage ${id} repeats ${collection} ID ${duplicate}.`,
        );
      }
      const expectedBranch = stageBranchName(manifest, manifest.stages.length, id);
      if (stage.branch !== expectedBranch) {
        errors.push(
          `Working stage ${id} branch ${stage.branch} should be ${expectedBranch}.`,
        );
      }
    }
  }
  if (workStages.size > 1) {
    errors.push("Only one working stage may exist at a time.");
  }

  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  if (!validateGit) {
    return;
  }

  const base = commitObject(workspace.root, manifest.baseRevision);
  const targetHead = branchCommit(workspace.root, manifest.targetBranch);
  const finalStageId = manifest.stages.at(-1);
  const finalStageHead = finalStageId
    ? finalizedStage(artifact, finalStageId).change.headRevision
    : undefined;
  const targetContainsLandedStack =
    allowLandedTarget &&
    finalStageHead !== undefined &&
    isAncestor(workspace.root, finalStageHead, targetHead);
  if (targetHead !== base && !targetContainsLandedStack && !allowTargetDrift) {
    fail(
      `Target branch ${manifest.targetBranch} moved from ${base} to ${targetHead}; check it out, then run restack --base ${manifest.targetBranch}.`,
    );
  }
  let expectedBaseBranch = manifest.targetBranch;
  let expectedParent = base;
  for (const [index, id] of manifest.stages.entries()) {
    const stage = finalizedStage(artifact, id);
    const { branch, baseBranch, baseRevision, headRevision } = stage.change;
    if (branch !== stageBranchName(manifest, index, id)) {
      fail(`Stage ${id} branch ${branch} does not follow the stack convention.`);
    }
    if (baseBranch !== expectedBaseBranch) {
      fail(
        `Stage ${id} base branch ${baseBranch} should be ${expectedBaseBranch}.`,
      );
    }
    if (baseRevision !== expectedParent) {
      fail(
        `Stage ${id} base revision ${baseRevision} should be ${expectedParent}.`,
      );
    }
    const branchHead = branchCommit(workspace.root, branch);
    const head = commitObject(workspace.root, headRevision);
    if (branchHead !== head) {
      fail(
        `Stage ${id} branch ${branch} moved from ${head} to ${branchHead}; check it out, then run restack --from ${id}.`,
      );
    }
    assertLinearRange(workspace.root, expectedParent, head, `Stage ${id}`);
    const actualFiles = changedFiles(workspace.root, expectedParent, head);
    if (!sameChanges(stage.change.files, actualFiles)) {
      fail(
        `Stage ${id} file inventory is stale.\nExpected: ${JSON.stringify(actualFiles)}\nActual:   ${JSON.stringify(stage.change.files)}`,
      );
    }
    const nodeErrors = stageNodeErrors(stage, actualFiles, {
      root: workspace.root,
      baseRevision: expectedParent,
      headRevision: head,
    });
    if (nodeErrors.length > 0) {
      fail(nodeErrors.join("\n"));
    }
    expectedBaseBranch = branch;
    expectedParent = head;
  }
}

interface ArtifactValidationOptions extends SemanticValidationOptions {
  schemaOnly?: boolean;
  publish?: boolean;
  quiet?: boolean;
}

/** Validates the artifact the workspace read, or a draft of its next version. */
function validateArtifact(
  workspace: Pick<Workspace, "root"> & Partial<Workspace>,
  {
    schemaOnly = false,
    publish = false,
    quiet = false,
    validateGit = true,
    allowLandedTarget = false,
    allowTargetDrift = false,
  }: ArtifactValidationOptions = {},
  files: ArtifactFiles | undefined = workspace.snapshot,
): Artifact {
  if (!files) throw new Error("Validation requires the artifact's files.");
  const artifact = loadArtifact(files);

  for (const stage of [...artifact.stages.values(), ...artifact.workStages.values()]) {
    for (const collection of STAGE_ITEM_COLLECTIONS) for (const item of stageItems(stage, collection)) {
      if (item.codeTarget) validateCodeTarget(workspace.root, item.codeTarget, !schemaOnly && validateGit);
    }
  }
  if (!schemaOnly) {
    validateSemantic(workspace, files, artifact, { validateGit, allowLandedTarget, allowTargetDrift });
  }

  if (publish) {
    if (artifact.manifest.stages.length === 0) {
      fail("Publication validation requires at least one finalized stage.");
    }
    if (artifact.workStages.size > 0) {
      fail(
        `Publication validation found unfinished stages: ${[...artifact.workStages.keys()].join(", ")}.`,
      );
    }
  }

  if (!quiet) {
    if (!schemaOnly) reportEvidenceWarnings(artifact.stages.values());
    console.log(validationMessage(artifact, schemaOnly ? "schema" : publish ? "publication" : "full"));
  }
  return artifact;
}

function validationMessage(artifact: Artifact, mode: "schema" | "publication" | "full"): string {
  return `Semantic implementation ${mode} validation passed: ${artifact.requirements.size} specification(s), ${artifact.stages.size} finalized stage(s), ${artifact.workStages.size} working stage(s).`;
}

function reportEvidenceWarnings(stages: Iterable<Stage>): void {
  for (const stage of stages) {
    for (const warning of evidenceWarnings(stage)) console.error(`Warning: ${warning}`);
  }
}

export interface ImplementationValidation {
  /** The summary `implementation validate` prints. */
  message: string;
  warnings: string[];
}

/** Fully validates the implementation in root, as `implementation validate` does. */
export function validateImplementation(root: string): ImplementationValidation {
  return withValidationContext(() => {
    const artifact = validateArtifact(openWorkspace(root), { quiet: true });
    return {
      message: validationMessage(artifact, "full"),
      warnings: [...artifact.stages.values()].flatMap((stage) => evidenceWarnings(stage)),
    };
  });
}

function ensureArtifactExcluded(root: string): void {
  const exclude = git(["rev-parse", "--git-path", "info/exclude"], {
    cwd: root,
  });
  const resolvedExclude = path.isAbsolute(exclude)
    ? exclude
    : path.resolve(root, exclude);
  fs.mkdirSync(path.dirname(resolvedExclude), { recursive: true });
  const existing = fs.existsSync(resolvedExclude)
    ? fs.readFileSync(resolvedExclude, "utf8")
    : "";
  const lines = existing.split(/\r?\n/);
  if (!lines.includes(".semantic-review/")) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(
      resolvedExclude,
      `${prefix}.semantic-review/\n`,
      "utf8",
    );
  }
}

/** A specification built from command options; it is validated before use. */
function specificationFromOptions(options: Options): Specification {
  const criteria = repeatedOption(options, "criterion").map((value) => {
    const [id, text] = splitPair(value, "--criterion");
    return { id, text };
  });
  if (criteria.length === 0) {
    fail("At least one --criterion <id>=<text> is required.");
  }

  const kind = option(options, "source-kind", { required: true });
  const reference = option(options, "source-reference", { required: true });
  const sourceUrl = option(options, "source-url");
  return {
    $schema: SPECIFICATION_SCHEMA_ID,
    id: option(options, "specification-id", { required: true }),
    title: option(options, "specification-title", { required: true }),
    summary: option(options, "specification-summary", { required: true }),
    source: { kind, reference, ...(sourceUrl ? { url: sourceUrl } : {}) },
    acceptanceCriteria: criteria,
  };
}

function initialize(root: string, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "init"));
  const existing = readArtifact(root);
  if (existing) {
    fail(`A semantic implementation already exists at ${existing.describe("manifest.json")}.`);
  }
  if (hasIncompleteArtifact(root)) {
    fail(
      `${describeArtifact(root)} already contains files but has no manifest. Inspect or remove it before initialization.`,
    );
  }
  assertCleanWorkingTree(root, "Initialization");

  const specificationInput = specificationFromOptions(options);
  const implementationId = option(options, "implementation-id", { required: true });
  const targetBranch = option(options, "target-branch", { required: true });
  git(["check-ref-format", "--branch", targetBranch], { cwd: root });
  const targetHead = branchCommit(root, targetBranch);
  const baseRevision = commitObject(
    root,
    option(options, "base-revision") ?? targetBranch,
  );
  if (baseRevision !== targetHead) {
    fail(
      `Base revision ${baseRevision} must equal target branch ${targetBranch} head ${targetHead}.`,
    );
  }
  const branchPrefix = option(options, "branch-prefix") ?? `semantic-flow/${implementationId}`;
  git(["check-ref-format", "--branch", `${branchPrefix}/01-probe`], {
    cwd: root,
  });
  const versionFile = path.join(skillDirectory, "VERSION");
  const skillVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "";
  const manifestInput: ImplementationManifest = {
    $schema: MANIFEST_SCHEMA_ID,
    ...(skillVersion ? { skillVersion } : {}),
    formatVersion: "0.1",
    implementationId,
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
    baseRevision,
    targetBranch,
    branchPrefix,
    requirements: [specificationInput.id],
    stages: [],
  };

  const specification = parseDocument(SPECIFICATION_SCHEMA_ID, specificationInput, "Specification input");
  const manifest = parseDocument(MANIFEST_SCHEMA_ID, manifestInput, "Manifest input");

  const draft = new ArtifactDraft(undefined);
  draft.writeJson(`requirements/${specification.id}.json`, specification);
  draft.writeJson("manifest.json", manifest);
  validateArtifact({ root }, { quiet: true }, draft);
  ensureArtifactExcluded(root);
  commitArtifact(root, undefined, draft);
  console.log(`Initialized semantic implementation ${manifest.implementationId}.`);
}

function addSpecification(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "specification add"),
  );
  const artifact = validateArtifact(workspace, { quiet: true });
  const specificationInput = specificationFromOptions(options);
  if (artifact.requirements.has(specificationInput.id)) {
    fail(`Specification ${specificationInput.id} already exists.`);
  }
  const specification = parseDocument(SPECIFICATION_SCHEMA_ID, specificationInput, "Specification input");

  artifact.manifest.requirements.push(specification.id);
  const draft = new ArtifactDraft(workspace.snapshot);
  draft.writeJson(`requirements/${specification.id}.json`, specification);
  draft.writeJson("manifest.json", artifact.manifest);
  validateArtifact(workspace, { quiet: true }, draft);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  console.log(`Added specification ${specification.id}.`);
}

function beginStage(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage begin"),
  );
  const artifact = validateArtifact(workspace, { quiet: true });
  assertCleanWorkingTree(workspace.root, "Beginning a stage");
  if (artifact.workStages.size > 0) {
    fail(
      `Finish the current working stage before beginning another: ${[...artifact.workStages.keys()].join(", ")}.`,
    );
  }

  const id = option(options, "id", { required: true });
  if (artifact.stages.has(id)) {
    fail(`Stage ${id} is already finalized.`);
  }
  const file = `.work/stages/${id}.json`;
  if (workspace.snapshot.type(file) !== undefined) {
    fail(`Working stage ${id} already exists.`);
  }

  const branch = stageBranchName(artifact.manifest, artifact.manifest.stages.length, id);
  const ordinalPrefix = branch.slice(0, branch.lastIndexOf("/") + 1)
    + `${String(artifact.manifest.stages.length + 1).padStart(2, "0")}-`;
  const ordinalRefs = git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${artifact.manifest.branchPrefix}/`], { cwd: workspace.root });
  const collision = ordinalRefs.split(/\r?\n/).find((ref) => ref.startsWith(ordinalPrefix));
  if (collision) fail(`Stage ordinal already exists on branch ${collision}; resolve it before beginning another stage.`);
  git(["check-ref-format", "--branch", branch], { cwd: workspace.root });
  const existingBranch = gitOptional(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: workspace.root,
  });
  if (existingBranch) {
    fail(`Stage branch ${branch} already exists at ${existingBranch}.`);
  }
  const parent = stackTip(artifact);
  const head = commitObject(workspace.root, "HEAD");
  if (head !== parent) {
    fail(
      `Beginning ${id} requires HEAD at stack tip ${parent}, but HEAD is ${head}.`,
    );
  }

  const stageInput: WorkStage = {
    $schema: WORK_STAGE_SCHEMA_ID,
    id,
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
    branch,
    dependsOn: repeatedOption(options, "depends-on"),
    specificationRefs: repeatedOption(options, "specification-ref"),
    nodes: [],
    rationale: option(options, "rationale", { required: true }),
    decisions: [],
    assumptions: [],
    alternatives: [],
    failedAttempts: [],
    risks: [],
    validation: [],
    evidence: [],
    openQuestions: [],
  };
  if (stageInput.specificationRefs.length === 0) {
    fail("At least one --specification-ref is required.");
  }
  const stage = parseDocument(WORK_STAGE_SCHEMA_ID, stageInput, "Stage input");

  const draft = new ArtifactDraft(workspace.snapshot);
  draft.writeJson(file, stage);
  validateArtifact(workspace, { quiet: true }, draft);
  const originalBranch = currentBranch(workspace.root);
  git(["switch", "-c", branch, parent], { cwd: workspace.root });
  try {
    commitArtifact(workspace.root, workspace.snapshot, draft);
  } catch (error) {
    if (originalBranch) {
      git(["switch", originalBranch], { cwd: workspace.root });
    } else {
      git(["switch", "--detach", parent], { cwd: workspace.root });
    }
    git(["branch", "-D", branch], { cwd: workspace.root });
    throw error;
  }
  if (flag(options, "json")) console.log(JSON.stringify({ worktree: workspace.root, stageId: id, branch, baseRevision: parent, headRevision: parent, next: "implement" }));
  else console.log(`Began working stage ${id} on ${branch}.`);
}

/** A working stage of a validated artifact, with the file it was loaded from. */
function workingStage(artifact: Artifact, id: string): { file: string; stage: WorkStage } {
  const file = `.work/stages/${id}.json`;
  const stage = artifact.workStages.get(id);
  if (!stage) {
    fail(`Working stage ${id} does not exist.`);
  }
  return { file, stage };
}

function selectedWorkingStageId(artifact: Artifact, requested: string | undefined, optionName: string): string {
  if (requested && requested !== "current") {
    return requested;
  }
  if (artifact.workStages.size === 0) {
    fail(`No active working stage exists; specify --${optionName} explicitly.`);
  }
  if (artifact.workStages.size > 1) {
    fail(
      `More than one working stage exists; repair the artifact before using --${optionName} current.`,
    );
  }
  const [id] = artifact.workStages.keys();
  return id;
}

/** Edits a stage in place, or returns its replacement when the edit revalidates the document. */
type StageUpdate = (stage: EditableStage) => EditableStage;

/** Items of a record-batch, applied to one in-memory stage and saved together. */
interface StageBatch {
  artifact: Artifact;
  finalized: boolean;
  stage: EditableStage;
}

/** Applies one edit to a stage in a draft and validates the edited artifact. */
function saveStage(workspace: Workspace, draft: ArtifactDraft, file: string, stage: EditableStage, update: StageUpdate): EditableStage {
  const updated = update(structuredClone(stage));
  draft.writeJson(file, updated);
  validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
  return updated;
}

/** Edits one stage and saves it, or adds the edit to a batch or to a draft
 * that the caller commits. */
function updateStage(
  workspace: Workspace,
  id: string,
  finalized: boolean,
  update: StageUpdate,
  batch: StageBatch | undefined = undefined,
  draft: ArtifactDraft | undefined = undefined,
): EditableStage {
  if (batch) {
    if (id !== batch.stage.id || finalized !== batch.finalized) fail("Every batch item must target the selected stage.");
    batch.stage = update(batch.stage);
    return batch.stage;
  }
  const artifact = validateArtifact(workspace, {
    quiet: true,
    validateGit: false,
  });
  const edit = draft ?? new ArtifactDraft(workspace.snapshot);
  let updated: EditableStage;
  if (!finalized) {
    const { file, stage } = workingStage(artifact, id);
    updated = saveStage(workspace, edit, file, stage, update);
  } else {
    const stage = artifact.stages.get(id);
    if (!stage) {
      fail(`Finalized stage ${id} does not exist.`);
    }
    updated = saveStage(workspace, edit, `stages/${id}.json`, stage, update);
  }
  if (!draft) commitArtifact(workspace.root, workspace.snapshot, edit);
  return updated;
}

function setStage(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage set"),
  );
  const artifact = validateArtifact(workspace, {
    quiet: true,
    validateGit: false,
  });
  const finalized = flag(options, "finalized"), requested = option(options, "id");
  const id = finalized ? explicitStageId(requested, "id") : selectedWorkingStageId(artifact, requested, "id");
  const title = option(options, "title");
  const summary = option(options, "summary");
  const rationale = option(options, "rationale");
  const hasDependencies = options.has("depends-on");
  const hasSpecificationRefs = options.has("specification-ref");
  if (
    title === undefined &&
    summary === undefined &&
    rationale === undefined &&
    !hasDependencies &&
    !hasSpecificationRefs
  ) {
    fail("stage set requires at least one field to update.");
  }

  updateStage(workspace, id, finalized, (stage) => {
    if (title !== undefined) stage.title = title;
    if (summary !== undefined) stage.summary = summary;
    if (rationale !== undefined) stage.rationale = rationale;
    if (hasDependencies) stage.dependsOn = repeatedOption(options, "depends-on");
    if (hasSpecificationRefs) {
      stage.specificationRefs = repeatedOption(options, "specification-ref");
    }
    return stage;
  });
  console.log(`Updated ${finalized ? "finalized" : "working"} stage ${id}.`);
}

/** An insight item built from command options, validated when stored in its stage. */
interface RecordedItem {
  collection: InsightCollection;
  value: JsonRecord;
  allowed: string[];
}

function itemForKind(kind: string, options: Options): RecordedItem {
  const id = option(options, "item-id", { required: true });
  switch (kind) {
    case "decision":
      return {
        collection: "decisions",
        value: {
          id,
          category: option(options, "category", { required: true }),
          summary: option(options, "summary", { required: true }),
          rationale: option(options, "rationale", { required: true }),
        },
        allowed: ["category", "summary", "rationale"],
      };
    case "assumption":
      return {
        collection: "assumptions",
        value: {
          id,
          statement: option(options, "statement", { required: true }),
          riskIfWrong: option(options, "risk-if-wrong", { required: true }),
        },
        allowed: ["statement", "risk-if-wrong"],
      };
    case "alternative":
      return {
        collection: "alternatives",
        value: {
          id,
          approach: option(options, "approach", { required: true }),
          reasonRejected: option(options, "reason-rejected", { required: true }),
        },
        allowed: ["approach", "reason-rejected"],
      };
    case "failed-attempt":
      return {
        collection: "failedAttempts",
        value: {
          id,
          approach: option(options, "approach", { required: true }),
          outcome: option(options, "outcome", { required: true }),
          lesson: option(options, "lesson", { required: true }),
        },
        allowed: ["approach", "outcome", "lesson"],
      };
    case "risk": {
      const value: JsonRecord = {
        id,
        summary: option(options, "summary", { required: true }),
      };
      const mitigation = option(options, "mitigation");
      if (mitigation !== undefined) value.mitigation = mitigation;
      return {
        collection: "risks",
        value,
        allowed: ["summary", "mitigation"],
      };
    }
    case "question":
      return {
        collection: "openQuestions",
        value: {
          id,
          question: option(options, "question", { required: true }),
        },
        allowed: ["question"],
      };
    default:
      fail(
        `Unsupported record kind ${kind}. Use decision, assumption, alternative, failed-attempt, risk, or question.`,
      );
  }
}

function validateRecordedNodeRefs(stage: EditableStage, nodeRefs: string[] | undefined): void {
  if (!stage.nodes.length) return;
  if (!nodeRefs?.length) {
    fail("Recording an insight after stage organization requires --node-ref.");
  }
  const knownNodeIds = new Set(stage.nodes.map((node) => node.id));
  for (const nodeRef of nodeRefs) {
    if (!knownNodeIds.has(nodeRef)) {
      fail(`Stage ${stage.id} has no node ${nodeRef}.`);
    }
  }
}

/** The code target the options select, else the one of the item being replaced. */
function recordedCodeTarget(
  workspace: Workspace,
  stage: EditableStage,
  options: Options,
  previous: InsightItem | undefined = undefined,
): CodeTarget | undefined {
  const file = option(options, "code-path");
  const start = option(options, "code-start");
  const end = option(options, "code-end");
  if (file === undefined && start === undefined && end === undefined) {
    return previous?.codeTarget;
  }
  if (file === undefined || start === undefined) fail("Code targets require --code-path and --code-start.");
  const revision = stage.$schema === STAGE_SCHEMA_ID ? stage.change.headRevision : branchCommit(workspace.root, stage.branch);
  return captureCodeTarget(workspace.root, revision, file, Number(start), Number(end ?? start));
}

/** Adds or replaces one recorded item, keeping the node refs and code target
 * of the item it replaces unless the options set them. The stage document is
 * revalidated, so the option values are typed only once its schema accepts
 * them; errors name the stage file, as validating the saved file would. */
function storeRecordedItem(
  workspace: Workspace,
  stage: EditableStage,
  options: Options,
  collection: InsightCollection,
  index: number,
  value: JsonRecord,
): EditableStage {
  const items: unknown[] = [...stageItems(stage, collection)];
  const previous = index >= 0 ? stageItems(stage, collection)[index] : undefined;
  if (previous && value.nodeRefs === undefined && previous.nodeRefs) {
    value.nodeRefs = previous.nodeRefs;
  }
  const codeTarget = recordedCodeTarget(workspace, stage, options, previous);
  if (codeTarget) value.codeTarget = codeTarget;
  validateRecordedNodeRefs(stage, isStringArray(value.nodeRefs) ? value.nodeRefs : undefined);
  if (index >= 0) items[index] = value;
  else items.push(value);
  return parseDocument(stage.$schema, { ...stage, [collection]: items }, workspace.snapshot.describe(stageFile(stage)));
}

function targetInsight(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "stage target"));
  const finalized = flag(options, "finalized"), requested = option(options, "stage");
  const explicitId = finalized ? explicitStageId(requested, "stage") : undefined;
  const artifact = validateArtifact(workspace, { quiet: true, validateGit: false });
  const id = explicitId ?? selectedWorkingStageId(artifact, requested, "stage");
  const collection = option(options, "collection", { required: true }), itemId = option(options, "item-id", { required: true });
  if (!isInsightCollection(collection)) fail("Unknown insight collection.");
  const remove = flag(options, "remove");
  const hasCode = ["code-path", "code-start", "code-end"].some(key => options.has(key));
  if (remove ? hasCode : !hasCode) fail("Use --remove or --code-path with --code-start to set a target.");
  updateStage(workspace, id, finalized, stage => {
    const item = stageItems(stage, collection).find(value => value.id === itemId);
    if (!item) fail(`Stage ${id} has no ${collection} item ${itemId}.`);
    if (remove) delete item.codeTarget;
    else {
      const codeTarget = recordedCodeTarget(workspace, stage, options, item);
      if (codeTarget) item.codeTarget = codeTarget;
    }
    return stage;
  });
  console.log(`${remove ? "Removed" : "Set"} code target for ${collection}/${itemId}.`);
}

function recordStageItem(workspace: Workspace, options: Options, batch: StageBatch | undefined = undefined): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage record"),
  );
  const finalized = flag(options, "finalized");
  const requestedStage = option(options, "stage");
  const explicitId = finalized ? explicitStageId(requestedStage, "stage") : undefined;
  const stageId = explicitId
    ?? selectedWorkingStageId(batch?.artifact ?? validateArtifact(workspace, { quiet: true, validateGit: false }), requestedStage, "stage");
  const kind = option(options, "kind", { required: true });
  const item = itemForKind(kind, options);
  const itemId = option(options, "item-id", { required: true });
  const nodeRefs = repeatedOption(options, "node-ref");
  if (nodeRefs.length > 0) {
    item.value.nodeRefs = nodeRefs;
  }
  item.allowed.push("node-ref", "code-path", "code-start", "code-end");
  const replace = flag(options, "replace");
  assertKnownOptions(
    options,
    new Set([
      "stage",
      "kind",
      "item-id",
      "replace",
      "finalized",
      ...item.allowed,
    ]),
  );

  updateStage(workspace, stageId, finalized, (stage) => {
    const index = stageItems(stage, item.collection).findIndex(
      (existing) => existing.id === itemId,
    );
    if (index >= 0 && !replace) {
      fail(
        `Working stage ${stageId} already has ${item.collection} item ${itemId}.`,
      );
    }
    if (index < 0 && replace) {
      fail(
        `Working stage ${stageId} has no ${item.collection} item ${itemId} to replace.`,
      );
    }
    return storeRecordedItem(workspace, stage, options, item.collection, index, item.value);
  }, batch);
  if (!batch) console.log(
    `${replace ? "Replaced" : "Recorded"} ${kind} ${itemId} for ${finalized ? "finalized " : ""}${stageId}.`,
  );
}

function recordValidation(workspace: Workspace, options: Options, batch: StageBatch | undefined = undefined): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage validation"),
  );
  const finalized = flag(options, "finalized");
  const requestedStage = option(options, "stage");
  const explicitId = finalized ? explicitStageId(requestedStage, "stage") : undefined;
  const stageId = explicitId
    ?? selectedWorkingStageId(batch?.artifact ?? validateArtifact(workspace, { quiet: true, validateGit: false }), requestedStage, "stage");
  const replace = flag(options, "replace");
  const itemId = option(options, "item-id", { required: true });
  const value: JsonRecord = {
    id: itemId,
    type: option(options, "type", { required: true }),
    status: option(options, "status", { required: true }),
    summary: option(options, "summary", { required: true }),
  };
  const command = option(options, "command");
  if (command !== undefined) {
    value.command = command;
  }
  const nodeRefs = repeatedOption(options, "node-ref");
  if (nodeRefs.length > 0) {
    value.nodeRefs = nodeRefs;
  }

  updateStage(workspace, stageId, finalized, (stage) => {
    const index = stage.validation.findIndex(
      (existing) => existing.id === itemId,
    );
    if (index >= 0 && !replace) {
      fail(
        `Working stage ${stageId} already has validation evidence ${itemId}.`,
      );
    }
    if (index < 0 && replace) {
      fail(
        `Working stage ${stageId} has no validation evidence ${itemId} to replace.`,
      );
    }
    return storeRecordedItem(workspace, stage, options, "validation", index, value);
  }, batch);
  if (!batch) console.log(
    `${replace ? "Replaced" : "Recorded"} validation evidence ${itemId} for ${finalized ? "finalized " : ""}${stageId}.`,
  );
}

interface SelectedStage {
  id: string;
  stage: EditableStage;
  finalized: boolean;
  branch: string;
}

// Evidence must show the committed stage head, so capture on the stage branch
// with nothing uncommitted; the files themselves stay out of every stage diff.
function evidenceStage(workspace: Workspace, options: Options, command: string): SelectedStage {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, command));
  const finalized = flag(options, "finalized");
  const requested = option(options, "stage");
  const explicitId = finalized ? explicitStageId(requested, "stage") : undefined;
  const artifact = validateArtifact(workspace, { quiet: true, validateGit: false });
  const id = explicitId ?? selectedWorkingStageId(artifact, requested, "stage");
  const stage = finalized ? artifact.stages.get(id) : artifact.workStages.get(id);
  if (!stage) fail(`Stage ${id} does not exist.`);
  assertEvidenceDirectories(workspace.snapshot, id);
  return { id, stage, finalized, branch: stageBranch(stage) };
}

/** Removes the stored captures of a stage that no evidence entry references. */
function pruneEvidenceFiles(draft: ArtifactDraft, stage: EditableStage): void {
  assertEvidenceDirectories(draft, stage.id);
  const referenced = new Set(stage.evidence.flatMap((item) => (item.attachments ?? []).map((attachment) => attachment.path)));
  for (const file of draft.list(`evidence/${stage.id}`)) {
    if (!referenced.has(file)) draft.remove(file);
  }
}

type EvidenceRole = "before" | "after";

/** A file to attach; its attachment record is validated with the stage. */
interface EvidenceInput {
  bytes: Buffer;
  extension: string;
  attachment: { mediaType: string; sha256: string; caption?: string; role?: EvidenceRole };
}

function evidenceInputs(options: Options): EvidenceInput[] {
  const named: { value: string; role: EvidenceRole | undefined }[] = [
    ...repeatedOption(options, "before").map((value) => ({ value, role: "before" as const })),
    ...repeatedOption(options, "after").map((value) => ({ value, role: "after" as const })),
    ...repeatedOption(options, "file").map((value) => ({ value, role: undefined })),
  ];
  return named.map(({ value, role }) => {
    // An existing path wins, so a path containing = still works without a caption.
    const separator = fs.existsSync(value) ? -1 : value.indexOf("=");
    const source = separator < 0 ? value : value.slice(0, separator);
    const caption = separator < 0 ? undefined : value.slice(separator + 1);
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (!stat?.isFile()) fail(`Evidence file ${source} does not exist.`);
    if (stat.size > MAX_EVIDENCE_ATTACHMENT_BYTES) fail(`Evidence file ${source} is larger than 25 MiB.`);
    const { extension, mediaType } = evidenceMediaType(source);
    const bytes = fs.readFileSync(source);
    return { bytes, extension, attachment: { mediaType, sha256: sha256Hex(bytes), ...(caption ? { caption } : {}), ...(role ? { role } : {}) } };
  });
}

// Recording writes files before saving and prunes after, so concurrent evidence
// edits must not interleave: one's rollback could delete the other's capture.
function withEvidenceLock<T>(workspace: Workspace, write: () => T): T {
  const manifest = parseDocument(MANIFEST_SCHEMA_ID, readArtifactJson(workspace.snapshot, "manifest.json"), workspace.snapshot.describe("manifest.json"));
  return withArtifactLock(workspace, manifest.implementationId, write);
}

function recordEvidence(workspace: Workspace, options: Options): void {
  withEvidenceLock(workspace, () => writeEvidence(workspace, options));
}

function writeEvidence(workspace: Workspace, options: Options): void {
  const { id, finalized, branch } = evidenceStage(workspace, options, "stage evidence");
  if (currentBranch(workspace.root) !== branch) fail(`Recording evidence for ${id} requires checked-out stage branch ${branch}.`);
  assertCleanWorkingTree(workspace.root, "Recording evidence");
  const replace = flag(options, "replace");
  const inputs = evidenceInputs(options);
  const inline = option(options, "inline");
  if (!inputs.length && inline === undefined) fail("Evidence requires --file, --before, --after or --inline.");
  const specificationRefs = repeatedOption(options, "specification-ref");
  const nodeRefs = repeatedOption(options, "node-ref");
  const reproduction = option(options, "reproduction");
  const itemId = option(options, "item-id", { required: true });
  const value: JsonRecord = {
    id: itemId,
    kind: option(options, "kind", { required: true }),
    summary: option(options, "summary", { required: true }),
    ...(specificationRefs.length ? { specificationRefs } : {}),
    ...(inputs.length ? { attachments: inputs.map(({ attachment, extension }) => ({ path: evidenceAttachmentPath(id, attachment.sha256, extension), ...attachment })) } : {}),
    ...(inline !== undefined ? { inline } : {}),
    capturedAt: new Date().toISOString(),
    ...(reproduction !== undefined ? { reproduction } : {}),
    ...(nodeRefs.length ? { nodeRefs } : {}),
  };
  const draft = new ArtifactDraft(workspace.snapshot);
  if (inputs.length) ensureEvidenceAttributes(draft);
  for (const input of inputs) {
    const file = `evidence/${id}/${input.attachment.sha256}.${input.extension}`;
    // A file left damaged by an earlier crash is rewritten, not trusted for its name.
    if (draft.type(file) === "file" && sha256Hex(draft.read(file)) === input.attachment.sha256) continue;
    draft.write(file, input.bytes);
  }
  const updated = updateStage(workspace, id, finalized, (current) => {
    const index = current.evidence.findIndex((existing) => existing.id === itemId);
    if (index >= 0 && !replace) fail(`Stage ${id} already has evidence ${itemId}.`);
    if (index < 0 && replace) fail(`Stage ${id} has no evidence ${itemId} to replace.`);
    return storeRecordedItem(workspace, current, options, "evidence", index, value);
  }, undefined, draft);
  pruneEvidenceFiles(draft, updated);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  console.log(`${replace ? "Replaced" : "Recorded"} evidence ${itemId} for ${finalized ? "finalized " : ""}${id}.`);
}

function removeEvidence(workspace: Workspace, options: Options): void {
  withEvidenceLock(workspace, () => deleteEvidence(workspace, options));
}

function deleteEvidence(workspace: Workspace, options: Options): void {
  const { id, finalized } = evidenceStage(workspace, options, "stage evidence-remove");
  const itemId = option(options, "item-id", { required: true });
  const draft = new ArtifactDraft(workspace.snapshot);
  const updated = updateStage(workspace, id, finalized, (current) => {
    const index = current.evidence.findIndex((existing) => existing.id === itemId);
    if (index < 0) fail(`Stage ${id} has no evidence ${itemId}.`);
    current.evidence.splice(index, 1);
    return current;
  }, undefined, draft);
  pruneEvidenceFiles(draft, updated);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  console.log(`Removed evidence ${itemId} from ${finalized ? "finalized " : ""}${id}.`);
}

function recordNoEvidence(workspace: Workspace, options: Options): void {
  const { id, finalized } = evidenceStage(workspace, options, "stage no-evidence");
  const remove = flag(options, "remove");
  const reason = option(options, "reason");
  if (remove === (reason !== undefined)) fail("Use either --reason or --remove.");
  updateStage(workspace, id, finalized, (current) => {
    if (remove) delete current.noEvidenceReason;
    else current.noEvidenceReason = reason;
    return current;
  });
  console.log(`${remove ? "Removed the reason for having no evidence from" : "Recorded why there is no evidence for"} ${id}.`);
}

function recordStageBatch(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "stage record-batch"));
  const artifact = validateArtifact(workspace, { quiet: true, validateGit: false });
  const finalized = flag(options, "finalized");
  const requested = option(options, "stage");
  const id = finalized ? explicitStageId(requested, "stage") : selectedWorkingStageId(artifact, requested, "stage");
  const stage = finalized ? artifact.stages.get(id) : artifact.workStages.get(id);
  if (!stage) fail(`Stage ${id} does not exist.`);
  const items: unknown = parseJson(option(options, "items", { required: true }));
  if (!Array.isArray(items) || !items.length) fail("--items must be a non-empty JSON array.");
  // Each entry is narrowed to options by objectOptions and validated with the stage.
  const entries: unknown[] = items;
  const batch: StageBatch = { artifact, finalized, stage: structuredClone(stage) };
  for (const item of entries) {
    const input = objectOptions(item);
    if (input.has("stage") || input.has("finalized")) fail("Set the batch stage and finalized flag outside items.");
    input.set("stage", [id]);
    if (finalized) input.set("finalized", [true]);
    if (option(input, "kind") === "validation") {
      input.delete("kind");
      recordValidation(workspace, input, batch);
    } else recordStageItem(workspace, input, batch);
  }
  const draft = new ArtifactDraft(workspace.snapshot);
  draft.writeJson(stageFile(stage), batch.stage);
  validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  console.log(JSON.stringify({ stageId: id, recorded: entries.length }));
}

function organizationPlan(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "stage plan"));
  const artifact = validateArtifact(workspace, { quiet: true, validateGit: false });
  const finalized = flag(options, "finalized");
  const requested = option(options, "stage");
  const id = finalized ? explicitStageId(requested, "stage") : selectedWorkingStageId(artifact, requested, "stage");
  const stage = finalized ? artifact.stages.get(id) : artifact.workStages.get(id);
  if (!stage) fail(`Stage ${id} does not exist.`);
  const branch = stageBranch(stage);
  if (currentBranch(workspace.root) !== branch) fail(`Planning ${id} requires checked-out stage branch ${branch}.`);
  const base = stage.$schema === STAGE_SCHEMA_ID ? stage.change.baseRevision : stackTip(artifact);
  const head = branchCommit(workspace.root, branch);
  assertLinearRange(workspace.root, base, head, `Stage ${id}`);
  const selectors = flag(options, "selectors");
  const files = changedFiles(workspace.root, base, head).map((file) => ({
    ...file,
    ...(selectors ? { selectors: diffChangeShape(workspace.root, base, head, file) } : {}),
  }));
  const unlinkedItems = STAGE_ITEM_COLLECTIONS.flatMap((collection) => stageItems(stage, collection)
    .filter((item) => !item.nodeRefs?.length)
    .map((item) => ({ collection, itemId: item.id })));
  console.log(JSON.stringify({ stageId: id, branch, baseRevision: base, headRevision: head, files, unlinkedItems, evidenceWarnings: evidenceWarnings(stage) }));
}

function applyOrganization(stage: EditableStage, organization: StageOrganization): void {
  const links = new Map<string, string[]>();
  for (const link of organization.itemLinks) {
    const key = `${link.collection}\0${link.itemId}`;
    if (links.has(key)) {
      fail(
        `Stage organization repeats link ${link.collection}/${link.itemId}.`,
      );
    }
    links.set(key, link.nodeRefs);
  }

  for (const collection of STAGE_ITEM_COLLECTIONS) {
    for (const item of stageItems(stage, collection)) {
      const key = `${collection}\0${item.id}`;
      const nodeRefs = links.get(key);
      if (!nodeRefs) {
        fail(
          `Stage organization has no link for ${collection}/${item.id}.`,
        );
      }
      item.nodeRefs = nodeRefs;
      links.delete(key);
    }
  }
  if (links.size > 0) {
    const [key] = links.keys();
    const [collection, itemId] = key.split("\0");
    fail(`Stage organization links missing item ${collection}/${itemId}.`);
  }
  stage.nodes = organization.nodes;
}

function organizeStage(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage organize"),
  );
  const finalized = flag(options, "finalized");
  const requestedStage = option(options, "stage");
  const explicitId = finalized ? explicitStageId(requestedStage, "stage") : undefined;
  const inputFile = path.resolve(
    workspace.root,
    option(options, "file", { required: true }),
  );
  const organization = parseDocument(STAGE_ORGANIZATION_SCHEMA_ID, readJson(inputFile), inputFile);

  const artifact = validateArtifact(workspace, {
    quiet: true,
    validateGit: false,
  });
  const stageId = explicitId ?? selectedWorkingStageId(artifact, requestedStage, "stage");
  const stage = finalized
    ? artifact.stages.get(stageId)
    : artifact.workStages.get(stageId);
  if (!stage) {
    fail(`${finalized ? "Finalized" : "Working"} stage ${stageId} does not exist.`);
  }

  const updated = structuredClone(stage);
  let baseRevision: string;
  let headRevision: string;
  let files: FileChange[];
  let finalizedStageMoved = false;
  if (updated.$schema === STAGE_SCHEMA_ID) {
    const { change } = updated;
    baseRevision = change.baseRevision;
    headRevision = branchCommit(workspace.root, change.branch);
    if (
      currentBranch(workspace.root) !== change.branch ||
      commitObject(workspace.root, "HEAD") !== headRevision
    ) {
      fail(`Organizing ${stageId} requires checked-out stage branch ${change.branch}.`);
    }
    assertLinearRange(workspace.root, baseRevision, headRevision, `Stage ${stageId}`);
    files = changedFiles(workspace.root, baseRevision, headRevision);
    finalizedStageMoved = headRevision !== change.headRevision;
    if (finalizedStageMoved) {
      change.headRevision = headRevision;
      change.files = files;
    }
  } else {
    baseRevision = stackTip(artifact);
    headRevision = branchCommit(workspace.root, updated.branch);
    if (currentBranch(workspace.root) !== updated.branch || commitObject(workspace.root, "HEAD") !== headRevision) {
      fail(`Organizing ${stageId} requires checked-out stage branch ${updated.branch}.`);
    }
    assertLinearRange(workspace.root, baseRevision, headRevision, `Stage ${stageId}`);
    files = changedFiles(workspace.root, baseRevision, headRevision);
  }

  applyOrganization(updated, organization);
  const errors = stageNodeErrors(updated, files, {
    root: workspace.root,
    baseRevision,
    headRevision,
  });
  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  const draft = new ArtifactDraft(workspace.snapshot);
  draft.writeJson(stageFile(stage), updated);
  validateArtifact(workspace, {
    quiet: true,
    validateGit: finalized && !finalizedStageMoved,
  }, draft);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  console.log(
    `Organized ${finalized ? "finalized " : ""}stage ${stageId} into ${updated.nodes.length} node(s).`,
  );
}

/** The finalized form of a working stage. Finalized stages link every item to
 * nodes, so the document is validated here; errors name the stage file, as
 * validating the saved file would. */
function canonicalStage(
  workStage: WorkStage,
  change: StageChange,
  file: string,
): Stage {
  return parseDocument(STAGE_SCHEMA_ID, {
    $schema: STAGE_SCHEMA_ID,
    id: workStage.id,
    title: workStage.title,
    summary: workStage.summary,
    dependsOn: workStage.dependsOn,
    specificationRefs: workStage.specificationRefs,
    nodes: workStage.nodes,
    change,
    rationale: workStage.rationale,
    decisions: workStage.decisions,
    assumptions: workStage.assumptions,
    alternatives: workStage.alternatives,
    failedAttempts: workStage.failedAttempts,
    risks: workStage.risks,
    validation: workStage.validation,
    evidence: workStage.evidence,
    ...(workStage.noEvidenceReason ? { noEvidenceReason: workStage.noEvidenceReason } : {}),
    openQuestions: workStage.openQuestions,
  }, file);
}

function finishStage(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage finish"),
  );
  const artifact = validateArtifact(workspace, { quiet: true });
  assertCleanWorkingTree(workspace.root, "Finalizing a stage");
  const id = selectedWorkingStageId(artifact, option(options, "id"), "id");
  const { file: workFile, stage: workStage } = workingStage(artifact, id);
  if (artifact.stages.has(id)) {
    fail(`Stage ${id} is already finalized.`);
  }

  const branch = currentBranch(workspace.root);
  if (branch !== workStage.branch) {
    fail(
      `Finalizing ${id} requires checked-out stage branch ${workStage.branch}, not ${branch ?? "detached HEAD"}.`,
    );
  }
  const headRevision = branchCommit(workspace.root, workStage.branch);
  if (commitObject(workspace.root, "HEAD") !== headRevision) {
    fail(`HEAD does not match stage branch ${workStage.branch}.`);
  }
  const previousId = artifact.manifest.stages.at(-1);
  const baseBranch = previousId
    ? finalizedStage(artifact, previousId).change.branch
    : artifact.manifest.targetBranch;
  const baseRevision = stackTip(artifact);
  assertLinearRange(workspace.root, baseRevision, headRevision, `Stage ${id}`);
  const files = changedFiles(workspace.root, baseRevision, headRevision);
  const canonicalFile = `stages/${id}.json`;
  const stage = canonicalStage(
    workStage,
    { branch: workStage.branch, baseBranch, baseRevision, headRevision, files },
    workspace.snapshot.describe(canonicalFile),
  );
  artifact.manifest.stages.push(id);

  const draft = new ArtifactDraft(workspace.snapshot);
  draft.writeJson(canonicalFile, stage);
  draft.writeJson("manifest.json", artifact.manifest);
  draft.remove(workFile);
  validateArtifact(workspace, { quiet: true }, draft);
  commitArtifact(workspace.root, workspace.snapshot, draft);
  reportEvidenceWarnings([stage]);
  if (flag(options, "json")) console.log(JSON.stringify({ worktree: workspace.root, stageId: id, branch: workStage.branch, baseRevision, headRevision, next: "stage begin or review" }));
  else console.log(`Finalized stage ${id} on ${workStage.branch} at ${headRevision}.`);
}

function discardStage(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "stage discard"),
  );
  const artifact = validateArtifact(workspace, {
    quiet: true,
    validateGit: false,
  });
  const id = selectedWorkingStageId(artifact, option(options, "id"), "id");
  const { file, stage } = workingStage(artifact, id);
  const branch = stage.branch;
  const creationParent = stackTip(artifact);

  const branchHead = gitOptional(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: workspace.root,
  });
  let branchNote = "";
  let removeBranch = false;
  if (branchHead) {
    if (branchHead !== creationParent) {
      branchNote = ` Branch ${branch} has local commits and was kept; delete it manually before reusing the ordinal.`;
    } else if (
      checkedOutBranches(workspace.root).has(branch) &&
      currentBranch(workspace.root) !== branch
    ) {
      branchNote = ` Branch ${branch} is checked out in another worktree and was kept; remove that worktree or delete the branch manually before reusing the ordinal.`;
    } else {
      removeBranch = true;
    }
  }

  const draft = new ArtifactDraft(workspace.snapshot);
  draft.remove(file);
  draft.remove(`evidence/${id}`);
  validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
  const wasCurrent = removeBranch && currentBranch(workspace.root) === branch;
  if (wasCurrent) {
    git(["switch", "--detach", creationParent], { cwd: workspace.root });
  }
  if (removeBranch) {
    git(["branch", "-D", branch], { cwd: workspace.root });
    branchNote = ` Removed unchanged branch ${branch}.`;
  }
  try {
    commitArtifact(workspace.root, workspace.snapshot, draft);
  } catch (error) {
    if (removeBranch) git(["branch", branch, creationParent], { cwd: workspace.root, allowFailure: true });
    if (wasCurrent) git(["switch", branch], { cwd: workspace.root, allowFailure: true });
    throw error;
  }
  console.log(`Discarded working stage ${id}.${branchNote}`);
}

interface CommitMetadata {
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

function commitMetadata(root: string, commit: string): CommitMetadata {
  const [
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    message,
  ] = gitRaw(
    [
      "show",
      "-s",
      "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
      commit,
    ],
    { cwd: root },
  ).split("\0");
  return {
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    message,
  };
}

class PatchConflictError extends Error {}

interface CommitPatch {
  root: string;
  indexFile: string;
  baseTree: string;
  patchParent: string;
  patchCommit: string;
  metadataCommit: string;
  newParent: string;
}

function applyCommitPatch({
  root,
  indexFile,
  baseTree,
  patchParent,
  patchCommit,
  metadataCommit,
  newParent,
}: CommitPatch): string {
  fs.rmSync(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  gitRaw(["read-tree", baseTree], { cwd: root, env });
  const patch = gitRawBuffer(
    [
      "diff",
      "--binary",
      "--full-index",
      "--find-renames=50%",
      patchParent,
      patchCommit,
      "--",
    ],
    { cwd: root },
  );
  if (patch.length === 0) {
    fail(`Commit ${patchCommit} has no patch to apply.`);
  }
  try {
    gitRaw(["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], {
      cwd: root,
      env,
      input: patch,
      encoding: "buffer",
    });
  } catch (error) {
    const unmerged = gitRaw(["ls-files", "-u"], { cwd: root, env });
    if (unmerged) {
      throw new PatchConflictError(errorMessage(error));
    }
    throw error;
  }
  const tree = gitRaw(["write-tree"], { cwd: root, env });
  const metadata = commitMetadata(root, metadataCommit);
  return gitRaw(["commit-tree", tree, "-p", newParent], {
    cwd: root,
    input: metadata.message,
    env: {
      GIT_AUTHOR_NAME: metadata.authorName,
      GIT_AUTHOR_EMAIL: metadata.authorEmail,
      GIT_AUTHOR_DATE: metadata.authorDate,
      GIT_COMMITTER_NAME: metadata.committerName,
      GIT_COMMITTER_EMAIL: metadata.committerEmail,
      GIT_COMMITTER_DATE: metadata.committerDate,
    },
  });
}

function replayRange(
  root: string,
  indexFile: string,
  oldBase: string,
  oldHead: string,
  newBase: string,
  label: string,
): string {
  assertLinearRange(root, oldBase, oldHead, label);
  return applyCommitPatch({
    root,
    indexFile,
    baseTree: newBase,
    patchParent: oldBase,
    patchCommit: oldHead,
    metadataCommit: oldHead,
    newParent: newBase,
  });
}

/** Holds the review lock across a multi-document artifact write and renews a running feedback round. */
function withArtifactLock<T>(workspace: Workspace, implementationId: string, write: () => T): T {
  const review = reviewId(workspace.root, implementationId);
  return withReviewLock(review, () => {
    const result = write();
    updateAgentState(review, (state, now) => touchAgent(state, now));
    return result;
  });
}

interface RestackPlan {
  id: string;
  stage: Stage;
  branch: string;
  previousHead: string;
  nextHead: string;
  baseBranch: string;
  baseRevision: string;
}

/** What a restack changed, as `implementation restack --json` prints it. */
export interface RestackSummary {
  mode: "base" | "stage";
  fromStage: string | null;
  targetBranch: string;
  baseRevision: string;
  refreshedStages: number;
  rewrittenBranches: number;
  stages: Array<{
    id: string;
    branch: string;
    previousHead: string;
    nextHead: string;
    baseBranch: string;
    baseRevision: string;
    rewritten: boolean;
  }>;
}

function restack(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "restack"));
  const fromId = option(options, "from");
  const baseOption = option(options, "base");
  // Reject a malformed --json before the restack rewrites any refs.
  const json = flag(options, "json");
  const summary = restackStages(workspace, { fromId, baseOption });
  if (json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(
      `Restacked ${summary.refreshedStages} stage(s) ${
        baseOption
          ? `onto ${summary.targetBranch}`
          : `from ${fromId}`
      }; rewrote ${summary.rewrittenBranches} ${
        summary.rewrittenBranches === 1 ? "branch" : "branches"
      }.`,
    );
  }
}

/** Restacks every stage onto the current target branch head. */
export function restackOntoTarget(root: string, base: string): RestackSummary {
  return withValidationContext(() => restackStages(openWorkspace(root), { baseOption: base }));
}

function restackStages(
  workspace: Workspace,
  { fromId, baseOption }: { fromId?: string; baseOption?: string },
): RestackSummary {
  assertCleanWorkingTree(workspace.root, "Restacking");
  const artifact = validateArtifact(workspace, {
    schemaOnly: true,
    quiet: true,
  });
  if (artifact.workStages.size > 0) {
    fail("Restacking requires every stage to be finalized.");
  }

  if (!fromId && !baseOption) {
    fail("restack requires --from <stage-id> or --base <revision>.");
  }
  if (fromId && baseOption) {
    fail("restack accepts either --from or --base, not both.");
  }
  const fromIndex = fromId
    ? artifact.manifest.stages.indexOf(fromId)
    : artifact.manifest.stages.length;
  if (fromId && fromIndex < 0) {
    fail(`Stage ${fromId} does not exist.`);
  }
  if (fromId) {
    const branch = finalizedStage(artifact, fromId).change.branch;
    if (currentBranch(workspace.root) !== branch) {
      fail(
        `Restacking from ${fromId} requires checked-out stage branch ${branch}.`,
      );
    }
  }
  const startIndex = baseOption ? 0 : fromIndex;
  const newBase = baseOption
    ? commitObject(workspace.root, baseOption)
    : artifact.manifest.baseRevision;
  if (baseOption) {
    const targetHead = branchCommit(workspace.root, artifact.manifest.targetBranch);
    if (newBase !== targetHead) {
      fail(
        `New base ${newBase} must equal target branch ${artifact.manifest.targetBranch} head ${targetHead}.`,
      );
    }
  }

  const indexFile = path.join(
    os.tmpdir(),
    `semantic-implementation-restack-${process.pid}-${Date.now()}.index`,
  );
  const plans: RestackPlan[] = [];
  let parentBranch = artifact.manifest.targetBranch;
  let parentHead = newBase;

  try {
    for (const [index, id] of artifact.manifest.stages.entries()) {
      const stage = finalizedStage(artifact, id);
      const actualHead = branchCommit(workspace.root, stage.change.branch);
      if (index < startIndex) {
        if (actualHead !== stage.change.headRevision) {
          fail(
            `Stage ${id} moved before the requested restack range; start from ${id}.`,
          );
        }
        parentBranch = stage.change.branch;
        parentHead = actualHead;
        continue;
      }

      let nextHead: string;
      if (isAncestor(workspace.root, parentHead, actualHead)) {
        assertLinearRange(workspace.root, parentHead, actualHead, `Stage ${id}`);
        nextHead = actualHead;
      } else {
        try {
          nextHead = replayRange(
            workspace.root,
            indexFile,
            stage.change.baseRevision,
            actualHead,
            parentHead,
            `Stage ${id}`,
          );
        } catch (error) {
          if (!(error instanceof PatchConflictError)) throw error;
          const detail = error.message;
          fail(
            [
              `Restacking stage ${id} onto ${parentHead} failed.`,
              "No stage refs or artifacts were changed.",
              `Conflict context: stage base ${stage.change.baseRevision}, stage head ${actualHead}, new parent ${parentHead}.`,
              detail,
            ].join("\n"),
          );
        }
      }
      plans.push({
        id,
        stage,
        branch: stage.change.branch,
        previousHead: actualHead,
        nextHead,
        baseBranch: parentBranch,
        baseRevision: parentHead,
      });
      parentBranch = stage.change.branch;
      parentHead = nextHead;
    }

    const branchUpdates = plans.filter(({ previousHead, nextHead }) => previousHead !== nextHead);
    const refUpdates = branchUpdates.map(({ branch, previousHead, nextHead }): RefUpdate => ({
      ref: `refs/heads/${branch}`,
      previous: previousHead,
      next: nextHead,
    }));
    const checkedOut = checkedOutBranches(workspace.root);
    const checkedOutUpdates = branchUpdates
      .map(({ branch }) => branch)
      .filter((branch) => checkedOut.has(branch));
    if (checkedOutUpdates.length > 0) {
      fail(
        `Cannot move branch(es) checked out in a worktree: ${checkedOutUpdates.join(", ")}.`,
      );
    }
    if (
      baseOption &&
      branchCommit(workspace.root, artifact.manifest.targetBranch) !== newBase
    ) {
      fail(
        `Target branch ${artifact.manifest.targetBranch} moved during restacking; retry from its new head.`,
      );
    }
    // Diff and validate outside the lock; readers take it, so the viewer never sees a partly restacked stack.
    artifact.manifest.baseRevision = newBase;
    const draft = new ArtifactDraft(workspace.snapshot);
    for (const plan of plans) {
      plan.stage.change = {
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        baseRevision: plan.baseRevision,
        headRevision: plan.nextHead,
        files: changedFiles(workspace.root, plan.baseRevision, plan.nextHead),
      };
      draft.writeJson(`stages/${plan.id}.json`, plan.stage);
    }
    draft.writeJson("manifest.json", artifact.manifest);
    validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
    withArtifactLock(workspace, artifact.manifest.implementationId, () => {
      commitArtifact(workspace.root, workspace.snapshot, draft, refUpdates);
    });

    return {
      mode: baseOption ? "base" : "stage",
      fromStage: fromId ?? null,
      targetBranch: artifact.manifest.targetBranch,
      baseRevision: newBase,
      refreshedStages: plans.length,
      rewrittenBranches: refUpdates.length,
      stages: plans.map((plan) => ({
        id: plan.id,
        branch: plan.branch,
        previousHead: plan.previousHead,
        nextHead: plan.nextHead,
        baseBranch: plan.baseBranch,
        baseRevision: plan.baseRevision,
        rewritten: plan.previousHead !== plan.nextHead,
      })),
    };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

function repairArtifact(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "repair"));
  const files = workspace.snapshot;
  const manifest = parseDocument(MANIFEST_SCHEMA_ID, readArtifactJson(files, "manifest.json"), files.describe("manifest.json"));
  const removals: string[] = [];
  const ambiguous: string[] = [];

  for (const id of listJsonIds(files, "requirements")) {
    if (!manifest.requirements.includes(id)) {
      removals.push(`requirements/${id}.json`);
    }
  }

  for (const id of listJsonIds(files, "stages")) {
    if (!manifest.stages.includes(id)) {
      if (hasFile(files, `.work/stages/${id}.json`)) {
        removals.push(`stages/${id}.json`);
      } else {
        ambiguous.push(`stages/${id}.json`);
      }
    }
  }

  for (const id of manifest.stages) {
    if (!hasFile(files, `stages/${id}.json`)) {
      ambiguous.push(`stages/${id}.json`);
    } else if (hasFile(files, `.work/stages/${id}.json`)) {
      removals.push(`.work/stages/${id}.json`);
    }
  }

  for (const id of manifest.requirements) {
    if (!hasFile(files, `requirements/${id}.json`)) {
      ambiguous.push(`requirements/${id}.json`);
    }
  }

  if (ambiguous.length > 0) {
    fail(
      `Repair is ambiguous for: ${ambiguous.join(", ")}. Restore these files from source control or the interrupted process before retrying.`,
    );
  }
  if (removals.length === 0) {
    validateArtifact(workspace, { quiet: true, validateGit: false });
    console.log("No interrupted artifact mutation was found.");
    return;
  }

  const draft = new ArtifactDraft(files);
  for (const file of removals) draft.remove(file);
  validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
  commitArtifact(workspace.root, files, draft);
  console.log(`Repaired ${removals.length} interrupted artifact write(s).`);
}

function changedPathNames(root: string, from: string, to: string): string[] {
  const output = git(["diff", "--name-only", from, to, "--"], { cwd: root });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function lastStageHead(artifact: Artifact): string {
  const lastStageId = artifact.manifest.stages.at(-1);
  if (!lastStageId) {
    fail("The implementation has no finalized stages.");
  }
  return finalizedStage(artifact, lastStageId).change.headRevision;
}

function metadataBranch(artifact: Artifact): string {
  return `${artifact.manifest.branchPrefix}/metadata`;
}

function preparedBranchRefPrefix(artifact: Artifact): string {
  return `refs/semantic-review/prepared/${artifact.manifest.implementationId}/`;
}

function preparedBranchRef(artifact: Artifact, branch: string): string {
  const encodedBranch = Buffer.from(branch, "utf8").toString("base64url");
  return `${preparedBranchRefPrefix(artifact)}${encodedBranch}`;
}

/** The cumulative branch an implementation is bound to, and the head it was prepared at. */
interface PreparedBinding {
  branch: string;
  head: string;
  ref: string;
}

function preparedBranchBinding(root: string, artifact: Artifact): PreparedBinding | undefined {
  const prefix = preparedBranchRefPrefix(artifact);
  const output = git(
    ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
    { cwd: root },
  );
  if (!output) return undefined;
  const bindings = output.split(/\r?\n/).map((line): PreparedBinding => {
    const separator = line.indexOf(" ");
    if (separator < 0) {
      fail(`Prepared branch state contains malformed ref output: ${line}.`);
    }
    const ref = line.slice(0, separator);
    const encodedBranch = ref.slice(prefix.length);
    const branch = Buffer.from(encodedBranch, "base64url").toString("utf8");
    if (
      !branch ||
      Buffer.from(branch, "utf8").toString("base64url") !== encodedBranch
    ) {
      fail(`Prepared branch state contains invalid ref ${ref}.`);
    }
    const object = line.slice(separator + 1);
    if (!/^[0-9a-f]{40}$/.test(object)) {
      fail(`Prepared branch state ${ref} does not point to a commit.`);
    }
    const head = commitObject(root, ref);
    if (head !== object) {
      fail(`Prepared branch state ${ref} must point directly to a commit.`);
    }
    return { branch, head, ref };
  });
  if (bindings.length > 1) {
    fail(
      `Implementation ${artifact.manifest.implementationId} has multiple cumulative branch bindings: ${bindings.map(({ branch }) => branch).join(", ")}.`,
    );
  }
  return bindings[0];
}

function buildMetadataCommit(workspace: Workspace, parent: string, message: string): { commit: string; tree: string } {
  const tree = buildArtifactTree(workspace.root, workspace.snapshot, parent);
  const commit = gitRaw(["commit-tree", tree, "-p", parent], {
    cwd: workspace.root,
    input: `${message}\n`,
  });
  return { commit, tree };
}

// Reuse expensive immutable validation, but re-read documents and refs before
// each mutation in a combined workflow. A prior success never validates edits.
function assertValidatedArtifactCurrent(workspace: Workspace, artifact: Artifact, allowLandedTarget = false): void {
  const changed = "Semantic implementation changed during the workflow; retry after the current edit completes.";
  if (readArtifact(workspace.root)?.version !== workspace.snapshot.version) fail(changed);
  const expected = new Map<string, string>([[artifact.manifest.targetBranch, artifact.manifest.baseRevision]]);
  for (const stage of artifact.stages.values()) expected.set(stage.change.branch, stage.change.headRevision);
  const refs = git(["for-each-ref", "--format=%(refname:strip=2) %(objectname)", ...[...expected.keys()].map((branch) => `refs/heads/${branch}`)], { cwd: workspace.root });
  // Branch names contain no spaces, so the first space separates name and object.
  const actual = new Map(refs.split("\n").filter(Boolean).map((line): [string, string] => {
    const [name = "", object = ""] = line.split(" ");
    return [name, object];
  }));
  for (const [branch, head] of expected) {
    const actualHead = actual.get(branch);
    if (actualHead === head) continue;
    if (allowLandedTarget && branch === artifact.manifest.targetBranch && actualHead !== undefined && isAncestor(workspace.root, lastStageHead(artifact), actualHead)) continue;
    fail(`Branch ${branch} changed during the workflow; validate the current stack before retrying.`);
  }
}

interface MetadataPublication {
  branch: string;
  commit: string;
  update: RefUpdate | undefined;
}

function metadataPublicationPlan(workspace: Workspace, artifact: Artifact, message: string): MetadataPublication {
  const stageTip = lastStageHead(artifact);
  const branch = metadataBranch(artifact);
  git(["check-ref-format", "--branch", branch], { cwd: workspace.root });
  const publication = buildMetadataCommit(workspace, stageTip, message);
  const existing = gitOptional(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: workspace.root,
  });
  if (existing) {
    const existingTree = git(["show", "-s", "--format=%T", existing], {
      cwd: workspace.root,
    });
    const parents = commitParents(workspace.root, existing);
    if (parents.length === 1 && parents[0] === stageTip && existingTree === publication.tree) {
      return { branch, commit: existing, update: undefined };
    }
    const pathsChanged = parents.length === 1
      ? changedPathNames(workspace.root, parents[0], existing)
      : [];
    if (
      pathsChanged.length === 0 ||
      !pathsChanged.every(
        (file) =>
          file === ".semantic-review" ||
          file.startsWith(".semantic-review/"),
      )
    ) {
      fail(
        `Metadata branch ${branch} contains changes outside .semantic-review; refusing to move it.`,
      );
    }
    if (checkedOutBranches(workspace.root).has(branch)) {
      fail(`Cannot update metadata branch ${branch} while it is checked out.`);
    }
  }
  return {
    branch,
    commit: publication.commit,
    update: {
      ref: `refs/heads/${branch}`,
      next: publication.commit,
      previous: existing ?? ZERO_OID,
    },
  };
}

function publishArtifact(
  workspace: Workspace,
  options: Options,
  validatedArtifact: Artifact | undefined = undefined,
  quiet = false,
): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "publish"));
  const artifact = validatedArtifact ?? validateArtifact(workspace, {
    publish: true,
    quiet: true,
    allowLandedTarget: true,
  });
  assertCleanWorkingTree(workspace.root, "Artifact publication");
  if (validatedArtifact) assertValidatedArtifactCurrent(workspace, artifact);
  const message = option(options, "message")
    ?? `Publish ${artifact.manifest.implementationId} semantic implementation`;
  const publication = metadataPublicationPlan(workspace, artifact, message);
  if (!publication.update) {
    if (!quiet) console.log(
      `Semantic implementation metadata is already published on ${publication.branch}.`,
    );
    return;
  }
  updateRefs(workspace.root, [publication.update]);
  if (!quiet) console.log(
    `Published semantic implementation metadata on ${publication.branch} at ${publication.commit}.`,
  );
}

export interface StackEntry {
  position: number;
  stageId: string;
  branch: string;
  baseBranch: string;
  headRevision: string;
}

export interface StackSummary {
  targetBranch: string;
  branchPrefix: string;
  metadataBranch: string;
  cumulativeBranch: string | null;
  preparedHeadRevision: string | null;
  finalHeadRevision: string;
  stages: StackEntry[];
}

function stackSummary(artifact: Artifact, root: string): StackSummary {
  const binding = preparedBranchBinding(root, artifact);
  const entries = artifact.manifest.stages.map((id, index): StackEntry => {
    const stage = finalizedStage(artifact, id);
    return {
      position: index + 1,
      stageId: id,
      branch: stage.change.branch,
      baseBranch: stage.change.baseBranch,
      headRevision: stage.change.headRevision,
    };
  });
  return {
    targetBranch: artifact.manifest.targetBranch,
    branchPrefix: artifact.manifest.branchPrefix,
    metadataBranch: metadataBranch(artifact),
    cumulativeBranch: binding?.branch ?? null,
    preparedHeadRevision: binding?.head ?? null,
    finalHeadRevision: artifact.manifest.stages.length ? lastStageHead(artifact) : artifact.manifest.baseRevision,
    stages: entries,
  };
}

function validateStack(workspace: Workspace, options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "validate-stack"),
  );
  const json = flag(options, "json");
  const artifact = validateArtifact(workspace, { publish: true, quiet: true });
  const result = stackSummary(artifact, workspace.root);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Local stage stack valid (${result.stages.length} stage(s)):`);
  for (const entry of result.stages) {
    console.log(
      `  ${entry.position}. ${entry.branch} -> ${entry.baseBranch} (${entry.headRevision})`,
    );
  }
  console.log(`Final cumulative head: ${result.finalHeadRevision}`);
  if (result.cumulativeBranch) {
    console.log(
      `Bound cumulative branch: ${result.cumulativeBranch} (${result.preparedHeadRevision})`,
    );
  }
}

function prepareBranch(
  workspace: Workspace,
  options: Options,
  validatedArtifact: Artifact | undefined = undefined,
  quiet = false,
): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticImplementationApi, "prepare-branch"),
  );
  const requestedBranch = option(options, "branch");
  const adopt = flag(options, "adopt");
  const rebind = flag(options, "rebind");
  const artifact = validatedArtifact ?? validateArtifact(workspace, { publish: true, quiet: true });
  assertCleanWorkingTree(workspace.root, "Single-branch preparation");
  if (validatedArtifact) assertValidatedArtifactCurrent(workspace, artifact);
  const binding = preparedBranchBinding(workspace.root, artifact);
  if (rebind && !requestedBranch) {
    fail("--rebind requires --branch <branch-name>.");
  }
  if (rebind && !binding) {
    fail("--rebind requires an existing cumulative branch binding.");
  }
  const branch = requestedBranch ?? binding?.branch;
  // branch is undefined only when neither exists; an empty --branch also fails here.
  if ((!binding && !requestedBranch) || branch === undefined) {
    fail(
      `No cumulative branch is bound for ${artifact.manifest.implementationId}; specify --branch <branch-name> for the first preparation.`,
    );
  }
  if (binding && branch !== binding.branch && !rebind) {
    fail(
      `Implementation ${artifact.manifest.implementationId} is bound to cumulative branch ${binding.branch}; omit --branch to reuse it or pass --rebind with --branch ${branch}.`,
    );
  }
  if (binding && branch === binding.branch && rebind) {
    fail(`Cumulative branch ${branch} is already bound; omit --rebind.`);
  }
  git(["check-ref-format", "--branch", branch], { cwd: workspace.root });
  const head = lastStageHead(artifact);
  const existing = gitOptional(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: workspace.root,
  });
  const reusedBinding = binding?.branch === branch ? binding : undefined;
  const reusingBinding = reusedBinding !== undefined;
  if (
    reusedBinding &&
    existing &&
    existing !== reusedBinding.head &&
    existing !== head &&
    !adopt
  ) {
    fail(
      `Bound cumulative branch ${branch} moved from prepared head ${reusedBinding.head} to ${existing} outside preparation; refusing to overwrite it. Use --adopt to accept and replace its current tip.`,
    );
  }
  if (!reusingBinding && existing && !adopt) {
    const action = existing === head
      ? "bind it to this implementation"
      : `bind and replace it with reviewed head ${head}`;
    fail(`Branch ${branch} already points to ${existing}; use --adopt to ${action}.`);
  }
  if (adopt && !existing) {
    fail(`--adopt requires existing branch ${branch}.`);
  }
  if (existing !== head && checkedOutBranches(workspace.root).has(branch)) {
    fail(`Cannot update cumulative branch ${branch} while it is checked out.`);
  }

  const publication = metadataPublicationPlan(
    workspace,
    artifact,
    `Publish ${artifact.manifest.implementationId} semantic implementation`,
  );
  const bindingRef = preparedBranchRef(artifact, branch);
  git(["check-ref-format", bindingRef], { cwd: workspace.root });
  const updates: RefUpdate[] = [];
  if (publication.update) updates.push(publication.update);
  if (existing !== head) {
    updates.push({
      ref: `refs/heads/${branch}`,
      next: head,
      previous: existing ?? ZERO_OID,
    });
  }
  if (!reusedBinding || reusedBinding.head !== head) {
    updates.push({
      ref: bindingRef,
      next: head,
      previous: reusedBinding ? reusedBinding.head : ZERO_OID,
    });
  }
  if (binding && rebind) {
    updates.push({
      ref: binding.ref,
      next: ZERO_OID,
      previous: binding.head,
    });
  }
  updateRefs(workspace.root, updates);

  if (quiet) return;
  if (publication.update) {
    console.log(
      `Published semantic implementation metadata on ${publication.branch} at ${publication.commit}.`,
    );
  } else {
    console.log(
      `Semantic implementation metadata is already published on ${publication.branch}.`,
    );
  }
  if (binding && rebind) {
    console.log(
      `Rebound cumulative output from ${binding.branch} to ${branch} at ${head}; the old branch was left unchanged.`,
    );
  } else if (!reusingBinding && existing === head) {
    console.log(
      `Adopted and bound existing cumulative branch ${branch} at ${head}; base is ${artifact.manifest.targetBranch}.`,
    );
  } else if (existing && existing !== head) {
    console.log(
      `${adopt ? "Adopted and updated" : "Updated"} bound cumulative branch ${branch} from ${existing} to ${head}; base is ${artifact.manifest.targetBranch}.`,
    );
    console.log(
      `Remote update: git push --force-with-lease=refs/heads/${branch}:${existing} <remote> refs/heads/${branch}:refs/heads/${branch}`,
    );
  } else if (!existing && reusedBinding) {
    console.log(
      `Recreated bound local cumulative branch ${branch} at ${head}; previous prepared head was ${reusedBinding.head}.`,
    );
    console.log(
      `Remote update: git push --force-with-lease=refs/heads/${branch}:${reusedBinding.head} <remote> refs/heads/${branch}:refs/heads/${branch}`,
    );
  } else if (!existing) {
    console.log(
      `Prepared and bound local cumulative branch ${branch} at ${head}; base is ${artifact.manifest.targetBranch}.`,
    );
  } else {
    console.log(
      `Local cumulative branch ${branch} is already prepared at ${head}; base is ${artifact.manifest.targetBranch}.`,
    );
  }
}

function archiveImplementation(
  workspace: Workspace,
  options: Options,
  validatedArtifact: Artifact | undefined = undefined,
  quiet = false,
): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "archive"));
  const artifact = validatedArtifact ?? validateArtifact(workspace, {
    publish: true,
    quiet: true,
    allowLandedTarget: true,
  });
  assertCleanWorkingTree(workspace.root, "Implementation archival");
  if (validatedArtifact) assertValidatedArtifactCurrent(workspace, artifact, true);
  const current = currentBranch(workspace.root);
  if (current !== artifact.manifest.targetBranch) {
    fail(
      `Archive requires checked-out target branch ${artifact.manifest.targetBranch}, not ${current ?? "detached HEAD"}.`,
    );
  }
  const stageTip = lastStageHead(artifact);
  const targetHead = branchCommit(workspace.root, artifact.manifest.targetBranch);
  if (!isAncestor(workspace.root, stageTip, targetHead)) {
    fail(
      `Archive requires target branch ${artifact.manifest.targetBranch} to contain final stage head ${stageTip}.`,
    );
  }
  const publicationBranch = metadataBranch(artifact);
  const publicationHead = gitOptional(
    ["rev-parse", "--verify", `refs/heads/${publicationBranch}`],
    { cwd: workspace.root },
  );
  if (!publicationHead) {
    fail(`Archive requires published metadata branch ${publicationBranch}.`);
  }
  const publicationParents = commitParents(workspace.root, publicationHead);
  const publicationTree = git(
    ["show", "-s", "--format=%T", publicationHead],
    { cwd: workspace.root },
  );
  const expectedTree = buildArtifactTree(workspace.root, workspace.snapshot, stageTip);
  if (
    publicationParents.length !== 1 ||
    publicationParents[0] !== stageTip ||
    publicationTree !== expectedTree
  ) {
    fail(
      `Metadata branch ${publicationBranch} does not publish the current semantic implementation; run publish again before archiving.`,
    );
  }

  const destinationOption = option(options, "destination")
    ?? `.semantic-review-history/${artifact.manifest.implementationId}/.semantic-review`;
  if (
    path.isAbsolute(destinationOption) ||
    destinationOption.split(/[\\/]/).includes("..")
  ) {
    fail("Archive destination must be a repository-relative path without '..'.");
  }
  const destination = path.resolve(workspace.root, destinationOption);
  if (
    destination === workspace.root ||
    !destination.startsWith(`${workspace.root}${path.sep}`) ||
    path.basename(destination) !== ".semantic-review"
  ) {
    fail("Archive destination must end in .semantic-review inside the repository.");
  }
  if (fs.existsSync(destination)) {
    fail(`Archive destination already exists: ${destinationOption}.`);
  }

  const message = option(options, "message")
    ?? `Archive ${artifact.manifest.implementationId} semantic implementation`;
  const currentHead = gitOptional(["rev-parse", "HEAD"], { cwd: workspace.root });
  try {
    exportArtifactFiles(workspace.snapshot, destination);
    const relativeDestination = formatPath(
      path.relative(workspace.root, destination),
    );
    git(["add", "-f", "--", relativeDestination], { cwd: workspace.root });
    const staged = git(["diff", "--cached", "--name-only"], {
      cwd: workspace.root,
    })
      .split(/\r?\n/)
      .filter(Boolean);
    if (
      staged.length === 0 ||
      !staged.every(
        (file) =>
          file.startsWith(`${relativeDestination}/`),
      )
    ) {
      fail("Archival staged files outside the active and destination artifacts.");
    }
    git(
      ["commit", "-m", message],
      { cwd: workspace.root },
    );
    removeArtifact(workspace.root, workspace.snapshot);
    if (!quiet) console.log(
      `Archived ${artifact.manifest.implementationId} at ${relativeDestination}.`,
    );
  } catch (error) {
    git(["reset", "--", destinationOption], {
      cwd: workspace.root,
      allowFailure: true,
    });
    if (currentHead === gitOptional(["rev-parse", "HEAD"], { cwd: workspace.root })) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Validates the recorded stack before sync; target ancestry is checked by the caller. */
export function validateSyncStack(root: string): void {
  validateArtifact(openWorkspace(root), { quiet: true, allowTargetDrift: true });
}

export interface WorkflowSummary extends StackSummary {
  worktree: string;
  implementationId: string;
  workingStages: string[];
}

/** One validation boundary for a workflow; standalone commands keep their own gates. */
export function implementationWorkflow(
  root: string,
  mode: "validate" | "prepare" | "archive",
  options: Options,
): WorkflowSummary {
  const workspace = openWorkspace(root);
  const publish = mode !== "validate" || flag(options, "publish");
  const artifact = validateArtifact(workspace, { quiet: true, publish, allowLandedTarget: mode === "archive" });
  const summary: WorkflowSummary = {
    worktree: root,
    implementationId: artifact.manifest.implementationId,
    ...stackSummary(artifact, root),
    workingStages: [...artifact.workStages.keys()],
  };
  if (mode === "prepare") {
    const branch = option(options, "branch");
    if (branch) {
      prepareBranch(workspace, new Map([["branch", [branch]]]), artifact, flag(options, "json"));
      Object.assign(summary, stackSummary(artifact, root));
    } else {
      publishArtifact(workspace, new Map(), artifact, flag(options, "json"));
    }
  } else if (mode === "archive") {
    archiveImplementation(workspace, new Map(), artifact, flag(options, "json"));
  }
  return summary;
}

function dispatch(root: string, positionals: string[], options: Options): void {
  const [command, subcommand, ...extra] = positionals;
  if (extra.length > 0) {
    fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  }
  if (!command || command === "help" || flag(options, "help")) {
    console.log(HELP);
    return;
  }
  // Unknown options are reported before the artifact is read.
  const known = [command, subcommand].filter(Boolean).join(" ");
  if (semanticImplementationApi.commands.some((signature) => signature.command === known)) {
    assertKnownOptions(options, commandOptionNames(semanticImplementationApi, known));
  }

  if (command === "init" && subcommand === undefined) {
    initialize(root, options);
    return;
  }
  if (command === "specification" && subcommand === "add") {
    addSpecification(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "begin") {
    beginStage(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "set") {
    setStage(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "target") return targetInsight(openWorkspace(root), options);
  if (command === "stage" && subcommand === "evidence") return recordEvidence(openWorkspace(root), options);
  if (command === "stage" && subcommand === "evidence-remove") return removeEvidence(openWorkspace(root), options);
  if (command === "stage" && subcommand === "no-evidence") return recordNoEvidence(openWorkspace(root), options);
  if (command === "stage" && subcommand === "record-batch") return recordStageBatch(openWorkspace(root), options);
  if (command === "stage" && subcommand === "plan") return organizationPlan(openWorkspace(root), options);
  if (command === "stage" && subcommand === "record") {
    recordStageItem(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "organize") {
    organizeStage(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "validation") {
    recordValidation(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "finish") {
    finishStage(openWorkspace(root), options);
    return;
  }
  if (command === "stage" && subcommand === "discard") {
    discardStage(openWorkspace(root), options);
    return;
  }
  if (command === "restack" && subcommand === undefined) {
    restack(openWorkspace(root), options);
    return;
  }
  if (command === "repair" && subcommand === undefined) {
    repairArtifact(openWorkspace(root), options);
    return;
  }
  if (command === "publish" && subcommand === undefined) {
    publishArtifact(openWorkspace(root), options);
    return;
  }
  if (command === "validate-stack" && subcommand === undefined) {
    validateStack(openWorkspace(root), options);
    return;
  }
  if (command === "prepare-branch" && subcommand === undefined) {
    prepareBranch(openWorkspace(root), options);
    return;
  }
  if (command === "archive" && subcommand === undefined) {
    archiveImplementation(openWorkspace(root), options);
    return;
  }
  if (command === "validate" && subcommand === undefined) {
    assertKnownOptions(
      options,
      commandOptionNames(semanticImplementationApi, "validate"),
    );
    if (options.has("schema-only") && options.has("publish")) {
      fail("--schema-only and --publish cannot be combined.");
    }
    validateArtifact(openWorkspace(root), {
      schemaOnly: flag(options, "schema-only"),
      publish: flag(options, "publish"),
    });
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

/** Runs one `semantic-flow implementation` command line in the current working directory. */
export function runImplementationCommand(argv: string[]): void {
  const parsed = parseArguments(argv);
  if (parsed.options.has("help") && parsed.positionals.length === 0) {
    assertKnownOptions(parsed.options, new Set(["help"]));
    flag(parsed.options, "help");
    console.log(HELP);
    return;
  }
  const root = repositoryRoot();
  withValidationContext(() => dispatch(
    root,
    parsed.positionals,
    expandInputOptions(parsed.options, process.cwd()),
  ));
}
