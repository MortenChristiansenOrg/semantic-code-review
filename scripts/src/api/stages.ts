import type { InsightKind, DecisionCategory, ValidationType, ValidationStatus, EvidenceKind } from "./shared.js";

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
 * @cli semantic-flow.mjs
 * @command implementation stage begin
 */
export declare function beginStage(options: BeginStageOptions): void;

export interface SetStageOptions {
  /** Stage to update; omitted or `current` selects the only active stage. Required with `finalized`. */
  id?: string;
  /** Updates a finalized stage instead of the active working stage. */
  finalized?: true;
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
 * Updates stage metadata on the active working stage or, with `finalized`, on a finalized stage.
 * At least one field to update must be supplied. A finalized stage's commit
 * message takes a new title or summary at the next restack that covers it.
 * @cli semantic-flow.mjs
 * @command implementation stage set
 */
export declare function setStage(options: SetStageOptions): void;

export interface RecordStageInsightOptions {
  /** Optional code link, captured from the committed stage head; requires code-start. */
  "code-path"?: string;
  /** First line of the code target (one-based). */
  "code-start"?: string;
  /** Last line, inclusive; defaults to code-start. */
  "code-end"?: string;

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
 * @cli semantic-flow.mjs
 * @command implementation stage record
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
 * their changed hunks or line ranges. With `finalized`, a corrected stage is
 * recorded at its new head, folded into one stage commit.
 * @cli semantic-flow.mjs
 * @command implementation stage organize
 */
export declare function organizeStage(options: OrganizeStageOptions): void;

export interface RecordValidationOptions {
  /** Optional code link, captured from the committed stage head; requires code-start. */
  "code-path"?: string;
  /** First line of the code target (one-based). */
  "code-start"?: string;
  /** Last line, inclusive; defaults to code-start. */
  "code-end"?: string;

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
 * @cli semantic-flow.mjs
 * @command implementation stage validation
 */
export declare function recordValidation(
  options: RecordValidationOptions,
): void;

export interface RecordEvidenceOptions {
  /** Optional code link, captured from the committed stage head; requires code-start. */
  "code-path"?: string;
  /** First line of the code target (one-based). */
  "code-start"?: string;
  /** Last line, inclusive; defaults to code-start. */
  "code-end"?: string;

