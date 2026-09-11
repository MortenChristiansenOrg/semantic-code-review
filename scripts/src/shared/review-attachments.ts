/** Managed, immutable local message files. Callers serialize access with the review lock. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { atomicJson, readReview, reviewDirectory, touchReview } from "./review-store.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_COMMENT_ATTACHMENTS = 10;
export type Attachment = { id: string; filename: string; mediaType: string; size: number; sha256: string; path: string };
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function directory(reviewId: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid attachment identity.");
  return path.join(reviewDirectory(reviewId), "attachments", id);
}
export function imageMediaType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}
function filenameValid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255 && Buffer.from(value).toString("utf8") === value && !/[\\/\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value);
}
/** Returns metadata and a contained local path, without loading file bytes into agent output. */
export function resolveAttachment(reviewId: string, id: string): Attachment & { localPath: string } {
  const dir = directory(reviewId, id), root = reviewDirectory(reviewId);
  const record = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
  const metadata: Attachment = record.attachment;
  if (metadata?.id !== id || metadata.path !== `attachments/${id}/content.bin` || !filenameValid(metadata.filename) ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(metadata.mediaType) || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_ATTACHMENT_BYTES) throw new Error("Invalid stored attachment metadata.");
  const localPath = path.join(root, metadata.path);
  if (fs.realpathSync(localPath) !== path.join(fs.realpathSync(root), metadata.path) || !fs.statSync(localPath).isFile() || fs.statSync(localPath).size !== metadata.size) throw new Error("Attachment content is unavailable or outside its review.");
  const actualSha256 = hash(fs.readFileSync(localPath));
  if (actualSha256 !== metadata.sha256 || hash(JSON.stringify([metadata.filename, metadata.mediaType, actualSha256])) !== metadata.id) throw new Error("Attachment content or identity is damaged.");
  return { ...metadata, localPath };
}
export function attachmentReferences(reviewId: string, ids: string[]): Attachment[] {
  if (ids.length > MAX_COMMENT_ATTACHMENTS || new Set(ids).size !== ids.length) throw new Error("Use at most 10 distinct attachments per message.");
  return ids.map((id) => { const { localPath, ...metadata } = resolveAttachment(reviewId, id); return metadata; });
}
export function validateAttachmentReferences(reviewId: string, references: Attachment[] = []) {
  if (!Array.isArray(references) || !isDeepStrictEqual(attachmentReferences(reviewId, references.map((item) => item.id)), references)) throw new Error("Message attachment metadata does not match its managed file.");
}
/** Stores original bytes once per name/type/content; retries return the same reference. */
export function storeAttachment(reviewId: string, generation: string, filename: string, mediaType: string, bytes: Buffer): Attachment {
  if (readReview(reviewId).generation !== generation) throw new Error("The review session was replaced or deleted.");
  if (!filenameValid(filename)) throw new Error("Choose a filename without path separators or control characters (maximum 255 characters).");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be 20 MiB or smaller.");
  mediaType = mediaType || "application/octet-stream";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new Error("Invalid attachment media type.");
  mediaType = imageMediaType(bytes) || (mediaType.startsWith("image/") ? "application/octet-stream" : mediaType);
  const sha256 = hash(bytes), id = hash(JSON.stringify([filename, mediaType, sha256]));
  const attachment: Attachment = { id, filename, mediaType, size: bytes.length, sha256, path: `attachments/${id}/content.bin` };
  const dir = directory(reviewId, id);
  if (fs.existsSync(dir)) {
    validateAttachmentReferences(reviewId, [attachment]);
    atomicJson(path.join(dir, "metadata.json"), { attachment, uploadedAt: new Date().toISOString() });
    touchReview(reviewId); return attachment;
  }
  const temporary = fs.mkdtempSync(path.join(reviewDirectory(reviewId), "attachments", ".upload-"));
  try {
    fs.writeFileSync(path.join(temporary, "content.bin"), bytes, { mode: 0o600 });
    atomicJson(path.join(temporary, "metadata.json"), { attachment, uploadedAt: new Date().toISOString() });
    fs.renameSync(temporary, dir);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  touchReview(reviewId);
  return attachment;
}
