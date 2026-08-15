export type RequirementSourceKind = "azure-devops" | "github" | "url" | "local";
export type ContextKind = "decision" | "assumption" | "alternative" | "failed-attempt" | "risk" | "question";
export type DecisionCategory = "requirement" | "engineering";
export type ValidationType = "automated" | "manual" | "analysis";
export type ValidationStatus = "passed" | "failed" | "not-run";
export type ChangeClassification = "behavior" | "refactor" | "test" | "documentation" | "configuration" | "dependency" | "migration" | "generated" | "chore" | "trivial";
export type FeedbackTargetKind = "requirement" | "criterion" | "stage" | "context" | "file" | "line";
export type DiffSide = "old" | "new";
export interface GlobalCliOptions {
    /** Prints command help without mutating repository state. */
    help?: true;
    /** Loads command options from one JSON object; camelCase and kebab-case keys are accepted. */
    input?: string;
}
export interface InitializeReviewOptions {
    /** Stable kebab-case identifier for the complete review. */
    "review-id": string;
    /** Human-readable title for the complete body of work. */
    title: string;
    /** Concise summary of the review scope. */
    summary: string;
    /** Target branch revision immediately before the first semantic stage. @defaultValue "<target-branch>" */
    "base-revision"?: string;
    /** Branch into which the completed implementation is intended to merge. */
    "target-branch": string;
    /** Folder-like prefix shared by every stage branch. @defaultValue "semantic-review/<review-id>" */
    "branch-prefix"?: string;
    /** Stable kebab-case identifier for the initial requirement. */
    "requirement-id": string;
    /** Human-readable title for the initial requirement. */
    "requirement-title": string;
    /** Concise description of the required behavior. */
    "requirement-summary": string;
    /** Origin type for the requirement, such as local or azure-devops. */
    "source-kind": RequirementSourceKind;
    /** Identifier at the requirement source, such as a story number. */
    "source-reference": string;
    /** Optional URL for the source requirement. */
    "source-url"?: string;
    /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
    criterion: readonly string[];
}
/**
 * Initializes a semantic review and its first requirement.
 * @cli semantic-review.mjs
 * @command init
 */
export declare function initializeReview(options: InitializeReviewOptions): void;
export interface AddRequirementOptions {
    /** Stable kebab-case identifier for the requirement. */
    "requirement-id": string;
    /** Human-readable requirement title. */
    "requirement-title": string;
    /** Concise description of the required behavior. */
    "requirement-summary": string;
    /** Origin type for the requirement, such as local or azure-devops. */
    "source-kind": RequirementSourceKind;
    /** Identifier at the requirement source, such as a story number. */
    "source-reference": string;
    /** Optional URL for the source requirement. */
    "source-url"?: string;
    /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
    criterion: readonly string[];
}
/**
 * Adds another requirement to the active review.
 * @cli semantic-review.mjs
 * @command requirement add
 */
export declare function addRequirement(options: AddRequirementOptions): void;
export interface BeginStageOptions {
    /** Stable kebab-case identifier for the stage. */
    id: string;
    /** Human-readable stage title. */
    title: string;
    /** Coherent implementation intent for this stage. */
    summary: string;
    /** Explanation of why this stage boundary and approach exist. */
    rationale: string;
    /** Direct stage dependencies; omit when the stage has none. */
    "depends-on"?: readonly string[];
    /** Covered criteria formatted as `<requirement-id>#<criterion-id>`. */
    "requirement-ref": readonly string[];
}
/**
 * Creates the single active working stage before its code changes begin.
 * @cli semantic-review.mjs
 * @command stage begin
 */
export declare function beginStage(options: BeginStageOptions): void;
export interface SetStageOptions {
    /** Working stage to update; omitted or `current` selects the only active stage. */
    id?: string;
    /** Replacement stage title. */
    title?: string;
    /** Replacement implementation intent. */
    summary?: string;
    /** Replacement rationale. */
    rationale?: string;
    /** Complete replacement dependency list. */
    "depends-on"?: readonly string[];
    /** Complete replacement criterion coverage list. */
    "requirement-ref"?: readonly string[];
}
/**
 * Updates mutable metadata on the active working stage.
 * At least one optional field must be supplied.
 * @cli semantic-review.mjs
 * @command stage set
 */
