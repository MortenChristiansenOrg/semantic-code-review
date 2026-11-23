/** Durable approved file content, owned exclusively by one local review. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReviewContext, runReviewCommand, type ReviewContext } from "./review-context.js";
import { atomicJson, readReview, reviewDirectory, withReviewLock } from "./review-store.js";
import { parseJson } from "./json.js";
import { porcelainDiff } from "./diff-settings.js";
import { readBlobs } from "./artifact-store.js";
import { capturedOutput, errorMessage, exitStatus, isRecord, isStringArray, stringField, type JsonRecord } from "./narrow.js";
import type { ApiSuccess, ApprovalComparisonResponse, ApprovalFileEndpoint, ApprovalSnapshot, ApprovalSnapshotResult, DiffLine, DiffMode } from "./viewer-protocol.js";

/** The current file endpoint, as the server resolves it. */
export type FileEndpoint = ApprovalFileEndpoint;
/** An endpoint recorded with a snapshot. Older viewers recorded ownerships of
 * other shapes; it is only compared for equality. */
type RecordedEndpoint = Omit<FileEndpoint, "ownership"> & { ownership: unknown };
type Content = { exists: boolean; mode: string | null; objectId: string | null; binary: boolean; unsupported: string; bytes: string; size: number; sha256: string | null };
type Snapshot = { id: string; endpoint: RecordedEndpoint; createdAt: string; baseIdentity?: string; content: Content };
const isOptional = (value: unknown, check: (item: unknown) => boolean) => value === undefined || check(value);
const isString = (value: unknown) => typeof value === "string";
const isNullableString = (value: unknown) => value === null || typeof value === "string";
function isEndpoint(value: unknown): value is RecordedEndpoint {
  return isRecord(value) && ["stageId", "nodeId", "path", "baseRevision", "headRevision", "fileRevision"].every((key) => isString(value[key])) &&
    isOptional(value.previousPath, isString) && isOptional(value.previousPaths, isStringArray) && "ownership" in value;
}
function isContent(value: unknown): value is Content {
  return isRecord(value) && typeof value.exists === "boolean" && typeof value.binary === "boolean" && typeof value.size === "number" &&
    isString(value.unsupported) && isString(value.bytes) && [value.mode, value.objectId, value.sha256].every(isNullableString);
}
/** Snapshots are written by this module; anything else in their place is damage. */
function parseSnapshot(value: unknown): Snapshot {
  const damaged = new Error("The approved snapshot is damaged. Re-approve the current file to capture a new snapshot.");
  if (!isRecord(value)) throw damaged;
  const { id, createdAt, baseIdentity, endpoint, content } = value;
  if (typeof id !== "string" || typeof createdAt !== "string" || (baseIdentity !== undefined && typeof baseIdentity !== "string") ||
    !isEndpoint(endpoint) || !isContent(content)) throw damaged;
  return { id, createdAt, baseIdentity, endpoint, content };
}
const MAX_APPROVED_BYTES = 20 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function approvalSnapshotPath(reviewId: string, snapshotId: string) {
  if (!/^[a-f0-9]{32}$/.test(snapshotId)) throw new Error("Invalid approval snapshot identity.");
  return path.join(reviewDirectory(reviewId), "snapshots", snapshotId + ".json");
}
function git(context: ReviewContext, args: string[], input?: Buffer): Buffer {
  return runReviewCommand(context, "git", ["--literal-pathspecs", ...args], { encoding: null, input });
}
/** Characters of paths per `ls-tree` run, which keeps its command line well
 * within the shortest platform limit (Windows: 32,767). */
const MAX_PATHSPEC_CHARS = 16_000;
/** The tree entries ("<mode> <type> <object>") of `paths` at `revision`, by path,
 * read with one `ls-tree` per several hundred paths. A path the revision lacks
 * has no entry. ls-tree distinguishes an absent file from an unavailable commit. */
