/** TypeScript shapes of the artifact and feedback documents. They mirror the
 * JSON schemas in standard/v0.1 and scripts/schemas by hand: the schemas use
 * if/then, not and anyOf constraints that generated types do not model
 * faithfully. Values only acquire these types through schema validation
 * (see schema-validation.ts). Keep both in step when a schema changes. */

export const MANIFEST_SCHEMA_ID = "https://semantic-code-review.dev/schemas/v0.1/manifest.schema.json";
export const SPECIFICATION_SCHEMA_ID = "https://semantic-code-review.dev/schemas/v0.1/specification.schema.json";
export const STAGE_SCHEMA_ID = "https://semantic-code-review.dev/schemas/v0.1/stage.schema.json";
export const WORK_STAGE_SCHEMA_ID = "https://semantic-code-review.dev/skills/semantic-flow/v0.1/work-stage.schema.json";
export const STAGE_ORGANIZATION_SCHEMA_ID = "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json";
export const FEEDBACK_MANIFEST_SCHEMA_ID = "https://semantic-code-review.dev/schemas/feedback/v0.1/manifest.schema.json";
export const THREAD_SCHEMA_ID = "https://semantic-code-review.dev/schemas/feedback/v0.1/thread.schema.json";

const FEEDBACK_ID_PATTERN = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The feedback schema's identifier rule (feedback common.schema.json $defs/id).
 * Thread IDs name files, so check one before building a path from it. */
export function isFeedbackId(id: string): boolean {
  return id.length <= 80 && FEEDBACK_ID_PATTERN.test(id);
}

// --- Implementation artifact (standard/v0.1/schema) ---

export interface ImplementationManifest {
  $schema: typeof MANIFEST_SCHEMA_ID;
  formatVersion: "0.1";
  skillVersion?: string;
  implementationId: string;
  title: string;
  summary: string;
  baseRevision: string;
  targetBranch: string;
  branchPrefix: string;
  requirements: string[];
  stages: string[];
}

