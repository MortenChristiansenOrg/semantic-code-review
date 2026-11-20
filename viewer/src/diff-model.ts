// The model of an open file's diff: its rows with their line notes, ownership
// and inline insights, the comparison with the approved content, and the
// Markdown preview.
import type { DiffLine, DiffSide, Insight } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { approvalState } from "./approval-state";
import { approvalComparisons, comparisonKey, fileViewMode, isMarkdown, loadApprovalComparison, markdownMode, markdownPreviews, markdownUrl, retainedApproval, sinceApprovalEnabled, type MarkdownPreview } from "./diffs";
import { compose } from "./editor";
import { insightTargetsLine } from "./insight-preview";
import { INSIGHT, vstatus } from "./insights";
import { activeFileNodeId, approvalEntry, artifactThreads, fileApprovalKey, fileKey, hunkOf, lineKey, membershipOwnership, newLineOf, nodeTitleById, oldLineOf } from "./lookups";
import { errorMessage, failureOf } from "./narrow";
import { render } from "./render";
import { state } from "./state";
import { lineListKey, lineThreadModel } from "./thread-models";
import { artifactThreadsForElement, selectedThreadLists, visibleThreadCount } from "./threads";
import type { FileEntry, MembershipEntry, ViewerFile, ViewerStage } from "./types";
import type { ComparisonInfoView, DiffBodyView, DiffContentView, DiffControlsView, DiffPanelView, DiffRowView, InlineInsightView, MarkdownPreviewView } from "./views/diff";
import { highlightCode, langFor, type CodeToken } from "./views/highlight";

/** What a diff's rows look up per line, and the owner and hunk of the row before. */
export interface DiffContext {
  stageId: string;
  path: string;
  fileId: string;
  diffNodeId: string;
  notedLines: Set<string>;
  insightsByLine: Map<number, InlineInsightView[]>;
  ownership?: Map<string, string> | null;
  focusNodeId?: string;
  previousOwner?: string | null;
  previousHunk?: number;
}

/** A source row before its line anchor is added. */
interface CodeRow {
  kind: string;
  old: string;
  new: string;
  sign: string;
  code: readonly CodeToken[];
}

// An insight linked to a line of an open diff; it opens beside the code.
export function inlineInsightModel(stage: ViewerStage, ins: Insight): InlineInsightView {
  const info = vstatus(ins) || INSIGHT[ins.type] || INSIGHT.decision;
  return { stageId: stage.id, collection: ins.collection, itemId: ins.id, type: ins.type, glyph: info.glyph, label: info.label,
    title: ins.title, needsReview: ins.codeTarget?.status === "needs-review" };
}

