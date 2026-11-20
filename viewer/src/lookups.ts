// Keys of the page's elements and indexes over the implementation it shows,
// rebuilt when a live update adopts a new implementation.
import type { AcceptanceCriterion, ChangeNode, DiffLine, DiffSide, FeedbackThread, Requirement } from "../../scripts/src/shared/viewer-protocol";
import { data } from "./context";
import { selectedNodeForFile } from "./files";
import { state } from "./state";
import type { FileEntry, MembershipEntry, ViewerFile, ViewerStage } from "./types";

/* ---- ids & lookups ---------------------------------------------------- */
// Feedback targets may lack a part of the key; it then reads "undefined", as before.
type KeyPart = string | number | undefined;
export const fileKey = (stageId: KeyPart, path: KeyPart): string => `f:${stageId}:${path}`;
export const fileApprovalKey = (stageId: string, nodeId: string | null, path: string): string => `m:${JSON.stringify([stageId, nodeId, path])}`;
/** The file and node a file approval key names, while the node still owns part of the file. */
export function approvalEntry(id: string): MembershipEntry | null {
  if (!id.startsWith("m:")) return null;
  try {
    const parts: unknown = JSON.parse(id.slice(2));
    if (!Array.isArray(parts)) return null;
    const [stageId, nodeId, path] = parts;
    if (typeof stageId !== "string" || typeof nodeId !== "string" || typeof path !== "string") return null;
    const entry = fileById.get(fileKey(stageId, path));
    if (!entry) return null;
    const membership = entry.file.memberships?.find((item) => item.nodeId === nodeId);
    return membership ? { ...entry, nodeId, membership } : null;
  } catch { return null; }
}
export function stageFileApprovals(stage: ViewerStage): string[] {
  return stage.nodes.flatMap((node) => nodeFileList(stage, node).map((file) => fileApprovalKey(stage.id, node.id, file.path)));
}
export const insightKey = (stageId: KeyPart, collection: KeyPart, itemId: KeyPart): string =>
  `i:${stageId}:${collection}:${itemId}`;
export function parseInsightKey(id: string | null | undefined): { stageId: string; collection: string; itemId: string } | null {
  const m = /^i:([^:]+):([^:]+):([^:]+)$/.exec(id || "");
  return m ? { stageId: m[1], collection: m[2], itemId: m[3] } : null;
}
export const insightByKey = (id: string) => {
  const key = parseInsightKey(id);
  return key && stageById.get(key.stageId)?.insights.find((item) => item.collection === key.collection && item.id === key.itemId);
};
// A line thread's element id carries everything needed to resolve a feedback
// target: the stage, which diff side the line lives on, its line number, and
// the file path (kept last so paths with no colons parse unambiguously).
export const lineKey = (stageId: KeyPart, side: KeyPart, line: KeyPart, path: KeyPart): string => `l:${stageId}:${side}:${line}:${path}`;
export interface LineId {
  stageId: string;
  side: DiffSide;
  line: number;
  path: string;
}
export function parseLineId(id: string | null | undefined): LineId | null {
  const m = /^l:([^:]+):(old|new):(\d+):([^]+)$/.exec(id || "");
  if (!m) return null;
  return { stageId: m[1], side: m[2] === "old" ? "old" : "new", line: Number(m[3]), path: m[4] };
}
export const nodeTitleById = new Map<string, string>();
data.stages.forEach((s) => s.nodes.forEach((n) => nodeTitleById.set(`${s.id}:${n.id}`, n.title)));
export const stageById = new Map(data.stages.map((stage) => [stage.id, stage]));
export const stageNumberById = new Map(data.stages.map((stage, i) => [stage.id, i + 1]));
/** The stage with an ID a target may lack. */
export const stageOf = (id: string | null | undefined): ViewerStage | undefined => id == null ? undefined : stageById.get(id);
/** The file with an ID a target may lack. */
export const fileOf = (id: string | null | undefined): FileEntry | undefined => id == null ? undefined : fileById.get(id);

export const requirements: Requirement[] = Array.isArray(data.requirements) ? data.requirements : [];
/** An acceptance criterion with the specification it belongs to. */
export interface AcceptanceEntry extends AcceptanceCriterion {
  reqId: string;
  ref: string;
}
// Criterion ids are only unique within a specification, so every acceptance
// criterion is keyed by its full `<specificationId>#<criterionId>` ref.
export const allAcceptance: AcceptanceEntry[] = requirements.flatMap((r) =>
  (r.acceptance || []).map((a) => ({ ...a, reqId: r.id, ref: `${r.id}#${a.id}` })));

export const flatFiles: FileEntry[] = [];
data.stages.forEach((stage) => stage.files.forEach((file) => {
  flatFiles.push({ id: fileKey(stage.id, file.path), stage, file });
}));
export const fileById = new Map(flatFiles.map((f) => [f.id, f]));

export const fileBaseRevision = (entry: FileEntry): string => entry.file.baseRevision || entry.stage.baseRevision;

