import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

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

/** Resolves an artifact-relative attachment, refusing anything but a regular file inside the artifact. */
export function resolveEvidenceFile(artifactRoot: string, stageId: string, attachmentPath: string) {
  const expected = new RegExp(`^evidence/${stageId}/[a-f0-9]{64}\\.[a-z0-9]+$`);
  if (!expected.test(attachmentPath)) throw new Error(`Evidence attachment ${attachmentPath} is outside evidence/${stageId}/.`);
  const file = path.join(artifactRoot, ...attachmentPath.split("/"));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Evidence attachment ${attachmentPath} is missing.`);
  return { file, size: stat.size };
}

export const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Reports every way the stored attachments of one stage differ from its evidence entries.
 * Full validation also hashes content and rejects files no entry references; the quick
 * validation between edits skips both, because an edit prunes files only once it has saved.
 */
export function evidenceAttachmentErrors(artifactRoot: string, stage, verifyContent: boolean) {
  const errors: string[] = [];
  const referenced = new Set<string>();
  let total = 0;
  for (const item of stage.evidence ?? []) {
    for (const attachment of item.attachments ?? []) {
      const label = `Stage ${stage.id} evidence ${item.id} attachment ${attachment.path}`;
      referenced.add(attachment.path);
      let resolved;
      try { resolved = resolveEvidenceFile(artifactRoot, stage.id, attachment.path); }
      catch (error) { errors.push(`${label}: ${(error as Error).message}`); continue; }
      if (resolved.size > MAX_EVIDENCE_ATTACHMENT_BYTES) errors.push(`${label} is larger than 25 MiB.`);
      total += resolved.size;
      if (path.basename(attachment.path, path.extname(attachment.path)) !== attachment.sha256) errors.push(`${label} is not named after its hash.`);
      if (MEDIA_TYPES[path.extname(attachment.path).slice(1)] !== attachment.mediaType) errors.push(`${label} does not match media type ${attachment.mediaType}.`);
      if (verifyContent && sha256Hex(fs.readFileSync(resolved.file)) !== attachment.sha256) errors.push(`${label} does not match its recorded hash.`);
    }
  }
  if (total > MAX_EVIDENCE_TOTAL_BYTES) errors.push(`Stage ${stage.id} evidence attachments exceed 100 MiB.`);
  if (!verifyContent) return errors;
  const directory = path.join(artifactRoot, "evidence", stage.id);
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    if (!referenced.has(`evidence/${stage.id}/${name}`)) errors.push(`Stage ${stage.id} has unreferenced evidence file evidence/${stage.id}/${name}; remove it or record it.`);
  }
  return errors;
}

/** Warnings never block: a stage may legitimately still be gathering evidence. */
export function evidenceWarnings(stage, headRevision: string) {
  const warnings: string[] = [];
  const hasBehavior = (stage.nodes ?? []).some((node) => (node.changes ?? []).some((file) => file.classification === "behavior"));
  if (hasBehavior && !stage.evidence?.length && !stage.noEvidenceReason) {
    warnings.push(`Stage ${stage.id} changes behavior but has no evidence. Run stage evidence, or stage no-evidence with the reason.`);
  }
  for (const item of stage.evidence ?? []) {
    if (item.headRevision !== headRevision) warnings.push(`Stage ${stage.id} evidence ${item.id} was captured at ${item.headRevision.slice(0, 12)}, not the stage head. Recapture it if the behavior changed.`);
  }
  return warnings;
}