  /** Stage receiving the evidence; omitted or `current` selects the only active stage. */
  stage?: string;
  /** Stable identifier for this evidence. */
  "item-id": string;
  /** What the evidence is. Prefer screenshot or recording when the change has visible output. */
  kind: EvidenceKind;
  /** What the evidence demonstrates. */
  summary: string;
  /** File to copy into the artifact, as `path` or `path=caption`. */
  file?: readonly string[];
  /** Capture of the earlier behavior for a before/after comparison, as `path` or `path=caption`. */
  before?: readonly string[];
  /** Capture of the new behavior for a before/after comparison, as `path` or `path=caption`. */
  after?: readonly string[];
  /** Small textual evidence stored in the stage document, such as terminal output. */
  inline?: string;
  /** How to reproduce the capture: a URL, command, or steps. */
  reproduction?: string;
  /** Acceptance criteria this evidence supports; each must be addressed by the stage. */
  "specification-ref"?: readonly string[];
  /** Change nodes relevant to this evidence. */
  "node-ref"?: readonly string[];
  /** Replaces evidence with the same identifier and removes its unused files. */
  replace?: true;
  /** Updates a finalized stage instead of the active working stage. */
  finalized?: true;
}

/**
 * Records a capture from exercising the committed stage head. Requires the stage branch checked out and a clean worktree.
 * @cli semantic-flow.mjs
 * @command implementation stage evidence
 */
export declare function recordEvidence(options: RecordEvidenceOptions): void;

export interface RemoveEvidenceOptions {
  /** Stage holding the evidence; omitted or `current` selects the only active stage. */
  stage?: string;
  /** Evidence identifier. */
  "item-id": string;
  /** Updates a finalized stage instead of the active working stage. */
  finalized?: true;
}

/**
 * Removes evidence and its unused files, for example a capture containing sensitive data.
 * @cli semantic-flow.mjs
 * @command implementation stage evidence-remove
 */
export declare function removeEvidence(options: RemoveEvidenceOptions): void;

export interface RecordNoEvidenceOptions {
  /** Stage to update; omitted or `current` selects the only active stage. */
  stage?: string;
  /** Why evidence is not feasible, such as a pure refactor. */
  reason?: string;
  /** Clears a recorded reason. */
  remove?: true;
  /** Updates a finalized stage instead of the active working stage. */
  finalized?: true;
}

/**
 * Records why a stage has no evidence, or clears that reason.
 * @cli semantic-flow.mjs
 * @command implementation stage no-evidence
 */
export declare function recordNoEvidence(options: RecordNoEvidenceOptions): void;

export interface FinishStageOptions {
  /** Emits the finalized stage snapshot and next action as JSON. */
  json?: true;
  /** Working stage to finalize; omitted or `current` selects the only active stage. */
  id?: string;
}

/**
 * Finalizes a working stage against the current stage branch head, folding the
 * stage's commits into one commit whose message is the stage title and summary,
 * with the other authors of the folded commits as co-authors.
 * @cli semantic-flow.mjs
 * @command implementation stage finish
 */
export declare function finishStage(options: FinishStageOptions): void;

export interface DiscardStageOptions {
  /** Working stage to delete without reverting implementation files; omitted or `current` selects the only active stage. */
  id?: string;
}

/**
 * Deletes an unfinished working stage without reverting code changes.
 * @cli semantic-flow.mjs
 * @command implementation stage discard
 */
export declare function discardStage(options: DiscardStageOptions): void;

export interface RemoveStageOptions {
  /** Emits the rebuilt stages, kept items, resolved threads and dependency changes as JSON. */
  json?: true;
  /** Finalized empty stage to remove. */
  id: string;
  /** Implementation the stage belongs to; refused when this worktree works on another one. */
  "implementation-id"?: string;
}

/**
 * Removes a finalized stage that changes nothing, such as one a restack or a
 * correction emptied. The stages above it are rebuilt on the stage below with
 * unchanged content, and its branch is deleted in the same transaction. Its
 * document, with its insights and evidence, is kept under `removed-stages/`,
 * and its ID cannot be reused. Refused while a thread on the stage is not
 * resolved; its resolved threads stay readable but can no longer be replied to
 * or reopened. Refused for the only stage, with a pending restack or a working
 * stage, while its branch is checked out in another worktree, and while a Git
 * operation such as a merge, cherry-pick, rebase or bisect is in progress in
 * this worktree with the stage's branch or a rebuilt head checked out.
 * @cli semantic-flow.mjs
 * @command implementation stage remove
 */
export declare function removeStage(options: RemoveStageOptions): void;


export interface RecordStageBatchOptions {
  /** Stage to update; omitted selects the active working stage. */
  stage?: string;
  /** Updates a finalized stage; requires its explicit ID. */
  finalized?: true;
  /** JSON array of insight options or validation options with kind=validation, excluding stage/finalized. */
  items: string;
}
/** Atomically records multiple observed insights and validation evidence for one stage.
 * @cli semantic-flow.mjs
 * @command implementation stage record-batch
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
 * @cli semantic-flow.mjs
 * @command implementation stage plan
 */
export declare function organizationPlan(options?: OrganizationPlanOptions): void;

export interface TargetInsightOptions {
  /** Omitted or current selects the active working stage. */
  stage?: string;
  /** Target a finalized stage by explicit ID. */
  finalized?: true;
  /** Insight collection, validation, or evidence. */
  collection: "decisions" | "assumptions" | "alternatives" | "failedAttempts" | "risks" | "openQuestions" | "validation" | "evidence";
  /** Existing insight identifier. */
  "item-id": string;
  /** Remove the optional link while preserving the insight. */
  remove?: true;
  /** Optional code link, captured from the committed stage head; requires code-start. */
  "code-path"?: string;
  /** First line of the code target (one-based). */
  "code-start"?: string;
  /** Last line, inclusive; defaults to code-start. */
  "code-end"?: string;
}
/** Attach or retarget after reviewing an insight against committed code, or remove its link.
 * @cli semantic-flow.mjs
 * @command implementation stage target
 */
export declare function targetInsight(options: TargetInsightOptions): void;
