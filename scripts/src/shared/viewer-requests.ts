/** Narrows viewer request bodies and queries into the shared protocol types.
 *
 * Requests are untrusted. Each parser returns its protocol type, or a type mapped
 * from it, so a change to a request shape breaks both the page that sends it and
 * the parser that reads it. A value of the wrong type becomes one the receiving
 * operation rejects with its own message where that keeps the server's
 * established errors. */
import { isRecord, stringField, type JsonRecord } from "./narrow.js";
import type * as Wire from "./viewer-protocol.js";

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** A string field; any other value becomes "", which every identity check rejects. */
const text = (fields: JsonRecord, key: string): string => stringField(fields, key) ?? "";

/** Every value of a protocol union. The table must name each one, so a value added
 * to or removed from the protocol fails the typecheck here until the server handles it. */
type ValueTable<Value extends string> = Record<Value, true>;

const isValueOf = <Value extends string>(table: ValueTable<Value>, value: unknown): value is Value =>
  typeof value === "string" && Object.hasOwn(table, value);

const NOTE_KINDS: ValueTable<Wire.NoteKind> = { stage: true, node: true, file: true, line: true, insight: true };
const CLASSIFICATIONS: ValueTable<Wire.Classification> = {
  behavior: true, refactor: true, test: true, documentation: true, configuration: true,
  dependency: true, migration: true, generated: true, chore: true, trivial: true,
};
const DIFF_MODES: ValueTable<Wire.DiffMode> = { changes: true, full: true };
const DIFF_SIDES: ValueTable<Wire.DiffSide> = { old: true, new: true };
const EVIDENCE_KINDS: ValueTable<Wire.EvidenceKind> = {
  screenshot: true, recording: true, terminal: true, http: true, log: true,
  "output-file": true, measurement: true, report: true, other: true,
};

export const isNoteKind = (value: unknown): value is Wire.NoteKind => isValueOf(NOTE_KINDS, value);
export const isClassification = (value: unknown): value is Wire.Classification => isValueOf(CLASSIFICATIONS, value);
export const isDiffMode = (value: unknown): value is Wire.DiffMode => isValueOf(DIFF_MODES, value);
export const isDiffSide = (value: unknown): value is Wire.DiffSide => isValueOf(DIFF_SIDES, value);
export const isEvidenceKind = (value: unknown): value is Wire.EvidenceKind => isValueOf(EVIDENCE_KINDS, value);

const isLineSpan = (value: unknown): value is Wire.LineSpan => isRecord(value) && Number.isInteger(value.start) && Number.isInteger(value.end);
export function isLineRange(value: unknown): value is Wire.LineRange {
  return isRecord(value) && (value.old !== undefined || value.new !== undefined) &&
    (value.old === undefined || isLineSpan(value.old)) && (value.new === undefined || isLineSpan(value.new));
}

/* ---- queries --------------------------------------------------------------- */

/** A GET request's search parameters as sent: each one's text, or null when absent. */
export type QueryText<Query> = { [Key in keyof Query]-?: string | null };

/** A GET request's query read into its protocol types: each parameter, or null when absent. */
export type ReceivedQuery<Query> = { [Key in keyof Query]-?: Exclude<Query[Key], undefined> | null };

/** A flag parameter: set only by its one protocol value. */
const flag = <Value extends string>(value: string | null, set: Value): Value | null => value === set ? set : null;

export function parseFileContentQuery(query: QueryText<Wire.FileContentQuery>): ReceivedQuery<Wire.FileContentQuery> {
  return { ...query, raw: flag(query.raw, "1"), image: flag(query.image, "1") };
}

export function parseAttachmentQuery(query: QueryText<Wire.AttachmentQuery>): ReceivedQuery<Wire.AttachmentQuery> {
  return { preview: flag(query.preview, "1") };
}

/** A diff page request: its query with the defaults applied and its numbers read. */
export type DiffPageRequest = Omit<ReceivedQuery<Wire.DiffQuery>, "mode" | "offset" | "line"> & {
  mode: Wire.DiffMode;
  offset: number;
  line: number | null;
};

