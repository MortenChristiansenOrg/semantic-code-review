/** Wire types shared by the review viewer page and its local server.
 *
 * Types only: no runtime code and no imports, so both the browser bundle and the
 * Node server can use this module. The page's requests (`viewer/src/api.ts`), the
 * server's request parsers (`viewer-requests.ts`) and its response bodies all use
 * these types, and `tests/semantic-view/viewer-protocol.test.mjs` checks a running
 * server's responses against them. Every `/api/*` route except `/api/whoami` and
 * `/api/shutdown` also requires the `ReviewQuery` search parameters, which the
 * page's request module (`viewer/src/api.ts`) appends to each request. POST routes require
 * `content-type: application/json` and a same-origin request. */

/* ---- common ------------------------------------------------------------- */

/** Every JSON failure body. Some failures also carry partial results; see the
 * endpoint-specific failure types. */
export interface ApiFailure {
  ok: false;
  error?: string;
  /** Set on the review-scope gate and on `/api/review-state` failures when the
   * review session was deleted or replaced. */
  reviewUnavailable?: boolean;
}

/** A success body carrying `T`, or a failure body. */
export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

/** The fields of a response's success body, without `ok`. */
export type ApiSuccess<Response> = Omit<Extract<Response, { ok: true }>, "ok">;

/** A body that only reports success. */
export type OkResponse = ApiResult<{}>;

/** The keys of every branch of a type. `keyof` a union names only the keys all
 * its branches share, so a field added to one branch would be missed. */
export type KeysOfAny<T> = T extends unknown ? keyof T : never;

/** The values a key has in the branches of a type that have it. */
export type ValueOfAny<T, Key extends PropertyKey> = T extends unknown ? Key extends keyof T ? T[Key] : never : never;

/** Every field of a request, in any branch, each possibly undefined. Request builders
 * and parsers that list their fields with this type must name each one, optional
 * ones included, so a field added to or renamed in the protocol fails the typecheck. */
export type RequestFields<T> = { [Key in Extract<KeysOfAny<T>, string>]: ValueOfAny<T, Key> | undefined };

/** Selects one review session; its generation changes when the review is recreated. */
export interface ReviewTarget {
  reviewId: string;
  generation: string;
}

/** Search parameters that scope every review API request. */
export type ReviewQuery = {
  review: string;
  generation: string;
};

/** `window.SEMANTIC_REVIEW_CONTEXT`, written by GET `/implementation-data.js`. */
export interface ReviewContext {
  reviewId: string;
  generation: string;
}

/** A stored upload, referenced by notes, replies and feedback comments. */
export interface Attachment {
  /** SHA-256 over [filename, mediaType, content SHA-256]; 64 hex characters. */
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  /** SHA-256 of the content; 64 hex characters. */
  sha256: string;
  /** Always `attachments/<id>/content.bin`. */
  path: string;
}

/** An attachment in a request. The page sends whole `Attachment`s; the server reads
 * their IDs and checks each against its stored file. */
export type AttachmentRef = Pick<Attachment, "id">;

export type DiffSide = "old" | "new";

/** One diff row: `t` is the row kind, `o`/`n` the old/new line numbers, `s` the
 * text without its diff marker, and `h` the 1-based hunk number in the zero-context
 * diff (absent when the hunk could not be identified, and in approval comparisons). */
export type DiffLine =
  | { t: "add"; n: number; s: string; h?: number }
  | { t: "del"; o: number; s: string; h?: number }
  | { t: "ctx"; o: number; n: number; s: string };

export type DiffMode = "changes" | "full";

/* ---- implementation data ------------------------------------------------- */

export type FileKind = "added" | "modified" | "deleted" | "renamed";

export type Classification =
  | "behavior" | "refactor" | "test" | "documentation" | "configuration"
  | "dependency" | "migration" | "generated" | "chore" | "trivial";

export interface LineSpan {
  start: number;
  end: number;
}

/** Lines on the old side, the new side, or both; never neither. */
export type LineRange = { old: LineSpan; new?: LineSpan } | { old?: LineSpan; new: LineSpan };