function treeEntries(context: ReviewContext, revision: string, paths: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>(), wanted = new Set(paths);
  // ls-tree does not list a tree whose paths are listed too, so a path that
  // names a directory of another wanted path is listed on its own.
  const directories = new Set<string>();
  for (const entryPath of wanted) {
    for (let slash = entryPath.indexOf("/"); slash > 0; slash = entryPath.indexOf("/", slash + 1)) {
      const directory = entryPath.slice(0, slash);
      if (wanted.has(directory)) directories.add(directory);
    }
  }
  const list = (chunk: string[]) => {
    for (const line of git(context, ["ls-tree", "-z", revision, "--", ...chunk]).toString("utf8").split("\0")) {
      const tab = line.indexOf("\t"), entryPath = line.slice(tab + 1);
      if (tab >= 0 && wanted.has(entryPath)) entries.set(entryPath, line.slice(0, tab));
    }
  };
  let chunk: string[] = [], chars = 0;
  for (const entryPath of wanted) {
    if (directories.has(entryPath)) { list([entryPath]); continue; }
    if (chunk.length && chars + entryPath.length > MAX_PATHSPEC_CHARS) { list(chunk); chunk = []; chars = 0; }
    chunk.push(entryPath); chars += entryPath.length + 1;
  }
  if (chunk.length) list(chunk);
  return entries;
}
/** Each item's tree entry, read with the paths wanted at each distinct revision
 * together, or the error that reading its revision failed with. */
function entriesAt<T>(context: ReviewContext, items: readonly T[], revisionOf: (item: T) => string, pathOf: (item: T) => string): (string | undefined | Error)[] {
  const byRevision = new Map<string, Map<string, string> | Error>();
  for (const item of items) byRevision.set(revisionOf(item), byRevision.get(revisionOf(item)) ?? new Map());
  for (const revision of byRevision.keys()) {
    try { byRevision.set(revision, treeEntries(context, revision, items.filter((item) => revisionOf(item) === revision).map(pathOf))); }
    catch { byRevision.set(revision, new Error(`Git revision ${revision} cannot be read.`)); }
  }
  return items.map((item) => {
    const entries = byRevision.get(revisionOf(item));
    return entries instanceof Error ? entries : entries?.get(pathOf(item));
  });
}
/** A file at its head revision: its tree entry, if it has one, and its blob's size. */
interface HeadFile { entry: string | undefined; size?: number }
/** Each endpoint's file at its head, read with a few Git runs for all of them. */
function headFiles(context: ReviewContext, endpoints: readonly RecordedEndpoint[]): (HeadFile | Error)[] {
  const entries = entriesAt(context, endpoints, (endpoint) => endpoint.headRevision, (endpoint) => endpoint.path);
  const blobs = [...new Set(entries.flatMap((entry) => typeof entry === "string" && entry.split(" ")[1] === "blob" ? [entry.split(" ")[2]] : []))];
  const sizes = new Map<string, number>();
  const check = (ids: string[]) => {
    const lines = git(context, ["cat-file", "--batch-check"], Buffer.from(ids.map((id) => id + "\n").join(""), "utf8")).toString("utf8").split("\n");
    ids.forEach((id, index) => {
      const [, type, size] = (lines[index] ?? "").split(" ");
      if (type === "blob") sizes.set(id, Number(size));
    });
  };
  // An object that cannot be read, such as one a partial clone cannot fetch,
  // leaves its files, and only them, failed: when the check of all fails, each is checked alone.
  if (blobs.length) try { check(blobs); }
  catch {
    if (blobs.length > 1) for (const id of blobs) {
      try { check([id]); } catch { /* Its files report the object unavailable. */ }
    }
  }
  return entries.map((entry) => entry instanceof Error ? entry : { entry, size: entry ? sizes.get(entry.split(" ")[2]) : undefined });
}
/** The blob a file's content is read from, and its size: none for a file without
 * readable content within the snapshot limit. */
function blobToRead(file: HeadFile | Error): { id: string; size: number } | null {
  if (file instanceof Error || !file.entry || file.size === undefined || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_APPROVED_BYTES) return null;
  const [, type, id] = file.entry.split(" ");
  return type === "blob" ? { id, size: file.size } : null;
}
/** The content of the blobs, read with one Git run. When that fails, each blob is
 * read alone, so only the files of a blob that cannot be read fail. */
