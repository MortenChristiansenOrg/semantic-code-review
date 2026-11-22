import type { FeedbackTargetKind, DiffSide } from "./shared.js";

/**
 * Initializes mutable feedback state for the active semantic implementation.
 * @cli semantic-flow.mjs
 * @command feedback init
 */
export declare function initializeFeedback(): void;

export interface AddFeedbackThreadOptions {
  /** Stable identifier for the open feedback thread. */
  id: string;
  /** Stable identifier for the opening user comment. */
  "comment-id": string;
  /** Opening change instruction or question. */
  body?: string;
  /** Managed attachment IDs from `attachment add`; repeat the option for multiple files. */
  attachments?: string[];
  /** Human-readable label for the anchor. */
  label: string;
  /** Anchor shape, which determines the required conditional fields. */
  "target-kind": FeedbackTargetKind;
  /** Specification identifier for specification and criterion targets. */
  specification?: string;
  /** Criterion identifier for criterion targets. */
  criterion?: string;
  /** Stage identifier for stage, node, insight, file, and line targets. */
  stage?: string;
  /** Change node identifier for a node target. */
  node?: string;
  /** Insight collection name for an insight target. */
  collection?: string;
  /** Insight identifier for an insight target. */
  item?: string;
  /** Repository path for file and line targets. */
  path?: string;
  /** Diff side for a line target. */
  side?: DiffSide;
  /** Positive line number for a line target. */
  line?: string;
  /** Stage responsible for resolving the thread when it differs from the anchor stage; required for specification and criterion targets, which have none. */
  "assigned-stage"?: string;
}

/**
 * Adds an open feedback thread with an opening user comment.
 * Target-specific parameters are required by `target-kind`.
 * @cli semantic-flow.mjs
 * @command feedback thread add
 */
export declare function addFeedbackThread(
  options: AddFeedbackThreadOptions,
): void;

export interface AddFeedbackThreadsOptions {
  /** Commits valid items together and emits JSON accepted/rejected indexes; global failures still abort. */
  partial?: true;
  /**
   * One object per thread, with the options of `thread add` as kebab-case keys.
   * In `--input` JSON, give the array itself: `{"threads": [{...}]}`. Only `--threads` on the command line takes it as JSON text.
   */
  threads: readonly object[] | string;
}

/**
 * Adds several feedback threads as one locked and validated mutation.
 * Without `partial`, no thread is kept when any input is invalid.
 * With `partial`, valid inputs commit together and rejected indexes are returned.
 * @cli semantic-flow.mjs
 * @command feedback thread add-batch
 */
export declare function addFeedbackThreads(
  options: AddFeedbackThreadsOptions,
): void;

export interface NextFeedbackOptions {
  /** Emits machine-readable JSON instead of text. */
  json?: true;
  /** Omits repeated metadata and reports stale and automatic re-anchoring status, and where a current line thread's line now stands (`currentLine`). Requires `json`. */
  compact?: true;
  /** Claims the returned threads for one round, skipping threads another round is answering. Emits `{claim, claimedElsewhere, stages}`. Requires `json`. */
  claim?: true;
  /** Listening session that owns the claim. Requires `claim`. */
  session?: string;
}

/**
 * Lists open feedback threads awaiting an agent reply, grouped by stage.
 * A thread awaits a reply while a user comment follows the comment its latest
 * agent reply answered.
 * @cli semantic-flow.mjs
 * @command feedback next
 */
export declare function nextFeedback(options?: NextFeedbackOptions): void;

export interface ReplyFeedbackThreadOptions {
  /** Open feedback thread being continued. */
  id: string;
  /** Stable identifier for the new comment. */
  "comment-id": string;
  /** Comment text. */
  body?: string;
  /** Managed attachment IDs from `attachment add`; repeat the option for multiple files. */
  attachments?: string[];
  /** Comment author; defaults to `user`. Implementation agents reply with `agent`. */
  author?: "user" | "agent";
  /** Agent replies only: the round (`claim` from the feedback preflight) this reply belongs to. The reply then answers through the comment that round claimed, even if the round was replaced. */
  claim?: string;
}