/** A node's ownership of one changed file: the whole file, selected hunks, or line ranges. */
export interface FileMembership {
  nodeId: string;
  /** Absent when the artifact records a classification this viewer does not know. */
  classification?: Classification;
  /** The classification the artifact records when this viewer does not know it.
   * Only file approval keys use it, so approvals saved under it still match. */
  recordedClassification?: string;
  hunks?: number[];
  lineRanges?: LineRange[];
}

export interface NodeChange {
  path: string;
  /** Absent when the artifact records a classification this viewer does not know. */
  classification?: Classification;
  /** The classification the artifact records when this viewer does not know it. */
  recordedClassification?: string;
  hunks?: number[];
  lineRanges?: LineRange[];
}

export interface ChangeNode {
  id: string;
  /** Derived from the ID for display. */
  title: string;
  description: string;
  changes: NodeChange[];
}

export interface StageFile {
  path: string;
  kind: FileKind;
  /** The revision this file's diff starts from: the head of the stage that last
   * changed it, or the stage's base revision. */
  baseRevision: string;
  /** Earlier paths of the file in the review, newest first. */
  previousPaths: string[];
  /** The earlier stage that last changed this file. */
  previousStageId?: string;
  /** The path at `baseRevision` when the file was renamed in this stage. */
  previousPath?: string;
  /** The owning language project, or a top-level folder. */
  project: string;
  memberships: FileMembership[];
  additions: number;
  deletions: number;
  binary: boolean;
  /** Fingerprint of both file sides; approvals and line drafts compare against it. */
  revision: string;
}

/** An immutable authored code anchor, as recorded in the artifact. */
export interface CodeTarget {
  path: string;
  revision: string;
  blobId: string;
  startLine: number;
  endLine: number;
  contextStartLine: number;
  context: string[];
}

/** An insight's code anchor, resolved against the stage head. */
export type ResolvedCodeTarget =
  | {
      status: "current" | "mapped";
      original: CodeTarget;
      path: string;
      revision: string;
      startLine: number;
      endLine: number;
      contextStartLine: number;
      context: string[];
    }
  | {
      status: "needs-review";
      reason: string;
      original: CodeTarget;
      /** The path the target was followed to, or its original path. */
      path: string;
    };

/** The viewer's insight type; `lesson` is a failed attempt and `question` an open question. */
export type InsightType =
  | "decision" | "assumption" | "alternative" | "lesson" | "risk"
  | "validation" | "evidence" | "question";

/** The artifact collection an insight comes from. */
export type InsightCollection =
  | "decisions" | "assumptions" | "alternatives" | "failedAttempts" | "risks"
  | "validation" | "evidence" | "openQuestions";

/** `other` stands for a kind this viewer does not know; the insight's `meta` holds
 * the recorded kind. */
export type EvidenceKind =
  | "screenshot" | "recording" | "terminal" | "http" | "log"
  | "output-file" | "measurement" | "report" | "other";

/** An evidence file. Fetch its bytes from `/api/evidence` by its index. */
export interface EvidenceAttachment {
  mediaType: string;
  sha256: string;
  caption?: string;
  role?: "before" | "after";
}

export interface EvidenceDetails {
  kind: EvidenceKind;
  attachments: EvidenceAttachment[];
  inline?: string;
  reproduction?: string;
  specificationRefs: string[];
  capturedAt: string;
}

export interface Insight {
  type: InsightType;
  collection: InsightCollection;
  id: string;
  title: string;
  /** Composed display text; may be empty. */
  body: string;
  /** Decision category, validation status, or evidence kind. */
  meta?: string;
  /** Validation type (`automated`, `manual` or `analysis`) for validation insights. */
  validationType?: string;
  nodeRefs: string[];
  evidence?: EvidenceDetails;
  codeTarget?: ResolvedCodeTarget;
}