function readBlobContents(context: ReviewContext, ids: readonly string[]): Map<string, Buffer> {
  const run = (args: string[], input?: Buffer) => git(context, args, input);
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  try { return readBlobs(run, unique); }
  catch {
    const contents = new Map<string, Buffer>();
    if (unique.length > 1) for (const id of unique) {
      try { for (const [read, content] of readBlobs(run, [id])) contents.set(read, content); }
      catch { /* The file reports its object unavailable. */ }
    }
    return contents;
  }
}
/** A file's content from its head entry and the blobs read for it. */
function contentOf(file: HeadFile | Error, contents: ReadonlyMap<string, Buffer>): Content | Error {
  if (file instanceof Error) return file;
  const { entry, size } = file;
  const [mode, type, objectId] = entry ? entry.split(" ") : [];
  const unsupported = entry && type !== "blob" ? "Git submodules do not have file content to compare." : "";
  if (entry && !unsupported) {
    if (size === undefined) return new Error(`Git object ${objectId} is unavailable.`);
    if (!Number.isSafeInteger(size) || size < 0) return new Error("Invalid Git blob size.");
    if (size > MAX_APPROVED_BYTES) return { exists: true, mode, objectId, binary: false, bytes: "", size, sha256: null,
      unsupported: "File content exceeds the 20 MiB approval snapshot limit. Size and Git object identity are retained; a line comparison is unavailable." };
  }
  const content = entry && !unsupported ? contents.get(objectId) : Buffer.alloc(0);
  if (!content) return new Error(`Git object ${objectId} is unavailable.`);
  const text = content.toString("utf8");
  return { exists: Boolean(entry), mode: mode || null, objectId: objectId || null, unsupported,
    binary: content.includes(0) || !Buffer.from(text, "utf8").equals(content), bytes: content.toString("base64"), size: content.length, sha256: digest(content) };
}
function readContent(context: ReviewContext, endpoint: RecordedEndpoint): Content {
  const [file] = headFiles(context, [endpoint]), blob = blobToRead(file);
  return orThrow(contentOf(file, readBlobContents(context, blob ? [blob.id] : [])));
}
/** The tree entry each endpoint's file had at its base, empty when the base lacks it. */
function baseIdentities(context: ReviewContext, endpoints: readonly RecordedEndpoint[]): (string | Error)[] {
  return entriesAt(context, endpoints, (endpoint) => endpoint.baseRevision, (endpoint) => endpoint.previousPath || endpoint.path)
    .map((entry) => entry ?? "");
}
function baseIdentity(context: ReviewContext, endpoint: RecordedEndpoint): string {
  return orThrow(baseIdentities(context, [endpoint])[0]);
}
function orThrow<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}
function approvedBaseIdentity(context: ReviewContext, snapshot: Snapshot): string | null {
  try { return snapshot.baseIdentity ?? baseIdentity(context, snapshot.endpoint); }
  // Older snapshots may outlive their original Git objects.
  catch { return null; }
}
/** Text of a base file identity: empty when the base lacks the file, null when it cannot take part in a merge. */
function baseContent(context: ReviewContext, identity: string): Buffer | null {
  if (!identity) return Buffer.alloc(0);
  const [, type, objectId] = identity.split(" ");
  if (type !== "blob") return null;
  try {
    if (Number(git(context, ["cat-file", "-s", objectId]).toString("utf8").trim()) > MAX_APPROVED_BYTES) return null;
    const bytes = git(context, ["cat-file", "blob", objectId]);
    return bytes.includes(0) ? null : bytes;
  } catch { return null; }
}
/** The approved file with only the base's changes applied, or null when they overlap the stage's own edits. */
function approvedOnCurrentBase(context: ReviewContext, approved: Buffer, previousBase: Buffer, currentBase: Buffer, directory: string): Buffer | null {
  const approvedFile = path.join(directory, "rebased-approved"), previousFile = path.join(directory, "previous-base"), currentFile = path.join(directory, "current-base");
  fs.writeFileSync(approvedFile, approved); fs.writeFileSync(previousFile, previousBase); fs.writeFileSync(currentFile, currentBase);
  // merge-file exits nonzero for conflicts as well as for errors; either way the changes stay inseparable.
  try { return git(context, ["merge-file", "-p", approvedFile, previousFile, currentFile]); }
  catch { return null; }
}
/** Files whose content is read with one Git run and written under one hold of the
 * review lock, and the content bytes they may have together: this bounds the
 * memory a capture holds and how long other requests and the agent's commands
 * wait for the lock. */
const MAX_GROUP_FILES = 200, MAX_GROUP_BYTES = 32 * 1024 * 1024;
/** Retains the content of each approved file. The files are read in groups,
 * outside the review lock: their revisions are immutable. A file that cannot be
 * read or stored fails alone; a review that changed or ended fails the whole capture. */
