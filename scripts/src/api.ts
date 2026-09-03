export type SpecificationSourceKind =
  | "azure-devops"
  | "github"
  | "url"
  | "local";
export type InsightKind =
  | "decision"
  | "assumption"
  | "alternative"
  | "failed-attempt"
  | "risk"
  | "question";
export type DecisionCategory = "specification" | "engineering";
export type ValidationType = "automated" | "manual" | "analysis";
export type ValidationStatus = "passed" | "failed" | "not-run";
export type ChangeClassification =
  | "behavior"
  | "refactor"
  | "test"
  | "documentation"
  | "configuration"
  | "dependency"
  | "migration"
  | "generated"
  | "chore"
  | "trivial";
export type FeedbackTargetKind =
  | "specification"
  | "criterion"
  | "stage"
  | "insight"
  | "file"
  | "line";
export type DiffSide = "old" | "new";

export interface GlobalCliOptions {
  /** Prints command help without mutating repository state. */
  help?: true;
  /** Loads command options from one JSON object; camelCase and kebab-case keys are accepted. */
  input?: string;
}

export interface InitializeImplementationOptions {
  /** Stable kebab-case identifier for the complete implementation. */
  "implementation-id": string;
  /** Human-readable title for the complete body of work. */
  title: string;
  /** Concise summary of the implementation scope. */
  summary: string;
  /** Target branch revision immediately before the first semantic stage. @defaultValue "<target-branch>" */
  "base-revision"?: string;
  /** Branch into which the completed implementation is intended to merge. */
  "target-branch": string;
  /** Folder-like prefix shared by every stage branch. @defaultValue "semantic-flow/<implementation-id>" */
  "branch-prefix"?: string;
  /** Stable kebab-case identifier for the initial specification. */
  "specification-id": string;
  /** Human-readable title for the initial specification. */
  "specification-title": string;
  /** Concise description of the required behavior. */
  "specification-summary": string;
  /** Origin type for the specification, such as local or azure-devops. */
  "source-kind": SpecificationSourceKind;
  /** Identifier at the specification source, such as a story number. */
  "source-reference": string;
  /** Optional URL for the source specification. */
  "source-url"?: string;
  /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
  criterion: readonly string[];
}

/**
 * Initializes a semantic implementation and its first specification.
 * @cli semantic-implementation.mjs
 * @command init
 */
export declare function initializeImplementation(
  options: InitializeImplementationOptions,
): void;

export interface AddSpecificationOptions {
  /** Stable kebab-case identifier for the specification. */
  "specification-id": string;
  /** Human-readable specification title. */
  "specification-title": string;
  /** Concise description of the required behavior. */
  "specification-summary": string;
  /** Origin type for the specification, such as local or azure-devops. */
  "source-kind": SpecificationSourceKind;
  /** Identifier at the specification source, such as a story number. */
  "source-reference": string;
  /** Optional URL for the source specification. */
  "source-url"?: string;
  /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
  criterion: readonly string[];
}

/**
 * Adds another specification to the active implementation.
 * @cli semantic-implementation.mjs
 * @command specification add
 */
export declare function addSpecification(options: AddSpecificationOptions): void;

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
  /** Covered criteria formatted as `<specification-id>#<criterion-id>`. */
  "specification-ref": readonly string[];
}

/**
 * Creates the single active working stage before its code changes begin.
 * @cli semantic-implementation.mjs
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
  "specification-ref"?: readonly string[];
}

/**
 * Updates mutable metadata on the active working stage.
 * At least one optional field must be supplied.
 * @cli semantic-implementation.mjs
 * @command stage set
 */
export declare function setStage(options: SetStageOptions): void;

