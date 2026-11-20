/** The one loader of the active implementation artifact and the forms it is written in.
 *
 * The active artifact stores only what Git cannot tell: the manifest lists each
 * stage with its recorded head revision, and stage documents carry no `change`.
 * Loading derives each stage's branch, base branch, base revision and file
 * inventory from the stage order and the head revisions, and validates the
 * result as the full documents that standard/v0.1/schema describes. Published
 * and archived artifacts are written in that full form, so they can be read
 * without the repository. */
import { spawnSync } from "node:child_process";
import {
  MANIFEST_SCHEMA_ID,
  SPECIFICATION_SCHEMA_ID,
  STAGE_SCHEMA_ID,
  WORK_STAGE_SCHEMA_ID,
  type FileChange,
  type ImplementationManifest,
  type Specification,
  type Stage,
  type WorkStage,
} from "./documents.js";
import { ArtifactDraft, hasFile, listJsonIds, readArtifactJson, type ArtifactFiles } from "./artifact-store.js";
import { fail } from "./errors.js";
import { isRecord, type JsonRecord } from "./narrow.js";
import { parseDocument } from "./schema-validation.js";
import { processFailureDetail, SUBPROCESS_MAX_BUFFER } from "./subprocess.js";
import { factCache } from "./validation-context.js";

/** A loaded implementation artifact in its full form; every document has passed its schema. */
export interface Artifact {
  manifest: ImplementationManifest;
  requirements: Map<string, Specification>;
  stages: Map<string, Stage>;
  workStages: Map<string, WorkStage>;
}

/** A finalized or working stage. */
export type EditableStage = Stage | WorkStage;

/** The branch of a stage. Stage order comes only from the manifest, so the
 * name holds no position; the `stages/` level keeps a stage named `metadata`
 * apart from the `<prefix>/metadata` publication branch. */
export function stageBranchName(branchPrefix: string, stageId: string): string {
  return `${branchPrefix}/stages/${stageId}`;
}

/** Where a stage document is stored in the artifact. */
export function stageFile(stage: EditableStage): string {
  return stage.$schema === STAGE_SCHEMA_ID ? `stages/${stage.id}.json` : `.work/stages/${stage.id}.json`;
}

const compareOrdinal = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// --- File inventories -------------------------------------------------------

const changedFileFacts = factCache<FileChange[]>();

/** Format 0.1 kind of a non-rename Git name-status code. */
function changeKind(code: string): "added" | "modified" | "deleted" | undefined {
  return code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : undefined;
}

/** Parses name-status records starting at fields[index]; stops at a record that is not a status. */
function parseChanges(fields: string[], index: number, commit: string): { files: FileChange[]; next: number } {
  const files: FileChange[] = [];
  while (index < fields.length && /^[A-Z][0-9]*$/.test(fields[index])) {
    const status = fields[index];
    index += 1;
    const code = status[0];
    if (code === "R") {
      const previousPath = fields[index];
      const currentPath = fields[index + 1];
      if (!previousPath || !currentPath) {
        fail(`Malformed Git rename record for commit ${commit}.`);
      }
      files.push({ path: currentPath, kind: "renamed", previousPath });
      index += 2;
      continue;
    }
    const currentPath = fields[index];
    if (!currentPath) {
      fail(`Malformed Git change record for commit ${commit}.`);
    }
    const kind = changeKind(code);
    if (!kind) {
      fail(`Git status ${status} for ${currentPath} is unsupported by format 0.1.`);
    }
    files.push({ path: currentPath, kind });
    index += 1;
  }
  return { files, next: index };
}

