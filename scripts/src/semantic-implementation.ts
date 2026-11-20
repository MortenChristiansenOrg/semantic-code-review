#!/usr/bin/env node
import { captureCodeTarget, validateCodeTarget } from "./shared/insight-targets.js";
import { assertEvidenceDirectories, ensureEvidenceAttributes, evidenceAttachmentErrors, evidenceAttachmentPath, evidenceMediaType, evidenceTreeErrors, evidenceWarnings, MAX_EVIDENCE_ATTACHMENT_BYTES, sha256Hex } from "./shared/evidence.js";

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
  LANDING_SCHEMA_ID,
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
  type LandingRecord,
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
import { parseJson, readJson } from "./shared/json.js";
import {
  changedFiles,
  fullFormFiles,
  loadImplementation,
  loadManifest,
  stageBranchName,
  stageFile,
  writeManifest,
  writeStage,
  type Artifact,
  type EditableStage,
} from "./shared/implementation.js";
import {
  ArtifactDraft,
  archiveRef,
  archiveTag,
  buildArtifactTree,
  commitArtifact,
  exportArtifactFiles,
  hasFile,
  listJsonIds,
  readArtifact,
  activeRef,
  readPublishedArtifact,
  rememberImplementation,
  removeArtifact,
  requireArtifact,
  updateRefs,
  worktreeImplementation,
  ZERO_OID,
  type ArtifactFiles,
  type ArtifactSnapshot,
  type RefUpdate,
} from "./shared/artifact-store.js";
import { errorMessage, isStringArray, type JsonRecord } from "./shared/narrow.js";
import { parseDocument } from "./shared/schema-validation.js";
import { reviewId, withReviewLock, writeReviewId } from "./shared/review-store.js";
import { touchAgent, updateAgentState } from "./shared/agent-session.js";

const commitFacts = factCache<string>();
const linearRangeFacts = factCache<number>();
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

/** The landing record an archive adds to the published artifact. */
const ARCHIVE_LANDING_FILE = "landing.json";

/** The worktree a command runs in and the artifact snapshot it read there. */
interface Workspace {
  root: string;
  snapshot: ArtifactSnapshot;
}

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

