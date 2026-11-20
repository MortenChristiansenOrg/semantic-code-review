/** Narrows viewer request bodies and queries into the shared protocol types.
 *
 * Requests are untrusted. Each parser returns its protocol type, so a change to a
 * request shape breaks both the page that sends it and the parser that reads it.
 * A value of the wrong type becomes one the receiving operation rejects with its
 * own message where that keeps the server's established errors. */
import { isRecord, stringField, type JsonRecord } from "./narrow.js";
import type * as Wire from "./viewer-protocol.js";

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** A string field; any other value becomes "", which every identity check rejects. */
const text = (fields: JsonRecord, key: string): string => stringField(fields, key) ?? "";

const NOTE_KINDS: readonly Wire.NoteKind[] = ["stage", "node", "file", "line", "insight"];
const isNoteKind = (value: unknown): value is Wire.NoteKind => NOTE_KINDS.some((kind) => kind === value);

/** A GET request's query as received: each protocol parameter, or null when absent. */
export type ReceivedQuery<Query> = { [Key in keyof Query]-?: string | null };

export function parseReviewTarget(fields: JsonRecord): Wire.ReviewTarget {
  return { reviewId: text(fields, "reviewId"), generation: text(fields, "generation") };
}

export function parseStorageAction(fields: JsonRecord): Wire.ReviewStorageActionRequest {
  return { ...parseReviewTarget(fields), fingerprint: text(fields, "fingerprint") };
}

export function parseCompletion(fields: JsonRecord): Wire.ReviewCompletionRequest {
  const { completed, expectedCompletedAt } = fields;
  if (typeof completed !== "boolean" || (expectedCompletedAt !== null && typeof expectedCompletedAt !== "string")) throw new Error("Invalid review lifecycle change.");
  return { ...parseReviewTarget(fields), completed, expectedCompletedAt };
}

function stateValue(value: unknown): Wire.ReviewStateValue {
  if (!isRecord(value) || typeof value.present !== "boolean") throw new Error("Invalid state change value.");
  if (!value.present) return { present: false };
  if (!Object.hasOwn(value, "value")) throw new Error("Invalid state change value.");
  return { present: true, value: value.value };
}

/** Review state changes. patchReviewState checks their limits; this establishes
 * their shape, with the same messages. */
export function parseStateChanges(value: unknown): Wire.ReviewStateChange[] {
  if (!isList(value)) throw new Error("Invalid state changes.");
  return value.map((item) => {
    const fields = isRecord(item) ? item : {};
    const keys = fields.path;
    if (!isList(keys) || !keys.every((key): key is string => typeof key === "string")) throw new Error("Invalid state change path.");
    return { path: keys, before: stateValue(fields.before), after: stateValue(fields.after) };
  });
}

export function parseStatePatch(fields: JsonRecord): Wire.ReviewStatePatchRequest {
  return { ...parseReviewTarget(fields), changes: parseStateChanges(fields.changes) };
}

export function parseAttachmentUpload(fields: JsonRecord, maxBytes: number): Wire.AttachmentUploadRequest {
  const { data, filename, mediaType } = fields;
  if (typeof data !== "string" || data.length > Math.ceil(maxBytes / 3) * 4 || Buffer.from(data, "base64").toString("base64") !== data) throw new Error("Invalid attachment bytes or file larger than 20 MiB.");
  // A missing type means the default; storeAttachment rejects a name that is not a nonblank string.
  if (mediaType && typeof mediaType !== "string") throw new Error("Invalid attachment media type.");
  return { data, filename: typeof filename === "string" ? filename : "", mediaType: typeof mediaType === "string" ? mediaType : "" };
}

/** A draft's snapshot, or undefined when it has none. Throws when it is malformed,
 * so a draft is never sent without checking that its file is unchanged. */
function draftSnapshot(value: unknown): Wire.DraftSnapshot | undefined {
  if (!value) return undefined;
  const fileRevision = stringField(value, "fileRevision");
  if (!isRecord(value) || typeof value.base !== "string" || typeof value.head !== "string" || (value.fileRevision !== undefined && fileRevision === undefined)) {
    throw new Error("The draft's snapshot is invalid. Copy its text into a new note on the current diff before sending.");
  }
  return { base: value.base, head: value.head, ...(fileRevision !== undefined ? { fileRevision } : {}) };
}

/** The notes of a draft-snapshot request. A note the server cannot read is null and
 * resolves to no snapshot, as the page treats any note without one. */
export function parseDraftSnapshotNotes(fields: JsonRecord): (Wire.DraftSnapshotNote | null)[] {
  if (!isList(fields.notes)) throw new Error("Draft snapshots require a list of notes.");
  return fields.notes.map((note) => {
    if (!isRecord(note) || !isNoteKind(note.kind) || typeof note.id !== "string") return null;
    try {
      const snapshot = draftSnapshot(note.snapshot);
      return { kind: note.kind, id: note.id, ...(snapshot ? { snapshot } : {}) };
    } catch { return null; }
  });
}

const isLineSpan = (value: unknown): value is Wire.LineSpan => isRecord(value) && Number.isInteger(value.start) && Number.isInteger(value.end);
function isLineRange(value: unknown): value is Wire.LineRange {
  return isRecord(value) && (value.old !== undefined || value.new !== undefined) &&
    (value.old === undefined || isLineSpan(value.old)) && (value.new === undefined || isLineSpan(value.new));
}
const CLASSIFICATIONS: readonly Wire.Classification[] = ["behavior", "refactor", "test", "documentation", "configuration", "dependency", "migration", "generated", "chore", "trivial"];