export function captureApprovalSnapshots(context: ReviewContext, endpoints: readonly FileEndpoint[]): ApprovalSnapshotResult[] {
  const files = headFiles(context, endpoints), bases = baseIdentities(context, endpoints);
  // A review that changed or ended while the files were read fails as a whole,
  // not as files that could not be read.
  assertReviewContext(context);
  const results: ApprovalSnapshotResult[] = [];
  for (let start = 0, end = 0; start < endpoints.length; start = end) {
    let bytes = 0;
    while (end < endpoints.length && end - start < MAX_GROUP_FILES && (end === start || bytes + (blobToRead(files[end])?.size ?? 0) <= MAX_GROUP_BYTES)) {
      bytes += blobToRead(files[end++])?.size ?? 0;
    }
    const group = Array.from({ length: end - start }, (_, offset) => start + offset);
    const contents = readBlobContents(context, group.flatMap((index) => blobToRead(files[index])?.id ?? []));
    // A review that changed or ended meanwhile is why its blobs could not be read.
    assertReviewContext(context);
    const snapshots: { index: number; snapshot: Snapshot }[] = [];
    for (const index of group) {
      const content = contentOf(files[index], contents), base = bases[index];
      if (content instanceof Error || base instanceof Error) { results[index] = { error: errorMessage(content instanceof Error ? content : base) }; continue; }
      snapshots.push({ index, snapshot: { id: randomUUID().replaceAll("-", ""), endpoint: endpoints[index], createdAt: new Date().toISOString(), baseIdentity: base, content } });
    }
    if (snapshots.length) withReviewLock(context.reviewId, () => {
      assertReviewContext(context);
      for (const { index, snapshot } of snapshots) {
        try {
          atomicJson(approvalSnapshotPath(context.reviewId, snapshot.id), snapshot);
          results[index] = { snapshotId: snapshot.id, capturedAt: snapshot.createdAt };
        } catch (error) { results[index] = { error: `Could not store the approved content: ${errorMessage(error)}` }; }
      }
    });
  }
  return results;
}
export function captureApprovalSnapshot(context: ReviewContext, endpoint: FileEndpoint): ApprovalSnapshot {
  const [captured] = captureApprovalSnapshots(context, [endpoint]);
  if ("error" in captured) throw new Error(captured.error);
  return captured;
}
export function compareApprovalSnapshot(context: ReviewContext, snapshotId: string, current: FileEndpoint, offset = 0, mode: DiffMode = "changes", scope: "stage" | "all" = "stage"): ApiSuccess<ApprovalComparisonResponse> {
  if (!["changes", "full"].includes(mode)) throw new Error("Invalid comparison view.");
  if (!["stage", "all"].includes(scope)) throw new Error("Invalid comparison scope.");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid comparison page.");
  return withReviewLock(context.reviewId, () => {
    assertReviewContext(context);
    const file = approvalSnapshotPath(context.reviewId, snapshotId);
    if (!fs.existsSync(file)) throw new Error("Approved content is unavailable. Re-approve the current file to capture a new snapshot.");
    const snapshot = parseSnapshot(parseJson(fs.readFileSync(file, "utf8")));
    // A persisted reference carries identity through rename edges observed in earlier revisions.
    const review = readReview(context.reviewId);
    const approvals: JsonRecord = isRecord(review.state.approvals) ? review.state.approvals : {};
    const approvedSnapshot = (key: string) => stringField(approvals[key], "snapshotId");
    const retained = [current.path, current.previousPath].filter(Boolean).some((filePath) =>
      approvedSnapshot(`m:${JSON.stringify([current.stageId, current.nodeId, filePath])}`) === snapshotId);
    const originalKey = `m:${JSON.stringify([snapshot.endpoint.stageId, snapshot.endpoint.nodeId, snapshot.endpoint.path])}`;
    const remotePrevious = review.remote && /^commit-[a-f0-9]{40,64}$/.test(current.stageId) && /^commit-[a-f0-9]{40,64}$/.test(snapshot.endpoint.stageId) &&
      current.nodeId === "changes" && snapshot.endpoint.nodeId === "changes" &&
      [current.path, current.previousPath, ...(current.previousPaths || [])].includes(snapshot.endpoint.path) && approvedSnapshot(originalKey) === snapshotId;
    if (!remotePrevious && (snapshot.endpoint.stageId !== current.stageId || snapshot.endpoint.nodeId !== current.nodeId || (!retained && ![current.path, current.previousPath].includes(snapshot.endpoint.path)))) throw new Error("The approved snapshot belongs to another file review.");
    const before = snapshot.content, after = readContent(context, current);
    if (snapshot.id !== snapshotId || (before.sha256 === null ? !before.unsupported || before.bytes !== "" : digest(Buffer.from(before.bytes, "base64")) !== before.sha256)) throw new Error("The approved snapshot is damaged. Re-approve the current file to capture a new snapshot.");
    const previousIdentity = approvedBaseIdentity(context, snapshot), currentIdentity = baseIdentity(context, current);
    const baseChanged = previousIdentity === null ? snapshot.endpoint.baseRevision !== current.baseRevision : previousIdentity !== currentIdentity;
    const info = {
      approved: { ...snapshot.endpoint, at: snapshot.createdAt, size: before.size, sha256: before.sha256, exists: before.exists, mode: before.mode, objectId: before.objectId },
      current: { ...current, size: after.size, sha256: after.sha256, exists: after.exists, mode: after.mode, objectId: after.objectId },
      baseChanged,
      ownershipChanged: !isDeepStrictEqual(snapshot.endpoint.ownership, current.ownership),
    };
    const unsupported = before.unsupported || after.unsupported || (before.binary || after.binary ? "Binary file comparison: content hashes and sizes are shown; a line diff is unavailable." : "");
    type BaseChanges = ApiSuccess<ApprovalComparisonResponse>["baseChanges"];
    if (unsupported) return { ...info, baseChanges: baseChanged ? "mixed" : "none", unsupported, lines: [], offset, nextOffset: null };
    const temporary = fs.mkdtempSync(path.join(reviewDirectory(context.reviewId), "snapshots", ".compare-"));
    try {
      const approvedBytes = Buffer.from(before.bytes, "base64"), currentBytes = Buffer.from(after.bytes, "base64");
      // An approval carried to a later commit stage has that stage's earlier commits in its base; they stay visible.
      const previousBase = baseChanged && previousIdentity !== null && snapshot.endpoint.stageId === current.stageId ? baseContent(context, previousIdentity) : null;
      const currentBase = previousBase && baseContent(context, currentIdentity);
      const separated = previousBase && currentBase ? approvedOnCurrentBase(context, approvedBytes, previousBase, currentBase, temporary) : null;
      // Comparing with the approved file moved onto the current base attributes base changes away from the stage.
      const baseChanges: BaseChanges = !baseChanged ? "none" : !separated ? "mixed" : scope === "all" ? "included" : "excluded";
      const comparedBytes = baseChanges === "excluded" && separated ? separated : approvedBytes;
      if (mode === "full" && comparedBytes.equals(currentBytes)) {
        const text = currentBytes.toString("utf8");
        const content = text ? text.split("\n") : [];
        if (text.endsWith("\n")) content.pop();
        const lines = content.slice(offset, offset + 900).map((s, i): DiffLine => ({ t: "ctx", o: offset + i + 1, n: offset + i + 1, s }));
        return { ...info, baseChanges, unsupported: "", lines, offset, nextOffset: offset + lines.length < content.length ? offset + lines.length : null };
      }
      const oldFile = path.join(temporary, "approved"), newFile = path.join(temporary, "current");
      fs.writeFileSync(oldFile, comparedBytes); fs.writeFileSync(newFile, currentBytes);
      let patch: string;
      // The settings of the viewer's diffs, so the lines read the same whatever the user's Git configuration.
      const command = porcelainDiff("diff", ["--no-index", "--text", mode === "full" ? "-U2147483647" : "-U3", "--", oldFile, newFile],
        { objectIdLength: current.headRevision.length });
      try { patch = runReviewCommand(context, "git", command.args, { encoding: null, environment: command.env }).toString("utf8"); }
      catch (error) {
        const stdout = capturedOutput(error, "stdout");
        if (exitStatus(error) !== 1 || !stdout) throw error;
        patch = stdout.toString("utf8");
      }
      const lines: DiffLine[] = [];
      let oldNo = 0, newNo = 0, started = false, count = 0, more = false;
      for (const line of patch.split("\n")) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) { oldNo = Number(header[1]); newNo = Number(header[2]); started = true; continue; }
        if (!started || !["+", "-", " "].includes(line[0])) continue;
        const item: DiffLine = line[0] === "+" ? { t: "add", n: newNo++, s: line.slice(1) }
          : line[0] === "-" ? { t: "del", o: oldNo++, s: line.slice(1) } : { t: "ctx", o: oldNo++, n: newNo++, s: line.slice(1) };
        if (count++ < offset) continue;
        if (lines.length === 900) { more = true; break; }
        lines.push(item);
      }
      return { ...info, baseChanges, unsupported: "", lines, offset, nextOffset: more ? offset + lines.length : null };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}