// Adds a code row and, when the file is diff-anchored (ctx present) and the
// row maps to a real line, the ownership notice and inline insights above it
// and its thread below it. The sign column doubles as the line's note
// affordance: a "+" on hover, or a bubble that toggles the line's thread.
export function pushCodeRow(out: DiffRowView[], row: CodeRow, ctx: DiffContext | null, side: DiffSide, lineNo: number | undefined): void {
  if (!ctx || !ctx.stageId || !lineNo) { out.push({ type: "code", key: `${row.kind}:${row.old}:${row.new}`, ...row, line: null }); return; }
  const lineId = lineKey(ctx.stageId, side, lineNo, ctx.path);
  // Most lines have no notes; only look up the ones that might.
  const noted = ctx.notedLines.has(lineId);
  const count = noted ? visibleThreadCount("line", lineId) : 0;
  const resolved = noted && !count && artifactThreadsForElement("line", lineId).some((t) => t.status === "resolved");
  // For a file split across steps, dim the lines owned by other steps so the
  // step currently in focus reads as this node's slice of the shared diff.
  let ownership = "";
  if (ctx.ownership && (side === "old" || side === "new")) {
    const owner = ctx.ownership.get(`${side}:${lineNo}`);
    if (owner) {
      ownership = ctx.focusNodeId ? owner === ctx.focusNodeId ? "own-focus" : "own-other" : "own-mark";
      if (ctx.focusNodeId && owner !== ctx.focusNodeId && ctx.previousOwner !== owner)
        out.push({ type: "owner", key: `owner:${lineId}`, lineId, nodeId: owner, title: nodeTitleById.get(`${ctx.stageId}:${owner}`) || owner });
      ctx.previousOwner = owner;
    } else ctx.previousOwner = null;
  }
  const linked = side === "new" ? ctx.insightsByLine.get(lineNo) : null;
  if (linked) out.push({ type: "insights", key: `insights:${lineId}`, insights: linked });
  out.push({ type: "code", key: lineId, ...row, line: { id: lineId, count, resolved, open: Boolean(state.openLineThreads[lineId]),
    ownership, insightTarget: insightTargetsLine(ctx, side, lineNo) } });
  // A selection holds the list it touches, so a thread a live update removed
  // stays until the selection clears.
  const thread = noted || compose?.id === lineId || (selectedThreadLists.size && selectedThreadLists.has(lineListKey(lineId))) ? lineThreadModel(lineId) : null;
  if (thread) out.push({ type: "thread", key: `thread:${lineId}`, thread });
}
// What a diff's rows look up per line, gathered once per diff: the lines that
// threads or local notes may be attached to, and the current inline insights
// by the new line they start on.
export function diffContext(entry: FileEntry, nodeId: string, extra: Partial<DiffContext> = {}): DiffContext {
  const notedLines = new Set(state.comments.filter((c) => c.kind === "line").map((c) => c.id));
  for (const t of artifactThreads) if (t.target?.kind === "line") notedLines.add(lineKey(t.target.stageId, t.target.side, t.target.line, t.target.path));
  const insightsByLine = new Map<number, InlineInsightView[]>();
  for (const ins of entry.stage.insights) {
    const target = ins.codeTarget;
    if (target?.status === "needs-review" || target?.path !== entry.file.path) continue;
    const start = target.startLine;
    insightsByLine.set(start, [...(insightsByLine.get(start) || []), inlineInsightModel(entry.stage, ins)]);
  }
  return { stageId: entry.stage.id, path: entry.file.path, fileId: entry.id, diffNodeId: nodeId, notedLines, insightsByLine, ...extra };
}
export function pushDiffRow(out: DiffRowView[], r: DiffLine, lang: string, ctx: DiffContext | null): void {
  if (ctx && ctx.previousHunk !== hunkOf(r)) { ctx.previousOwner = null; ctx.previousHunk = hunkOf(r); }
  const side = r.t === "del" ? "old" : "new";
  pushCodeRow(out, { kind: r.t, old: String(oldLineOf(r) || ""), new: String(newLineOf(r) || ""), sign: r.t === "add" ? "+" : r.t === "del" ? "−" : "",
    code: highlightCode(r.s || " ", lang) }, ctx, side, r.t === "del" ? oldLineOf(r) : newLineOf(r));
}
// Added and deleted files show their full contents once, as neutral lines.
export function pushWholeFileRow(out: DiffRowView[], r: DiffLine, lang: string, ctx: DiffContext | null, side: DiffSide): void {
  const o = oldLineOf(r), n = newLineOf(r);
  pushCodeRow(out, { kind: "newline", old: "", new: String(n || o || ""), sign: "", code: highlightCode(r.s || " ", lang) },
    ctx, side, side === "old" ? o || n : n || o);
}
export const gapRow = (count: number, key: number | string): DiffRowView => ({ type: "gap", key: `gap:${key}`, count });
export const diffMessage = (text: string, status = false): DiffContentView => ({ type: "message", text, status });
// Rows are keyed so an unchanged row keeps its element; keys stay unique even
// when a page repeats a line.
export function uniqueRowKeys(rows: DiffRowView[]): DiffRowView[] {
  const seen = new Set<string>();
  for (const row of rows) {
    let key = row.key;
    for (let n = 2; seen.has(key); n++) key = `${row.key}#${n}`;
    row.key = key; seen.add(key);
  }
  return rows;
}
export function diffContentModel(file: ViewerFile, mode: "full" | "hunk", hideDel: boolean, ctx: DiffContext): DiffContentView {
  if (file._diffError) return diffMessage(`Could not load diff: ${file._diffError}`);
  if (!Array.isArray(file.lines)) return diffMessage("Loading diff…");
  if (file.binary) return diffMessage("Binary file — not shown.");
  const lines = file.lines;
  if (!lines.length) return diffMessage("No line changes recorded for this file.");
  const lang = langFor(file.path);
  const out: DiffRowView[] = [];
  if (file.kind === "added") {
    out.push({ type: "banner", key: "banner", kind: "newfile", sign: "＋", text: "New file — full contents" });
    lines.forEach((r) => pushWholeFileRow(out, r, lang, ctx, "new"));
  } else if (file.kind === "deleted") {
    out.push({ type: "banner", key: "banner", kind: "oldfile", sign: "－", text: "Deleted file — previous contents" });
    lines.forEach((r) => pushWholeFileRow(out, r, lang, ctx, "old"));
  } else {
    const CTX = 3;
    const n = lines.length;
    const keep = new Array(n).fill(mode === "full");
    for (let i = 0; i < n; i++) {
      if (lines[i].t !== "ctx") {
        for (let j = Math.max(0, i - CTX); j <= Math.min(n - 1, i + CTX); j++) keep[j] = true;
      }
    }
    let oldNo: number | null = null, newNo: number | null = null, omitted = 0;
    for (let i = 0; i < n; i++) {
      const row = lines[i];
      // Git omits context between hunks. Track each side independently so
      // additions/deletions do not look like gaps when the other side resumes.
      const rowOld = oldLineOf(row), rowNew = newLineOf(row);
      const oldGap = oldNo != null && rowOld != null ? rowOld - oldNo - 1 : 0;
      const newGap = newNo != null && rowNew != null ? rowNew - newNo - 1 : 0;
      const gap = Math.max(0, oldGap, newGap);
      omitted += gap;
      if (oldNo != null) oldNo += gap;
      if (newNo != null) newNo += gap;
      if (rowOld != null) oldNo = rowOld;
      if (rowNew != null) newNo = rowNew;
      if (!keep[i]) { omitted++; continue; }
      if (omitted) { out.push(gapRow(omitted, i)); omitted = 0; }
      pushDiffRow(out, row, lang, ctx);
    }
    if (omitted) out.push(gapRow(omitted, "end"));
  }
  const offset = file._pageOffset || 0;
  const pager = file.nextOffset != null || offset > 0 ? { action: "diff-page", id: fileKey(ctx.stageId, file.path), offset, rows: lines.length,
    previousOffset: offset > 0 ? Math.max(0, offset - 900) : null, nextOffset: file.nextOffset ?? null } : null;
  return { type: "grid", grid: { hideRemoved: hideDel, rows: uniqueRowKeys(out), pager } };
}