export declare function setStage(options: SetStageOptions): void;
export interface RecordStageContextOptions {
    /** Stage receiving the context item; omitted or `current` selects the only active stage. */
    stage?: string;
    /** Context item shape, which determines the required conditional fields. */
    kind: ContextKind;
    /** Stable identifier within the selected context collection. */
    "item-id": string;
    /** Replaces an existing context item with the same identifier. */
    replace?: true;
    /** Updates a finalized stage instead of the active working stage. */
    finalized?: true;
    /** Decision category; required when `kind` is `decision`. */
    category?: DecisionCategory;
    /** Decision or risk summary; required for those kinds. */
    summary?: string;
    /** Decision rationale; required when `kind` is `decision`. */
    rationale?: string;
    /** Assumption statement; required when `kind` is `assumption`. */
    statement?: string;
    /** Impact if an assumption is false; required when `kind` is `assumption`. */
    "risk-if-wrong"?: string;
    /** Rejected or failed approach; required for alternative and failed-attempt kinds. */
    approach?: string;
    /** Why an alternative was not selected; required when `kind` is `alternative`. */
    "reason-rejected"?: string;
    /** Observed result; required when `kind` is `failed-attempt`. */
    outcome?: string;
    /** Learning from a failed attempt; required when `kind` is `failed-attempt`. */
    lesson?: string;
    /** Optional response to a recorded risk. */
    mitigation?: string;
    /** Open question text; required when `kind` is `question`. */
    question?: string;
    /** Change nodes relevant to this item. Required once the stage is organized. */
    "node-ref"?: readonly string[];
}
/**
 * Records a decision, discovery, failure, risk, or question when it occurs.
 * Unrelated kind-specific parameters are rejected.
 * @cli semantic-review.mjs
 * @command stage record
 */
export declare function recordStageContext(options: RecordStageContextOptions): void;
export interface OrganizeStageOptions {
    /** Stage to organize; omitted or `current` selects the only active stage. */
    stage?: string;
    /** JSON document containing nodes and links from every recorded item to relevant nodes. */
    file: string;
    /** Reorganizes an already finalized stage. */
    finalized?: true;
}
/**
 * Post-processes a committed stage diff into descriptive change nodes.
 * Every changed file must belong to a node. Multi-node files must partition
 * their changed hunks or line ranges.
 * @cli semantic-review.mjs
 * @command stage organize
 */
export declare function organizeStage(options: OrganizeStageOptions): void;
export interface RecordValidationOptions {
    /** Stage receiving the validation evidence; omitted or `current` selects the only active stage. */
    stage?: string;
    /** Stable identifier for this validation result. */
    "item-id": string;
    /** How the validation was performed. */
    type: ValidationType;
    /** Observed validation outcome. */
    status: ValidationStatus;
    /** What was checked and what happened. */
    summary: string;
    /** Exact command used; required when `type` is `automated`. */
    command?: string;
    /** Change nodes relevant to this validation evidence. */
    "node-ref"?: readonly string[];
    /** Replaces validation evidence with the same identifier. */
    replace?: true;
    /** Updates a finalized stage instead of the active working stage. */
    finalized?: true;
}
/**
 * Records real validation evidence for a working or finalized stage.
 * @cli semantic-review.mjs
 * @command stage validation
 */
export declare function recordValidation(options: RecordValidationOptions): void;
export interface FinishStageOptions {
    /** Working stage to finalize; omitted or `current` selects the only active stage. */
    id?: string;
}
/**
 * Finalizes a working stage against the current stage branch head.
 * @cli semantic-review.mjs
 * @command stage finish
 */
export declare function finishStage(options: FinishStageOptions): void;
export interface DiscardStageOptions {
    /** Working stage to delete without reverting implementation files; omitted or `current` selects the only active stage. */
    id?: string;
}
/**
 * Deletes an unfinished working stage without reverting code changes.
 * @cli semantic-review.mjs
 * @command stage discard
 */
export declare function discardStage(options: DiscardStageOptions): void;
export interface RestackOptions {
    /** Earliest stage branch that was edited manually. */
    from?: string;
    /** Replacement trunk revision, usually the current target branch head. */
    base?: string;
}
/**
 * Refreshes an edited stage branch and rebases every branch above it.
 * @cli semantic-review.mjs
 * @command restack
 */