export interface RecordStageInsightOptions {
  /** Stage receiving the insight; omitted or `current` selects the only active stage. */
  stage?: string;
  /** Insight shape, which determines the required conditional fields. */
  kind: InsightKind;
  /** Stable identifier within the selected insight collection. */
  "item-id": string;
  /** Replaces an existing insight with the same identifier. */
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
 * @cli semantic-implementation.mjs
 * @command stage record
 */
export declare function recordStageInsight(
  options: RecordStageInsightOptions,
): void;

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
 * @cli semantic-implementation.mjs
 * @command stage organize
 */
export declare function organizeStage(options: OrganizeStageOptions): void;

export interface RecordValidationOptions {
  /** Stage receiving the validation evidence; omitted or `current` selects the only active stage. */
  stage?: string;
  /** Stable identifier for this validation evidence. */
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
 * @cli semantic-implementation.mjs
 * @command stage validation
 */
export declare function recordValidation(
  options: RecordValidationOptions,
): void;

export interface FinishStageOptions {
  /** Working stage to finalize; omitted or `current` selects the only active stage. */
  id?: string;
}

/**
 * Finalizes a working stage against the current stage branch head.
 * @cli semantic-implementation.mjs
 * @command stage finish
 */
export declare function finishStage(options: FinishStageOptions): void;

export interface DiscardStageOptions {
  /** Working stage to delete without reverting implementation files; omitted or `current` selects the only active stage. */
  id?: string;
}

/**
 * Deletes an unfinished working stage without reverting code changes.
 * @cli semantic-implementation.mjs
 * @command stage discard
 */
export declare function discardStage(options: DiscardStageOptions): void;

export interface RestackOptions {
  /** Earliest edited stage. Its recorded branch must be checked out. Mutually exclusive with `base`. */
  from?: string;
  /** Replacement trunk revision, usually the current target branch head. Mutually exclusive with `from`. */
  base?: string;
  /** Emits exact old and new revisions for every refreshed stage. */
  json?: true;
}

/**
 * Refreshes an edited stage branch and rebases every branch above it.
 * @cli semantic-implementation.mjs
 * @command restack
 */
export declare function restack(options: RestackOptions): void;

/**
 * Repairs unambiguous interrupted artifact mutations.
 * @cli semantic-implementation.mjs
 * @command repair
 */
export declare function repairArtifact(): void;

export interface PublishArtifactOptions {
  /** Metadata commit message. @defaultValue "Publish <implementation-id> semantic implementation" */
  message?: string;
}

/**
 * Commits validated semantic metadata to the metadata branch.
 * @cli semantic-implementation.mjs
 * @command publish
 */
export declare function publishArtifact(
  options?: PublishArtifactOptions,
): void;

export interface ValidateStackOptions {
  /** Emits machine-readable local stack information. */
  json?: true;
}

/**
 * Verifies stage branches and prints their local base chain.
 * @cli semantic-implementation.mjs
 * @command validate-stack
 */
export declare function validateStack(options?: ValidateStackOptions): void;

export interface PrepareBranchOptions {
  /** Local cumulative branch to create at the final reviewed stage head. */
  branch: string;
}

/**
 * Creates a local cumulative implementation branch without changing the worktree.
 * @cli semantic-implementation.mjs
 * @command prepare-branch
 */
export declare function prepareBranch(options: PrepareBranchOptions): void;

export interface ArchiveImplementationOptions {
  /** Repository-relative archive directory ending in `.semantic-review`. @defaultValue ".semantic-review-history/<implementation-id>/.semantic-review" */
  destination?: string;
  /** Archive commit message. @defaultValue "Archive <implementation-id> semantic implementation" */
  message?: string;
}

/**
 * Moves a merged and published implementation into repository history.
 * The target branch must be checked out, contain the final stage head, and have
 * a metadata branch that exactly matches the current artifact.
 * @cli semantic-implementation.mjs
 * @command archive
 */
export declare function archiveImplementation(options?: ArchiveImplementationOptions): void;

export interface ValidateArtifactOptions {
  /** Validates JSON schemas only and skips semantic and Git validation. */
  "schema-only"?: true;
  /** Applies the stricter completion and publication validation gate. */
  publish?: true;
}

/**
 * Validates schemas, references, dependencies, artifact state, and Git state.
 * `schema-only` and `publish` are mutually exclusive.
 * @cli semantic-implementation.mjs
 * @command validate
 */
export declare function validateArtifact(
  options?: ValidateArtifactOptions,
): void;

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
  /** Stage identifier for stage, insight, file, and line targets. */
  stage?: string;
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
export declare function addFeedbackThread(
  options: AddFeedbackThreadOptions,
): void;

export interface AddFeedbackThreadsOptions {
  /** JSON array of feedback thread inputs using the same fields as `thread add`. */
  threads: string;
}

/**
 * Adds several feedback threads as one locked and validated mutation.
 * No thread is kept when any input is invalid.
 * @cli review-feedback.mjs
 * @command thread add-batch
 */
export declare function addFeedbackThreads(
  options: AddFeedbackThreadsOptions,
): void;

export interface NextFeedbackOptions {
  /** Emits machine-readable JSON instead of text. */
  json?: true;
  /** Omits comment metadata and repeated revision data, reports staleness as a boolean, and emits minified JSON. Requires `json`. */
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
export declare function replyFeedbackThread(
  options: ReplyFeedbackThreadOptions,
): void;

export interface ReplyFeedbackThreadsOptions {
  /** JSON array of reply inputs using the same fields as `thread reply`. */
  replies: string;
}

/**
 * Appends several replies as one locked and validated mutation.
 * No reply is kept when any input is invalid.
 * @cli review-feedback.mjs
 * @command thread reply-batch
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
 * @cli review-feedback.mjs
 * @command thread resolve
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
 * @cli review-feedback.mjs
 * @command thread reopen
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
 * @cli review-feedback.mjs
 * @command validate
 */
export declare function validateFeedback(
  options?: ValidateFeedbackOptions,
): void;

export interface SelectSemanticFlowImplementationOptions {
  /** Repository or worktree used to discover linked semantic implementation artifacts. */
  project?: string;
  /** Selects one artifact by its implementation ID when several linked worktrees contain implementations. */
  "implementation-id"?: string;
}

export interface InspectSemanticFlowOptions {
  /** Repository or worktree used to discover linked semantic implementation artifacts. */
  project?: string;
  /** Selects one artifact by its implementation ID when several linked worktrees contain implementations. */
  "implementation-id"?: string;
  /** Emits machine-readable repository, candidate, and selected artifact details. */
  json?: true;
}

/**
 * Finds semantic implementation artifacts in the selected repository and its linked worktrees.
 * This command does not fail when no artifact exists.
 * @cli semantic-flow.mjs
 * @command inspect
 */
export declare function inspectSemanticFlow(
  options?: InspectSemanticFlowOptions,
): void;

export interface ValidateSemanticFlowOptions {
  /** Repository or worktree used to discover linked semantic implementation artifacts. */
  project?: string;
  /** Selects one artifact by its implementation ID when several linked worktrees contain implementations. */
  "implementation-id"?: string;
  /** Applies the stricter artifact publication validation gate. */
  publish?: true;
}

/**
 * Resolves one active artifact, validates it, and validates feedback when present.
 * @cli semantic-flow.mjs
 * @command validate
 */
export declare function validateSemanticFlow(
  options?: ValidateSemanticFlowOptions,
): void;

export interface SemanticFlowStatusOptions {
  /** Repository or worktree used to discover linked semantic implementation artifacts. */
  project?: string;
  /** Selects one artifact by its implementation ID when several linked worktrees contain implementations. */
  "implementation-id"?: string;
  /** Emits the complete machine-readable status snapshot. */
  json?: true;
}

/**
 * Reports lifecycle state, criterion coverage, evidence, feedback, metadata,
 * and validation results for one active semantic implementation.
 * @cli semantic-flow.mjs
 * @command status
 */
export declare function semanticFlowStatus(
  options?: SemanticFlowStatusOptions,
): void;

/**
 * Resolves one active artifact and launches its local review viewer.
 * @cli semantic-flow.mjs
 * @command review
 */
export declare function reviewSemanticFlow(
  options?: SelectSemanticFlowImplementationOptions,
): void;

export interface SemanticFlowFeedbackOptions {
  /** Repository or worktree used to discover linked semantic implementation artifacts. */
  project?: string;
  /** Selects one artifact by its implementation ID when several linked worktrees contain implementations. */
  "implementation-id"?: string;
  /** Emits a compact machine-readable preflight and pending-feedback snapshot. */
  json?: true;
}

/**
 * Resolves one active artifact, automatically restacks a clean finalized stack
 * after its target branch advances, validates it, and lists feedback awaiting
 * an agent reply. The result also reports the artifact worktree and local
 * changes.
 * @cli semantic-flow.mjs
 * @command feedback
 */
export declare function semanticFlowFeedback(
  options?: SemanticFlowFeedbackOptions,
): void;

export interface SemanticFlowVersionOptions {
  /** Emits machine-readable installed skill and format versions. */
  json?: true;
}

/**
 * Reports the installed skill, artifact format, and feedback format versions.
 * @cli semantic-flow.mjs
 * @command version
 */
export declare function semanticFlowVersion(
  options?: SemanticFlowVersionOptions,
): void;

export interface UpdateSemanticFlowOptions {
  /** Maintained semantic-code-review source repository. */
  source?: string;
  /** Builds the current source checkout without pulling; requires explicit approval for questionable source state. */
  "use-current-source"?: true;
}

/**
 * Safely updates source and rebuilds the skill without running the test suite,
 * then replaces the installed skill without changing target repository artifacts.
 * @cli semantic-flow.mjs
 * @command update
 */
export declare function updateSemanticFlow(
  options?: UpdateSemanticFlowOptions,
): void;
