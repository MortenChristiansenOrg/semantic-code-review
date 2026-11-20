/** Storage of implementation artifacts. Every command, feedback operation and
 * viewer request reads and writes the active artifact through this module, so
 * nothing else knows where or how it is stored.
 *
 * An active artifact lives in the repository's Git object store: the private
 * ref refs/semantic-review/active/<implementation-id> points at a snapshot
 * commit whose tree holds the artifact's files. Every worktree of the
 * repository sees the same artifact, and cleaning a worktree cannot lose it.
 *
 * A read pins one snapshot: an immutable view of the artifact's files, with a
 * version that changes whenever the artifact does. A writer edits a draft on
 * top of the snapshot it read and commits the draft as a new snapshot, moving
 * the ref only if it still points at the snapshot that was read. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.js";
import { git, gitRaw } from "./git.js";
import { jsonBytes, parseJsonDocument, replaceFile } from "./json.js";
import { errorCode, errorMessage, isRecord } from "./narrow.js";

/** The folder published and archived artifacts are stored under in a commit. */
export const PUBLISHED_DIRECTORY = ".semantic-review";
export const ZERO_OID = "0000000000000000000000000000000000000000";

/** What a path of an artifact holds. "other" is anything but a regular file
 * or a directory, such as a symbolic link. */
export type ArtifactEntryType = "file" | "directory" | "other";

/** A read-only view of an artifact's files. Paths are relative to the
 * artifact's root and separated by "/". */
export interface ArtifactFiles {
  /** Sorted paths of the non-directory entries below directory, or of all of them. */
  list(directory?: string): string[];
  /** What the path holds, or undefined when nothing is there. */
  type(file: string): ArtifactEntryType | undefined;
  /** The size of a regular file in bytes. */
  size(file: string): number;
  /** The bytes of a regular file. */
  read(file: string): Buffer;
  /** How messages name the file. */
  describe(file: string): string;
}

/** An artifact as one read found it. */
export interface ArtifactSnapshot extends ArtifactFiles {
  /** The worktree the artifact was read from; Git commands run there. */
  readonly root: string;
  /** Identifies this content; any change to the artifact changes it. */
  readonly version: string;
}

/** An update of one ref, compared with the value the command read. ZERO_OID
 * as next deletes the ref; as previous, it requires that the ref is absent. */
export interface RefUpdate {
  ref: string;
  next: string;
  previous: string;
}

const compareOrdinal = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function isBelow(file: string, directory: string): boolean {
  return directory === "" || file.startsWith(`${directory}/`);
}

/** Paths are built from validated IDs and hashes; anything that could leave
 * the artifact's root is a programming error. */
function checkedPath(file: string): string {
  if (!file || file.startsWith("/") || file.split("/").some((part) => part === "" || part === "." || part === "..") || file.includes("\\")) {
    throw new Error(`Invalid artifact path ${JSON.stringify(file)}.`);
  }
  return file;
}

/** Whether a file exists as a regular file. */
export function hasFile(files: ArtifactFiles, file: string): boolean {
  return files.type(file) === "file";
}

/** Parses a stored JSON document; errors name the file. The result is unvalidated. */
export function readArtifactJson(files: ArtifactFiles, file: string): unknown {
  return parseJsonDocument(files.read(file).toString("utf8"), files.describe(file));
}

/** The IDs of the JSON documents directly in directory, sorted. */
export function listJsonIds(files: ArtifactFiles, directory: string): string[] {
  return files.list(directory)
    .filter((file) => file.lastIndexOf("/") === directory.length && file.endsWith(".json") && files.type(file) === "file")
    .map((file) => file.slice(directory.length + 1, -".json".length));
}

// --- Folder storage -----------------------------------------------------------

/** Artifact files in a directory, such as a remote review's projection. */
class FolderFiles implements ArtifactSnapshot {
  readonly #version: string;

  constructor(readonly root: string, readonly directory: string) {
    // Taken when the snapshot is read, so a later comparison detects every
    // write that happened after this read.
    const hash = createHash("sha256");
    for (const file of this.list()) {
      const stat = fs.lstatSync(this.absolute(file), { bigint: true });
      hash.update(`${file}\0${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}\0`);
    }
    this.#version = hash.digest("hex");
  }

  absolute(file: string): string {
    return path.join(this.directory, ...checkedPath(file).split("/"));
  }