export declare function restack(options: RestackOptions): void;
/**
 * Repairs unambiguous interrupted artifact mutations.
 * @cli semantic-review.mjs
 * @command repair
 */
export declare function repairArtifact(): void;
export interface PublishArtifactOptions {
    /** Metadata commit message. @defaultValue "Publish <review-id> semantic review" */
    message?: string;
}
/**
 * Commits validated semantic metadata after approval.
 * @cli semantic-review.mjs
 * @command publish
 */
export declare function publishArtifact(options?: PublishArtifactOptions): void;
export interface PrepareStackOptions {
    /** Emits machine-readable local stack information. */
    json?: true;
}
/**
 * Verifies stage branches and prints their local base chain.
 * @cli semantic-review.mjs
 * @command prepare-stack
 */
export declare function prepareStack(options?: PrepareStackOptions): void;
export interface PrepareBranchOptions {
    /** Local cumulative branch to create at the final reviewed stage head. */
    branch: string;
}
/**
 * Creates a local single-branch review head without changing the worktree.
 * @cli semantic-review.mjs
 * @command prepare-branch
 */
export declare function prepareBranch(options: PrepareBranchOptions): void;
export interface ArchiveReviewOptions {
    /** Repository-relative archive directory ending in `.semantic-review`. @defaultValue ".semantic-review-history/<review-id>/.semantic-review" */
    destination?: string;
    /** Archive commit message. @defaultValue "Archive <review-id> semantic review" */
    message?: string;
}
/**
 * Moves a merged and published review into repository history.
 * The target branch must be checked out, contain the final stage head, and have
 * a metadata branch that exactly matches the current artifact.
 * @cli semantic-review.mjs
 * @command archive
 */
export declare function archiveReview(options?: ArchiveReviewOptions): void;
export interface ValidateArtifactOptions {
    /** Validates JSON schemas only and skips semantic and Git validation. */
    "schema-only"?: true;
    /** Applies the stricter completion and publication validation gate. */
    publish?: true;
}
/**
 * Validates schemas, references, dependencies, artifact state, and Git state.
 * `schema-only` and `publish` are mutually exclusive.
 * @cli semantic-review.mjs
 * @command validate
 */
export declare function validateArtifact(options?: ValidateArtifactOptions): void;
/**
 * Initializes mutable feedback state for the active semantic review.
 * @cli review-feedback.mjs
 * @command init
 */
export declare function initializeFeedback(): void;
export interface CreateFeedbackBatchOptions {
    /** Stable identifier for the draft feedback batch. */
    id: string;
    /** Human-readable batch title. */
    title: string;
}
/**
 * Creates an empty draft feedback batch.
 * @cli review-feedback.mjs
 * @command batch create
 */
export declare function createFeedbackBatch(options: CreateFeedbackBatchOptions): void;
export interface DeleteFeedbackBatchOptions {
    /** Empty draft batch to delete. */
    id: string;
}
/**
 * Deletes an empty draft feedback batch.
 * @cli review-feedback.mjs
 * @command batch delete
 */
export declare function deleteFeedbackBatch(options: DeleteFeedbackBatchOptions): void;
export interface AddFeedbackCommentOptions {
    /** Draft batch receiving the comment. */
    batch: string;
    /** Stable identifier for the feedback item. */
    id: string;
    /** Actionable reviewer feedback. */
    body: string;
    /** Human-readable label for the anchor. */
    label: string;
    /** Anchor shape, which determines the required conditional fields. */
    "target-kind": FeedbackTargetKind;
    /** Requirement identifier for requirement and criterion targets. */
    requirement?: string;
    /** Criterion identifier for criterion targets. */
    criterion?: string;
    /** Stage identifier for stage, context, file, and line targets. */
    stage?: string;
    /** Context collection name for a context target. */
    collection?: string;
    /** Context item identifier for a context target. */
    item?: string;
    /** Repository path for file and line targets. */
    path?: string;
    /** Diff side for a line target. */
    side?: DiffSide;
    /** Positive line number for a line target. */
    line?: string;
    /** Stage responsible for resolution when it differs from the anchor stage. */
    "assigned-stage"?: string;
}
/**
 * Adds a draft comment anchored to semantic or diff context.
 * Target-specific parameters are required by `target-kind`.
 * @cli review-feedback.mjs
 * @command comment add
 */
