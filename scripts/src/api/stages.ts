import type { InsightKind, DecisionCategory, ValidationType, ValidationStatus } from "./shared.js";

export interface BeginStageOptions {
  /** Emits stage branch, immutable revisions, worktree, and next action as JSON. */
  json?: true;
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
  /** Emits the finalized stage snapshot and next action as JSON. */
  json?: true;
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


export interface RecordStageBatchOptions {
  /** Stage to update; omitted selects the active working stage. */
  stage?: string;
  /** Updates a finalized stage; requires its explicit ID. */
  finalized?: true;
  /** JSON array of insight options or validation options with kind=validation, excluding stage/finalized. */
  items: string;
}
/** Atomically records multiple observed insights and validation evidence for one stage.
 * @cli semantic-implementation.mjs
 * @command stage record-batch
 */
export declare function recordStageBatch(options: RecordStageBatchOptions): void;

export interface OrganizationPlanOptions {
  /** Stage to inspect; omitted selects the active working stage. */
  stage?: string;
  /** Inspects the checked-out finalized stage instead. */
  finalized?: true;
  /** Includes ordered zero-context hunk coordinates for shared-file ownership. */
  selectors?: true;
}
/** Emits the current committed file inventory, revisions, and unlinked item IDs as JSON.
 * @cli semantic-implementation.mjs
 * @command stage plan
 */
export declare function organizationPlan(options?: OrganizationPlanOptions): void;