export function markdownPreviewModel(entry: FileEntry): MarkdownPreviewView {
  const key = markdownUrl(entry);
  let preview = markdownPreviews.get(key);
  if (!preview) {
    const loading: MarkdownPreview = preview = { loading: true, entryId: entry.id };
    markdownPreviews.set(key, preview);
    // Open previews must survive cache pressure, including collapsed nodes.
    for (const [cachedKey, cached] of markdownPreviews) {
      if (markdownPreviews.size <= 12) break;
      if (cachedKey !== key && !(cached.entryId in state.activeFiles && state.markdownPreview[cached.entryId])) markdownPreviews.delete(cachedKey);
    }
    api.getFileContent(key).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not load Markdown.");
      if (!window.renderMarkdownPreview) throw new Error("Markdown renderer unavailable; reload the viewer.");
      // Sanitized by the Markdown module (DOMPurify, validated link and image URLs).
      loading.html = window.renderMarkdownPreview(result.content, (target, image) => markdownUrl(entry, target, image));
      loading.label = `Complete file · ${result.side === "base" ? "Base revision (deleted file)" : "Head revision"} ${result.revision.slice(0, 12)}`;
    }).catch((error) => { loading.error = errorMessage(error); }).finally(() => { loading.loading = false; render(); });
  }
  if (preview.loading) return { type: "loading" };
  if (preview.error) return { type: "error", message: preview.error };
  // A loaded preview has its label and HTML.
  return { type: "ready", label: preview.label ?? "", html: preview.html ?? "" };
}
export function diffControlsModel(entry: FileEntry): DiffControlsView {
  const k = entry.file.kind, id = fileApprovalKey(entry.stage.id, activeFileNodeId(entry.id), entry.file.path);
  const stale = approvalState(id) === "stale", since = sinceApprovalEnabled(id);
  return {
    fileId: entry.id, wrap: Boolean(state.wrapLines),
    view: since || !["added", "deleted"].includes(k) ? { full: fileViewMode(entry.id) === "full", hideRemoved: Boolean(state.hideDeleted[entry.id]) } : null,
    comparison: stale ? { approvalId: id, on: since } : null,
    markdown: isMarkdown(entry) ? { preview: markdownMode(entry) } : null,
  };
}