  list(directory = ""): string[] {
    const result: string[] = [];
    const visit = (relative: string) => {
      const absolute = relative ? this.absolute(relative) : this.directory;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(child);
        else result.push(child);
      }
    };
    const start = directory ? this.type(directory) : fs.lstatSync(this.directory, { throwIfNoEntry: false })?.isDirectory() ? "directory" : undefined;
    if (start === "directory") visit(directory);
    return result.sort(compareOrdinal);
  }

  type(file: string): ArtifactEntryType | undefined {
    const stat = fs.lstatSync(this.absolute(file), { throwIfNoEntry: false });
    return !stat ? undefined : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  }

  size(file: string): number {
    const stat = fs.lstatSync(this.absolute(file), { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`${this.describe(file)} is not a regular file.`);
    return stat.size;
  }

  read(file: string): Buffer {
    const absolute = this.absolute(file);
    try {
      return fs.readFileSync(absolute);
    } catch (error) {
      fail(`Cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  describe(file: string): string {
    return this.absolute(file);
  }

  /** Identifies the files as this view was opened: the path, size, modification
   * time and file identity of every entry. Writers replace files by renaming,
   * which changes the identity, so any write changes the version. Only metadata
   * is read, so an idle viewer can poll it cheaply. */
  get version(): string {
    return this.#version;
  }
}

/** Artifact files stored in a directory outside any worktree, such as a
 * remote review's projection; Git commands run in root. */
export function readArtifactDirectory(root: string, directory: string): ArtifactSnapshot | undefined {
  return fs.existsSync(path.join(directory, "manifest.json")) ? new FolderFiles(root, directory) : undefined;
}

// --- Active artifacts ---------------------------------------------------------

/** The namespace of the refs holding active artifacts, one per implementation. */
/** Refs only Semantic Flow writes, all of them direct. */
const OWN_REF_PREFIX = "refs/semantic-review/";
export const ACTIVE_REF_PREFIX = `${OWN_REF_PREFIX}active/`;
/** Where earlier versions kept the active artifact, relative to a worktree root. */
const LEGACY_DIRECTORY = ".semantic-review";
/** The file in a worktree's Git directory naming the implementation last
 * initialized or begun there; it settles which of several is meant. */
const WORKTREE_SELECTION = "semantic-review-implementation";
/** The fixed identity of artifact snapshot commits, so writing one needs no user configuration. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Semantic Flow",
  GIT_AUTHOR_EMAIL: "semantic-flow@localhost",
  GIT_COMMITTER_NAME: "Semantic Flow",
  GIT_COMMITTER_EMAIL: "semantic-flow@localhost",
};

export const activeRef = (implementationId: string) => `${ACTIVE_REF_PREFIX}${implementationId}`;

/** An archived implementation: a commit on top of its published metadata
 * commit that adds the landing record. Archiving moves the implementation from
 * its active ref to this one in one transaction. */
export const ARCHIVE_REF_PREFIX = `${OWN_REF_PREFIX}archive/`;
export const archiveRef = (implementationId: string) => `${ARCHIVE_REF_PREFIX}${implementationId}`;
/** The annotated tag that shares an archive. It is never moved once created. */
export const ARCHIVE_TAG_PREFIX = "refs/tags/semantic-review/archive/";
export const archiveTag = (implementationId: string) => `${ARCHIVE_TAG_PREFIX}${implementationId}`;

/** An active implementation, as its ref names it. */
export interface ActiveImplementation {
  implementationId: string;
  ref: string;
  /** The snapshot commit the ref points at. */
  commit: string;
  /** The stage heads earlier snapshots recorded and later ones replaced. */
  supersededHeads: string[];
}

/** An active ref must be direct: it names its snapshot, and every write moves it. */
function assertDirectActiveRef(ref: string, symref: string): void {
  if (symref) fail(`${ref} is a symbolic ref to ${symref}, not an active artifact; remove it with git symbolic-ref --delete.`);
}

/** Every active implementation of the repository of root, read with one Git
 * process. A symbolic ref at an active ref's name fails every read: skipping it
 * would let selection fall back to another implementation. */
export function listActiveImplementations(root: string): ActiveImplementation[] {
  const output = gitRaw(["for-each-ref", "--format=%(objectname)%09%(refname)%09%(parent)%09%(symref)", ACTIVE_REF_PREFIX], { cwd: root });
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [commit, ref, parents = "", symref = ""] = line.split("\t");
    assertDirectActiveRef(ref, symref);
    return [{ implementationId: ref.slice(ACTIVE_REF_PREFIX.length), ref, commit, supersededHeads: parents.split(" ").filter(Boolean) }];
  }).sort((left, right) => compareOrdinal(left.implementationId, right.implementationId));
}

/** Names the implementation a process acts on once a command selected it.
 * Worker threads and child processes, such as the viewer and the commands it
 * runs, inherit the selection with the environment. */
const SELECTION_VARIABLE = "SEMANTIC_FLOW_IMPLEMENTATION_ID";

/** Makes later reads of this process and its children act on the
 * implementation, or select one again when undefined. */
export function selectImplementation(implementationId: string | undefined): void {
  if (implementationId === undefined) delete process.env[SELECTION_VARIABLE];
  else process.env[SELECTION_VARIABLE] = implementationId;
}

const selectedImplementation = (): string | undefined => process.env[SELECTION_VARIABLE] || undefined;

function worktreeSelectionFile(root: string): string {
  return path.resolve(root, gitRaw(["rev-parse", "--git-path", WORKTREE_SELECTION], { cwd: root }));
}

/** Records that the worktree at root works on the implementation. */
export function rememberImplementation(root: string, implementationId: string): void {
  try {
    fs.writeFileSync(worktreeSelectionFile(root), `${implementationId}\n`);
  } catch { /* The record only settles ambiguity; without it, a command asks which implementation is meant. */ }
}

function rememberedImplementation(root: string): string | undefined {
  try {
    return fs.readFileSync(worktreeSelectionFile(root), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Whether ref is one of the stage branches or the metadata branch named by a branch prefix. */
function ownsBranch(prefix: string, ref: string): boolean {
  const start = `refs/heads/${prefix}/`;
  if (!ref.startsWith(start)) return false;
  const rest = ref.slice(start.length);
  return rest === "metadata" || /^stages\/[^/]+$/.test(rest);
}

/** The active implementation the worktree at root has claimed: the one whose
 * branch is checked out there, or else the one last initialized or begun there. */
export function claimedImplementation(root: string, actives: ActiveImplementation[]): ActiveImplementation | undefined {
  if (actives.length === 0) return undefined;
  const head = git(["symbolic-ref", "--quiet", "HEAD"], { cwd: root, allowFailure: true });
  if (head) {
    let manifests = new Map<string, Buffer>();
    try {
      manifests = readBlobs(defaultRunner(root), actives.map((active) => `${active.commit}:manifest.json`));
    } catch { /* A snapshot without a readable manifest owns no branch. */ }
    // An implementation owns its stage and metadata branches; when several
    // prefixes still name the branch, the longest one owns it.
    let owner: ActiveImplementation | undefined;
    let ownerPrefix = "";
    for (const active of actives) {
      let manifest: unknown;
      try {
        manifest = parseJsonDocument(manifests.get(`${active.commit}:manifest.json`)?.toString("utf8") ?? "", "manifest.json");
      } catch {
        continue;
      }
      const prefix = isRecord(manifest) ? manifest.branchPrefix : undefined;
      if (typeof prefix === "string" && ownsBranch(prefix, head) && prefix.length > ownerPrefix.length) {
        owner = active;
        ownerPrefix = prefix;
      }
    }
    if (owner) return owner;
  }
  const remembered = rememberedImplementation(root);
  return actives.find((active) => active.implementationId === remembered);
}

/** The active implementation the worktree at root has claimed, if any; see claimedImplementation. */
export function worktreeImplementation(root: string): ActiveImplementation | undefined {
  return claimedImplementation(root, listActiveImplementations(root));
}

/** The active implementation a worktree works on: the selected one, the only
 * one, or the one the worktree has claimed. */
function chooseActive(root: string, actives: ActiveImplementation[], implementationId: string | undefined): ActiveImplementation | undefined {
  if (implementationId !== undefined) return actives.find((active) => active.implementationId === implementationId);
  if (actives.length <= 1) return actives[0];
  const claimed = claimedImplementation(root, actives);
  if (claimed) return claimed;
  fail(`Several semantic implementations are active in this repository: ${actives.map((active) => active.implementationId).join(", ")}. Run the command in the worktree of the one you mean, with one of its stage branches checked out.`);
}

/** Fails when root holds an untracked artifact folder from an earlier version. */
export function assertNoLegacyArtifact(root: string): void {
  const manifest = path.join(root, LEGACY_DIRECTORY, "manifest.json");
  if (!fs.existsSync(manifest)) return;
  // A checkout of a metadata branch or an archive tracks its artifact files.
  const tracked = git(["ls-files", "--", `${LEGACY_DIRECTORY}/manifest.json`], { cwd: root, allowFailure: true });
  if (tracked) return;
  fail(`${path.join(root, LEGACY_DIRECTORY)} holds a semantic implementation written by an earlier Semantic Flow version. Implementations are now stored in Git, and an earlier one cannot be continued across this change: finish it with the earlier version, or remove ${LEGACY_DIRECTORY}/ and start again.`);
}

const snapshotTrees = new Map<string, TreeFiles>();

/** The active artifact of an implementation, pinned to one snapshot commit.
 * The files are listed and read from Git only when first used. */
class RefSnapshot implements ArtifactSnapshot {
  #files: TreeFiles | undefined;

  constructor(readonly root: string, readonly active: ActiveImplementation, readonly run: GitRunner = defaultRunner(root)) {}

  get implementationId(): string { return this.active.implementationId; }
  get version(): string { return this.active.commit; }

  get files(): TreeFiles {
    if (!this.#files) {
      // Snapshot commits never change, so one process lists and reads each once.
      const key = `${this.root}\0${this.active.commit}`;
      let files = snapshotTrees.get(key);
      if (!files) {
        files = treeFiles(this.run, this.active.commit, "", this.active.ref)
          ?? fail(`Cannot read the snapshot ${this.active.commit} of ${this.active.ref}.`);
        snapshotTrees.set(key, files);
        // A long-running viewer sees many snapshots; keep only the recent ones.
        for (const old of snapshotTrees.keys()) {
          if (snapshotTrees.size <= 8) break;
          snapshotTrees.delete(old);
        }
      }
      this.#files = files;
    }
    return this.#files;
  }

  list(directory?: string): string[] { return this.files.list(directory); }
  type(file: string): ArtifactEntryType | undefined { return this.files.type(file); }
  size(file: string): number { return this.files.size(file); }
  read(file: string): Buffer { return this.files.read(file); }
  describe(file: string): string { return this.files.describe(file); }
  objectId(file: string): string | undefined { return this.files.objectId(file); }
}

/** The active artifact the worktree at root works on, or undefined when it has none. */
export function readArtifact(root: string, implementationId = selectedImplementation()): ArtifactSnapshot | undefined {
  const active = chooseActive(root, listActiveImplementations(root), implementationId);
  if (active) return new RefSnapshot(root, active);
  assertNoLegacyArtifact(root);
  return undefined;
}

/** The active artifact the worktree at root works on; fails when it has none. */
export function requireArtifact(root: string, implementationId = selectedImplementation()): ArtifactSnapshot {
  const snapshot = readArtifact(root, implementationId);
  if (snapshot) return snapshot;
  fail((implementationId === undefined
    ? "No active semantic implementation exists in this repository."
    : `No active semantic implementation has implementation ID ${implementationId}.`));
}

// --- Drafts and commits -----------------------------------------------------

/** Edits on top of a snapshot, or of nothing for a new artifact. A draft is a
 * view of the edited files, so it can be validated before it is committed. */
export class ArtifactDraft implements ArtifactFiles {
  readonly #changes = new Map<string, Buffer | null>();

  constructor(readonly base: ArtifactFiles | undefined) {}

  write(file: string, bytes: Buffer | string): void {
    this.#changes.set(checkedPath(file), typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
  }

  writeJson(file: string, value: unknown): void {
    this.write(file, jsonBytes(value));
  }

  /** Removes a file, or every file below a directory. */
  remove(file: string): void {
    checkedPath(file);
    for (const existing of this.list(file)) this.#changes.set(existing, null);
    if (this.type(file) === "file" || this.type(file) === "other") this.#changes.set(file, null);
  }

  /** The changed files: their new bytes, or null when removed. */
  get changes(): ReadonlyMap<string, Buffer | null> {
    return this.#changes;
  }

  list(directory = ""): string[] {
    const listed = new Set((this.base?.list(directory) ?? []).filter((file) => !this.#changes.has(file)));
    for (const [file, bytes] of this.#changes) if (bytes && isBelow(file, directory)) listed.add(file);
    return [...listed].sort(compareOrdinal);
  }

  type(file: string): ArtifactEntryType | undefined {
    const change = this.#changes.get(file);
    if (change) return "file";
    if (change === null) return undefined;
    for (const [changed, bytes] of this.#changes) if (bytes && isBelow(changed, file)) return "directory";
    const type = this.base?.type(file);
    // A directory whose files were all removed is gone.
    return type === "directory" && this.list(file).length === 0 ? undefined : type;
  }

  size(file: string): number {
    const change = this.#changes.get(file);
    if (change) return change.length;
    if (change === null || !this.base) throw new Error(`${this.describe(file)} is not a regular file.`);
    return this.base.size(file);
  }

  read(file: string): Buffer {
    const change = this.#changes.get(file);
    if (change) return change;
    if (change === null || !this.base) fail(`Cannot read ${this.describe(file)}: it does not exist.`);
    return this.base.read(file);
  }

  describe(file: string): string {
    return this.base?.describe(file) ?? file;
  }
}

/** Moves refs in one transaction, each compared with the value the command read. */
export function updateRefs(root: string, updates: readonly RefUpdate[]): void {
  if (updates.length === 0) return;
  const commands = [
    "start",
    ...updates.flatMap(({ ref, next, previous }) => {
      const write = next !== previous;
      return [
        // A write never follows a symbolic ref: a ref made symbolic since it
        // was read is replaced, not the ref it names, and the expected value is
        // still checked. Semantic Flow's own refs are never symbolic.
        ...(write || ref.startsWith(OWN_REF_PREFIX) ? ["option no-deref"] : []),
        // An unchanged ref is only checked. Git reports `verify` to
        // reference-transaction hooks as a deletion, so an existing ref is
        // checked by updating it to its own value.
        !write ? (previous === ZERO_OID ? `verify ${ref} ${ZERO_OID}` : `update ${ref} ${previous} ${previous}`)
          : next === ZERO_OID ? `delete ${ref} ${previous}` : `update ${ref} ${next} ${previous}`,
      ];
    }),
    "prepare",
    "commit",
    "",
  ].join("\n");
  gitRaw(["update-ref", "--create-reflog", "-m", "semantic-flow", "--stdin"], { cwd: root, input: commands });
}

/** The stage heads a stored manifest records, read leniently. */
function recordedHeads(files: ArtifactFiles | undefined): string[] {
  if (!files || files.type("manifest.json") !== "file") return [];
  let manifest: unknown;
  try {
    manifest = readArtifactJson(files, "manifest.json");
  } catch {
    return [];
  }
  const stages = isRecord(manifest) && Array.isArray(manifest.stages) ? manifest.stages : [];
  return stages.flatMap((stage) =>
    isRecord(stage) && typeof stage.headRevision === "string" && /^[0-9a-f]{40,64}$/.test(stage.headRevision) ? [stage.headRevision] : []);
}

/** The superseded heads of the next snapshot: those the base carried, and
 * those the base recorded that the draft no longer does. Keeping them as the
 * snapshot's parents keeps earlier stage heads reachable, so feedback anchored
 * to them survives garbage collection. */
function supersededHeads(base: RefSnapshot | undefined, draft: ArtifactDraft, retain: readonly string[] = []): string[] {
  const current = new Set(recordedHeads(draft));
  const heads = [...(base?.active.supersededHeads ?? []), ...recordedHeads(base), ...retain];
  return [...new Set(heads)].filter((head) => !current.has(head));
}

/** Writes the draft's files as one tree and returns it. Unchanged files keep
 * their blobs; new bytes are stored unchanged by any filter or line-ending setting. */
function writeDraftTree(root: string, draft: ArtifactDraft): string {
  const listed = draft.list();
  for (const file of listed) if (draft.type(file) !== "file") fail(`${draft.describe(file)} is not a regular file.`);
  const oids = writeBlobs(root, draft, listed);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-artifact-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    const entries = listed.map((file) => `100644 ${oids.get(file)}\t${file}\0`).join("");
    gitRaw(["update-index", "--add", "-z", "--index-info"], { cwd: root, env, input: entries });
    return gitRaw(["write-tree"], { cwd: root, env });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const CHANGED = "The semantic implementation changed while this command ran; retry it.";

/** Runs a ref transaction that includes the artifact's ref. When it fails
 * because another writer moved that ref first, says so. */
function moveArtifactRef(root: string, implementationId: string, previous: string, updates: RefUpdate[]): void {
  try {
    updateRefs(root, updates);
  } catch (error) {
    const current = listActiveImplementations(root).find((active) => active.implementationId === implementationId)?.commit ?? ZERO_OID;
    if (current === previous) throw error;
    fail(previous === ZERO_OID ? `A semantic implementation with implementation ID ${implementationId} already exists.` : CHANGED);
  }
}

/** Commits a draft as the new snapshot of its implementation and moves the
 * implementation's ref to it together with the other ref updates, in one
 * transaction. Fails without changing anything when the artifact changed since
 * base was read; without base, when the implementation already exists.
 * Superseded stage heads stay reachable as the snapshot's parents, as do the
 * retained commits, such as the commits a fold replaced. */
export function commitArtifact(
  root: string,
  base: ArtifactSnapshot | undefined,
  draft: ArtifactDraft,
  refUpdates: readonly RefUpdate[] = [],
  retain: readonly string[] = [],
): string {
  if (base !== undefined && !(base instanceof RefSnapshot)) throw new Error("Only an active artifact can be committed.");
  const implementationId = activeImplementationId(root, draft);
  if (base && base.implementationId !== implementationId) fail("A command may not change the implementation ID.");
  const tree = writeDraftTree(root, draft);
  const parents = supersededHeads(base, draft, retain).flatMap((head) => ["-p", head]);
  const commit = gitRaw(["commit-tree", tree, ...parents, "-m", `Semantic implementation ${implementationId}`], { cwd: root, env: SNAPSHOT_IDENTITY });
  const previous = base?.version ?? ZERO_OID;
  // A new implementation may not take the ID of an archived one, whose archive
  // ref and shared tag are named by it.
  const archived = [archiveRef(implementationId), archiveTag(implementationId)];
  if (!base && archived.some((ref) => git(["rev-parse", "--verify", "--quiet", ref], { cwd: root, allowFailure: true }))) {
    fail(`Implementation ID ${implementationId} belongs to an archived implementation; choose another ID.`);
  }
  const unarchived = base ? [] : archived.map((ref) => ({ ref, next: ZERO_OID, previous: ZERO_OID }));
  // The artifact's ref goes last, so no other update can fail after it moved.
  moveArtifactRef(root, implementationId, previous, [...refUpdates, ...unarchived, { ref: activeRef(implementationId), next: commit, previous }]);
  return commit;
}

/** Replaces one top-level file of the active artifact of an implementation in
 * the repository whose Git directory is gitDirectory. Every Git command is
 * given that directory, so none needs a worktree or repository discovery, which
 * a setting such as safe.bareRepository=explicit refuses for a bare repository.
 * replace receives the artifact's files and returns the file's new bytes, or
 * undefined to leave the artifact unchanged. The ref moves only if it still
 * points at the snapshot replace saw; when another writer moved it first,
 * replace decides again on what that writer committed. Returns whether the
 * file was replaced; false also when the implementation is not active. */
export function replaceArtifactFileInGitDirectory(
  gitDirectory: string,
  implementationId: string,
  file: string,
  replace: (files: ArtifactFiles) => Buffer | undefined,
): boolean {
  if (checkedPath(file).includes("/")) throw new Error(`${file} is not a top-level artifact file.`);
  const gitDir = `--git-dir=${gitDirectory}`;
  const run: GitRunner = (args, input) => gitRaw([gitDir, ...args], { input, encoding: "buffer" });
  const ref = activeRef(implementationId);
  const read = () => run(["for-each-ref", "--format=%(objectname)%09%(refname)%09%(parent)%09%(symref)", ref]).toString("utf8")
    .split(/\r?\n/).find((entry) => entry.split("\t")[1] === ref);
  for (let attempt = 0; ; attempt++) {
    const line = read();
    if (!line) return false;
    const [commit, , parents = "", symref = ""] = line.split("\t");
    assertDirectActiveRef(ref, symref);
    const files = treeFiles(run, commit, "", ref) ?? fail(`Cannot read the snapshot ${commit} of ${ref}.`);
    const bytes = replace(files);
    if (bytes === undefined) return false;
    const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], bytes).toString("utf8").trim();
    // The other entries keep their blobs and modes; mktree orders the entries itself.
    const entries = run(["ls-tree", "-z", commit]).toString("utf8").split("\0")
      .filter((entry) => entry && entry.slice(entry.indexOf("\t") + 1) !== file);
    entries.push(`100644 blob ${blob}\t${file}`);
    const tree = run(["mktree", "-z"], Buffer.from(entries.map((entry) => `${entry}\0`).join(""), "utf8")).toString("utf8").trim();
    // The superseded heads stay the snapshot's parents, as commitArtifact keeps them.
    const next = gitRaw([gitDir, "commit-tree", tree, ...parents.split(" ").filter(Boolean).flatMap((parent) => ["-p", parent]),
      "-m", `Semantic implementation ${implementationId}`], { env: SNAPSHOT_IDENTITY });
    try {
      run(["update-ref", "--no-deref", "--create-reflog", "-m", "semantic-flow", ref, next, commit]);
      return true;
    } catch (error) {
      // Only another writer moving the ref first is worth deciding again.
      if (attempt >= 4 || read()?.split("\t")[0] === commit) throw error;
    }
  }
}

/** The active artifact of an implementation in the repository whose Git
 * directory is gitDirectory, read as in replaceArtifactFileInGitDirectory.
 * confirmed() tells whether the ref still holds what was read, checked in a ref
 * transaction; false when it changed or another writer holds it. */
export function readActiveArtifactInGitDirectory(
  gitDirectory: string,
  implementationId: string,
): { active?: ArtifactFiles; confirmed: () => boolean } {
  const gitDir = `--git-dir=${gitDirectory}`;
  const run: GitRunner = (args, input) => gitRaw([gitDir, ...args], { input, encoding: "buffer" });
  const ref = activeRef(implementationId);
  const commit = run(["for-each-ref", "--format=%(objectname)%09%(refname)", ref]).toString("utf8")
    .split(/\r?\n/).map((line) => line.split("\t")).find(([, name]) => name === ref)?.[0];
  const confirmed = () => {
    // A verify command locks the ref and compares it, so it fails when the ref
    // moved since the read, or another writer holds it.
    try { run(["update-ref", "--stdin"], Buffer.from(`verify ${ref} ${commit ?? ZERO_OID}\n`, "utf8")); return true; }
    catch { return false; }
  };
  const active = commit === undefined ? undefined : treeFiles(run, commit, "", ref) ?? fail(`Cannot read the snapshot ${commit} of ${ref}.`);
  return { active, confirmed };
}

/** Removes the active artifact read as base, together with the other ref
 * updates, unless it changed since. */
export function removeArtifact(root: string, base: ArtifactSnapshot, refUpdates: readonly RefUpdate[] = []): void {
  if (!(base instanceof RefSnapshot)) throw new Error("Only an active artifact can be removed.");
  moveArtifactRef(root, base.implementationId, base.version, [...refUpdates, { ref: base.active.ref, next: ZERO_OID, previous: base.version }]);
}

/** Writes every file of an artifact below a directory, byte for byte, and
 * returns a function that removes what it wrote. A failed write removes it. */
export function exportArtifactFiles(files: ArtifactFiles, destination: string): () => void {
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  // Directories are created one level at a time, so only those this call made are recorded.
  const makeDirectory = (directory: string) => {
    const missing: string[] = [];
    for (let current = directory; !fs.existsSync(current) && path.dirname(current) !== current; current = path.dirname(current)) {
      missing.unshift(current);
    }
    for (const current of missing) {
      try {
        fs.mkdirSync(current);
        createdDirectories.push(current);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  };
  // Removes only what this call created, so a concurrent writer's files and
  // anything else placed beside them are kept.
  const remove = () => {
    for (const file of createdFiles.reverse()) fs.rmSync(file, { force: true });
    for (const directory of createdDirectories.sort((left, right) => right.length - left.length)) {
      try { fs.rmdirSync(directory); } catch { /* Not empty, or already gone. */ }
    }
  };
  try {
    makeDirectory(destination);
    for (const file of files.list()) {
      if (files.type(file) !== "file") fail(`${files.describe(file)} is not a regular file.`);
      const target = path.join(destination, ...file.split("/"));
      const bytes = files.read(file);
      makeDirectory(path.dirname(target));
      // Only a file this call opened exclusively is its own to remove.
      const descriptor = fs.openSync(target, "wx");
      createdFiles.push(target);
      try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
    }
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}

/** A thrown value's message; describing it never throws. */
function describeFailure(failure: unknown): string {
  try { return errorMessage(failure); } catch { return "an unprintable error"; }
}

function writeFileAtomically(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    replaceFile(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Replaces the files of an artifact directory, such as a remote review's
 * projection. The change runs first; nothing is replaced when it fails. When
 * anything fails, undo reverts the change and the previous files stay.
 * Viewers may be reading the directory meanwhile; Windows refuses to move a
 * directory while a file in it is open, so each move waits for them as
 * replaceFile does. */
export function replaceArtifactDirectory(
  directory: string,
  files: Iterable<readonly [string, Buffer]>,
  change: () => void,
  undo: () => void = () => {},
): void {
  const next = `${directory}.next`;
  const previous = `${directory}.previous`;
  // Windows also refuses to remove a folder while a file in it is open.
  const remove = (folder: string) => fs.rmSync(folder, { recursive: true, force: true, ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 20 } : {}) });
  // A replacement whose rollback failed left the previous files only in their
  // backup; they are put back before that backup can be replaced.
  if (!fs.existsSync(directory) && fs.existsSync(previous)) replaceFile(previous, directory);
  remove(next);
  try {
    // Each file is written before the next is produced, so large files are not all held at once.
    for (const [file, bytes] of files) writeFileAtomically(path.join(next, ...checkedPath(file).split("/")), bytes);
    try {
      change();
      remove(previous);
      if (fs.existsSync(directory)) replaceFile(directory, previous);
      replaceFile(next, directory);
    } catch (error) {
      // The change is reverted first; both rollback steps run before any failure is described.
      const failures: Array<[string, unknown]> = [];
      try { undo(); } catch (failure) { failures.push(["Reverting the change also failed", failure]); }
      try {
        if (!fs.existsSync(directory) && fs.existsSync(previous)) replaceFile(previous, directory);
      } catch (failure) {
        failures.push([`Restoring the previous files from ${previous} also failed`, failure]);
      }
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures.map(([, failure]) => failure)],
          [describeFailure(error), ...failures.map(([what, failure]) => `${what}: ${describeFailure(failure)}`)].join(" "));
      }
      throw error;
    }
  } finally {
    // The staged files are not needed once the replacement succeeded or failed.
    try { remove(next); } catch { /* The operation's own outcome says more. */ }
  }
  // The new files are in place; a copy left behind is removed by the next replacement.
  try { remove(previous); } catch { /* See above. */ }
}

// --- Artifacts stored in Git trees ------------------------------------------

/** Runs Git with optional standard input and returns its raw output. */
export type GitRunner = (args: string[], input?: Buffer) => Buffer;

function defaultRunner(root: string): GitRunner {
  return (args, input) => gitRaw(args, { cwd: root, input, encoding: "buffer" });
}

interface TreeEntry {
  type: ArtifactEntryType;
  oid: string;
  size: number;
}

/** Reads the requested blobs with one Git process. */
export function readBlobs(run: GitRunner, oids: readonly string[]): Map<string, Buffer> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;
  const output = run(["cat-file", "--batch"], Buffer.from(unique.map((oid) => `${oid}\n`).join(""), "utf8"));
  let offset = 0;
  for (const oid of unique) {
    const end = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    if (end < 0 || header[1] !== "blob") fail(`Git object ${oid} is not a readable blob.`);
    const size = Number(header[2]);
    blobs.set(oid, Buffer.from(output.subarray(end + 1, end + 1 + size)));
    offset = end + 1 + size + 1;
  }
  return blobs;
}

/** Files of a directory in a Git tree. JSON documents are read together on
 * first use; other files are read one at a time when asked for. */
class TreeFiles implements ArtifactFiles {
  readonly #blobs = new Map<string, Buffer>();

  constructor(
    readonly run: GitRunner,
    readonly label: string,
    readonly entries: ReadonlyMap<string, TreeEntry>,
  ) {}

  list(directory = ""): string[] {
    return [...this.entries.keys()].filter((file) => isBelow(file, directory));
  }

  type(file: string): ArtifactEntryType | undefined {
    const entry = this.entries.get(file);
    if (entry) return entry.type;
    for (const other of this.entries.keys()) if (isBelow(other, file)) return "directory";
    return undefined;
  }

  size(file: string): number {
    const entry = this.entries.get(file);
    if (entry?.type !== "file") throw new Error(`${this.describe(file)} is not a regular file.`);
    return entry.size;
  }

  objectId(file: string): string | undefined {
    const entry = this.entries.get(file);
    return entry?.type === "file" ? entry.oid : undefined;
  }

  read(file: string): Buffer {
    const entry = this.entries.get(file);
    if (entry?.type !== "file") fail(`Cannot read ${this.describe(file)}: it is not a regular file.`);
    // Documents are read together on first use and kept. Any other file, such
    // as captured evidence, can be large, so it is read alone and not kept.
    const isDocument = (name: string) => name === "manifest.json" ||
      /^(requirements|stages|\.work\/stages)\/[^/]+\.json$/.test(name);
    if (!isDocument(file)) {
      const bytes = readBlobs(this.run, [entry.oid]).get(entry.oid);
      if (!bytes) fail(`Cannot read ${this.describe(file)}.`);
      return bytes;
    }
    if (!this.#blobs.has(entry.oid)) {
      const documents = [...this.entries].filter(([name, other]) => other.type === "file" && isDocument(name)).map(([, other]) => other.oid);
      for (const [oid, blob] of readBlobs(this.run, documents)) this.#blobs.set(oid, blob);
    }
    const bytes = this.#blobs.get(entry.oid);
    if (!bytes) fail(`Cannot read ${this.describe(file)}.`);
    return bytes;
  }

  describe(file: string): string {
    return `${this.label}/${file}`;
  }
}

/** The files below a directory of a Git tree, or undefined when the tree has no such directory. */
export function readTreeFiles(run: GitRunner, treeish: string, directory: string, label = `${treeish}:${directory}`): ArtifactFiles | undefined {
  return treeFiles(run, treeish, directory, label);
}

function treeFiles(run: GitRunner, treeish: string, directory: string, label: string): TreeFiles | undefined {
  let output: Buffer;
  try {
    output = run(["ls-tree", "-r", "-z", "-l", "--full-tree", `${treeish}:${directory}`]);
  } catch {
    return undefined;
  }
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, kind, oid, size] = record.slice(0, tab).split(/ +/);
    const regular = kind === "blob" && (mode === "100644" || mode === "100755");
    entries.set(record.slice(tab + 1), { type: regular ? "file" : "other", oid, size: regular ? Number(size) : 0 });
  }
  return new TreeFiles(run, label, entries);
}

/** The published artifact in a commit, or undefined when it has none. */
export function readPublishedArtifact(root: string, commit: string, run: GitRunner = defaultRunner(root)): ArtifactFiles | undefined {
  return readTreeFiles(run, commit, PUBLISHED_DIRECTORY);
}

/** The blob a file is already stored as, when it was read from Git unchanged. */
function storedObjectId(files: ArtifactFiles | undefined, file: string): string | undefined {
  if (files instanceof ArtifactDraft) return files.changes.has(file) ? undefined : storedObjectId(files.base, file);
  return files instanceof TreeFiles || files instanceof RefSnapshot ? files.objectId(file) : undefined;
}

/** Stores the files as blobs, unchanged by any filter or line-ending setting. */
function writeBlobs(root: string, files: ArtifactFiles, paths: readonly string[]): Map<string, string> {
  const oids = new Map<string, string>();
  const pending: string[] = [];
  for (const file of paths) {
    const known = storedObjectId(files, file);
    if (known) oids.set(file, known);
    else pending.push(file);
  }
  if (pending.length === 0) return oids;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-artifact-"));
  try {
    if (/[\r\n]/.test(scratch)) {
      // Git reads one path per line, so without a usable scratch path each blob goes through stdin.
      for (const file of pending) {
        oids.set(file, gitRaw(["hash-object", "-w", "--no-filters", "--stdin"], { cwd: root, input: files.read(file) }));
      }
      return oids;
    }
    const sources = pending.map((file, index) => {
      // Git reads one path per line, so a path with a line break is copied first.
      if (files instanceof FolderFiles && !/[\r\n]/.test(files.absolute(file))) return files.absolute(file);
      const source = path.join(scratch, `${index}.blob`);
      fs.writeFileSync(source, files.read(file));
      return source;
    });
    const output = gitRaw(["hash-object", "-w", "--no-filters", "--stdin-paths"], { cwd: root, input: `${sources.join("\n")}\n` });
    output.split(/\r?\n/).forEach((oid, index) => oids.set(pending[index], oid));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return oids;
}

/** The tree of parent with the artifact's files in its .semantic-review
 * directory, in place of whatever the parent stored there. The artifact's
 * subtree is written from a fresh index and spliced into the parent's root
 * tree, so neither the checkout nor a sparse checkout setting takes part. */
export function buildArtifactTree(root: string, files: ArtifactFiles, parent: string): string {
  const listed = files.list();
  for (const file of listed) if (files.type(file) !== "file") fail(`${files.describe(file)} is not a regular file.`);
  const oids = writeBlobs(root, files, listed);
  const indexFile = path.join(os.tmpdir(), `semantic-artifact-${process.pid}-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  let artifactTree: string;
  try {
    gitRaw(["read-tree", "--empty"], { cwd: root, env });
    const entries = listed.map((file) => `100644 ${oids.get(file)}\t${file}\0`).join("");
    gitRaw(["update-index", "--add", "-z", "--index-info"], { cwd: root, env, input: entries });
    artifactTree = gitRaw(["write-tree"], { cwd: root, env });
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
  const rootEntries = gitRaw(["ls-tree", "-z", `${parent}^{tree}`], { cwd: root }).split("\0")
    .filter((entry) => entry && entry.slice(entry.indexOf("\t") + 1) !== PUBLISHED_DIRECTORY);
  rootEntries.push(`040000 tree ${artifactTree}\t${PUBLISHED_DIRECTORY}`);
  return gitRaw(["mktree", "-z"], { cwd: root, input: rootEntries.map((entry) => `${entry}\0`).join("") });
}

// --- Identity -----------------------------------------------------------------

/** The implementation ID of the active artifact of root. Only the identity is
 * read; commands that use the artifact validate it. */
export function activeImplementationId(root: string, snapshot: ArtifactFiles | undefined = readArtifact(root)): string {
  if (!snapshot) fail("No active semantic implementation exists.");
  // An active artifact's ref names its implementation.
  if (snapshot instanceof RefSnapshot) return snapshot.implementationId;
  const manifest = readArtifactJson(snapshot, "manifest.json");
  const implementationId = isRecord(manifest) ? manifest.implementationId : undefined;
  if (typeof implementationId !== "string") fail("The active semantic implementation manifest has no implementation ID.");
  return implementationId;
}