/** Reads a diff query, rejecting it with the messages and in the order the diff source checks. */
export function parseDiffQuery(query: QueryText<Wire.DiffQuery>): DiffPageRequest {
  const mode = query.mode || "changes", offset = Number(query.offset || 0);
  if (!isDiffMode(mode) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid diff page.");
  const side = isDiffSide(query.side) ? query.side : null, line = query.line === null ? null : Number(query.line);
  if (query.side && (!side || line === null || !Number.isSafeInteger(line) || line < 1)) throw new Error("Invalid target line.");
  return { stage: query.stage, path: query.path, base: query.base, head: query.head, mode, offset, side, line };
}

/* ---- review sessions ------------------------------------------------------- */

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

/** One side of a state change, with every field as received: patchReviewState
 * compares it exactly, so a side with fields beyond its shape (an absent value that
 * still names a value) matches no stored value and is rejected as a conflict. */
function stateValue(value: unknown): Wire.ReviewStateValue {
  if (!isRecord(value) || typeof value.present !== "boolean") throw new Error("Invalid state change value.");
  if (!value.present) return { ...value, present: false };
  if (!Object.hasOwn(value, "value")) throw new Error("Invalid state change value.");
  return { ...value, present: true, value: value.value };
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

/* ---- drafts ---------------------------------------------------------------- */

/** A draft's snapshot, or undefined when it has none. Throws when it cannot be
 * checked, so a draft is never sent without checking that its file is unchanged.
 * A draft is checked by its file revision when it has one, and otherwise by its
 * base and head revisions; a missing file revision (an older draft's null or empty
 * one included) is absent, so it can be reconstructed from those revisions. */
function draftSnapshot(value: unknown): Wire.DraftSnapshot | undefined {
  if (!value) return undefined;
  const fields: JsonRecord = isRecord(value) ? value : {};
  const { fileRevision, base, head } = fields;
  const invalid = () => new Error("The draft's snapshot is invalid. Copy its text into a new note on the current diff before sending.");
  if (fileRevision) {
    if (typeof fileRevision !== "string") throw invalid();
    return { base: typeof base === "string" ? base : "", head: typeof head === "string" ? head : "", fileRevision };
  }
  if (typeof base !== "string" || typeof head !== "string") throw invalid();
  return { base, head };
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

/* ---- approvals ------------------------------------------------------------- */

/** A file approval request as received. The page's ownership is only compared with
 * the server's own, so it stays as sent: any difference, such as an extra key,
 * means the ownership changed. */
export type ReceivedApprovalEndpoint = Omit<Wire.ApprovalEndpoint, "ownership"> & { ownership: unknown };

/** The file approval the page shows. A request for a file the server no longer
 * shows fails when the server compares it with its own data. */
export function parseApprovalEndpoint(fields: JsonRecord): ReceivedApprovalEndpoint {
  return {
    stageId: text(fields, "stageId"), nodeId: text(fields, "nodeId"), path: text(fields, "path"),
    baseRevision: text(fields, "baseRevision"), headRevision: text(fields, "headRevision"), fileRevision: text(fields, "fileRevision"),
    ownership: fields.ownership,
  };
}

/** The comparison options of an approval comparison request, read after its file is checked. */
export function parseApprovalComparison(fields: JsonRecord): Required<Omit<Wire.ApprovalComparisonRequest, keyof Wire.ApprovalEndpoint>> {
  const offset = fields.offset, mode = fields.mode ?? "changes", scope = fields.scope ?? "stage";
  if (!isDiffMode(mode)) throw new Error("Invalid comparison view.");
  if (scope !== "stage" && scope !== "all") throw new Error("Invalid comparison scope.");
  // Older pages could send a falsy offset for the first page.
  const page = offset || 0;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0) throw new Error("Invalid comparison page.");
  return { snapshotId: text(fields, "snapshotId"), offset: page, mode, scope };
}

/* ---- agent ----------------------------------------------------------------- */

export function parseAgentResponse(fields: JsonRecord): Wire.AgentRespondRequest {
  const { body, requestId } = fields;
  const answer = typeof body === "string" ? body.trim() : "";
  if (typeof requestId !== "string" || !answer || answer.length > 4000) throw new Error("Write an answer of up to 4000 characters.");
  return { requestId, body: answer };
}

/* ---- feedback -------------------------------------------------------------- */

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

/** A list entry of a request: read, or skipped with the reason. */
export type Received<Item> = Item | Skipped<Item extends { ref: infer Ref } ? Ref : never>;

/** A feedback draft to send, or why it is skipped. */
export function parseFeedbackNote(value: unknown, index: number): Received<Wire.FeedbackNoteExport> {
  const fields = isRecord(value) ? value : {};
  const ref = typeof fields.ref === "number" && Number.isInteger(fields.ref) ? fields.ref : index;
  if (!value || typeof value !== "object") return { ref, reason: "not an object" };
  const body = typeof fields.body === "string" ? fields.body.trim() : "";
  try {
    const attachments = attachmentRefs(fields);
    if (!body && !attachments.length) return { ref, reason: "empty body" };
    if (!isNoteKind(fields.kind)) return { ref, reason: `unsupported note kind "${fields.kind}"` };
    const kind = fields.kind, stageId = fields.stageId, clientId = stringField(fields, "clientId");
    // A node note names its stage; any other value fails as a stage that does not exist.
    if (kind === "node" && stageId && typeof stageId !== "string") return { ref, reason: `unknown stage "${stageId}"` };
    // Only a line draft is checked against its snapshot; other notes never read it.
    const snapshot = kind === "line" ? draftSnapshot(fields.snapshot) : undefined;
    return {
      ref, kind, id: text(fields, "id"), body, attachments,
      ...(typeof stageId === "string" && stageId ? { stageId } : {}), ...(clientId !== undefined ? { clientId } : {}), ...(snapshot ? { snapshot } : {}),
    };
  } catch (error) { return { ref, reason: error instanceof Error ? error.message : String(error) }; }
}

/** A reply draft to send, or why it is skipped. */
export function parseFeedbackReply(value: unknown, index: number): Received<Wire.FeedbackReplyExport> {
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

/** Notes of a send, each read or skipped; a value that is not a list has none. */
export const parseFeedbackNotes = (value: unknown): Received<Wire.FeedbackNoteExport>[] => isList(value) ? value.map(parseFeedbackNote) : [];

/** Replies of a send, each read or skipped; a value that is not a list has none. */
export const parseFeedbackReplies = (value: unknown): Received<Wire.FeedbackReplyExport>[] => isList(value) ? value.map(parseFeedbackReply) : [];

/** The send request with each note and reply read or skipped, so one that cannot be
 * sent is reported with its reason while the others are sent. */
export type ReceivedFeedbackExport = {
  [Key in keyof Wire.FeedbackExportRequest]: Wire.FeedbackExportRequest[Key] extends (infer Item)[] ? Received<Item>[] : Wire.FeedbackExportRequest[Key];
};

export function parseFeedbackExport(fields: JsonRecord): ReceivedFeedbackExport {
  return { implementationId: text(fields, "implementationId"), notes: parseFeedbackNotes(fields.notes), replies: parseFeedbackReplies(fields.replies) };
}

/** A thread action as received. Its attachments are read only when a reply is sent,
 * after the implementation and thread are checked; resolve and reopen ignore them.
 * A client ID that is not a string is kept as sent: when it is truthy it still stands
 * in for the reply's hashed reference, and the reply reads it as reference "0". */
export type ReceivedThreadAction = Omit<Wire.ThreadActionRequest, "attachments" | "clientId"> & { attachments?: unknown; clientId?: unknown };

/** A thread action; its handler rejects an empty thread ID after checking the implementation. */
export function parseThreadAction(fields: JsonRecord): ReceivedThreadAction {
  const body = stringField(fields, "body"), clientId = fields.clientId;
  return {
    implementationId: text(fields, "implementationId"), threadId: text(fields, "threadId"),
    ...(body !== undefined ? { body } : {}), ...(clientId !== undefined ? { clientId } : {}),
    ...(fields.attachments !== undefined ? { attachments: fields.attachments } : {}),
  };
}