export function approvalComparisonModel(id: string, entry: MembershipEntry): DiffBodyView {
  const approval = retainedApproval(id);
  const plain = (text: string): DiffBodyView => ({ comparison: null, content: diffMessage(text) });
  if (!approval?.snapshotId) return plain("Approved content is unavailable. Re-approve the current file to retain a snapshot.");
  const key = comparisonKey(id, entry), comparison = approvalComparisons.get(key);
  if (!comparison) { queueMicrotask(() => { if (sinceApprovalEnabled(id)) void loadApprovalComparison(id, entry); }); return plain("Loading approved comparison…"); }
  if ("loading" in comparison) return plain("Loading approved comparison…");
  if ("error" in comparison) return plain(comparison.error);
  const info: ComparisonInfoView = { approvalId: id, ownershipChanged: Boolean(comparison.ownershipChanged),
    baseChanges: !comparison.baseChanged ? null : comparison.baseChanges === "excluded" || comparison.baseChanges === "included" ? comparison.baseChanges : "mixed" };
  if (comparison.unsupported) return { comparison: info, content: { type: "unsupported", text: comparison.unsupported,
    approvedSha: comparison.approved.sha256 || "Not retained", currentSha: comparison.current.sha256 || "Not retained" } };
  if (!comparison.lines.length) return { comparison: info, content: diffMessage(comparison.baseChanges === "excluded"
    ? "This stage made no changes to the file since approval. Only its base changed." : "No file content changes since approval.") };
  // Only current lines have a feedback anchor. A removed row's number belongs to
  // the approved snapshot, not to the stage's old side, so it gets no affordance.
  const ctx = diffContext(entry, entry.nodeId);
  const lang = langFor(entry.file.path);
  const rows: DiffRowView[] = []; let previousNew = 0;
  comparison.lines.forEach((row, index) => {
    const rowNew = newLineOf(row);
    if (previousNew && rowNew !== undefined && rowNew > previousNew + 1) rows.push(gapRow(rowNew - previousNew - 1, index));
    pushDiffRow(rows, row, lang, row.t === "del" ? null : ctx);
    if (rowNew) previousNew = rowNew;
  });
  const offset = comparison.offset || 0;
  const pager = offset || comparison.nextOffset != null ? { action: "approval-page", id, offset, rows: comparison.lines.length,
    previousOffset: offset ? Math.max(0, offset - 900) : null, nextOffset: comparison.nextOffset ?? null } : null;
  return { comparison: info, content: { type: "grid", grid: { hideRemoved: Boolean(state.hideDeleted[entry.id]), rows: uniqueRowKeys(rows), pager } } };
}
// The diff of a file opened in the step `nodeId`.
export function diffPanelModel(entry: FileEntry, nodeId: string): DiffPanelView {
  const ctx = diffContext(entry, nodeId, { ownership: membershipOwnership(entry.file), focusNodeId: nodeId });
  const approvalId = fileApprovalKey(entry.stage.id, nodeId, entry.file.path);
  const sinceApproval = sinceApprovalEnabled(approvalId);
  // The step's membership of the file, which its row is shown for.
  const approvalTarget = sinceApproval ? approvalEntry(approvalId) : null;
  const preview = markdownMode(entry);
  return {
    path: entry.file.path, kind: entry.file.kind, wrap: Boolean(state.wrapLines), sinceApproval,
    controls: diffControlsModel(entry),
    // The source rows stay rendered under a Markdown preview, so line drafts survive switching.
    body: approvalTarget ? approvalComparisonModel(approvalId, approvalTarget)
      : { comparison: null, content: diffContentModel(entry.file, fileViewMode(entry.id), Boolean(state.hideDeleted[entry.id]), ctx) },
    preview: preview ? markdownPreviewModel(entry) : null,
  };
}
