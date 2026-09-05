import type { FeedbackTargetKind, DiffSide } from "./shared.js";
/**
 * Initializes mutable feedback state for the active semantic implementation.
 * @cli review-feedback.mjs
 * @command init
 */
export declare function initializeFeedback(): void;
export interface AddFeedbackThreadOptions {
    /** Stable identifier for the open feedback thread. */
    id: string;
    /** Stable identifier for the opening user comment. */
    "comment-id": string;
    /** Opening change instruction or question. */
    body: string;
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
    /** Stage responsible for resolving the thread when it differs from the anchor stage. */
    "assigned-stage"?: string;
}
/**
 * Adds an open feedback thread with an opening user comment.
 * Target-specific parameters are required by `target-kind`.
 * @cli review-feedback.mjs
 * @command thread add
 */
export declare function addFeedbackThread(options: AddFeedbackThreadOptions): void;
export interface AddFeedbackThreadsOptions {
    /** Commits valid items together and emits JSON accepted/rejected indexes; global failures still abort. */
    partial?: true;
    /** JSON array of feedback thread inputs using the same fields as `thread add`. */
    threads: string;
}
/**
 * Adds several feedback threads as one locked and validated mutation.
 * No thread is kept when any input is invalid.
 * @cli review-feedback.mjs
 * @command thread add-batch
 */
export declare function addFeedbackThreads(options: AddFeedbackThreadsOptions): void;
export interface NextFeedbackOptions {
    /** Emits machine-readable JSON instead of text. */
    json?: true;
    /** Omits repeated metadata and reports stale and automatic re-anchoring status. Requires `json`. */
    compact?: true;
}
/**
 * Lists open feedback threads awaiting an agent reply, grouped by stage.
 * @cli review-feedback.mjs
 * @command next
 */
export declare function nextFeedback(options?: NextFeedbackOptions): void;
export interface ReplyFeedbackThreadOptions {
    /** Open feedback thread being continued. */
    id: string;
    /** Stable identifier for the new comment. */
    "comment-id": string;
    /** Comment text. */
    body: string;
    /** Comment author; defaults to `user`. Implementation agents reply with `agent`. */
    author?: "user" | "agent";
}
/**
 * Appends a comment to an open thread. Replying to a resolved thread reopens
 * it — closing a conversation is always the reviewer's decision.
 * @cli review-feedback.mjs
 * @command thread reply
 */
export declare function replyFeedbackThread(options: ReplyFeedbackThreadOptions): void;
export interface ReplyFeedbackThreadsOptions {
    /** Commits valid replies together and emits JSON accepted/rejected indexes; global failures still abort. */
    partial?: true;
    /** JSON array of reply inputs using the same fields as `thread reply`. */
    replies: string;
}
/**
 * Appends several replies as one locked and validated mutation.
 * No reply is kept when any input is invalid.
 * @cli review-feedback.mjs
 * @command thread reply-batch
 */
export declare function replyFeedbackThreads(options: ReplyFeedbackThreadsOptions): void;
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
 * @cli review-feedback.mjs
 * @command thread resolve
 */
export declare function resolveFeedbackThread(options: ResolveFeedbackThreadOptions): void;
export interface ReopenFeedbackThreadOptions {
    /** Resolved feedback thread to reopen. */
    id: string;
}
/**
 * Reopens a resolved thread so the conversation can continue.
 * @cli review-feedback.mjs
 * @command thread reopen
 */
export declare function reopenFeedbackThread(options: ReopenFeedbackThreadOptions): void;
export interface ValidateFeedbackOptions {
    /** Requires every feedback thread to be resolved. */
    "require-resolved"?: true;
}
/**
 * Validates feedback schemas, targets, stage snapshots, and thread states.
 * @cli review-feedback.mjs
 * @command validate
 */
export declare function validateFeedback(options?: ValidateFeedbackOptions): void;