function fileMembership(value: unknown): Wire.FileMembership | undefined {
  if (!isRecord(value) || typeof value.nodeId !== "string") return undefined;
  const { nodeId, classification, hunks, lineRanges } = value;
  const knownClassification = CLASSIFICATIONS.find((item) => item === classification);
  if (!knownClassification) return undefined;
  if (hunks !== undefined && !(isList(hunks) && hunks.every((hunk): hunk is number => Number.isInteger(hunk)))) return undefined;
  if (lineRanges !== undefined && !(isList(lineRanges) && lineRanges.every(isLineRange))) return undefined;
  return { nodeId, classification: knownClassification, ...(hunks !== undefined ? { hunks } : {}), ...(lineRanges !== undefined ? { lineRanges } : {}) };
}

/** The file approval the page shows. A request for a file the server no longer
 * shows fails when the server compares it with its own data. */
export function parseApprovalEndpoint(fields: JsonRecord): Wire.ApprovalEndpoint {
  const ownership = fileMembership(fields.ownership);
  if (!ownership) throw new Error("The file or its ownership changed. Refresh the viewer before approving or comparing it.");
  return {
    stageId: text(fields, "stageId"), nodeId: text(fields, "nodeId"), path: text(fields, "path"),
    baseRevision: text(fields, "baseRevision"), headRevision: text(fields, "headRevision"), fileRevision: text(fields, "fileRevision"), ownership,
  };
}

export function parseApprovalComparison(fields: JsonRecord): Wire.ApprovalComparisonRequest {
  const offset = fields.offset, mode = fields.mode ?? "changes", scope = fields.scope ?? "stage";
  if (mode !== "changes" && mode !== "full") throw new Error("Invalid comparison view.");
  if (scope !== "stage" && scope !== "all") throw new Error("Invalid comparison scope.");
  // Older pages could send a falsy offset for the first page.
  const page = offset || 0;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0) throw new Error("Invalid comparison page.");
  return { ...parseApprovalEndpoint(fields), snapshotId: text(fields, "snapshotId"), offset: page, mode, scope };
}

export function parseAgentResponse(fields: JsonRecord): Wire.AgentRespondRequest {
  const { body, requestId } = fields;
  const answer = typeof body === "string" ? body.trim() : "";
  if (typeof requestId !== "string" || !answer || answer.length > 4000) throw new Error("Write an answer of up to 4000 characters.");
  return { requestId, body: answer };
}

/** Attachment references of a note or reply. Only their IDs are read; the feedback
 * store checks each one against its managed file. */
function attachmentRefs(fields: JsonRecord): Wire.AttachmentRef[] {
  if (!isList(fields.attachments)) return [];
  return fields.attachments.map((item) => {
    const id = stringField(item, "id");
    if (id === undefined) throw new Error("Invalid message attachment.");
    return { id };
  });
}

/** Skips a note or reply that cannot be sent, with the reason. */
export interface Skipped<Ref> {
  ref: Ref;
  reason: string;
}

/** A feedback draft to send, or why it is skipped. */
export function parseFeedbackNote(value: unknown, index: number): Wire.FeedbackNoteExport | Skipped<number> {
  const fields = isRecord(value) ? value : {};
  const ref = typeof fields.ref === "number" && Number.isInteger(fields.ref) ? fields.ref : index;
  if (!value || typeof value !== "object") return { ref, reason: "not an object" };
  const body = typeof fields.body === "string" ? fields.body.trim() : "";
  try {
    const attachments = attachmentRefs(fields);
    if (!body && !attachments.length) return { ref, reason: "empty body" };
    if (!isNoteKind(fields.kind)) return { ref, reason: `unsupported note kind "${fields.kind}"` };
    const stageId = stringField(fields, "stageId"), clientId = stringField(fields, "clientId"), snapshot = draftSnapshot(fields.snapshot);
    return {
      ref, kind: fields.kind, id: text(fields, "id"), body, attachments,
      ...(stageId ? { stageId } : {}), ...(clientId !== undefined ? { clientId } : {}), ...(snapshot ? { snapshot } : {}),
    };
  } catch (error) { return { ref, reason: error instanceof Error ? error.message : String(error) }; }
}

/** A reply draft to send, or why it is skipped. */
export function parseFeedbackReply(value: unknown, index: number): Wire.FeedbackReplyExport | Skipped<string> {
  const fields = isRecord(value) ? value : {};
  const ref = typeof fields.ref === "string" ? fields.ref : String(index);
  const threadId = text(fields, "threadId");
  const body = typeof fields.body === "string" ? fields.body.trim() : "";
  if (!threadId) return { ref, reason: "thread no longer exists" };
  try {
    const attachments = attachmentRefs(fields);
    if (!body && !attachments.length) return { ref, reason: "empty body" };
    return { ref, threadId, body, attachments };
  } catch (error) { return { ref, reason: error instanceof Error ? error.message : String(error) }; }
}

/** The send request; its notes and replies are read one at a time, so one that
 * cannot be sent is skipped with its reason while the others are sent. */
export function parseFeedbackExport(fields: JsonRecord): Pick<Wire.FeedbackExportRequest, "implementationId"> & { notes: unknown[]; replies: unknown[] } {
  return { implementationId: text(fields, "implementationId"), notes: isList(fields.notes) ? fields.notes : [], replies: isList(fields.replies) ? fields.replies : [] };
}

/** A thread action; its handler rejects an empty thread ID after checking the implementation. */
export function parseThreadAction(fields: JsonRecord): Wire.ThreadActionRequest {
  const threadId = text(fields, "threadId");
  const body = stringField(fields, "body"), clientId = stringField(fields, "clientId");
  return {
    implementationId: text(fields, "implementationId"), threadId,
    ...(body !== undefined ? { body } : {}), ...(clientId !== undefined ? { clientId } : {}),
    ...(fields.attachments !== undefined ? { attachments: attachmentRefs(fields) } : {}),
  };
}
