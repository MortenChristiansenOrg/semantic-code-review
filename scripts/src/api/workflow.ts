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
  /** Includes the validated local branch chain without another validation call. */
  stack?: true;
  /** Emits the validated worktree, stage revisions, and working stage IDs as JSON. */
  json?: true;
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

export interface PrepareSemanticFlowOptions {
  /** Emits the prepared worktree and validated stack as JSON. */
  json?: true;
  /** Repository or artifact worktree; defaults to the current repository. */
  project?: string;
  /** Selects an implementation across linked worktrees. */
  "implementation-id"?: string;
  /** Optional cumulative branch; omit to prepare the existing stage stack. */
  branch?: string;
}

/** Validates artifact and resolved feedback once, publishes metadata, and prepares local refs.
 * @cli semantic-flow.mjs
 * @command prepare
 */
export declare function prepareSemanticFlow(options?: PrepareSemanticFlowOptions): void;

export interface ArchiveSemanticFlowOptions {
  /** Repository or artifact worktree; defaults to the current repository. */
  project?: string;
  /** Selects an implementation across linked worktrees. */
  "implementation-id"?: string;
  /** Emits the archived implementation and validated stack as JSON. */
  json?: true;
}

/** Validates landed artifact and resolved feedback, then archives on the target branch.
 * @cli semantic-flow.mjs
 * @command archive
 */
export declare function archiveSemanticFlow(options?: ArchiveSemanticFlowOptions): void;
