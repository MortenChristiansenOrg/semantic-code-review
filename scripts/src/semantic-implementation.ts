#!/usr/bin/env node
import { captureCodeTarget, validateCodeTarget } from "./shared/insight-targets.js";
import { assertEvidenceDirectories, ensureEvidenceAttributes, evidenceAttachmentErrors, evidenceAttachmentPath, evidenceMediaType, evidenceTreeErrors, evidenceWarnings, MAX_EVIDENCE_ATTACHMENT_BYTES, sha256Hex } from "./shared/evidence.js";

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
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
  activeImplementationId,
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
import { errorCode, errorMessage, isRecord, isStringArray, type JsonRecord } from "./shared/narrow.js";
import { parseDocument } from "./shared/schema-validation.js";
import { gitCommonDirectory, reviewHome, reviewId, withReviewLock, writeReviewId } from "./shared/review-store.js";
import { describeFinalizedStages, emptyStageIds } from "./shared/stage-report.js";
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

/** The message of a stage commit: the stage's title and summary, then its
 * trailers, such as a Co-authored-by trailer for each co-author. A marked empty
 * stage commit also names the stage commit whose changes the target contains. */
function stageCommitMessage(stage: Pick<EditableStage, "title" | "summary">, trailers: readonly string[], emptyOf?: string): string {
  const block = [...(emptyOf ? [`${EMPTY_STAGE_TRAILER}: ${emptyOf}`] : []), ...trailers];
  return [stage.title.trim(), stage.summary.trim(), ...(block.length ? [block.join("\n")] : [])].join("\n\n") + "\n";
}

/** Git options that read trailers with the separators the user configured
 * and with the colon Semantic Flow writes, so neither kind is missed. */
function trailerReading(root: string): string[] {
  // Untrimmed: a space or tab can be a separator.
  let configured = ":";
  try { configured = gitRaw(["config", "--get", "trailer.separators"], { cwd: root }).replace(/\r?\n$/, ""); } catch { /* Unset: Git's default. */ }
  // The first separator is the one Git prints trailers with, so the colon comes first.
  return ["-c", `trailer.separators=:${configured.replaceAll(":", "")}`];
}

const coAuthorTrailer = (identity: string) => `Co-authored-by: ${identity}`;

/** The trailers a stage commit carries over to a rebuilt message: every
 * trailer but the empty-stage marker, which the caller decides. A summary
 * whose last paragraph Git reads as trailers is parsed as such when no
 * trailer follows it, so the lines Git finds there are not taken as trailers. */
function stageTrailers(root: string, commit: string, stage: Pick<EditableStage, "summary">): string[] {
  const reading = trailerReading(root);
  const parse = (args: string[], input?: string) => gitRaw([...reading, ...args], { cwd: root, ...(input === undefined ? {} : { input }) })
    .split(/\0|\r?\n/).map((trailer) => trailer.trim()).filter(Boolean);
  // The summary follows the title in a stage message, as it does here.
  const fromSummary = new Set(parse(["interpret-trailers", "--parse", "--no-divider"], `Title\n\n${stage.summary.trim()}\n`));
  return parse(["show", "-s", "--encoding=UTF-8", "--format=%(trailers:unfold,separator=%x00)", commit])
    .filter((trailer) => !fromSummary.has(trailer) && !new RegExp(`^${EMPTY_STAGE_TRAILER}\\s*:`, "i").test(trailer));
}

/** Everyone who wrote commits in base..head, as authors or co-authors, except
 * author, in order of first appearance. */
function rangeCoAuthors(root: string, base: string, head: string, author: string): string[] {
  // Only the trailer block counts: a Co-authored-by line in the body is text,
  // not attribution. A message cannot hold NUL, so NUL separates the values
  // and two of them start each commit.
  // The range holds the user's commits and the stage commit Semantic Flow wrote.
  const log = gitRaw([...trailerReading(root), "log", "--encoding=UTF-8", "--reverse", "--format=%x00%x00%an <%ae>%x00%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x00)", `${base}..${head}`], { cwd: root });
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
  // An unchanged stage keeps its commit here; withStageMessage brings its message up to date.
  if (count === 1 && keepOneCommit) return head;
  const author = currentIdentity(root);
  const message = stageCommitMessage(stage, rangeCoAuthors(root, base, head, author).map(coAuthorTrailer));
  const [authorDate, committerDate, existing] = gitRaw(["show", "-s", "--encoding=UTF-8", "--format=%aI%x00%cI%x00%B", head], { cwd: root }).split("\0");
  if (count === 1 && existing.trimEnd() === message.trimEnd()) return head;
  // The folded head's dates make the fold repeatable: folding the same commits again gives the same commit.
  return gitRaw([...UTF8_COMMITS, "commit-tree", `${head}^{tree}`, "-p", base], {
    cwd: root,
    input: message,
    env: { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate },
  });
}

/** commit with the message its stage now generates: the current title and
 * summary over the commit's own trailers. Its tree, parent, authors and dates
 * stay, so a commit whose message is current is returned as it is. */