export interface SpecificationSource {
  kind: string;
  reference: string;
  /** Required when kind is "url". */
  url?: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface Specification {
  $schema: typeof SPECIFICATION_SCHEMA_ID;
  id: string;
  title: string;
  summary: string;
  source: SpecificationSource;
  acceptanceCriteria: AcceptanceCriterion[];
}

export const CLASSIFICATIONS = ["behavior", "refactor", "test", "documentation", "configuration", "dependency", "migration", "generated", "chore", "trivial"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export interface LineSpan {
  start: number;
  end: number;
}

/** At least one side is present. */
export type LineRange = { old: LineSpan; new?: LineSpan } | { old?: LineSpan; new: LineSpan };

/** A node owns a whole file, selected hunks, or selected line ranges, never hunks and ranges together. */
export type NodeFileChange =
  | { path: string; classification: Classification; hunks?: number[]; lineRanges?: undefined }
  | { path: string; classification: Classification; hunks?: undefined; lineRanges?: LineRange[] };

export interface ChangeNode {
  id: string;
  description: string;
  changes: NodeFileChange[];
}

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

/** previousPath is present exactly for renames. */
export type FileChange =
  | { path: string; kind: "added" | "modified" | "deleted"; previousPath?: undefined }
  | { path: string; kind: "renamed"; previousPath: string };

export interface CodeTarget {
  path: string;
  revision: string;
  blobId: string;
  startLine: number;
  endLine: number;
  contextStartLine: number;
  context: string[];
}

interface InsightBase {
  id: string;
  nodeRefs?: string[];
  codeTarget?: CodeTarget;
}

export interface Decision extends InsightBase {
  category: "specification" | "engineering";
  summary: string;
  rationale: string;
}

export interface Assumption extends InsightBase {
  statement: string;
  riskIfWrong: string;
}

export interface Alternative extends InsightBase {
  approach: string;
  reasonRejected: string;
}

export interface FailedAttempt extends InsightBase {
  approach: string;
  outcome: string;
  lesson: string;
}

export interface Risk extends InsightBase {
  summary: string;
  mitigation?: string;
}

export type ValidationType = "automated" | "manual" | "analysis";
export type ValidationStatus = "passed" | "failed" | "not-run";

/** Automated validation names its command. */
export type ValidationEvidence = InsightBase & { status: ValidationStatus; summary: string } & (
  | { type: "automated"; command: string }
  | { type: "manual" | "analysis"; command?: string }
);

export const EVIDENCE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "text/plain", "text/csv", "text/markdown", "application/json", "application/pdf"] as const;
export type EvidenceMediaType = (typeof EVIDENCE_MEDIA_TYPES)[number];

export interface EvidenceAttachment {
  path: string;
  mediaType: EvidenceMediaType;
  sha256: string;
  caption?: string;
  role?: "before" | "after";
}

export type EvidenceKind = "screenshot" | "recording" | "terminal" | "http" | "log" | "output-file" | "measurement" | "report";

/** Evidence carries attachments, inline text, or both. */
export type Evidence = InsightBase & {
  kind: EvidenceKind;
  summary: string;
  specificationRefs?: string[];
  capturedAt: string;
  reproduction?: string;
} & ({ attachments: EvidenceAttachment[]; inline?: string } | { attachments?: EvidenceAttachment[]; inline: string });

export interface OpenQuestion extends InsightBase {
  question: string;
}

export const INSIGHT_COLLECTIONS = ["decisions", "assumptions", "alternatives", "failedAttempts", "risks", "validation", "evidence", "openQuestions"] as const;
export type InsightCollection = (typeof INSIGHT_COLLECTIONS)[number];

/** Items of each insight collection while a stage is being worked on. */
export interface InsightItems {
  decisions: Decision;
  assumptions: Assumption;
  alternatives: Alternative;
  failedAttempts: FailedAttempt;
  risks: Risk;
  validation: ValidationEvidence;
  evidence: Evidence;
  openQuestions: OpenQuestion;
}
export type InsightItem = InsightItems[InsightCollection];

/** Finalized stages link every insight to nodes. */
export type Linked<T> = T & { nodeRefs: string[] };

export type StageCollections<Linking extends "linked" | "unlinked"> = {
  [K in InsightCollection]: Linking extends "linked" ? Linked<InsightItems[K]>[] : InsightItems[K][];
};

export interface StageChange {
  branch: string;
  baseBranch: string;
  baseRevision: string;
  headRevision: string;
  files: FileChange[];
}

interface StageBase {
  id: string;
  title: string;
  summary: string;
  dependsOn: string[];
  specificationRefs: string[];
  nodes: ChangeNode[];
  rationale: string;
  noEvidenceReason?: string;
}

/** A finalized stage. */
export interface Stage extends StageBase, StageCollections<"linked"> {
  $schema: typeof STAGE_SCHEMA_ID;
  change: StageChange;
}

// --- Semantic Flow working documents (scripts/schemas) ---

/** A stage still being implemented; nodes and node links may be incomplete. */
export interface WorkStage extends StageBase, StageCollections<"unlinked"> {
  $schema: typeof WORK_STAGE_SCHEMA_ID;
  branch: string;
}

export interface ItemLink {
  collection: InsightCollection;
  itemId: string;
  nodeRefs: string[];
}

export interface StageOrganization {
  $schema: typeof STAGE_ORGANIZATION_SCHEMA_ID;
  nodes: ChangeNode[];
  itemLinks: ItemLink[];
}

// --- Feedback (standard/v0.1/feedback-schema) ---

export interface FeedbackManifest {
  $schema: typeof FEEDBACK_MANIFEST_SCHEMA_ID;
  formatVersion: "0.1";
  implementationId: string;
  threads: string[];
}

export interface FeedbackAttachment {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  path: string;
}

export type CommentAuthor = "user" | "agent";

/** A comment has a nonblank body, attachments, or both. */
export interface Comment {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  /** Agent replies only: the latest user comment this reply answers. */
  respondsTo?: string;
  attachments?: FeedbackAttachment[];
}

export type TargetKind = "specification" | "criterion" | "stage" | "node" | "insight" | "file" | "line";

/** Every target field is allowed for every kind; each kind requires its own subset. */
interface TargetFields {
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
  side?: "old" | "new";
  line?: number;
}

interface StageAnchor {
  stageId: string;
  stageBranch: string;
  stageHead: string;
}

export type SpecificationTarget = TargetFields & { kind: "specification"; specificationId: string };
export type CriterionTarget = TargetFields & { kind: "criterion"; specificationId: string; criterionId: string };
export type StageTarget = TargetFields & StageAnchor & { kind: "stage" };
export type NodeTarget = TargetFields & StageAnchor & { kind: "node"; nodeId: string };
export type InsightTarget = TargetFields & StageAnchor & { kind: "insight"; collection: InsightCollection; itemId: string };
export type FileTarget = TargetFields & StageAnchor & { kind: "file"; path: string };
export type LineTarget = TargetFields & StageAnchor & { kind: "line"; path: string; side: "old" | "new"; line: number };

export type Target = SpecificationTarget | CriterionTarget | StageTarget | NodeTarget | InsightTarget | FileTarget | LineTarget;
export type StageScopedTarget = StageTarget | NodeTarget | InsightTarget | FileTarget | LineTarget;

interface ThreadFields {
  $schema: typeof THREAD_SCHEMA_ID;
  id: string;
  comments: Comment[];
  target: Target;
  assignedStageId: string;
  stageHead: string;
  createdAt: string;
}

/** A resolved thread records when it was resolved. */
export type Thread = ThreadFields & ({ status: "open"; resolvedAt?: string } | { status: "resolved"; resolvedAt: string });