/**
 * Appends a comment to an open thread. Replying to a resolved thread reopens
 * it — closing a conversation is always the reviewer's decision. An agent reply
 * records the user comment it answers; comments added while its round ran stay queued.
 * @cli semantic-flow.mjs
 * @command feedback thread reply
 */
export declare function replyFeedbackThread(
  options: ReplyFeedbackThreadOptions,
): void;

export interface ReplyFeedbackThreadsOptions {
  /** Commits valid replies together and emits JSON accepted/rejected indexes; global failures still abort. */
  partial?: true;
  /**
   * One object per reply, with the options of `thread reply` as kebab-case keys.
   * In `--input` JSON, give the array itself: `{"replies": [{...}]}`. Only `--replies` on the command line takes it as JSON text.
   */
  replies: readonly object[] | string;
  /** Round for every agent reply that does not name its own `claim`. */
  claim?: string;
}

/**
 * Appends several replies as one locked and validated mutation.
 * Without `partial`, no reply is kept when any input is invalid.
 * With `partial`, valid replies commit together and rejected indexes are returned.
 * @cli semantic-flow.mjs
 * @command feedback thread reply-batch
 */
export declare function replyFeedbackThreads(
  options: ReplyFeedbackThreadsOptions,
): void;

export interface ResolveFeedbackThreadOptions {
  /** Open feedback thread being resolved. */
  id: string;
  /** Stable identifier for an optional reviewer closing comment. */
  "comment-id"?: string;
  /** Optional reviewer closing note; required with `comment-id`. */
  body?: string;
}

/**
 * Marks an open thread resolved. Resolution is a reviewer decision; the agent
 * never closes a thread. A closing note is optional.
 * @cli semantic-flow.mjs
 * @command feedback thread resolve
 */
export declare function resolveFeedbackThread(
  options: ResolveFeedbackThreadOptions,
): void;

export interface ReopenFeedbackThreadOptions {
  /** Resolved feedback thread to reopen. */
  id: string;
}

/**
 * Reopens a resolved thread so the conversation can continue.
 * @cli semantic-flow.mjs
 * @command feedback thread reopen
 */
export declare function reopenFeedbackThread(
  options: ReopenFeedbackThreadOptions,
): void;

export interface ValidateFeedbackOptions {
  /** Requires every feedback thread to be resolved. */
  "require-resolved"?: true;
}

/**
 * Validates feedback schemas, targets, stage snapshots, and thread states.
 * @cli semantic-flow.mjs
 * @command feedback validate
 */
export declare function validateFeedback(
  options?: ValidateFeedbackOptions,
): void;

export interface AddAttachmentOptions {
  /** Local file to copy into this review (maximum 20 MiB). */
  file: string;
  /** Media type; defaults to application/octet-stream; raster images are detected. */
  "media-type"?: string;
}
/** Stores a local context file and emits its metadata and resolvable localPath as JSON.
 * @cli semantic-flow.mjs
 * @command feedback attachment add
 */
export declare function addAttachment(options: AddAttachmentOptions): void;
export interface ShowAttachmentOptions {
  /** Managed attachment identity within this review. */
  id: string;
}
/** Resolves a managed attachment to metadata and a localPath for agent access.
 * @cli semantic-flow.mjs
 * @command feedback attachment show
 */
export declare function showAttachment(options: ShowAttachmentOptions): void;

export interface AskReviewerOptions {
  /** Stable request identifier; repeating identical content is a no-op. */
  id: string;
  /** Plain-language question about a problem that is not about one feedback thread. */
  body: string;
  /** Optional answer the reviewer can pick; repeat for up to six choices. The reviewer can always write a different answer. */
  choice?: string[];
}
/** Shows a question in the viewer. The answer is returned in `responses` by the next `semantic-flow feedback` call.
 * @cli semantic-flow.mjs
 * @command feedback agent ask
 */
export declare function askReviewer(options: AskReviewerOptions): void;
export interface ReportAgentProgressOptions {
  /** Short description of the running round's current work, shown in the viewer. */
  body: string;
}
/** Updates the progress note of the feedback round in progress.
 * @cli semantic-flow.mjs
 * @command feedback agent progress
 */
export declare function reportAgentProgress(options: ReportAgentProgressOptions): void;
