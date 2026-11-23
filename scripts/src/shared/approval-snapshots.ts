/** Durable approved file content, owned exclusively by one local review. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReviewContext, runReviewCommand, type ReviewContext } from "./review-context.js";
import { atomicJson, readReview, reviewDirectory, withReviewLock } from "./review-store.js";
import { parseJson } from "./json.js";
import { porcelainDiff } from "./diff-settings.js";
import { capturedOutput, exitStatus, isRecord, isStringArray, stringField, type JsonRecord } from "./narrow.js";
import type { ApiSuccess, ApprovalComparisonResponse, ApprovalFileEndpoint, ApprovalSnapshotResponse, DiffLine, DiffMode } from "./viewer-protocol.js";

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
function git(context: ReviewContext, args: string[]): Buffer {
  return runReviewCommand(context, "git", ["--literal-pathspecs", ...args], { encoding: null });
}
function readContent(context: ReviewContext, endpoint: RecordedEndpoint): Content {
  // ls-tree distinguishes an absent file from an unavailable commit/blob.
  const tree = git(context, ["ls-tree", "-z", endpoint.headRevision, "--", endpoint.path]).toString("utf8");
  const record = tree.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === endpoint.path);
  const [mode, type, objectId] = record ? record.slice(0, record.indexOf("\t")).split(" ") : [];
  const unsupported = record && type !== "blob" ? "Git submodules do not have file content to compare." : "";
  if (record && !unsupported) {
    const size = Number(git(context, ["cat-file", "-s", objectId]).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git blob size.");
    if (size > MAX_APPROVED_BYTES) return { exists: true, mode, objectId, binary: false, bytes: "", size, sha256: null,
      unsupported: "File content exceeds the 20 MiB approval snapshot limit. Size and Git object identity are retained; a line comparison is unavailable." };
  }
  const bytes = record && !unsupported ? git(context, ["cat-file", "blob", objectId]) : Buffer.alloc(0);
  const text = bytes.toString("utf8");
  return { exists: Boolean(record), mode: mode || null, objectId: objectId || null, unsupported,
    binary: bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes), bytes: bytes.toString("base64"), size: bytes.length, sha256: digest(bytes) };
}
/** A base file's mode, type and object; empty where the base has no file
 * there. A directory of that name is not the file. */
const fileIdentity = (record: string) => record.split(" ")[1] === "tree" ? "" : record;
function baseIdentity(context: ReviewContext, endpoint: RecordedEndpoint): string {
  const filePath = endpoint.previousPath || endpoint.path;
  const tree = git(context, ["ls-tree", "-z", endpoint.baseRevision, "--", filePath]).toString("utf8");
  const record = tree.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === filePath);
  return record ? fileIdentity(record.slice(0, record.indexOf("\t"))) : "";
}
function approvedBaseIdentity(context: ReviewContext, snapshot: Snapshot): string | null {
  try { return snapshot.baseIdentity !== undefined ? fileIdentity(snapshot.baseIdentity) : baseIdentity(context, snapshot.endpoint); }
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
export function captureApprovalSnapshot(context: ReviewContext, endpoint: FileEndpoint): ApiSuccess<ApprovalSnapshotResponse> {
  return withReviewLock(context.reviewId, () => {
    assertReviewContext(context);
    const snapshot: Snapshot = { id: randomUUID().replaceAll("-", ""), endpoint, createdAt: new Date().toISOString(), baseIdentity: baseIdentity(context, endpoint), content: readContent(context, endpoint) };
    atomicJson(approvalSnapshotPath(context.reviewId, snapshot.id), snapshot);
    return { snapshotId: snapshot.id, capturedAt: snapshot.createdAt };
  });
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