function formatPath(value: string): string {
  return value.split(path.sep).join("/");
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

/** Fails unless head descends linearly from base; returns the number of commits between them. */
function assertLinearRange(root: string, base: string, head: string, label: string): number {
  return linearRangeFacts(JSON.stringify([root, base, head]), () => checkLinearRange(root, base, head, label));
}

function checkLinearRange(root: string, base: string, head: string, label: string): number {
  if (!isAncestor(root, base, head)) {
    fail(`${label} head ${head} must descend from ${base}.`);
  }
  const commits = git(["rev-list", "--parents", `${base}..${head}`], {
    cwd: root,
  }).split(/\r?\n/).filter(Boolean);
  if (commits.some((line) => line.split(" ").length > 2)) {
    fail(`${label} must not contain merge commits.`);
  }
  return commits.length;
}

/** The identity Git records for a commit made now, without its date. */
function currentIdentity(root: string, variable: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT" = "GIT_AUTHOR_IDENT"): string {
  return git(["var", variable], { cwd: root }).replace(/ \d+ [+-]\d{4}$/, "");
}

const IDENTITY = /^[^<>\x00-\x1f]+ <[^<>\x00-\x1f]+>$/;
const identityEmail = (identity: string) => /<([^>]*)>\s*$/.exec(identity)?.[1]?.toLowerCase() ?? identity.toLowerCase();

/** The message of a stage commit: the stage's title and summary, then a
 * Co-authored-by trailer for each co-author. */
function stageCommitMessage(stage: Pick<EditableStage, "title" | "summary">, coAuthors: readonly string[]): string {
  const trailers = coAuthors.map((identity) => `Co-authored-by: ${identity}`);
  return [stage.title.trim(), stage.summary.trim(), ...(trailers.length ? [trailers.join("\n")] : [])].join("\n\n") + "\n";
}

/** Everyone who wrote commits in base..head, as authors or co-authors, except
 * author, in order of first appearance. */
function rangeCoAuthors(root: string, base: string, head: string, author: string): string[] {
  // Only the trailer block counts: a Co-authored-by line in the body is text,
  // not attribution. A message cannot hold NUL, so NUL separates the values
  // and two of them start each commit.
  const log = gitRaw(["log", "--reverse", "--format=%x00%x00%an <%ae>%x00%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x00)", `${base}..${head}`], { cwd: root });
  const seen = new Set([identityEmail(author)]);
  const coAuthors: string[] = [];
  for (const entry of log.split("\0\0").slice(1)) {
    const [identity, ...trailers] = entry.split("\0").map((value) => value.trim());
    if (!identity) continue;
    for (const candidate of [identity, ...trailers.filter((trailer) => IDENTITY.test(trailer))]) {
      const key = identityEmail(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      coAuthors.push(candidate);
    }
  }
  return coAuthors;
}

/** One commit on base with head's tree and the generated stage message: what a
 * finalized stage is. Commits made while the stage was worked on or fixed are
 * folded into it, and their authors become co-authors. A range that is already
 * that one commit is kept as it is. */
function foldStage(root: string, stage: Pick<EditableStage, "title" | "summary">, base: string, head: string, label: string, keepOneCommit = false): string {
  const count = assertLinearRange(root, base, head, label);
  if (count === 0) fail(`${label} has no commits.`);
  // An unchanged stage keeps its commit, even when its title or summary was edited since.
  if (count === 1 && keepOneCommit) return head;
  const author = currentIdentity(root);
  const message = stageCommitMessage(stage, rangeCoAuthors(root, base, head, author));
  const [authorDate, committerDate, existing] = gitRaw(["show", "-s", "--format=%aI%x00%cI%x00%B", head], { cwd: root }).split("\0");
  if (count === 1 && existing.trimEnd() === message.trimEnd()) return head;
  // The folded head's dates make the fold repeatable: folding the same commits again gives the same commit.
  return gitRaw(["commit-tree", `${head}^{tree}`, "-p", base], {
    cwd: root,
    input: message,
    env: { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate },
  });
}

/** Points code targets captured on commits a fold replaced at the folded
 * commit, when the targeted lines read the same there. Others keep their
 * revision, and the viewer maps them as it does after any rewrite. */
function retargetFoldedCode(root: string, stage: EditableStage, base: string, previousHead: string, foldedHead: string): void {
  if (previousHead === foldedHead) return;
  const folded = new Set(git(["rev-list", `${base}..${previousHead}`], { cwd: root }).split(/\r?\n/).filter(Boolean));
  for (const collection of STAGE_ITEM_COLLECTIONS) for (const item of stageItems(stage, collection)) {
    const target = item.codeTarget;
    if (!target || !folded.has(target.revision)) continue;
    try {
      const current = captureCodeTarget(root, foldedHead, target.path, target.startLine, target.endLine);
      if (current.blobId === target.blobId && current.contextStartLine === target.contextStartLine && JSON.stringify(current.context) === JSON.stringify(target.context)) {
        item.codeTarget = { ...target, revision: foldedHead };
      }
    } catch { /* The lines are gone at the folded head; the viewer reports them for review. */ }
  }
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
  /** Branch heads the command moves together with the draft it validates. */
  movingBranches?: ReadonlyMap<string, string>;
  allowLandedTarget?: boolean;
  allowTargetDrift?: boolean;
}

function validateSemantic(
  workspace: Pick<Workspace, "root">,
  files: ArtifactFiles,
  artifact: Artifact,
  { validateGit = true, allowLandedTarget = false, allowTargetDrift = false, movingBranches = new Map() }: SemanticValidationOptions = {},
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
    if (heads.has(stage.change.headRevision)) {
      errors.push(`Stage ${id} repeats head ${stage.change.headRevision}.`);
    }
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
  const finalStageId = manifest.stages.at(-1);
  const finalStageHead = finalStageId
    ? finalizedStage(artifact, finalStageId).change.headRevision
    : undefined;
  // With drift allowed the target is not read at all, so it may even be gone.
  const targetHead = allowTargetDrift ? base : branchCommit(workspace.root, manifest.targetBranch);
  const targetContainsLandedStack =
    allowLandedTarget &&
    finalStageHead !== undefined &&
    isAncestor(workspace.root, finalStageHead, targetHead);
  if (targetHead !== base && !targetContainsLandedStack) {
    fail(
      `Target branch ${manifest.targetBranch} moved from ${base} to ${targetHead}; check it out, then run restack --base ${manifest.targetBranch}.`,
    );
  }
  // Branch names, bases and inventories are derived from the stage order and
  // heads; only the mutable branch refs and the recorded commits are checked.
  let below: Stage | undefined;
  for (const id of manifest.stages) {
    const stage = finalizedStage(artifact, id);
    const { branch, baseRevision, headRevision, files } = stage.change;
    const branchHead = movingBranches.get(branch) ?? branchCommit(workspace.root, branch);
    const head = commitObject(workspace.root, headRevision);
    if (branchHead !== head) {
      fail(
        `Stage ${id} branch ${branch} moved from ${head} to ${branchHead}; check it out, then run restack --from ${id}.`,
      );
    }
    // A stage keeps its own base only until restacking moves it onto the new head below it.
    const expectedBase = below ? below.change.headRevision : base;
    if (commitObject(workspace.root, baseRevision) !== expectedBase) {
      fail(below
        ? `Stage ${id} still builds on ${baseRevision}, not on the head ${expectedBase} of stage ${below.id}; check out ${below.change.branch}, then run restack --from ${below.id}.`
        : `Stage ${id} still builds on ${baseRevision}, not on ${expectedBase}; check out ${manifest.targetBranch}, then run restack --base ${manifest.targetBranch}.`);
    }
    below = stage;
    const commits = assertLinearRange(workspace.root, baseRevision, head, `Stage ${id}`);
    if (commits !== 1) {
      fail(`Stage ${id} has ${commits} commits between ${baseRevision} and ${head}; a finalized stage is one commit.`);
    }
    const nodeErrors = stageNodeErrors(stage, files, {
      root: workspace.root,
      baseRevision,
      headRevision: head,
    });
    if (nodeErrors.length > 0) {
      fail(nodeErrors.join("\n"));
    }
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
    movingBranches,
  }: ArtifactValidationOptions = {},
  files: ArtifactFiles | undefined = workspace.snapshot,
): Artifact {
  if (!files) throw new Error("Validation requires the artifact's files.");
  const artifact = loadImplementation(workspace.root, files);

  for (const stage of [...artifact.stages.values(), ...artifact.workStages.values()]) {
    for (const collection of STAGE_ITEM_COLLECTIONS) for (const item of stageItems(stage, collection)) {
      if (item.codeTarget) validateCodeTarget(workspace.root, item.codeTarget, !schemaOnly && validateGit);
    }
  }
  if (!schemaOnly) {
    validateSemantic(workspace, files, artifact, { validateGit, allowLandedTarget, allowTargetDrift, movingBranches });
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
  const claimed = worktreeImplementation(root);
  if (claimed) {
    fail(`A semantic implementation already exists in this worktree: ${claimed.implementationId}. Start new work in another worktree.`);
  }
  const implementationId = option(options, "implementation-id", { required: true });
  if (readArtifact(root, implementationId)) {
    fail(`A semantic implementation with implementation ID ${implementationId} already exists.`);
  }
  assertCleanWorkingTree(root, "Initialization");

  const specificationInput = specificationFromOptions(options);
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
  git(["check-ref-format", "--branch", stageBranchName(branchPrefix, "probe")], {
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
  writeManifest(draft, { manifest, stages: new Map() });
  // Private to the active artifact: every worktree of the repository shares the review.
  writeReviewId(draft, root, implementationId);
  validateArtifact({ root }, { quiet: true }, draft);
  commitArtifact(root, undefined, draft);
  rememberImplementation(root, implementationId);
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
  writeManifest(draft, artifact);
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

  const branch = stageBranchName(artifact.manifest.branchPrefix, id);
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
  writeStage(draft, stage);
  validateArtifact(workspace, { quiet: true }, draft);
  // The stage branch is created together with the artifact's new snapshot.
  const branchRef = `refs/heads/${branch}`;
  const snapshot = commitArtifact(workspace.root, workspace.snapshot, draft, [{ ref: branchRef, next: parent, previous: ZERO_OID }]);
  try {
    git(["switch", branch], { cwd: workspace.root });
  } catch (error) {
    // A failing post-checkout hook fails the switch after it took effect; the stage was then begun.
    if (gitOptional(["symbolic-ref", "--quiet", "HEAD"], { cwd: workspace.root }) !== branchRef) {
      // Without the switch the stage was never begun: take back the branch and the snapshot.
      updateRefs(workspace.root, [
        { ref: branchRef, next: ZERO_OID, previous: parent },
        { ref: activeRef(artifact.manifest.implementationId), next: workspace.snapshot.version, previous: snapshot },
      ]);
      throw error;
    }
    console.error(`semantic-implementation: the switch to ${branch} succeeded but reported: ${errorMessage(error)}`);
  }
  rememberImplementation(workspace.root, artifact.manifest.implementationId);
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
      `More than one working stage exists; specify --${optionName} explicitly.`,
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
function saveStage(workspace: Workspace, draft: ArtifactDraft, stage: EditableStage, update: StageUpdate): EditableStage {
  const updated = update(structuredClone(stage));
  writeStage(draft, updated);
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
    const { stage } = workingStage(artifact, id);
    updated = saveStage(workspace, edit, stage, update);
  } else {
    const stage = artifact.stages.get(id);
    if (!stage) {
      fail(`Finalized stage ${id} does not exist.`);
    }
    updated = saveStage(workspace, edit, stage, update);
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

// Evidence edits wait for each other instead of failing as concurrent writes:
// the artifact is read again once the lock is held.
function withEvidenceLock<T>(workspace: Workspace, write: (current: Workspace) => T): T {
  const manifest = loadManifest(workspace.snapshot);
  return withArtifactLock(workspace, manifest.implementationId, () => write(openWorkspace(workspace.root)));
}

function recordEvidence(workspace: Workspace, options: Options): void {
  withEvidenceLock(workspace, (current) => writeEvidence(current, options));
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
  withEvidenceLock(workspace, (current) => deleteEvidence(current, options));
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
  writeStage(draft, batch.stage);
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
  let branchHead: string | undefined;
  if (updated.$schema === STAGE_SCHEMA_ID) {
    const { change } = updated;
    baseRevision = change.baseRevision;
    assertDirectRefs(workspace.root, [`refs/heads/${change.branch}`]);
    headRevision = branchCommit(workspace.root, change.branch);
    branchHead = headRevision;
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
      // A corrected stage is recorded as one commit again.
      headRevision = foldStage(workspace.root, updated, baseRevision, branchHead, `Stage ${stageId}`);
      retargetFoldedCode(workspace.root, updated, baseRevision, branchHead, headRevision);
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
  writeStage(draft, updated);
  if (updated.$schema === STAGE_SCHEMA_ID && finalizedStageMoved) {
    artifact.stages.set(stageId, updated);
    writeManifest(draft, artifact);
  }
  validateArtifact(workspace, {
    quiet: true,
    validateGit: finalized && !finalizedStageMoved,
  }, draft);
  const fold = updated.$schema === STAGE_SCHEMA_ID && branchHead !== undefined
    ? [{ ref: `refs/heads/${updated.change.branch}`, next: headRevision, previous: branchHead }]
    : [];
  // The checked-out branch moves to a commit with the same tree, so the checkout
  // stays as it is; an unchanged branch is verified. The folded commits stay reachable.
  commitArtifact(workspace.root, workspace.snapshot, draft, fold,
    branchHead !== undefined && branchHead !== headRevision ? [branchHead] : []);
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
  // Reject a malformed --json before finishing rewrites the branch.
  const json = flag(options, "json");
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
  assertDirectRefs(workspace.root, [`refs/heads/${workStage.branch}`]);
  let headRevision = branchCommit(workspace.root, workStage.branch);
  if (commitObject(workspace.root, "HEAD") !== headRevision) {
    fail(`HEAD does not match stage branch ${workStage.branch}.`);
  }
  const previousId = artifact.manifest.stages.at(-1);
  const baseBranch = previousId
    ? finalizedStage(artifact, previousId).change.branch
    : artifact.manifest.targetBranch;
  const baseRevision = stackTip(artifact);
  const workHead = headRevision;
  // The finalized stage is one commit: the stage's commits fold into it.
  headRevision = foldStage(workspace.root, workStage, baseRevision, workHead, `Stage ${id}`);
  retargetFoldedCode(workspace.root, workStage, baseRevision, workHead, headRevision);
  const files = changedFiles(workspace.root, baseRevision, headRevision);
  const canonicalFile = `stages/${id}.json`;
  const stage = canonicalStage(
    workStage,
    { branch: workStage.branch, baseBranch, baseRevision, headRevision, files },
    workspace.snapshot.describe(canonicalFile),
  );
  artifact.manifest.stages.push(id);

  const draft = new ArtifactDraft(workspace.snapshot);
  artifact.stages.set(id, stage);
  writeStage(draft, stage);
  writeManifest(draft, artifact);
  draft.remove(workFile);
  validateArtifact(workspace, { quiet: true, movingBranches: new Map([[workStage.branch, headRevision]]) }, draft);
  // The checked-out branch moves to a commit with the same tree, so the checkout
  // stays as it is; an unchanged branch is verified. The folded commits stay
  // reachable for code targets captured on them.
  // The finalized stages below, which the new stage builds on, are verified.
  const lower = artifact.manifest.stages.filter((stageId) => stageId !== id).map((stageId): RefUpdate => {
    const { branch, headRevision: head } = finalizedStage(artifact, stageId).change;
    return { ref: `refs/heads/${branch}`, next: head, previous: head };
  });
  commitArtifact(workspace.root, workspace.snapshot, draft,
    [...lower, { ref: `refs/heads/${workStage.branch}`, next: headRevision, previous: workHead }],
    headRevision === workHead ? [] : [workHead]);
  reportEvidenceWarnings([stage]);
  if (json) console.log(JSON.stringify({ worktree: workspace.root, stageId: id, branch: workStage.branch, baseRevision, headRevision, next: "stage begin or review" }));
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
      branchNote = ` Branch ${branch} has local commits and was kept; delete it manually before reusing the stage ID.`;
    } else if (
      checkedOutBranches(workspace.root).has(branch) &&
      currentBranch(workspace.root) !== branch
    ) {
      branchNote = ` Branch ${branch} is checked out in another worktree and was kept; remove that worktree or delete the branch manually before reusing the stage ID.`;
    } else {
      removeBranch = true;
    }
  }

  const draft = new ArtifactDraft(workspace.snapshot);
  draft.remove(file);
  draft.remove(`evidence/${id}`);
  validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
  const wasCurrent = removeBranch && currentBranch(workspace.root) === branch;
  if (wasCurrent) git(["switch", "--detach", creationParent], { cwd: workspace.root });
  try {
    // The unchanged stage branch is deleted together with the artifact's new snapshot.
    commitArtifact(workspace.root, workspace.snapshot, draft,
      removeBranch ? [{ ref: `refs/heads/${branch}`, next: ZERO_OID, previous: creationParent }] : []);
  } catch (error) {
    if (wasCurrent) git(["switch", branch], { cwd: workspace.root, allowFailure: true });
    throw error;
  }
  if (removeBranch) branchNote = ` Removed unchanged branch ${branch}.`;
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

/** Where a stage's own changes start. A stage rebuilt on a correction of the
 * stage below, the latest or an earlier one, starts at the newest commit it
 * shares with that stage, so the correction is not replayed as its own change.
 * Otherwise it starts at its recorded base. */
function rebuiltStageBase(root: string, recordedBase: string, below: string | undefined, head: string): string {
  if (below === undefined || below === recordedBase) return recordedBase;
  const shared = gitOptional(["merge-base", below, head], { cwd: root });
  return shared && shared !== recordedBase && isAncestor(root, recordedBase, shared) ? shared : recordedBase;
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
  assertDirectRefs(workspace.root, [
    `refs/heads/${artifact.manifest.targetBranch}`,
    ...artifact.manifest.stages.map((id) => `refs/heads/${finalizedStage(artifact, id).change.branch}`),
  ]);
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
  // Refs the restack relies on but leaves in place, verified when it commits.
  const kept: RefUpdate[] = baseOption
    ? [{ ref: `refs/heads/${artifact.manifest.targetBranch}`, next: newBase, previous: newBase }]
    : [];
  let parentBranch = artifact.manifest.targetBranch;
  let parentHead = newBase;
  // The head the stage below had before this restack, which a corrected stage above may already build on.
  let belowHead: string | undefined;

  try {
    for (const [index, id] of artifact.manifest.stages.entries()) {
      const stage = finalizedStage(artifact, id);
      const actualHead = branchCommit(workspace.root, stage.change.branch);
      const observedBelow = belowHead;
      belowHead = actualHead;
      if (index < startIndex) {
        if (actualHead !== stage.change.headRevision) {
          fail(
            `Stage ${id} moved before the requested restack range; start from ${id}.`,
          );
        }
        kept.push({ ref: `refs/heads/${stage.change.branch}`, next: actualHead, previous: actualHead });
        parentBranch = stage.change.branch;
        parentHead = actualHead;
        continue;
      }

      let nextHead: string;
      // A stage whose branch moved was corrected; it is folded into one commit again.
      const unchanged = actualHead === stage.change.headRevision;
      const stageBase = rebuiltStageBase(workspace.root, stage.change.baseRevision, observedBelow, actualHead);
      if (isAncestor(workspace.root, parentHead, actualHead)) {
        nextHead = foldStage(workspace.root, stage, parentHead, actualHead, `Stage ${id}`, unchanged);
      } else {
        const stageCommit = foldStage(workspace.root, stage, stageBase, actualHead, `Stage ${id}`, unchanged);
        try {
          nextHead = applyCommitPatch({
            root: workspace.root,
            indexFile,
            baseTree: parentHead,
            patchParent: stageBase,
            patchCommit: stageCommit,
            metadataCommit: stageCommit,
            newParent: parentHead,
          });
        } catch (error) {
          if (!(error instanceof PatchConflictError)) throw error;
          const detail = error.message;
          fail(
            [
              `Restacking stage ${id} onto ${parentHead} failed.`,
              "No stage refs or artifacts were changed.",
              `Conflict context: stage base ${stageBase}, stage head ${actualHead}, new parent ${parentHead}.`,
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
    // Unchanged stage branches are verified rather than moved.
    const refUpdates = [...kept, ...plans.map(({ branch, previousHead, nextHead }): RefUpdate => ({
      ref: `refs/heads/${branch}`,
      previous: previousHead,
      next: nextHead,
    }))];
    // Corrections folded away stay reachable for code targets captured on them.
    const corrections = plans.filter(({ stage, previousHead }) => previousHead !== stage.change.headRevision).map(({ previousHead }) => previousHead);
    const checkedOut = checkedOutBranches(workspace.root);
    // A checked-out branch may only move to a commit with the same tree, as a fold does.
    const sameTree = (left: string, right: string) => git(["rev-parse", `${left}^{tree}`, `${right}^{tree}`], { cwd: workspace.root }).split(/\r?\n/).every((tree, _, trees) => tree === trees[0]);
    const checkedOutUpdates = branchUpdates
      .filter(({ branch, previousHead, nextHead }) => checkedOut.has(branch) && !sameTree(previousHead, nextHead))
      .map(({ branch }) => branch);
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
    }
    writeManifest(draft, artifact);
    validateArtifact(workspace, { quiet: true, validateGit: false }, draft);
    withArtifactLock(workspace, artifact.manifest.implementationId, () => {
      commitArtifact(workspace.root, workspace.snapshot, draft, refUpdates, corrections);
    });

    return {
      mode: baseOption ? "base" : "stage",
      fromStage: fromId ?? null,
      targetBranch: artifact.manifest.targetBranch,
      baseRevision: newBase,
      refreshedStages: plans.length,
      rewrittenBranches: branchUpdates.length,
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

/** The tree that publishes the artifact in its full form on top of parent. */
function publishedTree(workspace: Workspace, artifact: Artifact, parent: string): string {
  return buildArtifactTree(workspace.root, fullFormFiles(artifact, workspace.snapshot), parent);
}

function buildMetadataCommit(workspace: Workspace, artifact: Artifact, parent: string, message: string): { commit: string; tree: string } {
  const tree = publishedTree(workspace, artifact, parent);
  const commit = gitRaw(["commit-tree", tree, "-p", parent], {
    cwd: workspace.root,
    input: `${message}\n`,
  });
  return { commit, tree };
}

// Reuse expensive immutable validation, but re-read documents and refs before
// each mutation in a combined workflow. A prior success never validates edits.
function assertValidatedArtifactCurrent(workspace: Workspace, artifact: Artifact, ignoreTarget = false): void {
  const changed = "Semantic implementation changed during the workflow; retry after the current edit completes.";
  if (readArtifact(workspace.root)?.version !== workspace.snapshot.version) fail(changed);
  const expected = new Map<string, string>(ignoreTarget ? [] : [[artifact.manifest.targetBranch, artifact.manifest.baseRevision]]);
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
    fail(`Branch ${branch} changed during the workflow; validate the current stack before retrying.`);
  }
}

interface MetadataPublication {
  branch: string;
  commit: string;
  update: RefUpdate | undefined;
  /** When the branch already publishes the artifact: a check that it still does. */
  verify?: RefUpdate;
}

function metadataPublicationPlan(workspace: Workspace, artifact: Artifact, message: string): MetadataPublication {
  const stageTip = lastStageHead(artifact);
  const branch = metadataBranch(artifact);
  git(["check-ref-format", "--branch", branch], { cwd: workspace.root });
  if (branch === artifact.manifest.targetBranch) {
    fail(`Metadata branch ${branch} is the target branch; publishing there would rewrite it.`);
  }
  const publication = buildMetadataCommit(workspace, artifact, stageTip, message);
  const existing = gitOptional(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: workspace.root,
  });
  if (existing) {
    const existingTree = git(["show", "-s", "--format=%T", existing], {
      cwd: workspace.root,
    });
    const parents = commitParents(workspace.root, existing);
    if (parents.length === 1 && parents[0] === stageTip && existingTree === publication.tree) {
      return { branch, commit: existing, update: undefined, verify: { ref: `refs/heads/${branch}`, next: existing, previous: existing } };
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

/** What `archive` did, as `semantic-flow archive --json` reports it. */
export interface ArchiveSummary {
  ref: string;
  commit: string;
  metadataCommit: string;
  landing: LandingRecord;
  /** A target commit or range whose changes match the implementation's, offered
   * only when landing is unknown; matching does not show that it landed them. */
  suggestedLanding: string | null;
}

/** Where an implementation was archived from: enough to tell where it landed. */
interface LandingSubject {
  implementationId: string;
  targetBranch: string;
  baseRevision: string;
  finalHeadRevision: string;
}

/** The commit or range a reviewer supplied as landing, in full revisions. The
 * local target branch may be behind the remote one, so it only warns when the
 * landing is not on it. */
function suppliedLanding(root: string, targetBranch: string, value: string): string {
  const parts = value.split("..");
  if (parts.length > 2 || parts.some((part) => part === "" || part.startsWith("."))) {
    fail(`--landed takes a commit or a range <base>..<head>, not ${value}.`);
  }
  const revisions = parts.map((part) => commitObject(root, part));
  const head = revisions.at(-1) ?? fail("--landed requires a revision.");
  const targetHead = gitOptional(["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}^{commit}`], { cwd: root });
  if (!targetHead || !isAncestor(root, head, targetHead)) {
    console.error(`Warning: landing commit ${head} is not on the local target branch ${targetBranch}; it is recorded as supplied.`);
  }
  if (revisions.length === 2) {
    const [base] = revisions;
    if (base === head || !isAncestor(root, base, head)) fail(`Landing range ${value} must name commits after ${base} up to ${head}.`);
  }
  return revisions.join("..");
}

/** The landing record of an implementation: the commits the reviewer supplied,
 * else the target branch head when it contains the final stage head, else unknown. */
function landingRecord(root: string, subject: LandingSubject, landed: string | undefined): LandingRecord {
  const record: LandingRecord = {
    $schema: LANDING_SCHEMA_ID,
    implementationId: subject.implementationId,
    targetBranch: subject.targetBranch,
    finalHeadRevision: subject.finalHeadRevision,
    outcome: "unknown",
    recordedAt: new Date().toISOString(),
  };
  if (landed !== undefined) return { ...record, outcome: "supplied", landedCommits: suppliedLanding(root, subject.targetBranch, landed) };
  const targetHead = gitOptional(["rev-parse", "--verify", "--quiet", `refs/heads/${subject.targetBranch}^{commit}`], { cwd: root });
  if (targetHead && isAncestor(root, subject.finalHeadRevision, targetHead)) return { ...record, outcome: "ancestry", targetRevision: targetHead };
  return record;
}

/** Patch IDs of the commits a `git log -p` range lists, oldest first. */
function commitPatchIds(root: string, range: string[]): Array<{ commit: string; patchId: string }> {
  const log = gitRawBuffer(["log", "--no-merges", "--no-renames", "--no-ext-diff", "--no-textconv", "--reverse", "-p", "--format=commit %H", ...range], { cwd: root });
  if (log.length === 0) return [];
  const ids = new Map(gitRaw(["patch-id", "--stable"], { cwd: root, input: log }).split(/\r?\n/).filter(Boolean).map((line) => {
    const [patchId, commit] = line.split(" ");
    return [commit, patchId] as const;
  }));
  // patch-id skips commits without a diff; the log's order is kept.
  return gitRaw(["rev-list", "--no-merges", "--reverse", ...range], { cwd: root }).split(/\r?\n/).filter(Boolean)
    .flatMap((commit) => { const patchId = ids.get(commit); return patchId ? [{ commit, patchId }] : []; });
}

/** Commits of the target branch since the implementation's base whose changes
 * match the implementation's: one commit with all of them, as a squash merge
 * makes, or a run of commits matching its commits one by one, as a rebase merge
 * makes. Only a suggestion: the target may have made the same edits itself. */
function suggestedLanding(root: string, subject: LandingSubject): string | null {
  // Only a suggestion: when matching fails, there is none.
  try {
    return matchingLanding(root, subject);
  } catch {
    return null;
  }
}

function matchingLanding(root: string, subject: LandingSubject): string | null {
  const targetHead = gitOptional(["rev-parse", "--verify", "--quiet", `refs/heads/${subject.targetBranch}^{commit}`], { cwd: root });
  if (!targetHead) return null;
  // The most recent commits only, so a long-lived archive stays quick to check.
  const candidates = commitPatchIds(root, ["--max-count=1000", targetHead, `^${subject.finalHeadRevision}`, `^${subject.baseRevision}`]);
  if (candidates.length === 0) return null;
  const cumulative = gitRawBuffer(["diff", "--no-renames", "--no-ext-diff", "--no-textconv", subject.baseRevision, subject.finalHeadRevision, "--"], { cwd: root });
  const cumulativeId = cumulative.length === 0 ? undefined : gitRaw(["patch-id", "--stable"], { cwd: root, input: cumulative }).split(" ")[0];
  const squash = candidates.find((candidate) => candidate.patchId === cumulativeId);
  if (squash) return squash.commit;
  const own = commitPatchIds(root, [`${subject.baseRevision}..${subject.finalHeadRevision}`]).map((entry) => entry.patchId);
  if (own.length === 0) return null;
  for (let start = 0; start + own.length <= candidates.length; start++) {
    const run = candidates.slice(start, start + own.length);
    if (!own.every((patchId, offset) => run[offset].patchId === patchId)) continue;
    // Only a chain of commits, each the only parent of the next, is one range.
    const parents = run.map(({ commit }) => commitParents(root, commit));
    if (parents.some((list) => list.length !== 1) || run.some((entry, offset) => offset > 0 && parents[offset][0] !== run[offset - 1].commit)) continue;
    return `${parents[0][0]}..${run.at(-1)?.commit}`;
  }
  return null;
}

/** One line telling what a landing record says. */
function describeLanding(record: LandingRecord): string {
  if (record.outcome === "ancestry") return `landed: ${record.targetBranch} at ${record.targetRevision} contains final stage head ${record.finalHeadRevision}`;
  if (record.outcome === "supplied") return `landed by ${record.landedCommits} on ${record.targetBranch}, as supplied`;
  return "landing unknown";
}

/** A commit on top of the published metadata commit that adds the landing record
 * to the published artifact. */
function buildArchiveCommit(root: string, metadataCommit: string, record: LandingRecord, message: string): string {
  const published = readPublishedArtifact(root, metadataCommit) ?? fail(`Metadata commit ${metadataCommit} publishes no artifact.`);
  const files = new ArtifactDraft(published);
  files.writeJson(ARCHIVE_LANDING_FILE, parseDocument(LANDING_SCHEMA_ID, record, ARCHIVE_LANDING_FILE));
  const tree = buildArtifactTree(root, files, metadataCommit);
  return gitRaw(["commit-tree", tree, "-p", metadataCommit], { cwd: root, input: `${message}\n` });
}

/** The archive of an implementation: its commit, the metadata commit below it, and its landing record. */
function readArchive(root: string, implementationId: string): { commit: string; metadataCommit: string; landing: LandingRecord } {
  const ref = archiveRef(implementationId);
  const commit = gitOptional(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root });
  if (!commit) fail(`No archive of ${implementationId} exists at ${ref}.`);
  const parents = commitParents(root, commit);
  if (parents.length !== 1) fail(`Archive ${ref} must have the metadata commit as its only parent.`);
  const files = readPublishedArtifact(root, commit) ?? fail(`Archive ${ref} holds no artifact.`);
  if (!hasFile(files, ARCHIVE_LANDING_FILE)) fail(`Archive ${ref} has no landing record.`);
  const landing = parseDocument(LANDING_SCHEMA_ID, parseJson(files.read(ARCHIVE_LANDING_FILE).toString("utf8")), files.describe(ARCHIVE_LANDING_FILE));
  return { commit, metadataCommit: parents[0], landing };
}

/** Fails when any of refs is a symbolic ref, even a dangling one: a write
 * through it would move whatever ref it names, such as the target branch. */
function assertDirectRefs(root: string, refs: readonly string[]): void {
  for (const ref of refs) {
    const target = gitOptional(["symbolic-ref", "--quiet", ref], { cwd: root });
    if (target) fail(`${ref} is a symbolic ref to ${target}; Semantic Flow writes only direct refs. Replace it with a branch or remove it.`);
  }
}

/** The archive's shared tag and the commit it names, if it was shared. Any
 * ref at the tag's name counts as shared, so nothing replaces it. */
function sharedArchive(root: string, implementationId: string): { tag: string; commit: string | undefined; annotated: boolean } | undefined {
  const tag = archiveTag(implementationId);
  const object = gitOptional(["rev-parse", "--verify", "--quiet", tag], { cwd: root });
  if (!object) return undefined;
  const annotated = git(["cat-file", "-t", object], { cwd: root }) === "tag";
  return { tag, commit: gitOptional(["rev-parse", "--verify", "--quiet", `${object}^{commit}`], { cwd: root }), annotated };
}

function archiveImplementation(
  workspace: Workspace,
  options: Options,
  validatedArtifact: Artifact | undefined = undefined,
  quiet = false,
): ArchiveSummary {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "archive"));
  // The target may have moved on in any way: landing is recorded, never required.
  const artifact = validatedArtifact ?? validateArtifact(workspace, {
    publish: true,
    quiet: true,
    allowTargetDrift: true,
  });
  if (validatedArtifact) assertValidatedArtifactCurrent(workspace, artifact, true);
  const { implementationId } = artifact.manifest;
  const subject: LandingSubject = {
    implementationId,
    targetBranch: artifact.manifest.targetBranch,
    baseRevision: artifact.manifest.baseRevision,
    finalHeadRevision: lastStageHead(artifact),
  };
  const landing = landingRecord(workspace.root, subject, option(options, "landed"));
  assertDirectRefs(workspace.root, [`refs/heads/${artifact.manifest.targetBranch}`, `refs/heads/${metadataBranch(artifact)}`, archiveRef(implementationId), archiveTag(implementationId)]);
  // What is archived is what is published: an unpublished or outdated artifact is published now.
  const publication = metadataPublicationPlan(workspace, artifact, `Publish ${implementationId} semantic implementation`);
  const message = option(options, "message") ?? `Archive ${implementationId} semantic implementation`;
  const commit = buildArchiveCommit(workspace.root, publication.commit, landing, message);
  const ref = archiveRef(implementationId);
  // One transaction publishes, archives and removes the active artifact; the
  // stage branches must still hold the archived heads.
  const stageChecks = [...artifact.stages.values()].map(({ change }): RefUpdate =>
    ({ ref: `refs/heads/${change.branch}`, next: change.headRevision, previous: change.headRevision }));
  removeArtifact(workspace.root, workspace.snapshot, [
    ...stageChecks,
    publication.update ?? publication.verify ?? fail("The publication has no metadata ref."),
    { ref, next: commit, previous: ZERO_OID },
    { ref: archiveTag(implementationId), next: ZERO_OID, previous: ZERO_OID },
  ]);
  const suggestion = landing.outcome === "unknown" ? suggestedLanding(workspace.root, subject) : null;
  if (!quiet) {
    if (publication.update) console.log(`Published semantic implementation metadata on ${publication.branch} at ${publication.commit}.`);
    console.log(`Archived ${implementationId} at ${ref} (${describeLanding(landing)}).`);
    if (suggestion) console.log(landingSuggestion(implementationId, suggestion));
  }
  return { ref, commit, metadataCommit: publication.commit, landing, suggestedLanding: suggestion };
}

function landingSuggestion(implementationId: string, suggestion: string): string {
  return `Target ${suggestion.includes("..") ? "commits" : "commit"} ${suggestion} ${suggestion.includes("..") ? "match" : "matches"} the implementation's changes. Matching does not show that ${suggestion.includes("..") ? "they" : "it"} landed them; once the reviewer confirms it, record it with: semantic-flow.mjs implementation archive landing --id ${implementationId} --landed ${suggestion}`;
}

/** The --id of a command on an archived implementation. */
function archivedImplementationId(root: string, options: Options): string {
  const implementationId = option(options, "id", { required: true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(implementationId)) fail(`Invalid implementation ID ${implementationId}.`);
  git(["check-ref-format", archiveRef(implementationId)], { cwd: root });
  return implementationId;
}

/** Records where an archived implementation landed: the commits the reviewer
 * supplies, or the target branch once it contains the final stage head. */
function recordArchiveLanding(root: string, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "archive landing"));
  const implementationId = archivedImplementationId(root, options);
  assertDirectRefs(root, [archiveRef(implementationId), archiveTag(implementationId)]);
  const archive = readArchive(root, implementationId);
  const landed = option(options, "landed");
  const shared = sharedArchive(root, implementationId);
  const subject: LandingSubject = {
    implementationId,
    targetBranch: archive.landing.targetBranch,
    baseRevision: loadPublishedBase(root, archive.metadataCommit),
    finalHeadRevision: archive.landing.finalHeadRevision,
  };
  const next = landingRecord(root, subject, landed);
  // Without supplied commits, only finding the landing replaces an unknown one.
  const unchanged = landed === undefined
    ? archive.landing.outcome !== "unknown" || next.outcome === "unknown"
    : archive.landing.outcome === "supplied" && archive.landing.landedCommits === next.landedCommits;
  if (unchanged) {
    console.log(`Archive of ${implementationId} keeps its record (${describeLanding(archive.landing)}).`);
    if (archive.landing.outcome === "unknown") {
      const suggestion = suggestedLanding(root, subject);
      if (suggestion) console.log(landingSuggestion(implementationId, suggestion));
    }
    return;
  }
  if (shared) fail(`The archive of ${implementationId} is shared as tag ${shared.tag}, which never moves, so its landing record stays as shared.`);
  const message = gitRaw(["show", "-s", "--format=%B", archive.commit], { cwd: root }).trimEnd();
  const commit = buildArchiveCommit(root, archive.metadataCommit, next, message);
  updateRefs(root, [
    { ref: archiveRef(implementationId), next: commit, previous: archive.commit },
    { ref: archiveTag(implementationId), next: ZERO_OID, previous: ZERO_OID },
  ]);
  console.log(`Recorded the landing of ${implementationId} (${describeLanding(next)}).`);
}

/** The base revision a published artifact records. */
function loadPublishedBase(root: string, metadataCommit: string): string {
  const files = readPublishedArtifact(root, metadataCommit) ?? fail(`Metadata commit ${metadataCommit} publishes no artifact.`);
  return parseDocument(MANIFEST_SCHEMA_ID, parseJson(files.read("manifest.json").toString("utf8")), files.describe("manifest.json")).baseRevision;
}

/** Shares an archive as an annotated tag. The tag is created once and never moved. */
function shareArchive(root: string, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "archive share"));
  const implementationId = archivedImplementationId(root, options);
  assertDirectRefs(root, [archiveRef(implementationId), archiveTag(implementationId)]);
  const archive = readArchive(root, implementationId);
  const tag = archiveTag(implementationId);
  const shared = sharedArchive(root, implementationId);
  const push = `git push <remote> ${tag}`;
  if (shared) {
    if (!shared.annotated || shared.commit !== archive.commit) fail(`${tag} already exists and is not an annotated tag of the current archive commit ${archive.commit}; a shared archive tag is never moved or replaced.`);
    console.log(`The archive of ${implementationId} is already shared as ${tag}. Push it with: ${push}`);
    return;
  }
  const message = option(options, "message") ?? `Semantic implementation ${implementationId}, ${describeLanding(archive.landing)}`;
  const tagger = git(["var", "GIT_COMMITTER_IDENT"], { cwd: root });
  const tagName = tag.slice("refs/tags/".length);
  // mktag writes the tag object without signing or hooks; the ref is created only if absent.
  const object = gitRaw(["mktag"], { cwd: root, input: `object ${archive.commit}\ntype commit\ntag ${tagName}\ntagger ${tagger}\n\n${message}\n` });
  updateRefs(root, [
    { ref: archiveRef(implementationId), next: archive.commit, previous: archive.commit },
    { ref: tag, next: object, previous: ZERO_OID },
  ]);
  console.log(`Shared the archive of ${implementationId} as ${tag}. Push it with: ${push}`);
}

/** A path with every existing ancestor's links resolved, so containment checks see where it leads. */
function resolvedPath(file: string): string {
  const missing: string[] = [];
  let existing = path.resolve(file);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let real = existing;
  try { real = fs.realpathSync.native(existing); } catch { /* An unavailable root stays as written. */ }
  return path.join(real, ...missing);
}

function exportImplementation(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "export"));
  const artifact = loadImplementation(workspace.root, workspace.snapshot);
  const destination = option(options, "destination");
  if (destination === undefined) {
    console.log(JSON.stringify({
      manifest: artifact.manifest,
      requirements: Object.fromEntries(artifact.requirements),
      stages: Object.fromEntries(artifact.stages),
      workingStages: Object.fromEntries(artifact.workStages),
    }, null, 2));
    return;
  }
  const target = path.resolve(process.cwd(), destination);
  const active = resolvedPath(path.join(workspace.root, ".semantic-review"));
  const resolvedTarget = resolvedPath(target);
  if (resolvedTarget === active || resolvedTarget.startsWith(`${active}${path.sep}`)) {
    fail(`Export destination ${target} must be outside the active artifact.`);
  }
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length > 0)) {
    fail(`Export destination ${target} must be a new or empty directory.`);
  }
  const files = fullFormFiles(artifact, workspace.snapshot);
  for (const stage of artifact.workStages.values()) files.writeJson(stageFile(stage), stage);
  // A failed export removes only what it wrote, so it can be retried.
  exportArtifactFiles(files, target);
  console.log(`Exported ${artifact.manifest.implementationId} to ${target}.`);
}

/** Validates the recorded stack before sync; target ancestry is checked by the caller. */
export function validateSyncStack(root: string): void {
  validateArtifact(openWorkspace(root), { quiet: true, allowTargetDrift: true });
}

export interface WorkflowSummary extends StackSummary {
  worktree: string;
  implementationId: string;
  workingStages: string[];
  /** What `archive` recorded; only in its summary. */
  archive?: ArchiveSummary;
}

/** One validation boundary for a workflow; standalone commands keep their own gates. */
export function implementationWorkflow(
  root: string,
  mode: "validate" | "prepare" | "archive",
  options: Options,
): WorkflowSummary {
  const workspace = openWorkspace(root);
  const publish = mode !== "validate" || flag(options, "publish");
  const artifact = validateArtifact(workspace, { quiet: true, publish, allowTargetDrift: mode === "archive" });
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
    const landed = option(options, "landed");
    summary.archive = archiveImplementation(workspace, new Map(landed === undefined ? [] : [["landed", [landed]]]), artifact, flag(options, "json"));
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
  if (command === "export" && subcommand === undefined) return exportImplementation(openWorkspace(root), options);
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
  if (command === "archive" && subcommand === "landing") return recordArchiveLanding(root, options);
  if (command === "archive" && subcommand === "share") return shareArchive(root, options);
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