function withStageMessage(root: string, stage: Pick<EditableStage, "title" | "summary">, commit: string): string {
  const message = stageCommitMessage(stage, stageTrailers(root, commit, stage), emptyStageMarker(root, commit));
  if (commitMetadata(root, commit).message.trimEnd() === message.trimEnd()) return commit;
  return replayedCommit(root, `${commit}^{tree}`, `${commit}^`, commit, message);
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

function stageNodeErrors(stage: EditableStage, files: FileChange[], diffContext: DiffContext | undefined = undefined, membership = true): string[] {
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

  // An empty stage has no diff for its nodes to cover; its node IDs and links are still checked.
  if (!membership) return errors;
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
    // An emptied stage keeps the nodes of its change, which no diff covers now.
    errors.push(...stageNodeErrors(stage, stage.change.files, undefined, stage.change.files.length > 0));
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
    if (files.length === 0) {
      if (!isMarkedEmptyStage(workspace.root, head)) fail(`Stage ${id} changes nothing, and its commit is not marked as an empty stage.`);
      continue;
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
  /** Only the commands that complete or discard a pending restack read past it. */
  allowPendingRestack?: boolean;
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
    allowPendingRestack = false,
  }: ArtifactValidationOptions = {},
  files: ArtifactFiles | undefined = workspace.snapshot,
): Artifact {
  if (!files) throw new Error("Validation requires the artifact's files.");
  if (!allowPendingRestack) {
    const pending = readPendingRestack(files);
    if (pending) fail(pendingRestackNote(pending));
  }
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
  const empty = mode === "schema" ? [] : emptyStageIds(artifact.manifest.stages.map((id) => finalizedStage(artifact, id)));
  return `Semantic implementation ${mode} validation passed: ${artifact.requirements.size} specification(s), ${describeFinalizedStages(artifact.stages.size, empty)}, ${artifact.workStages.size} working stage(s).`;
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
  /** The marked empty finalized stages. */
  emptyStages: string[];
}

/** Fully validates the implementation in root, as `implementation validate` does. */
export function validateImplementation(root: string): ImplementationValidation {
  return withValidationContext(() => {
    const artifact = validateArtifact(openWorkspace(root), { quiet: true });
    return {
      message: validationMessage(artifact, "full"),
      warnings: [...artifact.stages.values()].flatMap((stage) => evidenceWarnings(stage)),
      emptyStages: emptyStageIds(artifact.manifest.stages.map((id) => finalizedStage(artifact, id))),
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
  assertBranchOutsideOwnNames(`${branchPrefix}/`, "Branch prefix", branchPrefix);
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
  if (finalized && (title !== undefined || summary !== undefined)) {
    console.log(`Its commit message takes the new title and summary at the next restack, such as implementation restack --from ${id} with its stage branch checked out.`);
  }
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
      if (change.files.length === 0) warnCorrectedEmptyStage(workspace.root, stageId, change.headRevision);
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
      "--encoding=UTF-8",
      // The message ends at the last NUL, so it is passed on exactly as written.
      "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B%x00",
      commit,
    ],
    { cwd: root, encoding: "buffer" },
  ).toString("utf8").split("\0");
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

/** A commit of tree on parent that keeps the author, committer, dates and
 * message of source, so replaying the same stage gives the same commit. */
function replayedCommit(root: string, tree: string, parent: string, source: string, message?: string): string {
  const metadata = commitMetadata(root, source);
  return gitRaw([...UTF8_COMMITS, "commit-tree", tree, "-p", parent], {
    cwd: root,
    input: message ?? metadata.message,
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

/** Whether two commits have the same tree. */
function sameTree(root: string, left: string, right: string): boolean {
  const [leftTree, rightTree] = git(["rev-parse", `${left}^{tree}`, `${right}^{tree}`], { cwd: root }).split(/\r?\n/);
  return leftTree === rightTree;
}

/** The trailer that marks a stage commit whose changes the target already
 * contains. Its value is the stage commit it replaced, which the artifact keeps
 * reachable, so a later restack can replay the stage again. */
const EMPTY_STAGE_TRAILER = "Semantic-Flow-Empty";

/** The marker value of a stage resolved to nothing at a restack conflict: its
 * changes are not replayed again, since the resolution dropped them. */
const RESOLVED_EMPTY = "resolved";

/** The marker of a marked empty stage commit, a commit with its parent's tree
 * and the marker trailer: the stage commit it replaced, or RESOLVED_EMPTY.
 * Undefined when head is not one. */
function emptyStageMarker(root: string, head: string): string | undefined {
  const [tree, parent, ...markers] = gitRaw([...trailerReading(root), "show", "-s", "--encoding=UTF-8", `--format=%T%x00%P%x00%(trailers:key=${EMPTY_STAGE_TRAILER},valueonly,unfold,separator=%x00)`, head], { cwd: root }).split("\0");
  if (!parent || parent.includes(" ")) return undefined;
  if (tree !== git(["rev-parse", `${parent}^{tree}`], { cwd: root })) return undefined;
  return markers.map((value) => value.trim()).find((value) => value === RESOLVED_EMPTY || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value));
}

/** The stage commit a marked empty stage commit replaced, which a restack replays. */
/** Warns that a correction to an emptied stage gives up the replay of the commit its marker names. */
function warnCorrectedEmptyStage(root: string, id: string, recordedHead: string): void {
  const source = emptyStageSource(root, recordedHead);
  if (source) console.error(`semantic-implementation: stage ${id} was empty in place of ${source}; its correction now defines the stage, so the changes of ${source} no longer come back if the target drops them.`);
}

function emptyStageSource(root: string, head: string): string | undefined {
  const marker = emptyStageMarker(root, head);
  return marker === RESOLVED_EMPTY ? undefined : marker;
}

function isMarkedEmptyStage(root: string, head: string): boolean {
  return emptyStageMarker(root, head) !== undefined;
}

/** The marked empty commit an emptied stage becomes on parent. source is the
 * stage commit whose changes parent contains; when it is itself a marked empty
 * commit, its marker is kept. A stage resolved to nothing is marked as such. */
function emptyStageCommit(root: string, stage: Pick<EditableStage, "title" | "summary">, parent: string, source: string, resolved = false): string {
  const original = resolved ? RESOLVED_EMPTY : emptyStageMarker(root, source) ?? source;
  return replayedCommit(root, `${parent}^{tree}`, parent, source, stageCommitMessage(stage, stageTrailers(root, source, stage), original));
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
  branch: string;
  previousHead: string;
  nextHead: string;
  baseBranch: string;
  baseRevision: string;
  emptied: boolean;
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
    /** The stage now changes nothing (the target contains its changes, or a resolution dropped them); it stays as a marked empty commit. */
    emptied: boolean;
  }>;
}

/** Where a stage's own changes start. A stage rebuilt on the stage below's
 * current head starts there; one rebuilt on an earlier correction below starts
 * at the newest commit it shares with that stage. Either way the correction is
 * not replayed as the stage's own change. Otherwise it starts at its recorded
 * base. When the stage below took in this stage's recorded commit other than
 * through the target, no start tells their changes apart, so the restack stops
 * before moving anything. */
function rebuiltStageBase(
  root: string,
  stage: { id: string; recordedBase: string; recordedHead: string; head: string },
  below: { id: string; head: string } | undefined,
  target: string,
): string {
  const { recordedBase, recordedHead, head } = stage;
  if (below === undefined || below.head === recordedBase) return recordedBase;
  // A target that merged this stage passes its commit to a stage rebuilt on it; the stage replays from its recorded base.
  if (isAncestor(root, recordedHead, target)) return recordedBase;
  if (isAncestor(root, recordedHead, below.head)) {
    fail(`Stage ${below.id} holds the commit ${recordedHead} of stage ${stage.id}, so restack cannot tell their changes apart. No refs were changed. Remove that commit from ${below.id}'s branch, or move its changes into one of the stages.`);
  }
  if (isAncestor(root, below.head, head)) return below.head;
  const shared = gitOptional(["merge-base", below.head, head], { cwd: root });
  return shared && shared !== recordedBase && isAncestor(root, recordedBase, shared) ? shared : recordedBase;
}

/** Where a restack that stopped at a conflict is recorded in the active artifact. */
/** Commits are written in UTF-8, the encoding every read asks Git for, whatever i18n.commitEncoding says. */
const UTF8_COMMITS = ["-c", "i18n.commitEncoding=UTF-8"];
const PENDING_RESTACK_FILE = ".work/restack.json";

/** A restack that stopped at a conflict. It is completed with `restack
 * --continue` or discarded with `restack --abort`. */
interface PendingRestack {
  mode: "base" | "stage";
  fromStage: string | null;
  newBase: string;
  /** The artifact snapshot the restack read; nothing else in it may change until it completes. */
  startSnapshot: string;
  /** Every ref the restack moves or depends on, as it read them. */
  refs: Record<string, string>;
  /** Stages already replayed, bottom-up. */
  plans: RestackPlan[];
  /** The stage that conflicted: its commit, cherry-picked onto parent in worktree. */
  conflict: { id: string; previousHead: string; stageCommit: string; parent: string };
  worktree: string;
  /** The checkout sync detached so the restack could move its stage branch; --continue and --abort switch it back. */
  checkout?: DetachedCheckout;
}

/** A worktree that had branch checked out at head and was detached so a restack could move the branch. */
export interface DetachedCheckout {
  worktree: string;
  branch: string;
  head: string;
}

function readPendingRestack(files: ArtifactFiles): PendingRestack | undefined {
  if (files.type(PENDING_RESTACK_FILE) === undefined) return undefined;
  const invalid = (): never => fail(`${files.describe(PENDING_RESTACK_FILE)} does not describe a restack; run restack --abort.`);
  const value: unknown = parseJson(files.read(PENDING_RESTACK_FILE).toString("utf8"));
  const record = isRecord(value) ? value : invalid();
  const text = (from: JsonRecord, key: string): string => { const field = from[key]; return typeof field === "string" ? field : invalid(); };
  const sha = (from: JsonRecord, key: string): string => { const field = text(from, key); return /^[0-9a-f]{40,64}$/.test(field) ? field : invalid(); };
  const mode = record.mode === "base" || record.mode === "stage" ? record.mode : invalid();
  const conflict = isRecord(record.conflict) ? record.conflict : invalid();
  const refRecord = isRecord(record.refs) ? record.refs : invalid();
  const refs: Record<string, string> = {};
  for (const ref of Object.keys(refRecord)) refs[ref] = sha(refRecord, ref);
  const plans = (Array.isArray(record.plans) ? record.plans : invalid()).map((entry: unknown): RestackPlan => {
    const plan = isRecord(entry) ? entry : invalid();
    return {
      id: text(plan, "id"),
      branch: text(plan, "branch"),
      previousHead: sha(plan, "previousHead"),
      nextHead: sha(plan, "nextHead"),
      baseBranch: text(plan, "baseBranch"),
      baseRevision: sha(plan, "baseRevision"),
      emptied: typeof plan.emptied === "boolean" ? plan.emptied : invalid(),
    };
  });
  return {
    mode,
    fromStage: record.fromStage === null ? null : text(record, "fromStage"),
    newBase: sha(record, "newBase"),
    startSnapshot: sha(record, "startSnapshot"),
    refs,
    plans,
    conflict: { id: text(conflict, "id"), previousHead: sha(conflict, "previousHead"), stageCommit: sha(conflict, "stageCommit"), parent: sha(conflict, "parent") },
    worktree: text(record, "worktree"),
    ...(record.checkout === undefined ? {} : { checkout: (() => {
      const checkout = isRecord(record.checkout) ? record.checkout : invalid();
      return { worktree: text(checkout, "worktree"), branch: text(checkout, "branch"), head: sha(checkout, "head") };
    })() }),
  };
}

/** Switches a worktree the restack's caller detached back to its branch, once
 * the restack completed or was discarded. Only a registered worktree of this
 * repository that is still detached where it was left goes back, and only to
 * one of the implementation's stage branches. Its notes go to stderr, so JSON
 * output stays valid. */
function restoreDetachedCheckout(root: string, checkout: DetachedCheckout, branchHead: string, stageBranches: ReadonlySet<string>): void {
  const { worktree, branch, head } = checkout;
  const leave = (reason: string) => console.error(`semantic-implementation: ${worktree} was left as it is, because ${reason}; check out ${branch} there if it is still wanted.`);
  const real = (candidate: string) => {
    let resolved = path.resolve(candidate);
    try { resolved = fs.realpathSync.native(candidate); } catch { /* A missing path compares as written. */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (!stageBranches.has(branch)) return leave(`${branch} is not a stage branch of the implementation`);
  const registered = git(["worktree", "list", "--porcelain"], { cwd: root }).split(/\r?\n/)
    .filter((line) => line.startsWith("worktree ")).map((line) => real(line.slice("worktree ".length)));
  if (!registered.includes(real(worktree))) return leave("it is no longer a worktree of this repository");
  let current: string | undefined, detachedAt: string;
  try {
    // A stale registration's path may now hold another repository.
    if (gitCommonDirectory(worktree) !== gitCommonDirectory(root)) return leave("it now belongs to another repository");
    // A plain directory at a stale registration's path resolves to the checkout around it.
    // Untrimmed: a directory name may end in a space.
    if (real(gitRaw(["rev-parse", "--show-toplevel"], { cwd: worktree }).replace(/\r?\n$/, "")) !== real(worktree)) return leave("it is no longer a worktree root");
    current = gitOptional(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktree });
    detachedAt = git(["rev-parse", "HEAD"], { cwd: worktree });
  } catch {
    return leave("it can no longer be read");
  }
  if (current !== undefined || detachedAt !== head) return leave(`it is no longer detached at ${head}`);
  if (checkedOutBranches(root).has(branch)) return leave(`${branch} is checked out elsewhere`);
  const now = gitOptional(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: root });
  if (now !== branchHead) return leave(now ? `${branch} moved` : `${branch} no longer exists`);
  // An ignored local file the branch tracks is not overwritten; Git refuses instead.
  try {
    git(["switch", "--quiet", "--no-overwrite-ignore", branch], { cwd: worktree });
  } catch (error) {
    // A failing post-checkout hook reports failure after the switch happened.
    if (gitOptional(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktree }) !== `refs/heads/${branch}`) return leave(`switching failed: ${errorMessage(error)}`);
    console.error(`semantic-implementation: switching ${worktree} to ${branch} reported: ${errorMessage(error)}`);
  }
  console.error(`Switched ${worktree} back to ${branch}.`);
}

/** The stage branches of the active artifact, or none when it cannot be read. */
function artifactStageBranches(workspace: Workspace): Set<string> {
  try {
    const artifact = loadImplementation(workspace.root, workspace.snapshot, { includeWork: false });
    return new Set(artifact.manifest.stages.map((id) => finalizedStage(artifact, id).change.branch));
  } catch { return new Set(); }
}

function pendingRestackNote(pending: PendingRestack): string {
  return `A restack stopped at a conflict in stage ${pending.conflict.id}. Resolve it in ${pending.worktree} and run implementation restack --continue, or discard it with implementation restack --abort.`;
}

/** The scratch worktree restacks replay stages in. It lives in the user data
 * root, outside every checkout of the repository, and no hook runs in it. */
class ScratchWorktree {
  private constructor(readonly root: string, readonly path: string) {}

  /** Where the restacks of an implementation replay stages. */
  static location(root: string, implementationId: string): string {
    const repository = gitCommonDirectory(root);
    const key = createHash("sha256").update(`${repository}\0${implementationId}`).digest("hex").slice(0, 16);
    return path.join(reviewHome(), "restacks", key);
  }

  /** Creates the worktree, detached at commit, replacing what an interrupted restack left there. */
  static create(root: string, location: string, commit: string): ScratchWorktree {
    ScratchWorktree.discard(root, location);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    const scratch = new ScratchWorktree(root, location);
    gitRaw([...scratch.config(), "worktree", "add", "--detach", "--force", location, commit], { cwd: root });
    return scratch;
  }

  /** The worktree a pending restack left, if it still exists. */
  static open(root: string, location: string): ScratchWorktree | undefined {
    if (!fs.existsSync(location)) return undefined;
    // Git lists real paths, which differ from the configured one under a symlink such as macOS's /var.
    const real = (candidate: string) => {
      const resolved = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : path.resolve(candidate);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const wanted = real(location);
    const listed = git(["worktree", "list", "--porcelain"], { cwd: root }).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => real(line.slice("worktree ".length)));
    return listed.includes(wanted) ? new ScratchWorktree(root, location) : undefined;
  }

  /** Whether location is where this implementation's restacks replay; nothing else is ever deleted. */
  static isCanonical(root: string, implementationId: string, location: string): boolean {
    const normal = (candidate: string) => process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
    return normal(location) === normal(ScratchWorktree.location(root, implementationId));
  }

  /** Removes the worktree at location and its registration, whatever state it is in. */
  static discard(root: string, location: string): void {
    // A symbolic link put where the worktree was is removed itself, never followed.
    let link = false;
    try { link = fs.lstatSync(location).isSymbolicLink(); } catch { /* Nothing there. */ }
    if (link) {
      fs.unlinkSync(location);
      git(["worktree", "prune"], { cwd: root, allowFailure: true });
      return;
    }
    git(["worktree", "remove", "--force", "--force", location], { cwd: root, allowFailure: true });
    // Windows can hold a file open briefly; the registration goes once the folder is gone.
    fs.rmSync(location, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    git(["worktree", "prune"], { cwd: root, allowFailure: true });
  }

  /** Options that keep the user's hooks, signing, recorded resolutions and
   * file system monitor out of the scratch worktree. */
  private config(): string[] {
    return [
      "-c", `core.hooksPath=${path.join(path.dirname(this.path), ".no-hooks")}`,
      "-c", "commit.gpgSign=false",
      "-c", "rerere.enabled=false",
      "-c", "core.fsmonitor=false",
    ];
  }

  run(args: string[], allowFailure = false): string {
    if (allowFailure) return git([...this.config(), ...args], { cwd: this.path, allowFailure: true }) ?? "";
    return gitRaw([...this.config(), ...args], { cwd: this.path });
  }

  /** Detaches at commit with a clean index and worktree; untracked files the agent left are removed, ignored ones kept.
   * HEAD is detached first, so the reset never moves a branch checked out there. */
  reset(commit: string): void {
    this.run(["update-ref", "--no-deref", "HEAD", commit]);
    this.run(["reset", "--quiet", "--hard", "HEAD"]);
    this.run(["clean", "--quiet", "-d", "--force"]);
  }

  /** Puts a staged resolution back after a --continue that could not finish:
   * HEAD at parent, the index and files at tree, and the stage commit being picked. */
  restoreResolution(parent: string, tree: string, stageCommit: string): void {
    this.reset(parent);
    this.run(["read-tree", "--reset", "-u", tree]);
    this.run(["update-ref", "--no-deref", "CHERRY_PICK_HEAD", stageCommit]);
  }

  /** Whether HEAD is detached at parent with commit being picked, as a conflict left it. */
  holdsConflictOf(parent: string, stageCommit: string): boolean {
    return this.run(["symbolic-ref", "--quiet", "HEAD"], true) === "" &&
      this.head() === parent &&
      this.run(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], true) === stageCommit;
  }

  /** Paths with changes that are not staged, untracked files included. */
  unstaged(): string[] {
    // Read untrimmed: a status entry starts with a space when only the worktree changed.
    const entries = gitRaw([...this.config(), "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: this.path, encoding: "buffer" })
      .toString("utf8").split("\0");
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const [staged, unstaged] = [entry[0], entry[1]];
      if (unstaged !== " " || staged === "?") paths.push(entry.slice(3));
      // A rename or copy names its source in the next entry.
      if (staged === "R" || staged === "C") index++;
    }
    return paths;
  }

  /** Applies commit to the checkout with a real merge; false when it conflicts.
   * A conflict records commit as CHERRY_PICK_HEAD, which --no-commit leaves out:
   * it shows the pick in git status, and a reset or commit there removes it. */
  cherryPick(commit: string): boolean {
    try {
      gitRaw([...this.config(), "cherry-pick", "--no-commit", commit], { cwd: this.path });
      return true;
    } catch (error) {
      if (this.unmerged().length > 0) {
        this.run(["update-ref", "--no-deref", "CHERRY_PICK_HEAD", commit]);
        return false;
      }
      fail(`Replaying ${commit} in ${this.path} failed without a conflict to resolve: ${errorMessage(error)}`);
    }
  }

  unmerged(): string[] {
    return [...new Set(this.run(["ls-files", "--unmerged", "-z"]).split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\t") + 1)))];
  }

  /** The tree of the staged result. */
  writeTree(): string {
    return this.run(["write-tree"]);
  }

  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }
}

/** Runs operation while no other restack, --continue or --abort of the
 * workspace's implementation runs, and only while the artifact is still the
 * snapshot the workspace read: each of them replaces or removes the scratch
 * worktree, which another one may be using. A second one fails at once. */
function withRestackLock<T>(workspace: Workspace, operation: () => T): T {
  const implementationId = activeImplementationId(workspace.root, workspace.snapshot);
  const lock = `${ScratchWorktree.location(workspace.root, implementationId)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // The lock appears with its owner's unique marker already in it, so its owner
  // is always known, and only that owner's marker is ever removed with it.
  const claim = fs.mkdtempSync(`${lock}.claim-`);
  const marker = `owner-${randomUUID()}`;
  fs.writeFileSync(path.join(claim, marker), String(process.pid));
  const busy = () => fail("Another restack of this implementation is running. Wait for it to finish, then run the command again.");
  /** Removes the lock only while it still holds this marker: rmdir refuses a lock another owner has since taken. */
  const remove = (owner: string) => {
    try { fs.unlinkSync(path.join(lock, owner)); fs.rmdirSync(lock); } catch { /* Another owner holds it now. */ }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(claim, lock); break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(errorCode(error) ?? "") || attempt > 0) busy();
        let owners: string[] = [];
        try { owners = fs.readdirSync(lock).filter((entry) => entry.startsWith("owner-")); } catch { /* Released meanwhile. */ }
        if (owners.length !== 1) continue;
        let pid = Number.NaN;
        try { pid = Number(fs.readFileSync(path.join(lock, owners[0]), "utf8")); } catch { continue; }
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); busy(); }
          catch (signalError) { if (errorCode(signalError) !== "ESRCH") busy(); }
        }
        // Its owner is gone: the lock is left over from a process that died.
        remove(owners[0]);
      }
    }
  } finally {
    fs.rmSync(claim, { recursive: true, force: true });
  }
  try {
    const current = gitOptional(["rev-parse", "--verify", "--quiet", activeRef(implementationId)], { cwd: workspace.root });
    if (current !== workspace.snapshot.version) fail("The semantic implementation changed while the command started. Run it again.");
    return operation();
  } finally {
    remove(marker);
  }
}

class RestackConflict extends Error {
  constructor(readonly conflict: PendingRestack["conflict"], readonly files: string[]) {
    super(`Stage ${conflict.id} conflicts.`);
  }
}

/** A restack in progress: the stages replayed so far and where the next one goes. */
interface RestackRun {
  mode: "base" | "stage";
  fromStage: string | null;
  newBase: string;
  plans: RestackPlan[];
  next: number;
  parentBranch: string;
  parentHead: string;
  scratch: ScratchWorktree | undefined;
  location: string;
  /** The resolution --continue resumed from: restored in the worktree when the restack cannot finish, so it is not lost. */
  resumed?: { parent: string; tree: string; stageCommit: string };
  /** The checkout the caller detached for this restack. */
  checkout?: DetachedCheckout;
}

/** Replays the stages from run.next up, bottom-up. A stage whose branch builds
 * on the new parent is accepted and folded; any other is cherry-picked onto it in
 * the scratch worktree. Throws RestackConflict and keeps the worktree when a
 * stage conflicts. */
function replayStages(root: string, artifact: Artifact, run: RestackRun, heads: ReadonlyMap<string, string>): void {
  for (; run.next < artifact.manifest.stages.length; run.next++) {
    const id = artifact.manifest.stages[run.next];
    const stage = finalizedStage(artifact, id);
    const branch = stage.change.branch;
    const actualHead = heads.get(branch) ?? fail(`Stage branch ${branch} is missing.`);
    // A stage whose branch moved was corrected; it is folded into one commit again.
    const unchanged = actualHead === stage.change.headRevision;
    if (!unchanged && stage.change.files.length === 0) warnCorrectedEmptyStage(root, id, stage.change.headRevision);
    // An emptied stage replays the stage commit it replaced, in case the target
    // no longer contains it; one resolved to nothing stays empty. Either is
    // decided before folding, so commits of the target never fold into it.
    const marker = unchanged && stage.change.files.length === 0 ? emptyStageMarker(root, actualHead) : undefined;
    const replaced = marker === RESOLVED_EMPTY ? undefined : marker;
    const replayable = replaced !== undefined && gitOptional(["cat-file", "-e", `${replaced}^{commit}`], { cwd: root }) !== undefined;
    let nextHead: string;
    // A stage whose commit the new parent already holds, as after a fast-forward,
    // is replayed too: the parent may have reverted its changes since.
    const integrated = isAncestor(root, actualHead, run.parentHead);
    if (marker === RESOLVED_EMPTY || (replaced !== undefined && !replayable)) {
      if (marker !== RESOLVED_EMPTY) console.error(`semantic-implementation: stage ${id} stays empty: the stage commit ${replaced} its marker names no longer exists, so its changes cannot be replayed.`);
      nextHead = emptyStageCommit(root, stage, run.parentHead, actualHead);
    } else if (replaced === undefined && !integrated && isAncestor(root, run.parentHead, actualHead)) {
      // A title or summary edited since the stage was folded reaches its commit here.
      nextHead = withStageMessage(root, stage, foldStage(root, stage, run.parentHead, actualHead, `Stage ${id}`, unchanged));
      // A correction that takes out every change of the stage drops them on purpose.
      if (sameTree(root, nextHead, run.parentHead)) nextHead = emptyStageCommit(root, stage, run.parentHead, nextHead, true);
    } else {
      const belowId = run.next > 0 ? artifact.manifest.stages[run.next - 1] : undefined;
      const belowHead = belowId === undefined ? undefined : heads.get(finalizedStage(artifact, belowId).change.branch);
      const stageBase = rebuiltStageBase(
        root,
        { id, recordedBase: stage.change.baseRevision, recordedHead: stage.change.headRevision, head: actualHead },
        belowId === undefined || belowHead === undefined ? undefined : { id: belowId, head: belowHead },
        run.newBase,
      );
      const stageCommit = replaced ?? foldStage(root, stage, stageBase, actualHead, `Stage ${id}`, unchanged);
      // A correction that takes out every change of the stage drops them on purpose, wherever it replays.
      const dropped = replaced === undefined && sameTree(root, stageCommit, `${stageCommit}^`);
      if (run.scratch) run.scratch.reset(run.parentHead);
      else run.scratch = ScratchWorktree.create(root, run.location, run.parentHead);
      if (!run.scratch.cherryPick(stageCommit)) {
        throw new RestackConflict({ id, previousHead: actualHead, stageCommit, parent: run.parentHead }, run.scratch.unmerged());
      }
      nextHead = stageResult(root, stage, run.scratch.writeTree(), run.parentHead, stageCommit, dropped);
    }
    run.plans.push({
      id,
      branch,
      previousHead: actualHead,
      nextHead,
      baseBranch: run.parentBranch,
      baseRevision: run.parentHead,
      emptied: sameTree(root, nextHead, run.parentHead),
    });
    run.parentBranch = branch;
    run.parentHead = nextHead;
  }
}

/** The stage commit an emptied stage's marker names, which a later restack replays. */
function replacedBy(root: string, plan: Pick<RestackPlan, "emptied" | "nextHead">): string[] {
  const source = plan.emptied ? emptyStageSource(root, plan.nextHead) : undefined;
  // A marker can name a commit that no longer exists; only existing commits can be kept.
  return source && gitOptional(["cat-file", "-e", `${source}^{commit}`], { cwd: root }) !== undefined ? [source] : [];
}

/** The commit a replayed stage becomes: its tree on parent with the stage
 * commit's authors and trailers under the stage's current title and summary,
 * or a marked empty commit when the target already contains its changes. */
function stageResult(root: string, stage: Stage, tree: string, parent: string, stageCommit: string, resolved = false): string {
  if (tree === git(["rev-parse", `${parent}^{tree}`], { cwd: root })) return emptyStageCommit(root, stage, parent, stageCommit, resolved);
  return replayedCommit(root, tree, parent, stageCommit, stageCommitMessage(stage, stageTrailers(root, stageCommit, stage)));
}

function restack(workspace: Workspace, options: Options): void {
  assertKnownOptions(options, commandOptionNames(semanticImplementationApi, "restack"));
  const fromId = option(options, "from");
  const baseOption = option(options, "base");
  const proceed = flag(options, "continue");
  const abort = flag(options, "abort");
  // Reject a malformed --json before the restack rewrites any refs.
  const json = flag(options, "json");
  if ([fromId !== undefined || baseOption !== undefined, proceed, abort].filter(Boolean).length > 1) {
    fail("restack takes --from or --base to start, or --continue or --abort for a pending restack.");
  }
  if (abort) {
    withRestackLock(workspace, () => abortRestack(workspace));
    return;
  }
  const summary = withRestackLock(workspace, () => proceed ? continueRestack(workspace) : restackStages(workspace, { fromId, baseOption }));
  if (json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(
      `Restacked ${summary.refreshedStages} stage(s) ${
        summary.mode === "base"
          ? `onto ${summary.targetBranch}`
          : `from ${summary.fromStage}`
      }; rewrote ${summary.rewrittenBranches} ${
        summary.rewrittenBranches === 1 ? "branch" : "branches"
      }.${emptiedStagesNote(workspace.root, summary)}`,
    );
  }
}

/** What a restack says about its empty stages: why the ones it emptied change
 * nothing, and which stayed empty. */
function emptiedStagesNote(root: string, summary: RestackSummary): string {
  const notes: string[] = [];
  const emptied = summary.stages.filter((stage) => stage.emptied);
  const already = emptied.filter((stage) => isMarkedEmptyStage(root, stage.previousHead));
  const dropped = emptied.filter((stage) => !already.includes(stage) && emptyStageMarker(root, stage.nextHead) === RESOLVED_EMPTY);
  const contained = emptied.filter((stage) => !already.includes(stage) && !dropped.includes(stage));
  const ids = (stages: typeof emptied) => stages.map(({ id }) => id).join(", ");
  if (contained.length) notes.push(`Stage(s) ${ids(contained)} now change nothing, because the target or the stages below already contain their changes.`);
  if (dropped.length) notes.push(`Stage(s) ${ids(dropped)} now change nothing, because a conflict resolution or a correction dropped their changes.`);
  if (already.length) notes.push(`Stage(s) ${ids(already)} stay empty.`);
  return notes.length ? ` ${notes.join(" ")} Empty stages stay in the implementation as marked empty stages, which stack preparation skips.` : "";
}

/** Restacks every stage onto the current target branch head. checkout names
 * a stage branch the caller detached for it; a restack that stops at a
 * conflict records it, so --continue and --abort switch the worktree back. */
export function restackOntoTarget(root: string, base: string, checkout?: DetachedCheckout): RestackSummary {
  return withValidationContext(() => {
    const workspace = openWorkspace(root);
    return withRestackLock(workspace, () => restackStages(workspace, { baseOption: base, checkout }));
  });
}

function restackStages(
  workspace: Workspace,
  { fromId, baseOption, checkout }: { fromId?: string; baseOption?: string; checkout?: DetachedCheckout },
): RestackSummary {
  assertCleanWorkingTree(workspace.root, "Restacking");
  const pending = readPendingRestack(workspace.snapshot);
  if (pending) fail(pendingRestackNote(pending));
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
  const targetRef = `refs/heads/${artifact.manifest.targetBranch}`;
  const targetHead = branchCommit(workspace.root, artifact.manifest.targetBranch);
  if (baseOption && newBase !== targetHead) {
    fail(
      `New base ${newBase} must equal target branch ${artifact.manifest.targetBranch} head ${targetHead}.`,
    );
  }

  // Every ref the restack depends on, read once: the result is computed from these.
  const refs = new Map<string, string>([[targetRef, targetHead]]);
  const heads = new Map<string, string>();
  for (const id of artifact.manifest.stages) {
    const branch = finalizedStage(artifact, id).change.branch;
    const head = branchCommit(workspace.root, branch);
    refs.set(`refs/heads/${branch}`, head);
    heads.set(branch, head);
  }
  const run: RestackRun = {
    mode: baseOption ? "base" : "stage",
    fromStage: fromId ?? null,
    newBase,
    plans: [],
    next: startIndex,
    parentBranch: artifact.manifest.targetBranch,
    parentHead: newBase,
    scratch: undefined,
    location: ScratchWorktree.location(workspace.root, artifact.manifest.implementationId),
    ...(checkout ? { checkout } : {}),
  };
  for (const id of artifact.manifest.stages.slice(0, startIndex)) {
    const stage = finalizedStage(artifact, id);
    if (heads.get(stage.change.branch) !== stage.change.headRevision) {
      fail(`Stage ${id} moved before the requested restack range; start from ${id}.`);
    }
    run.parentBranch = stage.change.branch;
    run.parentHead = stage.change.headRevision;
  }
  return runRestack(workspace, artifact, run, refs, heads, workspace.snapshot.version);
}

/** Replays the remaining stages and moves every ref at once, or records the
 * restack as pending when a stage conflicts. */
function runRestack(
  workspace: Workspace,
  artifact: Artifact,
  run: RestackRun,
  refs: ReadonlyMap<string, string>,
  heads: ReadonlyMap<string, string>,
  startSnapshot: string,
): RestackSummary {
  // A pending restack keeps its worktree, with the resolution staged again, until it completes or is aborted.
  const keepOrDiscard = () => {
    if (run.resumed && run.scratch) run.scratch.restoreResolution(run.resumed.parent, run.resumed.tree, run.resumed.stageCommit);
    else if (!run.resumed && run.scratch) ScratchWorktree.discard(workspace.root, run.scratch.path);
  };
  /** Keeps or discards the worktree, then rethrows original; a failed recovery is reported beside it, never instead. */
  const recover = (original: unknown): never => {
    try { keepOrDiscard(); }
    catch (recoveryError) {
      fail(`${errorMessage(original)}\nRestoring the restack worktree ${run.location} did not complete: ${errorMessage(recoveryError)}`);
    }
    throw original;
  };
  try {
    replayStages(workspace.root, artifact, run, heads);
  } catch (error) {
    if (!(error instanceof RestackConflict)) return recover(error);
    const pending: PendingRestack = {
      mode: run.mode,
      fromStage: run.fromStage,
      newBase: run.newBase,
      startSnapshot,
      refs: Object.fromEntries(refs),
      plans: run.plans,
      conflict: error.conflict,
      worktree: run.location,
      ...(run.checkout ? { checkout: run.checkout } : {}),
    };
    let recorded = false;
    try {
      const draft = new ArtifactDraft(workspace.snapshot);
      draft.writeJson(PENDING_RESTACK_FILE, pending);
      // The replayed stages and the stage commit being picked exist only in this record until --continue.
      const retained = [error.conflict.stageCommit, ...run.plans.flatMap((plan) => [plan.nextHead, ...replacedBy(workspace.root, plan)])];
      withArtifactLock(workspace, artifact.manifest.implementationId, () => {
        commitArtifact(workspace.root, workspace.snapshot, draft, [], retained);
        recorded = true;
      });
    } catch (recordError) {
      if (!recorded) recover(recordError);
      console.error(`semantic-implementation: the restack was recorded as pending, but ${errorMessage(recordError)}`);
    }
    fail([
      `Restacking stage ${error.conflict.id} onto ${error.conflict.parent} stopped at a conflict${error.files.length ? ` in ${error.files.join(", ")}` : ""}.`,
      "No stage refs were changed.",
      `Resolve the conflict in ${run.location}: edit the files and stage the resolution with git add or git rm, without committing.`,
      "Then run implementation restack --continue, or implementation restack --abort to discard the restack.",
    ].join("\n"));
  }
  let summary: RestackSummary;
  try {
    summary = finishRestack(workspace, artifact, run, refs);
  } catch (error) {
    return recover(error);
  }
  // The restack is complete; a worktree that cannot be removed now is only clutter.
  if (run.scratch) {
    try { ScratchWorktree.discard(workspace.root, run.scratch.path); }
    catch (error) { console.error(`semantic-implementation: the restack completed, but its worktree ${run.scratch.path} could not be removed: ${errorMessage(error)}`); }
  }
  return summary;
}

/** Moves the restacked branches and records their heads in one transaction,
 * only while every ref the restack read is unchanged. */
function finishRestack(workspace: Workspace, artifact: Artifact, run: RestackRun, refs: ReadonlyMap<string, string>): RestackSummary {
  // Checked again for --continue, which reads the refs a restack began with.
  assertDirectRefs(workspace.root, [...refs.keys()]);
  const branchUpdates = run.plans.filter(({ previousHead, nextHead }) => previousHead !== nextHead);
  const moved = new Set(branchUpdates.map(({ branch }) => `refs/heads/${branch}`));
  const refUpdates: RefUpdate[] = [
    // Every other ref the restack read is verified, so none moved meanwhile.
    ...[...refs].filter(([ref]) => !moved.has(ref)).map(([ref, head]): RefUpdate => ({ ref, next: head, previous: head })),
    ...branchUpdates.map(({ branch, previousHead, nextHead }): RefUpdate => ({
      ref: `refs/heads/${branch}`,
      previous: previousHead,
      next: nextHead,
    })),
  ];
  const checkedOut = checkedOutBranches(workspace.root);
  // A checked-out branch may only move to a commit with the same tree, as a fold does.
  const checkedOutUpdates = branchUpdates
    .filter(({ branch, previousHead, nextHead }) => checkedOut.has(branch) && !sameTree(workspace.root, previousHead, nextHead))
    .map(({ branch }) => branch);
  if (checkedOutUpdates.length > 0) {
    fail(
      `Cannot move branch(es) checked out in a worktree: ${checkedOutUpdates.join(", ")}. Run git switch --detach in each such worktree, then run the command again.`,
    );
  }
  // Diff and validate outside the lock; readers take it, so the viewer never sees a partly restacked stack.
  artifact.manifest.baseRevision = run.newBase;
  const draft = new ArtifactDraft(workspace.snapshot);
  draft.remove(PENDING_RESTACK_FILE);
  // Corrections folded away stay reachable for code targets captured on them.
  const corrections = run.plans
    .filter(({ id, previousHead }) => previousHead !== finalizedStage(artifact, id).change.headRevision)
    .map(({ previousHead }) => previousHead);
  for (const plan of run.plans) {
    const stage = finalizedStage(artifact, plan.id);
    stage.change = {
      branch: plan.branch,
      baseBranch: plan.baseBranch,
      baseRevision: plan.baseRevision,
      headRevision: plan.nextHead,
      files: plan.emptied ? [] : changedFiles(workspace.root, plan.baseRevision, plan.nextHead),
    };
  }
  writeManifest(draft, artifact);
  // Node coverage may no longer fit a replayed diff, as after a rename on the
  // target; validation reports it and the stage is organized again.
  validateArtifact(workspace, { quiet: true, schemaOnly: true, allowPendingRestack: true }, draft);
  // The commits an empty stage would replay stay reachable for later restacks.
  const retained = [...corrections, ...run.plans.flatMap((plan) => replacedBy(workspace.root, plan))];
  let committed = false;
  try {
    withArtifactLock(workspace, artifact.manifest.implementationId, () => {
      commitArtifact(workspace.root, workspace.snapshot, draft, refUpdates, retained);
      committed = true;
    });
  } catch (error) {
    if (!committed) throw error;
    console.error(`semantic-implementation: the restack completed, but ${errorMessage(error)}`);
  }

  return {
    mode: run.mode,
    fromStage: run.fromStage,
    targetBranch: artifact.manifest.targetBranch,
    baseRevision: run.newBase,
    refreshedStages: run.plans.length,
    rewrittenBranches: branchUpdates.length,
    stages: run.plans.map((plan) => ({
      id: plan.id,
      branch: plan.branch,
      previousHead: plan.previousHead,
      nextHead: plan.nextHead,
      baseBranch: plan.baseBranch,
      baseRevision: plan.baseRevision,
      rewritten: plan.previousHead !== plan.nextHead,
      emptied: plan.emptied,
    })),
  };
}

/** Whether the artifact holds nothing but the pending restack record that was not in the snapshot the restack started from. */
function unchangedSinceRestackBegan(root: string, current: string, start: string): boolean {
  // Every file but the pending record itself must be as it was.
  const entries = (commit: string) => gitRaw(["ls-tree", "-r", "-z", commit], { cwd: root }).split("\0")
    .filter((entry) => entry && entry.slice(entry.indexOf("\t") + 1) !== PENDING_RESTACK_FILE).sort();
  return JSON.stringify(entries(current)) === JSON.stringify(entries(start));
}

/** Completes a pending restack with the resolution staged in its worktree. */
function continueRestack(workspace: Workspace): RestackSummary {
  const pending = readPendingRestack(workspace.snapshot) ?? fail("No restack is pending.");
  const artifact = validateArtifact(workspace, { schemaOnly: true, quiet: true, allowPendingRestack: true });
  const changed = (what: string) => fail(`${what} changed since the restack began, so it cannot be completed. Run implementation restack --abort, then restack again.`);
  if (!unchangedSinceRestackBegan(workspace.root, workspace.snapshot.version, pending.startSnapshot)) changed("The semantic implementation");
  const currentRefs = new Map(git(["for-each-ref", "--format=%(refname) %(objectname)", ...Object.keys(pending.refs)], { cwd: workspace.root })
    .split(/\r?\n/).filter(Boolean).map((line): [string, string] => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]));
  for (const [ref, head] of Object.entries(pending.refs)) if (currentRefs.get(ref) !== head) changed(ref);
  const expectedStages = artifact.manifest.stages.map((id) => `refs/heads/${finalizedStage(artifact, id).change.branch}`);
  if (!expectedStages.every((ref) => ref in pending.refs)) changed("The stage stack");

  const canonical = ScratchWorktree.isCanonical(workspace.root, artifact.manifest.implementationId, pending.worktree);
  const scratch = (canonical ? ScratchWorktree.open(workspace.root, pending.worktree) : undefined)
    ?? fail(`The restack worktree ${pending.worktree} is gone. Run implementation restack --abort, then restack again.`);
  const { conflict } = pending;
  // Only the conflict this restack left can be continued: a commit, switch or reset there loses it.
  if (!scratch.holdsConflictOf(conflict.parent, conflict.stageCommit)) {
    fail(`The restack worktree ${pending.worktree} no longer holds the conflict of stage ${conflict.id} at ${conflict.parent}; it was committed, switched or reset. Run implementation restack --abort, then restack again.`);
  }
  const unmerged = scratch.unmerged();
  if (unmerged.length > 0) fail(`Resolve and stage these files in ${pending.worktree} first: ${unmerged.join(", ")}.`);
  // Edits that are not staged, and new files that are not added, would be lost.
  const unstaged = scratch.unstaged();
  if (unstaged.length > 0) fail(`Stage the resolution in ${pending.worktree} with git add or git rm; these files have unstaged changes or are not added:\n${unstaged.join("\n")}`);
  const tree = scratch.writeTree();
  const index = artifact.manifest.stages.indexOf(conflict.id);
  if (index < 0) changed("The stage stack");
  const stage = finalizedStage(artifact, conflict.id);
  // A resolution that drops the stage's changes stays empty in later restacks.
  const nextHead = stageResult(workspace.root, stage, tree, conflict.parent, conflict.stageCommit, true);
  const plans = [...pending.plans, {
    id: conflict.id,
    branch: stage.change.branch,
    previousHead: conflict.previousHead,
    nextHead,
    baseBranch: pending.plans.at(-1)?.branch ?? (index === 0 ? artifact.manifest.targetBranch : finalizedStage(artifact, artifact.manifest.stages[index - 1]).change.branch),
    baseRevision: conflict.parent,
    emptied: sameTree(workspace.root, nextHead, conflict.parent),
  }];
  const heads = new Map(Object.entries(pending.refs).map(([ref, sha]) => [ref.slice("refs/heads/".length), sha]));
  const run: RestackRun = {
    mode: pending.mode,
    fromStage: pending.fromStage,
    newBase: pending.newBase,
    plans,
    next: index + 1,
    parentBranch: stage.change.branch,
    parentHead: nextHead,
    scratch,
    location: pending.worktree,
    resumed: { parent: conflict.parent, tree, stageCommit: conflict.stageCommit },
    ...(pending.checkout ? { checkout: pending.checkout } : {}),
  };
  const summary = runRestack(workspace, artifact, run, new Map(Object.entries(pending.refs)), heads, pending.startSnapshot);
  if (pending.checkout) {
    const moved = summary.stages.find(({ branch }) => branch === pending.checkout?.branch);
    restoreDetachedCheckout(workspace.root, pending.checkout, moved?.nextHead ?? pending.checkout.head,
      new Set(artifact.manifest.stages.map((id) => finalizedStage(artifact, id).change.branch)));
  }
  return summary;
}

/** Discards a pending restack and its worktree; no stage ref has moved. */
function abortRestack(workspace: Workspace): void {
  if (workspace.snapshot.type(PENDING_RESTACK_FILE) === undefined) fail("No restack is pending.");
  // A record that cannot be read is still removed; none of its fields is used then.
  let pending: PendingRestack | undefined;
  try { pending = readPendingRestack(workspace.snapshot); } catch (error) {
    console.error(`Warning: ${errorMessage(error)} It is removed anyway.`);
  }
  const stageBranches = pending?.checkout ? artifactStageBranches(workspace) : new Set<string>();
  const implementationId = activeImplementationId(workspace.root, workspace.snapshot);
  const draft = new ArtifactDraft(workspace.snapshot);
  draft.remove(PENDING_RESTACK_FILE);
  withArtifactLock(workspace, implementationId, () => commitArtifact(workspace.root, workspace.snapshot, draft));
  // Only the folder restacks of this implementation use is ever deleted.
  const location = ScratchWorktree.location(workspace.root, implementationId);
  const canonical = pending === undefined || ScratchWorktree.isCanonical(workspace.root, implementationId, pending.worktree);
  let left = "";
  if (canonical) {
    try { ScratchWorktree.discard(workspace.root, location); } catch (error) {
      left = ` Its worktree ${location} could not be removed (${errorMessage(error)}); delete it by hand.`;
    }
  } else {
    left = ` Its recorded worktree ${pending?.worktree} is not where restacks replay, so it was left alone.`;
  }
  console.log(`Discarded the restack${pending ? ` that stopped at stage ${pending.conflict.id}` : ""}; no stage refs were changed.${left}`);
  if (pending?.checkout) restoreDetachedCheckout(workspace.root, pending.checkout, pending.checkout.head, stageBranches);
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
  const commit = gitRaw([...UTF8_COMMITS, "commit-tree", tree, "-p", parent], {
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
  /** Marked empty stages; they stay in the artifact but not in the stack to prepare. */
  emptyStages: string[];
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
  // Preparation skips emptied stages: the stage above builds on the last one with changes.
  const emptyStages: string[] = [];
  const entries: StackEntry[] = [];
  let baseBranch = artifact.manifest.targetBranch;
  for (const id of artifact.manifest.stages) {
    const stage = finalizedStage(artifact, id);
    if (stage.change.files.length === 0) {
      emptyStages.push(id);
      continue;
    }
    entries.push({
      position: entries.length + 1,
      stageId: id,
      branch: stage.change.branch,
      baseBranch,
      headRevision: stage.change.headRevision,
    });
    baseBranch = stage.change.branch;
  }
  return {
    emptyStages,
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
  console.log(`Local stage stack valid (${result.stages.length} stage(s) to prepare of ${describeFinalizedStages(result.stages.length + result.emptyStages.length, result.emptyStages)}):`);
  for (const entry of result.stages) {
    console.log(
      `  ${entry.position}. ${entry.branch} -> ${entry.baseBranch} (${entry.headRevision})`,
    );
  }
  if (result.emptyStages.length) console.log(`Skipped empty stage(s): ${result.emptyStages.join(", ")}`);
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
  assertBranchOutsideOwnNames(branch, "Cumulative branch", branch);
  if (artifact.manifest.stages.every((id) => finalizedStage(artifact, id).change.files.length === 0)) {
    fail(`Every stage of ${artifact.manifest.implementationId} is empty; there is nothing to prepare.`);
  }
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

/** Short-name prefixes Semantic Flow keeps for its own refs: everything under
 * `refs/semantic-review/` and the shared archive tags. A branch inside them
 * would make Git's short names ambiguous. */
const OWN_SHORT_NAME_PREFIXES = ["semantic-review/", "semantic-review-archive/"];

function assertBranchOutsideOwnNames(name: string, label: string, shown: string): void {
  // A branch named refs/... would also shadow a full ref name.
  const reserved = [...OWN_SHORT_NAME_PREFIXES, "refs/"].find((prefix) => name.startsWith(prefix));
  if (reserved) fail(`${label} ${shown} is inside ${reserved}, which Semantic Flow keeps for its own refs; choose another name.`);
}

/** The archive's shared tag and the commit it names, if it was shared. Any
 * ref at the tag's name counts as shared, so nothing replaces it. */
function sharedArchive(root: string, implementationId: string): { tag: string; commit: string | undefined; annotated: boolean } | undefined {
  const tag = archiveTag(implementationId);
  // Only the tag itself counts; rev-parse would also find a branch named after it.
  const object = gitOptional(["show-ref", "--verify", "--hash", tag], { cwd: root });
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
  // Feedback writes check under the review lock that the implementation is
  // still active, so removing it under the same lock never overtakes one of
  // them. The lock is reentrant: the `archive` workflow already holds it while
  // it checks that every thread is resolved.
  withReviewLock(reviewId(workspace.root, implementationId), () => removeArtifact(workspace.root, workspace.snapshot, [
    ...stageChecks,
    publication.update ?? publication.verify ?? fail("The publication has no metadata ref."),
    { ref, next: commit, previous: ZERO_OID },
    { ref: archiveTag(implementationId), next: ZERO_OID, previous: ZERO_OID },
  ]));
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
  // A ref of an older artifact may share the tag's short name, which would make pushing it by that name fail.
  const short = tag.slice("refs/tags/".length);
  const clash = [`refs/heads/${short}`, `refs/${short}`, `refs/heads/${tag}`, `refs/tags/${tag}`].find((ref) => gitOptional(["show-ref", "--verify", "--quiet", ref], { cwd: root }) !== undefined);
  if (clash) fail(`${clash} shares a name with the archive tag ${tag}, so pushing the tag by name would fail; rename or delete it before sharing the archive.`);
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
