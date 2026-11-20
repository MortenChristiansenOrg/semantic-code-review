// Reads the review state the server stores. The server keeps whatever the page
// wrote, so each value is checked against the shape the page writes, or the
// shape an older viewer wrote, before the page uses it.
import type {
  ApprovalRecord, Attachment, ComposeDraft, DraftSnapshot, EditorState, InsightReviewRecord, LegacyDraftNote, ReplyDraft, StoredReviewState,
} from "../../scripts/src/shared/viewer-protocol";
import { arrayOf, isBoolean, isNumber, isRecord, isString, oneOf, optional } from "./narrow";
import type { ViewerState } from "./types";

export const isNoteKind = oneOf("stage", "node", "file", "line", "insight");
export const isFeedbackTargetKind = oneOf("specification", "criterion", "stage", "node", "insight", "file", "line");
export const isNoteMode = oneOf("personal", "feedback");

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value) && isString(value.id) && isString(value.filename) && isString(value.mediaType) &&
    isNumber(value.size) && isString(value.sha256) && isString(value.path);
}
const isAttachments = arrayOf(isAttachment);

function isSnapshot(value: unknown): value is DraftSnapshot {
  return isRecord(value) && isString(value.base) && isString(value.head) && optional(isString)(value.fileRevision);
}

// Older viewers saved notes with `at` and without a mode; their optional fields are checked as well.
function isNote(value: unknown): value is LegacyDraftNote {
  return isRecord(value) && isNoteKind(value.kind) && isString(value.id) && optional(isString)(value.body) &&
    optional(isNoteMode)(value.mode) && optional(isAttachments)(value.attachments) && optional(isNumber)(value.createdAt) &&
    optional(isNumber)(value.at) && optional(isString)(value.stageId) && optional(isString)(value.nodeId) &&
    optional(isSnapshot)(value.snapshot) && optional(isBoolean)(value.exported) && optional(isString)(value.threadId);
}

function isReplyDraft(value: unknown): value is ReplyDraft {
  return isRecord(value) && isString(value.id) && isString(value.threadId) && isString(value.body) &&
    isAttachments(value.attachments) && isNumber(value.createdAt);
}

function isApproval(value: unknown): value is ApprovalRecord | boolean {
  if (isBoolean(value)) return true;
  return isRecord(value) && (value.rev === null || isString(value.rev)) && isNumber(value.at) &&
    ["stageId", "nodeId", "path", "baseRevision", "headRevision", "fileRevision", "snapshotId"].every((key) => optional(isString)(value[key])) &&
    optional(isRecord)(value.ownership);
}

function isInsightReview(value: unknown): value is InsightReviewRecord {
  return isRecord(value) && isString(value.fingerprint) && isNumber(value.at);
}

const isNullableString = (value: unknown): value is string | null => value === null || isString(value);

/** A composer saved by any viewer; fields an older one did not save take their defaults. */
function composeDraft(value: unknown): ComposeDraft | null | undefined {
  if (!isRecord(value) || !isNoteKind(value.kind) || !isString(value.id) || !optional(isString)(value.stageId) ||
    !optional(isNullableString)(value.nodeId) || !optional((item): item is number | null => item === null || isNumber(item))(value.editIndex) ||
    !optional(isNoteMode)(value.mode) || !optional(isString)(value.body) || !optional(isBoolean)(value.dirty) ||
    !optional(isAttachments)(value.attachments) || !optional(isSnapshot)(value.snapshot)) return undefined;
  const { kind, id, stageId, nodeId, editIndex, mode, body, dirty, attachments, snapshot } = value;
  return {
    kind, id, ...(stageId === undefined ? {} : { stageId }), ...(nodeId === undefined ? {} : { nodeId }),
    editIndex: editIndex ?? null, mode: mode ?? "personal", body: body ?? "", dirty: dirty ?? false,
    ...(attachments === undefined ? {} : { attachments }), ...(snapshot === undefined ? {} : { snapshot }),
  };
}

