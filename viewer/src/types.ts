// What the page holds beyond the wire types: the implementation as it is
// shown, with the diff pages loaded into it, and the shapes the page's modules
// pass between them.
import type {
  ApprovalRecord, DiffLine, DiffMode, DiffSide, DraftNote, FeedbackTargetKind, FeedbackThread, FileMembership, ImplementationData, InsightReviewRecord,
  LegacyDraftNote, NoteMode, ReplyDraft, ReviewState, Stage, StageFile,
} from "../../scripts/src/shared/viewer-protocol";
import type { UnusableNote } from "./stored-state";

/** A diff page asked for while another request for the same file runs. */
export interface QueuedDiff {
  offset: number;
  force: boolean;
  target: LineTarget | null;
  pageScroll: PageScroll | null;
  identity?: string;
}

/** A line a diff page must contain. */
export interface LineTarget {
  side: DiffSide;
  line: number;
}

/** Where a diff scrolls after a new page loads: to its end when paging backward. */
export interface PageScroll {
  direction: "forward" | "backward";
  nodeId: string | null;
}

/** A changed file as the page holds it: the server's file plus the diff page loaded for it. */
export interface ViewerFile extends StageFile {
  lines?: DiffLine[];
  _diffMode?: DiffMode;
  nextOffset?: number | null;
  _pageOffset?: number;
  truncated?: boolean;
  _diffLoading?: boolean;
  _diffError?: string;
  _queuedDiff?: QueuedDiff;
  /** The node owning each changed line ("old:<n>"/"new:<n>") of a split shared file; null when not split. */
  _ownership?: Map<string, string> | null;
}

export interface ViewerStage extends Stage {
  files: ViewerFile[];
}

/** The implementation the page shows. */
export interface ViewerData extends ImplementationData {
  stages: ViewerStage[];
}

/** A changed file of a stage, by its file ID `f:<stage>:<path>`. */
export interface FileEntry {
  id: string;
  stage: ViewerStage;
  file: ViewerFile;
}

/** A file in one of the nodes it belongs to, as a file approval key names it. */
export interface MembershipEntry extends FileEntry {
  nodeId: string;
  membership: FileMembership;
}

/** The element a note, draft or thread is attached to. A thread on a
 * specification or criterion has no element ID. */
export interface NoteTarget {
  kind: FeedbackTargetKind;
  id: string | undefined;
  stageId?: string;
  nodeId?: string | null;
}

/** A feedback thread as a note target, with the time its first comment was written. */
export interface ThreadNote extends NoteTarget {
  createdAt: string | undefined;
}

/** A saved note with its index in the review state's notes. */
export interface IndexedNote {
  c: Note;
  i: number;
}

/** A thread list held by a code selection: its key, the threads it shows and the latest ones. */
export interface HeldList {
  key: string;
  threads: FeedbackThread[];
  latest: FeedbackThread[];
}

/** A note or feedback draft saved in the review state, possibly by an older viewer. */
export type Note = DraftNote | LegacyDraftNote;

/** An entry of the review state's notes: a note, or a saved value the page keeps but cannot use. */
export type SavedNote = Note | UnusableNote;

/** The review state's named fields, without the keys older viewers wrote. */
type ReviewStateFields = { [K in keyof ReviewState as string extends K ? never : K]: ReviewState[K] };

/** The review state as the page holds it: the saved state with every field the
 * page keeps present, and the keys older viewers wrote kept as they were. */
export interface ViewerState extends Omit<ReviewStateFields, "comments"> {
  [legacyKey: string]: unknown;
  approvals: Record<string, ApprovalRecord | boolean>;
  insightReviews: Record<string, InsightReviewRecord>;
  /** Indexed by `ComposeDraft.editIndex` and sent feedback refs, so entries keep their places. */
  comments: SavedNote[];
  openStages: Record<string, boolean>;
  openThreads: Record<string, boolean>;
  lastNoteMode: NoteMode;
  specificationOpen: Record<string, boolean> | boolean;
  coverageOpen: boolean;
  notesOpen: boolean;
  pinnedInsight: unknown;
  hideApproved: boolean;
  fileView: Record<string, "hunk" | "full">;
  hideDeleted: Record<string, boolean>;
  wrapLines: boolean;
  markdownPreview: Record<string, boolean>;
  threadCollapsed: Record<string, boolean>;
  openLineThreads: Record<string, boolean>;
  activeFiles: Record<string, string | null | boolean>;
  approvalComparisons: Record<string, boolean>;
  notesFilter: "active" | "resolved";
  replyDrafts: ReplyDraft[];
}
