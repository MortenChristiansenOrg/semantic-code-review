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
  | "node"
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