/** The saved editors; a field of the wrong shape is left out. */
function editorState(value: unknown): EditorState | undefined {
  if (!isRecord(value)) return undefined;
  const compose = value.compose === null ? null : composeDraft(value.compose);
  return {
    compose: compose ?? null,
    replyTo: isNullableString(value.replyTo) ? value.replyTo : null,
    replyDraft: isString(value.replyDraft) ? value.replyDraft : "",
    replyEditId: isNullableString(value.replyEditId) ? value.replyEditId : null,
    replyAttachments: isAttachments(value.replyAttachments) ? value.replyAttachments : [],
  };
}

/** A saved map whose entries pass `guard`. Artifact IDs name the keys of these
 * maps. Without a prototype, keys such as "__proto__", "constructor" and
 * "prototype" are ordinary entries to assign and read. */
function mapOf<T>(value: unknown, guard: (entry: unknown) => entry is T): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  const map: Record<string, T> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) if (guard(entry)) map[key] = entry;
  return map;
}

const emptyMap = <T>(): Record<string, T> => Object.create(null);
const ifValid = <T>(value: unknown, guard: (value: unknown) => value is T): T | undefined => guard(value) ? value : undefined;

/** The page's state from the stored state: each field the page keeps, from the
 * stored value where it has a shape a viewer writes, otherwise its default.
 * Other stored keys, such as those older viewers wrote, are kept as they are. */
export function readState(stored: StoredReviewState): ViewerState {
  const { editor: storedEditor, repliesSeenThrough: seenThrough, readReplies: storedReadReplies, dismissedTargetRefresh: dismissed, ...others } = stored;
  const editor = editorState(storedEditor), repliesSeenThrough = ifValid(seenThrough, isString);
  const readReplies = mapOf(storedReadReplies, isBoolean), dismissedTargetRefresh = ifValid(dismissed, isString);
  return {
    ...others,
    ...(editor ? { editor } : {}),
    ...(repliesSeenThrough === undefined ? {} : { repliesSeenThrough }),
    ...(readReplies ? { readReplies } : {}),
    ...(dismissedTargetRefresh === undefined ? {} : { dismissedTargetRefresh }),
    approvals: mapOf(stored.approvals, isApproval) ?? emptyMap(),
    insightReviews: mapOf(stored.insightReviews, isInsightReview) ?? emptyMap(),
    comments: Array.isArray(stored.comments) ? stored.comments.filter(isNote) : [],
    openStages: mapOf(stored.openStages, isBoolean) ?? emptyMap(),
    openThreads: mapOf(stored.openThreads, isBoolean) ?? emptyMap(),
    lastNoteMode: ifValid(stored.lastNoteMode, isNoteMode) ?? "personal",
    // Older viewers saved one boolean for every specification.
    specificationOpen: isBoolean(stored.specificationOpen) ? stored.specificationOpen : mapOf(stored.specificationOpen, isBoolean) ?? emptyMap(),
    coverageOpen: ifValid(stored.coverageOpen, isBoolean) ?? false,
    notesOpen: ifValid(stored.notesOpen, isBoolean) ?? false,
    pinnedInsight: Object.hasOwn(stored, "pinnedInsight") ? stored.pinnedInsight : null,
    hideApproved: ifValid(stored.hideApproved, isBoolean) ?? false,
    fileView: mapOf(stored.fileView, oneOf("hunk", "full")) ?? emptyMap(),
    hideDeleted: mapOf(stored.hideDeleted, isBoolean) ?? emptyMap(),
    wrapLines: ifValid(stored.wrapLines, isBoolean) ?? false,
    markdownPreview: mapOf(stored.markdownPreview, isBoolean) ?? emptyMap(),
    threadCollapsed: mapOf(stored.threadCollapsed, isBoolean) ?? emptyMap(),
    openLineThreads: mapOf(stored.openLineThreads, isBoolean) ?? emptyMap(),
    // Older viewers saved `true` for a file open in its first node.
    activeFiles: mapOf(stored.activeFiles, (entry): entry is string | null | boolean => entry === null || isString(entry) || isBoolean(entry)) ?? emptyMap(),
    approvalComparisons: mapOf(stored.approvalComparisons, isBoolean) ?? emptyMap(),
    notesFilter: ifValid(stored.notesFilter, oneOf("active", "resolved")) ?? "active",
    replyDrafts: Array.isArray(stored.replyDrafts) ? stored.replyDrafts.filter(isReplyDraft) : [],
  };
}