// A renamed file no longer answers to its old path, but feedback anchored
// before the rename still targets that old path. Index the pre-rename path so
// such a thread can resolve to the file at its new destination.
export const fileByPreviousId = new Map<string, FileEntry>(
  flatFiles
    .filter((f) => f.file.previousPath)
    .map((f) => [fileKey(f.stage.id, f.file.previousPath), f]),
);
// Resolve a stage-scoped path to the file entry that currently holds it,
// following a rename when the path was the file's pre-rename name.
export function currentFileEntry(stageId: KeyPart, p: KeyPart): FileEntry | null {
  return fileById.get(fileKey(stageId, p)) || fileByPreviousId.get(fileKey(stageId, p)) || null;
}

/** A diff row's line number on the old side, or on the new side; undefined where it has none. */
export const oldLineOf = (row: DiffLine): number | undefined => row.t === "add" ? undefined : row.o;
export const newLineOf = (row: DiffLine): number | undefined => row.t === "del" ? undefined : row.n;

/** Whether the diff renders a row for `line` on `side`: a removed row for the
 * old side, any other row for the new side, as diff rows take their line IDs. */
export function fileHasLine(file: ViewerFile, side: DiffSide | undefined, line: number | undefined): boolean {
  return (file.lines || []).some((row) => side === "old" ? row.t === "del" && row.o === line : newLineOf(row) === line);
}

export function nodeFileList(stage: ViewerStage, node: ChangeNode): ViewerFile[] {
  return stage.files.filter((file) => file.memberships.some((m) => m.nodeId === node.id));
}
export function activeFileNodeId(id: string): string | null {
  const entry = fileById.get(id);
  return entry ? selectedNodeForFile(state.activeFiles[id], entry.file) : null;
}

export function classificationFor(file: ViewerFile, nodeId: string): string {
  const m = file.memberships.find((x) => x.nodeId === nodeId) || file.memberships[0];
  // A classification this viewer does not know arrives absent and is shown neutrally.
  return m ? m.classification || "unclassified" : "behavior";
}
// When a file is split across nodes, resolve which node owns each changed
// line (keyed "old:<n>"/"new:<n>") from the membership hunk or line-range
// selectors. Whole-file members carry no selector and are ignored; returns
// null unless the file is genuinely shared and split.
export function membershipOwnership(file: ViewerFile): Map<string, string> | null {
  if (file._ownership !== undefined) return file._ownership;
  const all = file.memberships || [];
  const split = all.filter(
    (m) => (m.hunks && m.hunks.length) || (m.lineRanges && m.lineRanges.length),
  );
  if (all.length < 2 || split.length === 0) { file._ownership = null; return null; }
  const lines = file.lines || [];
  const map = new Map<string, string>();
  split.forEach((m) => {
    if (m.hunks && m.hunks.length) {
      const set = new Set(m.hunks);
      lines.forEach((r) => {
        if ((r.t === "add" || r.t === "del") && r.h !== undefined && set.has(r.h)) {
          const side = r.t === "del" ? "old" : "new";
          map.set(`${side}:${r.t === "del" ? r.o : r.n}`, m.nodeId);
        }
      });
    } else {
      (m.lineRanges || []).forEach((rg) => {
        (["old", "new"] as const).forEach((side) => {
          const span = rg[side];
          if (!span) return;
          for (let ln = span.start; ln <= span.end; ln += 1) map.set(`${side}:${ln}`, m.nodeId);
        });
      });
    }

  });
  file._ownership = map.size ? map : null;
  return file._ownership;
}
// A short description of the current node's slice of a shared file, shown on
// the file row's "shared" chip: hunk numbers or old/new line ranges.
export function ownershipHint(file: ViewerFile, nodeId: string): string {
  const m = (file.memberships || []).find((x) => x.nodeId === nodeId);
  if (!m) return "";
  if (m.hunks && m.hunks.length) return `hunk${m.hunks.length === 1 ? "" : "s"} ${m.hunks.join(", ")}`;
  if (m.lineRanges && m.lineRanges.length) {
    return m.lineRanges
      .map((rg) => {
        const parts: string[] = [];
        if (rg.new) parts.push(`new ${rg.new.start}–${rg.new.end}`);
        if (rg.old) parts.push(`old ${rg.old.start}–${rg.old.end}`);
        return parts.join(" · ");
      })
      .join(", ");
  }
  return "";
}

/* ---- artifact feedback threads (from window.SEMANTIC_IMPLEMENTATION.feedback) -- */
export const artifactThreads: FeedbackThread[] = Array.isArray(data.feedback) ? [...data.feedback] : [];
export function artifactThreadById(tid: string | null | undefined): FeedbackThread | undefined {
  return tid ? artifactThreads.find((t) => t.id === tid) : undefined;
}
/** A diff row's hunk in the zero-context diff; undefined for context rows and where unknown. */
export const hunkOf = (row: DiffLine): number | undefined => row.t === "ctx" ? undefined : row.h;