export interface Stage {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  dependsOn: string[];
  specificationRefs: string[];
  branch: string;
  baseRevision: string;
  headRevision: string;
  nodes: ChangeNode[];
  files: StageFile[];
  insights: Insight[];
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface SpecificationSource {
  kind: string;
  reference: string;
  url?: string;
}

/** A specification; `acceptance` holds its acceptance criteria. */
export interface Requirement {
  id: string;
  title: string;
  summary: string;
  source: SpecificationSource;
  acceptance: AcceptanceCriterion[];
}

export type FeedbackTargetKind = "specification" | "criterion" | "stage" | "node" | "insight" | "file" | "line";

/** A thread's target, as stored in the feedback format. */
export interface FeedbackTarget {
  kind: FeedbackTargetKind;
  label: string;
  specificationId?: string;
  criterionId?: string;
  stageId?: string;
  nodeId?: string;
  stageBranch?: string;
  stageHead?: string;
  collection?: InsightCollection;
  itemId?: string;
  path?: string;
  side?: DiffSide;
  line?: number;
}

export type ThreadStatus = "open" | "resolved";

/** A comment as stored in the feedback format. */
export interface FeedbackComment {
  id: string;
  author: "user" | "agent";
  body: string;
  createdAt: string;
  /** Agent replies only: the latest user comment this reply answers. */
  respondsTo?: string;
  attachments?: Attachment[];
}

/** A comment in `ImplementationData.feedback`; attachments are always listed. */
export interface FeedbackThreadComment extends FeedbackComment {
  attachments: Attachment[];
}

/** Where a file or line thread's path is at the assigned stage's current head. */
export type FeedbackTargetState =
  | { state: "present" | "deleted" | "not-in-stage" }
  | { state: "renamed"; path: string };

export interface FeedbackThread {
  id: string;
  status: ThreadStatus;
  target: FeedbackTarget;
  /** Only for file and line targets whose stage still exists. */
  targetState?: FeedbackTargetState;
  comments: FeedbackThreadComment[];
  assignedStageId: string;
  stageHead: string;
  createdAt: string;
  resolvedAt: string | null;
  /** The assigned or target stage head moved since the thread was anchored. */
  anchorStale: boolean;
}

/** The source of a remote branch review. */
export interface RemoteInfo {
  sourceRoot: string;
  remoteName: string;
  branch: string;
  targetBranch: string;
  headRevision?: string;
  refreshedAt?: string;
}

/** `window.SEMANTIC_IMPLEMENTATION` (GET `/implementation-data.js`) and the
 * `implementation` of GET `/api/implementation`. Built by the worker method
 * `implementationDataScript`.
 *
 * When the review is unavailable, `/implementation-data.js` sends a reduced payload
 * (`UnavailableImplementationData`) instead. `/api/implementation` always sends
 * this full form. */
export interface ImplementationData {
  implementationId: string;
  reviewId: string;
  /** Present for remote branch reviews; null otherwise. */
  remote: RemoteInfo | null;
  title: string;
  /** The manifest's `skillVersion`, or null when it has none. */
  skillVersion: string | null;
  /** The release version of the installed viewer, or `unversioned`. */
  viewerReleaseVersion: string;
  summary: string;
  targetBranch: string;
  baseRevision: string;
  requirements: Requirement[];
  stages: Stage[];
  feedback: FeedbackThread[];
  /** Equals `ViewerSnapshot.revision` for the documents this payload was built from. */
  viewerRevision: string;
  awaitingAgentReplies: number;
}

/** The reduced `window.SEMANTIC_IMPLEMENTATION` sent when the review is unavailable:
 * `summary` holds the error and the lists are empty. */
export interface UnavailableImplementationData {
  implementationId: string;
  reviewId: string;
  title: string;
  viewerReleaseVersion: string;
  summary: string;
  stages: [];
  requirements: [];
  feedback: [];
  baseRevision: "";
  targetBranch: "";
}

/* ---- persisted review state ----------------------------------------------- */

/** The shape of a file approval request and of the endpoint retained with a file approval. */
export interface ApprovalEndpoint {
  stageId: string;
  nodeId: string;
  path: string;
  baseRevision: string;
  headRevision: string;
  fileRevision: string;
  /** The node's membership of the file when it was approved. */
  ownership: FileMembership;
}

/** `ReviewState.approvals` values. Keys are a stage ID (stage approvals, `rev: null`)
 * or `m:` followed by the JSON array `[stageId, nodeId, path]` (file approvals). */
export interface ApprovalRecord extends Partial<ApprovalEndpoint> {
  /** File approvals: JSON of [file revision, classification, hunks, lineRanges], where
   * an unknown classification is the one the artifact records.
   * Older viewers saved [file revision, base revision, classification, hunks,
   * lineRanges]; the viewer drops the base revision before comparing, so compare
   * through that normalisation rather than directly. */
  rev: string | null;
  /** Epoch milliseconds. */
  at: number;
  /** The retained approved content (32 hex characters), for file approvals. */
  snapshotId?: string;
}

/** `ReviewState.insightReviews` values, keyed by insight key. */
export interface InsightReviewRecord {
  fingerprint: string;
  /** Epoch milliseconds. */
  at: number;
}

/** The revisions a draft was written against, used to detect that its target changed. */
export interface DraftSnapshot {
  base: string;
  head: string;
  /** `StageFile.revision`; legacy line drafts lack it until `/api/draft-snapshots` resolves it. */
  fileRevision?: string;
}

/** The element a note is attached to. IDs: stage ID, node ID, `f:<stage>:<path>`,
 * `l:<stage>:<side>:<line>:<path>`, or `i:<stage>:<collection>:<item>`. */
export type NoteKind = "stage" | "node" | "file" | "line" | "insight";

export type NoteMode = "personal" | "feedback";

/** `ReviewState.comments` element: a personal note or a feedback draft. */
export interface DraftNote {
  kind: NoteKind;
  id: string;
  body: string;
  mode: NoteMode;
  attachments?: Attachment[];
  /** Epoch milliseconds; also the note's client ID when sent. */
  createdAt: number;
  stageId?: string;
  nodeId?: string;
  snapshot?: DraftSnapshot;
  /** Set once a feedback draft was sent; sent notes are immutable. */
  exported?: boolean;
  threadId?: string;
}

/** `ReviewState.replyDrafts` element: an unsent reply to a feedback thread. */
export interface ReplyDraft {
  /** `rd-<time>-<random>`. */
  id: string;
  threadId: string;
  body: string;
  attachments: Attachment[];
  /** Epoch milliseconds. */
  createdAt: number;
}

/** The open note composer. */
export interface ComposeDraft {
  kind: NoteKind;
  id: string;
  stageId?: string;
  nodeId?: string | null;
  /** Index into `comments` of the note being edited, or null for a new note. */
  editIndex: number | null;
  mode: NoteMode;
  body: string;
  dirty: boolean;
  attachments?: Attachment[];
  snapshot?: DraftSnapshot;
}

/** Unsent editor contents, restored on reload. */
export interface EditorState {
  compose: ComposeDraft | null;
  /** The feedback thread being replied to. */
  replyTo: string | null;
  replyDraft: string;
  /** The reply draft being edited. */
  replyEditId: string | null;
  replyAttachments: Attachment[];
}

/** A draft note saved by an older viewer: `at` instead of `createdAt`, no `mode`,
 * and a sent note possibly without its `body`. */
export interface LegacyDraftNote extends Partial<Omit<DraftNote, "kind" | "id" | "body">> {
  kind: NoteKind;
  id: string;
  body?: string;
  /** Epoch milliseconds. */
  at?: number;
}

/** The persisted viewer state (`state` in the page), as the current page writes it.
 * On the wire it is a `StoredReviewState`: the server starts it as `{}` and returns
 * whatever the page wrote, including records saved by older viewers, so every field
 * may be absent or hold a legacy shape. The page normalises the state on load. */
export interface ReviewState {
  /** A boolean is a legacy approval without a revision; the page discards it. */
  approvals?: Record<string, ApprovalRecord | boolean>;
  insightReviews?: Record<string, InsightReviewRecord>;
  comments?: (DraftNote | LegacyDraftNote)[];
  replyDrafts?: ReplyDraft[];
  editor?: EditorState;
  /** Stage ID -> expanded. */
  openStages?: Record<string, boolean>;
  /** Thread key or file ID -> notes open. */
  openThreads?: Record<string, boolean>;
  /** Line ID -> line notes open. */
  openLineThreads?: Record<string, boolean>;
  /** File ID -> node whose slice of the file is open, or null. Older viewers saved `true`. */
  activeFiles?: Record<string, string | null | boolean>;
  /** File approval key -> show the comparison with the approved content. */
  approvalComparisons?: Record<string, boolean>;
  /** Feedback thread ID -> collapsed. */
  threadCollapsed?: Record<string, boolean>;
  /** File ID -> show the Markdown preview. */
  markdownPreview?: Record<string, boolean>;
  /** File ID -> diff view. */
  fileView?: Record<string, "hunk" | "full">;
  /** File ID -> hide removed lines. */
  hideDeleted?: Record<string, boolean>;
  /** Specification ID -> expanded. Older viewers saved one boolean. */
  specificationOpen?: Record<string, boolean> | boolean;
  lastNoteMode?: NoteMode;
  coverageOpen?: boolean;
  notesOpen?: boolean;
  notesFilter?: "active" | "resolved";
  wrapLines?: boolean;
  // Unverified: pinnedInsight and hideApproved are only initialised (null, false) by the current page.
  pinnedInsight?: unknown;
  hideApproved?: boolean;
  /** Agent replies created after this ISO time count as unread unless in `readReplies`. */
  repliesSeenThrough?: string;
  /** JSON `[threadId, commentId]` -> read. */
  readReplies?: Record<string, boolean>;
  /** `AgentStatus.targetRefresh.at` of the dismissed target refresh notice. */
  dismissedTargetRefresh?: string;
  /** Keys written by older viewers, such as `active`. */
  [legacyKey: string]: unknown;
}

/** The review state as the server stores and returns it. The server applies the
 * page's changes without checking their values, so read it as a `ReviewState` only
 * after checking each value. Every key, including `__proto__`, is an own key. */
export type StoredReviewState = { [key: string]: unknown };

/** One side of a state change: whether the key exists and its value. */
export type ReviewStateValue = { present: true; value: unknown } | { present: false };

/** One element of the `changes` the page computes with `stateChanges(...)`. The
 * server applies it only when the current value equals `before` (or already equals `after`). */
export interface ReviewStateChange {
  /** Object keys from the state root; 1 to 32 entries. */
  path: string[];
  before: ReviewStateValue;
  after: ReviewStateValue;
}

/* ---- agent and snapshot ---------------------------------------------------- */

/** A question the agent asked the reviewer. */
export interface AgentRequest {
  id: string;
  body: string;
  /** Suggested answers; may be empty. */
  choices: string[];
  createdAt: string;
}

/** The listening agent's status (`agentStatus(...)` on the server). */
export interface AgentStatus {
  /** An interactive session is running. */
  session: boolean;
  /** The session sent a heartbeat recently. */
  listening: boolean;
  stopRequested: boolean;
  /** The round in progress, or null. */
  working: {
    startedAt: string;
    threads: { id: string; answered: boolean }[];
    note?: string;
  } | null;
  /** Unanswered questions. */
  requests: AgentRequest[];
  lastRound: { id: string; completedAt: string; threadIds: string[] } | null;
  /** The latest automatic move of the implementation onto its advanced target branch. */
  targetRefresh: { at: string; targetBranch: string; previousBaseRevision: string; baseRevision: string } | null;
  serverTime: string;
}

/** The worker `snapshot` result, spread into `/api/revision`, `/api/feedback/export`
 * and thread-action responses. */
export interface ViewerSnapshot {
  /** Hash of the artifact and feedback documents; compare with `ImplementationData.viewerRevision`. */
  revision: string;
  awaitingAgentReplies: number;
  agent: AgentStatus;
}

/* ---- endpoints ------------------------------------------------------------- */

/** GET and POST `/api/review-state` response. */
export type ReviewStateResponse = ApiResult<{
  reviewId: string;
  generation: string;
  state: StoredReviewState;
}>;

/** POST `/api/review-state` request. */
export interface ReviewStatePatchRequest {
  reviewId: string;
  generation: string;
  /** At most 10,000 changes. */
  changes: ReviewStateChange[];
}

/** GET `/api/revision` response. */
export type RevisionResponse = ApiResult<ViewerSnapshot>;

/** GET `/api/implementation` response. */
export type ImplementationResponse = ApiResult<{ implementation: ImplementationData }>;

/** GET `/api/diff` query. `base` is the file's `StageFile.baseRevision` and `head`
 * the stage head. `side` and `line` together request the page containing that line. */
export type DiffQuery = {
  stage: string;
  path: string;
  base: string;
  head: string;
  /** Defaults to `changes`. */
  mode?: DiffMode;
  /** Decimal row offset; defaults to 0. */
  offset?: string;
} & (
  | { side?: undefined; line?: undefined }
  /** `line` is a decimal line number on `side`. The server ignores `line` without `side`
   * and rejects `side` without `line`. */
  | { side: DiffSide; line: string }
);

/** GET `/api/diff` response (worker `fileDiff`). Pages hold at most 900 rows. */
export type DiffResponse = ApiResult<{
  lines: DiffLine[];
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  /** The offset of the next page, or null on the last page. */
  nextOffset: number | null;
  /** The offset of this page; absent when the whole first page came from the
   * stage-wide cache (offset 0). With `side`/`line` it may differ from the request. */
  offset?: number;
  mode: DiffMode;
}>;

/** GET `/api/file-content` query: a Markdown file's complete content at the stage
 * head (or base for a deleted file). `target` names another repository file at the
 * same revision (a link or image in the Markdown). */
export type FileContentQuery = {
  stage: string;
  path: string;
  base: string;
  head: string;
  target?: string;
  /** `1` returns the raw bytes with their media type instead of JSON. */
  raw?: "1";
  /** With `raw`, `1` fails unless the content is an image. */
  image?: "1";
};

/** GET `/api/file-content` JSON response (without `raw=1`). */
export type FileContentResponse = ApiResult<{
  revision: string;
  path: string;
  side: "base" | "head";
  /** UTF-8 text. */
  content: string;
  /** An image media type, or `text/plain; charset=utf-8`. */
  mediaType: string;
}>;

/** GET `/api/evidence` query. Responds with the evidence bytes (with HTTP range
 * support) or a JSON `ApiFailure` with status 404. */
export type EvidenceQuery = {
  stage: string;
  /** The evidence item ID. */
  item: string;
  /** Decimal index into `EvidenceDetails.attachments`. */
  index: string;
};

/** POST `/api/attachments` request. */
export interface AttachmentUploadRequest {
  filename: string;
  mediaType: string;
  /** Base64 content of at most 20 MiB. */
  data: string;
}

/** POST `/api/attachments` response. */
export type AttachmentUploadResponse = ApiResult<{ attachment: Attachment }>;

/** GET `/api/attachments/:id` query. Responds with the attachment bytes or a JSON
 * `ApiFailure` with status 404. */
export type AttachmentQuery = {
  /** `1` serves images inline with their media type. */
  preview?: "1";
};

/** POST `/api/approval-snapshots` response; the request is an `ApprovalEndpoint`. */
export type ApprovalSnapshotResponse = ApiResult<{
  snapshotId: string;
  capturedAt: string;
}>;

/** POST `/api/approval-comparison` request. */
export interface ApprovalComparisonRequest extends ApprovalEndpoint {
  snapshotId: string;
  /** Defaults to 0. */
  offset?: number;
  /** Defaults to `changes`. */
  mode?: DiffMode;
  /** `stage` leaves out base changes when they can be separated; defaults to `stage`. */
  scope?: "stage" | "all";
}

/** The server's file endpoint, as recorded with a snapshot or resolved for the current file. */
export interface ApprovalFileEndpoint extends ApprovalEndpoint {
  previousPath?: string;
  previousPaths?: string[];
}

/** File identity on one side of an approval comparison. */
export interface ApprovalContentInfo {
  size: number;
  /** Null when the content was too large to retain. */
  sha256: string | null;
  exists: boolean;
  mode: string | null;
  objectId: string | null;
}

/** POST `/api/approval-comparison` response: the current file compared with its
 * approved content. Pages hold at most 900 rows. */
export type ApprovalComparisonResponse = ApiResult<{
  /** The endpoint recorded with the snapshot. Snapshots of older viewers may hold an
   * ownership of another shape; the server only compares it with the current one. */
  approved: Omit<ApprovalFileEndpoint, "ownership"> & { ownership: unknown } & ApprovalContentInfo & { at: string };
  current: ApprovalFileEndpoint & ApprovalContentInfo;
  baseChanged: boolean;
  ownershipChanged: boolean;
  /** How changes to the stage base are reflected in `lines`. */
  baseChanges: "none" | "mixed" | "included" | "excluded";
  /** Why no line comparison is available, or empty. */
  unsupported: string;
  lines: DiffLine[];
  offset: number;
  nextOffset: number | null;
}>;

/** A saved review's identity, without its state. */
export interface ReviewIdentity {
  id: string;
  generation: string;
  title: string;
  implementationId: string;
  repositoryRoot: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  remote?: RemoteInfo;
}

/** One entry of GET `/api/reviews`. */
export interface ReviewSummary extends ReviewIdentity {
  available: boolean;
  /** Empty when available. */
  unavailableReason: string;
  /** Present (true) only for reviews whose deletion has not finished. */
  deletionPending?: true;
}

/** GET `/api/reviews` response, newest first. */
export type ReviewsResponse = ApiResult<{ reviews: ReviewSummary[] }>;

export interface ReviewStorageCategory {
  label: string;
  detail: string;
  bytes: number;
}

/** A review's local storage, as inspected for cleanup. */
export interface ReviewStorage {
  review: ReviewIdentity;
  storageDirectory: string;
  bytes: number;
  categories: ReviewStorageCategory[];
  /** Unsent drafts. */
  drafts: number;
  /** Unresolved feedback threads. */
  unresolved: number;
  /** Why unused-file cleanup is disabled, or empty. */
  referenceError: string;
  /** Pass to delete and clean-unused requests to confirm what was shown. */
  fingerprint: string;
  /** Owned files and folders that can be cleaned. */
  unused: { path: string; bytes: number }[];
  unusedBytes: number;
  deletionPending: boolean;
  /** Why a pending deletion has not finished. */
  error?: string;
}

/** POST `/api/reviews/storage` response; the request is a `ReviewTarget`. */
export type ReviewStorageResponse = ApiResult<{ storage: ReviewStorage }>;

/** POST `/api/reviews/delete` and `/api/reviews/clean-unused` request. */
export interface ReviewStorageActionRequest extends ReviewTarget {
  fingerprint: string;
}

/** POST `/api/reviews/delete` response. */
export type ReviewDeleteResponse = ApiResult<{
  deleted: true;
  /** The review can no longer be used, but some files remain to be removed. */
  cleanupPending: boolean;
  error?: string;
}>;

/** POST `/api/reviews/clean-unused` response. */
export type ReviewCleanResponse = ApiResult<{
  reclaimedBytes: number;
  failures: string[];
}>;

/** POST `/api/reviews/completion` request; responds with `OkResponse`. */
export interface ReviewCompletionRequest extends ReviewTarget {
  completed: boolean;
  /** The `completedAt` the page saw; a mismatch fails the change. */
  expectedCompletedAt: string | null;
}

/** POST `/api/reviews/open` request. */
export type ReviewOpenRequest = ReviewTarget;

/** POST `/api/reviews/open` response: the started review's viewer URL. */
export type ReviewOpenResponse = ApiResult<{ url: string }>;

/** POST `/api/agent/respond` request. */
export interface AgentRespondRequest {
  requestId: string;
  /** 1 to 4,000 characters after trimming. */
  body: string;
}

/** POST `/api/agent/stop` (body `{}`) and `/api/agent/respond` response. */
export type AgentControlResponse = ApiResult<{ agent: AgentStatus }>;

/** POST `/api/remote/refresh` (body `{}`) response. */
export type RemoteRefreshResponse = OkResponse;

/** A draft whose snapshot `/api/draft-snapshots` should resolve. The page sends
 * whole drafts, saved notes and the composer's draft alike, so other fields of
 * theirs may be present; the server reads only `kind`, `id` and `snapshot`. */
export type DraftSnapshotNote = Pick<DraftNote, "kind" | "id" | "snapshot">;

/** POST `/api/draft-snapshots` request. */
export interface DraftSnapshotsRequest {
  notes: DraftSnapshotNote[];
}

/** POST `/api/draft-snapshots` response: one snapshot per note, in order, with
 * `fileRevision` added where it could be resolved. Null for notes without a snapshot. */
export type DraftSnapshotsResponse = ApiResult<{ snapshots: (DraftSnapshot | null)[] }>;

/** A feedback draft to send as a new thread. */
export interface FeedbackNoteExport {
  /** Echoed in `exported` and `skipped`; the page uses the note's index in `comments`. */
  ref: number;
  kind: NoteKind;
  id: string;
  stageId?: string;
  body: string;
  attachments: AttachmentRef[];
  /** Makes the thread ID stable across retries. */
  clientId?: string;
  snapshot?: DraftSnapshot;
}

/** A reply draft to send to an existing thread. */
export interface FeedbackReplyExport {
  /** Echoed in `replied` and `replySkipped`; the page uses the reply draft ID. */
  ref: string;
  threadId: string;
  body: string;
  attachments: AttachmentRef[];
}

/** POST `/api/feedback/export` request. */
export interface FeedbackExportRequest {
  implementationId: string;
  notes: FeedbackNoteExport[];
  replies: FeedbackReplyExport[];
}

/** A reply that was written to its thread. */
export interface FeedbackReplyResult {
  ref: string;
  threadId: string;
  /** Absent when the thread could not be read back. */
  comment?: FeedbackComment;
  /** Absent when the thread could not be read back. */
  status?: ThreadStatus;
  resolvedAt: string | null;
}

/** The result of one send (worker `sendFeedback`). */
export interface FeedbackSendResult {
  exported: { ref: number; threadId: string }[];
  skipped: { ref: number; reason: string }[];
  replied: FeedbackReplyResult[];
  replySkipped: { ref: string; reason: string }[];
}

/** POST `/api/feedback/export` response. A send that wrote nothing fails with
 * status 422 but still carries the send result (except when there was nothing to
 * send) and the viewer snapshot; other failures carry only `error`. */
export type FeedbackExportResponse =
  | ({ ok: true } & FeedbackSendResult & ViewerSnapshot)
  | (ApiFailure & Partial<FeedbackSendResult> & Partial<ViewerSnapshot>);

export type ThreadActionKind = "resolve" | "reopen" | "reply";

/** POST `/api/feedback/resolve`, `/api/feedback/reopen` and `/api/feedback/reply`
 * request. `body`, `attachments` and `clientId` apply to `reply` only. */
export interface ThreadActionRequest {
  implementationId: string;
  threadId: string;
  body?: string;
  attachments?: AttachmentRef[];
  /** Makes the reply comment ID stable across retries. */
  clientId?: string;
}

/** POST `/api/feedback/{resolve,reopen,reply}` response. A plain `{ ok: true }`
 * means the action succeeded but the thread could not be read back. */
export type ThreadActionResponse =
  | { ok: true }
  | ({
      ok: true;
      status: ThreadStatus;
      resolvedAt: string | null;
      /** For `reply` only: the thread's last comment when the server answers. If other
       * comments followed the reply, a retry returns the latest of those instead. */
      comment?: FeedbackComment;
    } & ViewerSnapshot)
  | ApiFailure;

/** GET `/api/whoami` response: the viewer's identity, used to find and reuse a
 * running viewer. Requires no review scope. */
export interface WhoAmIResponse {
  ok: true;
  app: "semantic-flow-review-viewer";
  implementationId: string;
  repositoryRoot: string;
  reviewId: string;
  generation: string;
  reviewHome: string;
  port: number;
  skillDirectory: string;
  processId: number;
  /** Fingerprint of the viewer's code and assets. */
  viewerVersion: string;
  viewerReleaseVersion: string;
  /** The data worker is running. */
  healthy: boolean;
}

/** POST `/api/shutdown` (body `{}`) response; requires no review scope. */
export type ShutdownResponse = OkResponse;
