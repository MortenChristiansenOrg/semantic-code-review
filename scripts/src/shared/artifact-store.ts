/** Storage of implementation artifacts. Every command, feedback operation and
 * viewer request reads and writes the active artifact through this module, so
 * nothing else knows where or how it is stored.
 *
 * A read pins one snapshot: an immutable view of the artifact's files, with a
 * version that changes whenever the artifact does. A writer edits a draft on
 * top of the snapshot it read and commits the draft, which fails when the
 * artifact changed since that read. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.js";
import { gitRaw } from "./git.js";
import { jsonBytes, parseJsonDocument } from "./json.js";
import { errorCode, errorMessage, isRecord } from "./narrow.js";

/** The folder, relative to a worktree root, that holds the active artifact. */
const ACTIVE_DIRECTORY = ".semantic-review";
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

/** The active artifact of a repository, as one read found it. */
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

// --- Folder storage ---------------------------------------------------------

class FolderFiles implements ArtifactSnapshot {
  readonly directory: string;
  readonly #version: string;

  constructor(readonly root: string) {
    this.directory = path.join(root, ACTIVE_DIRECTORY);
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

function folderHasArtifact(root: string): boolean {
  return fs.existsSync(path.join(root, ACTIVE_DIRECTORY, "manifest.json"));
}

/** The active artifact of the worktree at root, or undefined when it has none. */
export function readArtifact(root: string): ArtifactSnapshot | undefined {
  return folderHasArtifact(root) ? new FolderFiles(root) : undefined;
}

/** The active artifact of the worktree at root; fails when it has none. */
export function requireArtifact(root: string): ArtifactSnapshot {
  const snapshot = readArtifact(root);
  if (!snapshot) fail(`No semantic implementation manifest exists at ${path.join(root, ACTIVE_DIRECTORY, "manifest.json")}.`);
  return snapshot;
}

/** Whether the worktree holds artifact files that do not form an artifact. */
export function hasIncompleteArtifact(root: string): boolean {
  const directory = path.join(root, ACTIVE_DIRECTORY);
  return !folderHasArtifact(root) && fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
}

/** Where messages say the active artifact of root is stored. */
export function describeArtifact(root: string): string {
  return path.join(root, ACTIVE_DIRECTORY);
}

/** The nearest directory from start upwards whose worktree has an active artifact. */
export function locateArtifactRoot(start: string): string | undefined {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (folderHasArtifact(directory)) return directory;
    if (path.dirname(directory) === directory) return undefined;
  }
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
    ...updates.map(({ ref, next, previous }) =>
      next === ZERO_OID ? `delete ${ref} ${previous}` : `update ${ref} ${next} ${previous}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  gitRaw(["update-ref", "--stdin"], { cwd: root, input: commands });
}

const reversed = (updates: readonly RefUpdate[]): RefUpdate[] =>
  updates.map(({ ref, next, previous }) => ({ ref, next: previous, previous: next }));

function assertUnchanged(root: string, base: ArtifactSnapshot | undefined): void {
  const current = readArtifact(root);
  if ((current?.version ?? null) !== (base?.version ?? null)) {
    fail(base
      ? "The semantic implementation changed while this command ran; retry it."
      : `A semantic implementation already exists at ${describeArtifact(root)}.`);
  }
}

function writeFileAtomically(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Removes the directories a removal emptied, up to the artifact's root. */
function removeEmptyDirectories(directory: string, file: string): void {
  for (let parent = path.dirname(file); parent.startsWith(`${directory}${path.sep}`); parent = path.dirname(parent)) {
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST", "ENOENT", "EPERM", "EBUSY"].includes(errorCode(error) ?? "")) return;
      throw error;
    }
  }
}

/** Writes a draft as the new artifact of root, together with the ref updates.
 * Fails without changing anything when the artifact changed since base was read. */
export function commitArtifact(
  root: string,
  base: ArtifactSnapshot | undefined,
  draft: ArtifactDraft,
  refUpdates: readonly RefUpdate[] = [],
): void {
  assertUnchanged(root, base);
  const folder = new FolderFiles(root);
  // Only what this write changes is restored on failure; a path it never
  // reached, or an entry that is not a regular file, is left as it was.
  const restores: Array<() => void> = [];
  updateRefs(root, refUpdates);
  try {
    // Entries that are not regular files cannot be restored, so they are
    // removed last, once every other change succeeded.
    const changes = [...draft.changes].sort(([left], [right]) => Number(folder.type(left) === "other") - Number(folder.type(right) === "other"));
    for (const [file, bytes] of changes) {
      const absolute = folder.absolute(file);
      const type = folder.type(file);
      if (type === "other" && bytes) fail(`${absolute} is not a regular file.`);
      const previous = type === "file" ? folder.read(file) : undefined;
      if (type === undefined && !bytes) continue;
      // The restore is recorded before the change, so a change that fails
      // halfway, such as a removal whose directory cleanup fails, is undone too.
      if (type !== "other") restores.push(previous ? () => writeFileAtomically(absolute, previous) : () => fs.rmSync(absolute, { force: true }));
      if (bytes) writeFileAtomically(absolute, bytes);
      else {
        fs.rmSync(absolute, { force: true });
        removeEmptyDirectories(folder.directory, absolute);
      }
    }
  } catch (error) {
    try { updateRefs(root, reversed(refUpdates)); } catch { /* The write's own error says more. */ }
    for (const restore of restores.reverse()) {
      try { restore(); } catch { /* Restore what can be restored. */ }
    }
    throw error;
  }
}

/** Removes the active artifact of root, unless it changed since base was read. */
export function removeArtifact(root: string, base: ArtifactSnapshot): void {
  assertUnchanged(root, base);
  fs.rmSync(path.join(root, ACTIVE_DIRECTORY), { recursive: true, force: true });
}

/** Writes every file of an artifact below a directory of the worktree, byte for byte. */
export function exportArtifactFiles(files: ArtifactFiles, destination: string): void {
  for (const file of files.list()) {
    if (files.type(file) !== "file") fail(`${files.describe(file)} is not a regular file.`);
    const target = path.join(destination, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files.read(file), { flag: "wx" });
  }
}

/** Replaces the artifact of a managed review checkout with new files. The
 * change runs in between, while no artifact is present. When anything fails,
 * undo reverts the change and then the previous artifact is restored. */
export function replaceArtifactFiles(
  root: string,
  files: Iterable<readonly [string, Buffer]>,
  scratch: string,
  change: () => void,
  undo: () => void = () => {},
): void {
  const next = path.join(scratch, ".artifact-next");
  const backup = path.join(scratch, ".artifact-previous");
  const active = path.join(root, ACTIVE_DIRECTORY);
  fs.rmSync(next, { recursive: true, force: true });
  try {
    // Each file is written before the next is produced, so large files are not all held at once.
    for (const [file, bytes] of files) writeFileAtomically(path.join(next, ...checkedPath(file).split("/")), bytes);
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(active)) fs.renameSync(active, backup);
    try {
      change();
      fs.rmSync(active, { recursive: true, force: true });
      fs.renameSync(next, active);
    } catch (error) {
      // The change is reverted first, so it cannot overwrite the restored artifact.
      let undoError: unknown;
      try { undo(); } catch (failure) { undoError = failure; }
      fs.rmSync(active, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, active);
      if (undoError !== undefined) throw new Error(`${errorMessage(error)} Reverting the change also failed: ${errorMessage(undoError)}`, { cause: error });
      throw error;
    }
  } finally {
    // The staged files are not needed once the replacement succeeded or failed.
    try { fs.rmSync(next, { recursive: true, force: true }); } catch { /* The operation's own outcome says more. */ }
  }
  // The new artifact is in place; a backup left behind is removed by the next replacement.
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* See above. */ }
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

/** Stores the files as blobs, unchanged by any filter or line-ending setting. */
function writeBlobs(root: string, files: ArtifactFiles, paths: readonly string[]): Map<string, string> {
  const oids = new Map<string, string>();
  const pending: string[] = [];
  for (const file of paths) {
    const known = files instanceof TreeFiles ? files.objectId(file) : undefined;
    if (known) oids.set(file, known);
    else pending.push(file);
  }
  if (pending.length === 0) return oids;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-artifact-"));
  try {
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

/** The tree of parent with the artifact's files below directory in place of
 * whatever the parent stored there. */
export function buildArtifactTree(root: string, files: ArtifactFiles, parent: string, directory = PUBLISHED_DIRECTORY): string {
  const listed = files.list();
  for (const file of listed) if (files.type(file) !== "file") fail(`${files.describe(file)} is not a regular file.`);
  const oids = writeBlobs(root, files, listed);
  const indexFile = path.join(os.tmpdir(), `semantic-artifact-${process.pid}-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitRaw(["read-tree", parent], { cwd: root, env });
    gitRaw(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", directory], { cwd: root, env });
    const entries = listed.map((file) => `100644 ${oids.get(file)}\t${directory}/${file}\0`).join("");
    gitRaw(["update-index", "--add", "-z", "--index-info"], { cwd: root, env, input: entries });
    return gitRaw(["write-tree"], { cwd: root, env });
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

// --- Identity -----------------------------------------------------------------

/** The implementation ID of the active artifact of root. Only the identity is
 * read; commands that use the artifact validate it. */
export function activeImplementationId(root: string, snapshot: ArtifactFiles | undefined = readArtifact(root)): string {
  if (!snapshot) fail("No active semantic implementation exists.");
  const manifest = readArtifactJson(snapshot, "manifest.json");
  const implementationId = isRecord(manifest) ? manifest.implementationId : undefined;
  if (typeof implementationId !== "string") fail("The active semantic implementation manifest has no implementation ID.");
  return implementationId;
}