export declare function addFeedbackComment(options: AddFeedbackCommentOptions): void;
export interface EditFeedbackCommentOptions {
    /** Draft feedback item to edit. */
    id: string;
    /** Replacement feedback body. */
    body: string;
}
/**
 * Replaces the body of a draft feedback comment.
 * @cli review-feedback.mjs
 * @command comment edit
 */
export declare function editFeedbackComment(options: EditFeedbackCommentOptions): void;
export interface DeleteFeedbackCommentOptions {
    /** Draft feedback item to delete. */
    id: string;
}
/**
 * Deletes a draft feedback comment.
 * @cli review-feedback.mjs
 * @command comment delete
 */
export declare function deleteFeedbackComment(options: DeleteFeedbackCommentOptions): void;
export interface AssignFeedbackCommentOptions {
    /** Draft feedback item to assign. */
    id: string;
    /** Stage responsible for resolving the feedback. */
    stage: string;
}
/**
 * Assigns a draft feedback comment to its resolution stage.
 * @cli review-feedback.mjs
 * @command comment assign
 */
export declare function assignFeedbackComment(options: AssignFeedbackCommentOptions): void;
export interface SubmitFeedbackBatchOptions {
    /** Non-empty draft batch to freeze and submit. */
    id: string;
}
/**
 * Freezes and submits a non-empty draft feedback batch.
 * @cli review-feedback.mjs
 * @command batch submit
 */
export declare function submitFeedbackBatch(options: SubmitFeedbackBatchOptions): void;
export interface NextFeedbackOptions {
    /** Emits machine-readable JSON instead of text. */
    json?: true;
}
/**
 * Lists submitted feedback grouped by resolution stage.
 * @cli review-feedback.mjs
 * @command next
 */
export declare function nextFeedback(options?: NextFeedbackOptions): void;
export interface ResolveFeedbackCommentOptions {
    /** Submitted feedback item being resolved. */
    id: string;
    /** Explanation of how the feedback was addressed. */
    summary: string;
    /** Stage rewritten to resolve the feedback. */
    stage: string;
    /** Full stage head captured when the feedback was submitted. */
    "previous-head": string;
    /** Full current rewritten head for the assigned stage. */
    "rewritten-head": string;
}
/**
 * Records how a submitted feedback item was addressed.
 * @cli review-feedback.mjs
 * @command comment resolve
 */
export declare function resolveFeedbackComment(options: ResolveFeedbackCommentOptions): void;
export interface RebindResolutionsOptions {
    /** Stage that was rewritten again. */
    stage: string;
    /** Superseded rewritten head. */
    "previous-head": string;
    /** Current rewritten head. */
    "rewritten-head": string;
}
/**
 * Moves existing resolutions to a later rewrite of the same stage.
 * @cli review-feedback.mjs
 * @command resolution rebind
 */
export declare function rebindResolutions(options: RebindResolutionsOptions): void;
export interface ApproveFeedbackCommentOptions {
    /** Addressed feedback item to approve. */
    id: string;
}
/**
 * Approves one addressed feedback resolution.
 * @cli review-feedback.mjs
 * @command comment approve
 */
export declare function approveFeedbackComment(options: ApproveFeedbackCommentOptions): void;
export interface ApproveFeedbackBatchOptions {
    /** Batch whose addressed resolutions should be approved. */
    id: string;
}
/**
 * Approves every addressed resolution in a feedback batch.
 * @cli review-feedback.mjs
 * @command batch approve-all
 */
export declare function approveFeedbackBatch(options: ApproveFeedbackBatchOptions): void;
/**
 * Validates feedback, publishes semantic metadata, and reports the local stack.
 * @cli review-feedback.mjs
 * @command approve-stack
 */
export declare function approveStack(): void;
/**
 * Validates feedback schemas, targets, statuses, and resolutions.
 * @cli review-feedback.mjs
 * @command validate
 */
export declare function validateFeedback(): void;
