/** Durable approved file content, owned exclusively by one local review. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReviewContext, runReviewCommand, type ReviewContext } from "./review-context.js";
import { atomicJson, readReview, reviewDirectory, withReviewLock } from "./review-store.js";

export type FileEndpoint = {
  stageId: string; nodeId: string; path: string; previousPath?: string;
  baseRevision: string; headRevision: string; fileRevision: string; ownership: any;
};
type Content = { exists: boolean; mode: string | null; objectId: string | null; binary: boolean; unsupported: string; bytes: string; size: number; sha256: string };
type Snapshot = { id: string; endpoint: FileEndpoint; createdAt: string; content: Content };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function approvalSnapshotPath(reviewId: string, snapshotId: string) {
  if (!/^[a-f0-9]{32}$/.test(snapshotId)) throw new Error("Invalid approval snapshot identity.");
  return path.join(reviewDirectory(reviewId), "snapshots", snapshotId + ".json");
}
function git(context: ReviewContext, args: string[]): Buffer {
  return runReviewCommand(context, "git", ["--literal-pathspecs", ...args], { encoding: null });
}
function readContent(context: ReviewContext, endpoint: FileEndpoint): Content {
  // ls-tree distinguishes an absent file from an unavailable commit/blob.
  const tree = git(context, ["ls-tree", "-z", endpoint.headRevision, "--", endpoint.path]).toString("utf8");
  const record = tree.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === endpoint.path);
  const [mode, type, objectId] = record ? record.slice(0, record.indexOf("\t")).split(" ") : [];
  const unsupported = record && type !== "blob" ? "Git submodules do not have file content to compare." : "";
  const bytes = record && !unsupported ? git(context, ["cat-file", "blob", objectId]) : Buffer.alloc(0);
  const text = bytes.toString("utf8");
  return { exists: Boolean(record), mode: mode || null, objectId: objectId || null, unsupported,
    binary: bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes), bytes: bytes.toString("base64"), size: bytes.length, sha256: digest(bytes) };
}
export function captureApprovalSnapshot(context: ReviewContext, endpoint: FileEndpoint) {
  return withReviewLock(context.reviewId, () => {
    assertReviewContext(context);
    const snapshot: Snapshot = { id: randomUUID().replaceAll("-", ""), endpoint, createdAt: new Date().toISOString(), content: readContent(context, endpoint) };
    atomicJson(approvalSnapshotPath(context.reviewId, snapshot.id), snapshot);
    return { snapshotId: snapshot.id, capturedAt: snapshot.createdAt };
  });
}
export function compareApprovalSnapshot(context: ReviewContext, snapshotId: string, current: FileEndpoint, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid comparison page.");
  return withReviewLock(context.reviewId, () => {
    assertReviewContext(context);
    const file = approvalSnapshotPath(context.reviewId, snapshotId);
    if (!fs.existsSync(file)) throw new Error("Approved content is unavailable. Re-approve the current file to capture a new snapshot.");
    const snapshot: Snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    // A persisted reference carries identity through rename edges observed in earlier revisions.
    const approvals = readReview(context.reviewId).state.approvals || {};
    const retained = [current.path, current.previousPath].filter(Boolean).some((filePath) =>
      approvals[`m:${JSON.stringify([current.stageId, current.nodeId, filePath])}`]?.snapshotId === snapshotId);
    if (snapshot.endpoint.stageId !== current.stageId || snapshot.endpoint.nodeId !== current.nodeId || (!retained && ![current.path, current.previousPath].includes(snapshot.endpoint.path))) throw new Error("The approved snapshot belongs to another file review.");
    const before = snapshot.content, after = readContent(context, current);
    if (snapshot.id !== snapshotId || digest(Buffer.from(before.bytes, "base64")) !== before.sha256) throw new Error("The approved snapshot is damaged. Re-approve the current file to capture a new snapshot.");
    const info = {
      approved: { ...snapshot.endpoint, at: snapshot.createdAt, size: before.size, sha256: before.sha256, exists: before.exists, mode: before.mode, objectId: before.objectId },
      current: { ...current, size: after.size, sha256: after.sha256, exists: after.exists, mode: after.mode, objectId: after.objectId },
      baseChanged: snapshot.endpoint.baseRevision !== current.baseRevision,
      ownershipChanged: !isDeepStrictEqual(snapshot.endpoint.ownership, current.ownership),
    };
    const unsupported = before.unsupported || after.unsupported || (before.binary || after.binary ? "Binary file comparison: content hashes and sizes are shown; a line diff is unavailable." : "");
    if (unsupported) return { ...info, unsupported, lines: [], offset, nextOffset: null };
    const temporary = fs.mkdtempSync(path.join(reviewDirectory(context.reviewId), "snapshots", ".compare-"));
    let patch: string;
    try {
      const oldFile = path.join(temporary, "approved"), newFile = path.join(temporary, "current");
      fs.writeFileSync(oldFile, Buffer.from(before.bytes, "base64")); fs.writeFileSync(newFile, Buffer.from(after.bytes, "base64"));
      try { patch = git(context, ["-c", "color.ui=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--text", "-U3", "--", oldFile, newFile]).toString("utf8"); }
      catch (error) { if (error.status !== 1 || !error.stdout) throw error; patch = error.stdout.toString("utf8"); }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    const lines: Array<{ t: string; o?: number; n?: number; s: string }> = [];
    let oldNo = 0, newNo = 0, started = false, count = 0, more = false;
    for (const line of patch.split("\n")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (header) { oldNo = Number(header[1]); newNo = Number(header[2]); started = true; continue; }
      if (!started || !["+", "-", " "].includes(line[0])) continue;
      const item = line[0] === "+" ? { t: "add", n: newNo++, s: line.slice(1) }
        : line[0] === "-" ? { t: "del", o: oldNo++, s: line.slice(1) } : { t: "ctx", o: oldNo++, n: newNo++, s: line.slice(1) };
      if (count++ < offset) continue;
      if (lines.length === 900) { more = true; break; }
      lines.push(item);
    }
    return { ...info, unsupported: "", lines, offset, nextOffset: more ? offset + lines.length : null };
  });
}