/** Checks one stage's inventory as the format requires it. */
function checkedChanges(files: FileChange[], parent: string, commit: string): FileChange[] {
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

function runGit(root: string, args: string[], input?: string) {
  return spawnSync("git", args, {
    cwd: root,
    // spawnSync encodes string input with the output encoding, which "buffer" is not.
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function readChangedFiles(root: string, parent: string, commit: string): FileChange[] {
  // A revision that Git would read as an option is never passed to it.
  for (const revision of [parent, commit]) if (revision.startsWith("-")) fail(`Invalid revision ${JSON.stringify(revision)}.`);
  const result = runGit(root, ["diff", "--name-status", "-z", "--find-renames=50%", parent, commit]);
  if (result.error || result.status !== 0) {
    fail(`Cannot derive changed files: ${processFailureDetail(result)}`);
  }
  const fields = result.stdout.toString("utf8").split("\0").filter((field) => field.length > 0);
  const { files, next } = parseChanges(fields, 0, commit);
  if (next !== fields.length) fail(`Malformed Git change record for commit ${commit}.`);
  return checkedChanges(files, parent, commit);
}

/** The files that change from parent to commit. */
export function changedFiles(root: string, parent: string, commit: string): FileChange[] {
  return changedFileFacts(JSON.stringify([root, parent, commit]), () => readChangedFiles(root, parent, commit));
}

/** Derives the inventories of several revision ranges with one Git process.
 * Within a validation context, later changedFiles calls for them reuse the
 * result. When Git fails, each range is derived alone, so the error names it. */
export function changedFilesOfRanges(root: string, ranges: ReadonlyArray<readonly [string, string]>): FileChange[][] {
  const valid = ranges.every(([parent, commit]) => /^[0-9a-f]{40}$/.test(parent) && /^[0-9a-f]{40}$/.test(commit));
  const distinct = [...new Map(ranges.map(([parent, commit]) => [`${commit} ${parent}`, [parent, commit] as const])).values()];
  const derived = new Map<string, FileChange[]>();
  if (valid && distinct.length > 1) {
    // Each line names a commit and the one parent to compare it with.
    const result = runGit(root, ["diff-tree", "--stdin", "-r", "-z", "--name-status", "--find-renames=50%"],
      distinct.map(([parent, commit]) => `${commit} ${parent}\n`).join(""));
    if (!result.error && result.status === 0) {
      const fields = result.stdout.toString("utf8").split("\0").filter((field) => field.length > 0);
      let index = 0;
      for (const [parent, commit] of distinct) {
        // Git prints nothing for a range without changes; deriving it alone reports that.
        if (fields[index] !== commit) continue;
        const { files, next } = parseChanges(fields, index + 1, commit);
        index = next;
        const key = JSON.stringify([root, parent, commit]);
        derived.set(key, changedFileFacts(key, () => checkedChanges(files, parent, commit)));
      }
    }
  }
  // Outside a validation context nothing is cached, so the batch's own results are used.
  return ranges.map(([parent, commit]) => derived.get(JSON.stringify([root, parent, commit])) ?? changedFiles(root, parent, commit));
}

// --- Stored forms -------------------------------------------------------------

/** A stage as the manifest of the active artifact lists it. A stage builds on
 * the head of the stage below it, so its base is stored only while it differs:
 * after a lower stage's new head was recorded and before restacking moves the
 * stage onto it. */
interface StackEntry {
  id: string;
  headRevision: string;
  baseRevision?: string;
}

function stackEntries(value: unknown, label: string): StackEntry[] {
  const stages = isRecord(value) ? value.stages : undefined;
  if (!Array.isArray(stages)) fail(`${label}/stages must be an array.`);
  return stages.map((entry: unknown, index): StackEntry => {
    const keys = isRecord(entry) ? Object.keys(entry).sort().join(",") : "";
    if (!isRecord(entry) || !["headRevision,id", "baseRevision,headRevision,id"].includes(keys) ||
      typeof entry.id !== "string" || typeof entry.headRevision !== "string") {
      fail(`${label}/stages/${index} must have exactly a string id and headRevision, and optionally a baseRevision.`);
    }
    for (const field of ["headRevision", "baseRevision"] as const) {
      const value = entry[field];
      if (value !== undefined && (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))) {
        fail(`${label}/stages/${index}/${field} must be a full lowercase SHA-1 commit ID.`);
      }
    }
    return typeof entry.baseRevision === "string"
      ? { id: entry.id, headRevision: entry.headRevision, baseRevision: entry.baseRevision }
      : { id: entry.id, headRevision: entry.headRevision };
  });
}

/** Writes the manifest in its active form: each stage with its head revision,
 * and with its base revision while that is not the head of the stage below. */
export function writeManifest(draft: ArtifactDraft, artifact: Pick<Artifact, "manifest" | "stages">): void {
  let parent = artifact.manifest.baseRevision;
  draft.writeJson("manifest.json", {
    ...artifact.manifest,
    stages: artifact.manifest.stages.map((id): StackEntry => {
      const stage = artifact.stages.get(id);
      if (!stage) fail(`Manifest stage ${id} is missing.`);
      const { baseRevision, headRevision } = stage.change;
      const entry: StackEntry = baseRevision === parent ? { id, headRevision } : { id, headRevision, baseRevision };
      parent = headRevision;
      return entry;
    }),
  });
}

/** Writes a stage document without what loading derives. */
export function writeStage(draft: ArtifactDraft, stage: EditableStage): void {
  if (stage.$schema === STAGE_SCHEMA_ID) {
    const { change: derived, ...stored } = stage;
    draft.writeJson(stageFile(stage), stored);
  } else {
    const { branch: derived, ...stored } = stage;
    draft.writeJson(stageFile(stage), stored);
  }
}

/** Each stage's revision range: from its stored base, or else the head below it, to its head. */
function stackRanges(baseRevision: string, stack: readonly StackEntry[], label: string): Array<[string, string]> {
  // The revisions reach Git commands as arguments, so only commit IDs are accepted.
  if (!/^[0-9a-f]{40}$/.test(baseRevision)) fail(`${label}/baseRevision must be a full lowercase SHA-1 commit ID.`);
  let parent = baseRevision;
  return stack.map((entry): [string, string] => {
    const range: [string, string] = [entry.baseRevision ?? parent, entry.headRevision];
    parent = entry.headRevision;
    return range;
  });
}

/** Fails when a stored document holds a field that loading derives. */
function withoutDerived(value: unknown, field: string, label: string): JsonRecord {
  if (!isRecord(value)) return {};
  if (Object.hasOwn(value, field)) fail(`${label}: ${field} is derived from Git and must not be stored.`);
  return value;
}

// --- Loading ----------------------------------------------------------------

function parseManifest(files: ArtifactFiles): { manifest: ImplementationManifest; stack: StackEntry[] } {
  const manifestLabel = files.describe("manifest.json");
  const storedManifest = readArtifactJson(files, "manifest.json");
  const stack = stackEntries(storedManifest, manifestLabel);
  // Each document must carry its own kind's $schema; an unknown one keeps the
  // "unsupported schema" message.
  const manifest = parseDocument(MANIFEST_SCHEMA_ID, { ...(isRecord(storedManifest) ? storedManifest : {}), stages: stack.map(({ id }) => id) }, manifestLabel);
  return { manifest, stack };
}

/** Validates the stored manifest alone and returns it in its full form, which
 * lists the stage IDs; reading it needs neither Git nor the other documents. */
export function loadManifest(files: ArtifactFiles): ImplementationManifest {
  return parseManifest(files).manifest;
}

/** Loads the artifact into its full form and validates every document. The
 * manifest is validated first; then every file is located before any is
 * validated, so missing files and ID mismatches are reported ahead of schema
 * errors; the first invalid document fails. Loading reads Git only to derive
 * the stage inventories. */
export function loadImplementation(root: string, files: ArtifactFiles, { includeWork = true }: { includeWork?: boolean } = {}): Artifact {
  if (!hasFile(files, "manifest.json")) {
    fail(`No semantic implementation manifest exists at ${files.describe("manifest.json")}.`);
  }
  const { manifest, stack } = parseManifest(files);

  const read = (directory: string, id: string, kind: string) => {
    const file = `${directory}/${id}.json`;
    if (!hasFile(files, file)) fail(`Manifest ${kind} ${id} is missing ${files.describe(file)}.`);
    return { id, label: files.describe(file), value: readArtifactJson(files, file) };
  };
  const requirementDocuments = manifest.requirements.map((id) => read("requirements", id, "specification"));
  const stageDocuments = manifest.stages.map((id) => read("stages", id, "stage"));
  const workDocuments = includeWork
    ? listJsonIds(files, ".work/stages").map((id) => {
      const file = `.work/stages/${id}.json`;
      const value = readArtifactJson(files, file);
      const internalId = isRecord(value) ? value.id : undefined;
      if (internalId !== id) fail(`Working stage file ${file} has internal ID ${String(internalId)}.`);
      return { id, label: files.describe(file), value };
    })
    : [];

  const requirements = new Map<string, Specification>();
  for (const { id, label, value } of requirementDocuments) {
    requirements.set(id, parseDocument(SPECIFICATION_SCHEMA_ID, value, label));
  }

  const ranges = stackRanges(manifest.baseRevision, stack, files.describe("manifest.json"));
  const inventories = changedFilesOfRanges(root, ranges);
  const stages = new Map<string, Stage>();
  let baseBranch = manifest.targetBranch;
  for (const [index, { id, label, value }] of stageDocuments.entries()) {
    const branch = stageBranchName(manifest.branchPrefix, id);
    const [baseRevision, headRevision] = ranges[index];
    stages.set(id, parseDocument(STAGE_SCHEMA_ID, {
      ...withoutDerived(value, "change", label),
      change: { branch, baseBranch, baseRevision, headRevision, files: inventories[index] },
    }, label));
    baseBranch = branch;
  }

  const workStages = new Map<string, WorkStage>();
  for (const { id, label, value } of workDocuments) {
    workStages.set(id, parseDocument(WORK_STAGE_SCHEMA_ID, {
      ...withoutDerived(value, "branch", label),
      branch: stageBranchName(manifest.branchPrefix, id),
    }, label));
  }
  return { manifest, requirements, stages, workStages };
}

/** The documents of an artifact, each stage with its derived change, as read
 * without schema validation. */
export interface UnvalidatedArtifact {
  manifest: JsonRecord;
  requirements: Map<string, unknown>;
  stages: Map<string, JsonRecord>;
}

const isFileId = (id: string) => id !== "" && id !== "." && id !== ".." && !/[\\/]/.test(id);

/** Reads the artifact and derives each stage's change without validating the
 * documents against their schemas, for a reader that narrows every field
 * itself, such as the viewer, so an artifact that validation rejects can still
 * be shown. Only what derivation needs must be valid: the manifest's stage
 * entries, base revision, target branch and branch prefix. */
export function readUnvalidatedImplementation(root: string, files: ArtifactFiles): UnvalidatedArtifact {
  const label = files.describe("manifest.json");
  if (!hasFile(files, "manifest.json")) fail(`No semantic implementation manifest exists at ${label}.`);
  const stored = readArtifactJson(files, "manifest.json");
  const stack = stackEntries(stored, label);
  const fields = isRecord(stored) ? stored : {};
  const text = (name: string): string => {
    const value = fields[name];
    if (typeof value !== "string") fail(`${label}/${name} must be a string.`);
    return value;
  };
  const baseRevision = text("baseRevision"), targetBranch = text("targetBranch"), branchPrefix = text("branchPrefix");
  const document = (directory: string, id: string, kind: string): unknown => {
    if (!isFileId(id)) fail(`${label}: ${kind} ID ${JSON.stringify(id)} cannot name a file.`);
    const file = `${directory}/${id}.json`;
    if (!hasFile(files, file)) fail(`Manifest ${kind} ${id} is missing ${files.describe(file)}.`);
    return readArtifactJson(files, file);
  };

  const requirements = new Map<string, unknown>();
  const requirementIds = Array.isArray(fields.requirements) ? fields.requirements : [];
  for (const id of requirementIds) {
    if (typeof id === "string" && isFileId(id) && hasFile(files, `requirements/${id}.json`)) {
      requirements.set(id, readArtifactJson(files, `requirements/${id}.json`));
    }
  }

  const ranges = stackRanges(baseRevision, stack, label);
  const documents = stack.map(({ id }) => document("stages", id, "stage"));
  const inventories = changedFilesOfRanges(root, ranges);
  const stages = new Map<string, JsonRecord>();
  let baseBranch = targetBranch;
  for (const [index, { id }] of stack.entries()) {
    const branch = stageBranchName(branchPrefix, id);
    const [stageBase, headRevision] = ranges[index];
    const value = documents[index];
    stages.set(id, {
      ...(isRecord(value) ? value : {}),
      change: { branch, baseBranch, baseRevision: stageBase, headRevision, files: inventories[index] },
    });
    baseBranch = branch;
  }
  return { manifest: { ...fields, stages: stack.map(({ id }) => id) }, requirements, stages };
}

// --- Full form ----------------------------------------------------------------

/** The artifact's files in their full form, as publication and archives store
 * them: derived stage data is included and working stages are left out. */
export function fullFormFiles(artifact: Artifact, files: ArtifactFiles): ArtifactDraft {
  const draft = new ArtifactDraft(files);
  for (const file of files.list()) {
    if (!file.startsWith("evidence/") && !file.startsWith("requirements/")) draft.remove(file);
  }
  draft.writeJson("manifest.json", artifact.manifest);
  for (const stage of artifact.stages.values()) draft.writeJson(stageFile(stage), stage);
  return draft;
}

/** The stage IDs a possibly invalid stored manifest lists; inspection reports
 * on such artifacts and leaves their errors to validation. */
export function listedStageIds(storedManifest: unknown): string[] {
  const stages = isRecord(storedManifest) ? storedManifest.stages : undefined;
  return Array.isArray(stages)
    ? stages.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []))
    : [];
}
