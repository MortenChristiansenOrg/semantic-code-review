import { createHash } from "node:crypto";
import path from "node:path";
import type { EvidenceAttachment, Stage, WorkStage } from "./documents.js";
import { fail } from "./errors.js";
import { errorMessage } from "./narrow.js";
import type { ArtifactDraft, ArtifactFiles } from "./artifact-store.js";

export const MAX_EVIDENCE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_EVIDENCE_TOTAL_BYTES = 100 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm",
  txt: "text/plain", log: "text/plain", csv: "text/csv", md: "text/markdown",
  json: "application/json", pdf: "application/pdf",
};

export function evidenceMediaType(file: string) {
  const extension = path.extname(file).slice(1).toLowerCase();
  const mediaType = MEDIA_TYPES[extension];
  if (!mediaType) fail(`Unsupported evidence file ${path.basename(file)}. Use ${Object.keys(MEDIA_TYPES).join(", ")}.`);
  return { extension, mediaType };
}

/** Stored names are content addressed, so the same capture is kept once per stage. */
export function evidenceAttachmentPath(stageId: string, sha256: string, extension: string) {
  return `evidence/${stageId}/${sha256}.${extension}`;
}

/** Refuses storage directories that are links or files, which would point reads, writes and pruning outside the artifact. */
export function assertEvidenceDirectories(files: ArtifactFiles, stageId: string) {
  for (const directory of ["evidence", `evidence/${stageId}`]) {
    const type = files.type(directory);
    if (type !== undefined && type !== "directory") throw new Error(`${directory} must be a real directory.`);
  }
}

/** Checks an artifact-relative attachment path, refusing anything but a regular file inside the artifact. */
export function resolveEvidenceFile(files: ArtifactFiles, stageId: string, attachmentPath: string) {
  const prefix = `evidence/${stageId}/`;
  if (!attachmentPath.startsWith(prefix) || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(attachmentPath.slice(prefix.length))) throw new Error(`Evidence attachment ${attachmentPath} is outside ${prefix}.`);
  assertEvidenceDirectories(files, stageId);
  if (files.type(attachmentPath) !== "file") throw new Error(`Evidence attachment ${attachmentPath} is missing.`);
  return { file: attachmentPath, size: files.size(attachmentPath) };
}

/** Reads a single-range request; anything else is served as the whole file. */
export function evidenceRange(header: string | undefined, length: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(length - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  return start > end || !length ? "unsatisfiable" as const : { start, end };
}

export const evidenceMediaTypeMatches = (attachment: { path: string; mediaType: string }) => MEDIA_TYPES[path.extname(attachment.path).slice(1)] === attachment.mediaType;

/**
 * Keeps Git from rewriting captures, so a published or archived file still matches its hash
 * under LFS filters or line-ending conversion. It travels with the artifact for that reason.
 */
export function ensureEvidenceAttributes(draft: ArtifactDraft) {
  if (draft.type("evidence/.gitattributes") === undefined) draft.write("evidence/.gitattributes", "* -text -filter -diff -merge\n");
}

export const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Reports every way the stored attachments of one stage differ from its evidence entries.
 * Only full validation runs this: a lost or leaked capture must not block the edits that repair it.
 */
export function evidenceAttachmentErrors(files: ArtifactFiles, stage: Pick<Stage | WorkStage, "id" | "evidence">) {
  const errors: string[] = [];
  let total = 0;
  for (const item of stage.evidence) {
    for (const attachment of item.attachments ?? []) {
      const label = `Stage ${stage.id} evidence ${item.id} attachment ${attachment.path}`;
      let resolved: { file: string; size: number };
      try { resolved = resolveEvidenceFile(files, stage.id, attachment.path); }
      catch (error) { errors.push(`${label}: ${errorMessage(error)}`); continue; }
      if (resolved.size > MAX_EVIDENCE_ATTACHMENT_BYTES) errors.push(`${label} is larger than 25 MiB.`);
      total += resolved.size;
      if (path.basename(attachment.path, path.extname(attachment.path)) !== attachment.sha256) errors.push(`${label} is not named after its hash.`);
      if (!evidenceMediaTypeMatches(attachment)) errors.push(`${label} does not match media type ${attachment.mediaType}.`);
      if (sha256Hex(files.read(resolved.file)) !== attachment.sha256) errors.push(`${label} does not match its recorded hash.`);
    }
  }
  if (total > MAX_EVIDENCE_TOTAL_BYTES) errors.push(`Stage ${stage.id} evidence attachments exceed 100 MiB.`);
  return errors;
}

/** Everything under evidence/ gets published, so each entry must belong to a recorded attachment. */
export function evidenceTreeErrors(files: ArtifactFiles, stages: Pick<Stage | WorkStage, "evidence">[]) {
  const type = files.type("evidence");
  if (!type) return [];
  if (type !== "directory") return ["evidence must be a real directory."];
  const referenced = new Set(stages.flatMap((stage) => stage.evidence.flatMap((item) => (item.attachments ?? []).map((attachment: EvidenceAttachment) => attachment.path))));
  const stray = (entry: string) => `Unreferenced evidence file ${entry}; remove it or record it.`;
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const file of files.list("evidence")) {
    const parts = file.split("/");
    if (parts.length === 2) {
      if (!(parts[1] === ".gitattributes" && files.type(file) === "file")) errors.push(stray(file));
      continue;
    }
    // Entries nested below a stage directory are reported once, as that directory's entry.
    const entry = parts.slice(0, 3).join("/");
    if (reported.has(entry)) continue;
    reported.add(entry);
    if (parts.length > 3 || !referenced.has(entry)) errors.push(stray(entry));
  }
  return errors;
}

/** Warnings never block: a stage may legitimately still be gathering evidence. */
export function evidenceWarnings(stage: Pick<Stage | WorkStage, "id" | "nodes" | "evidence" | "noEvidenceReason">) {
  const hasBehavior = stage.nodes.some((node) => node.changes.some((file) => file.classification === "behavior"));
  return hasBehavior && !stage.evidence.length && !stage.noEvidenceReason
    ? [`Stage ${stage.id} changes behavior but has no evidence. Run stage evidence, or stage no-evidence with the reason.`]
    : [];
}
