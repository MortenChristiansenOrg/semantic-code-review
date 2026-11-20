// Loading what an open file shows: its diff pages, its comparison with the
// approved content, and its Markdown preview.
import type { ApprovalComparisonResponse, ApprovalRecord, DiffMode, DiffQuery } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { approvalEndpoint, approvalRecord, approvalState, previousApprovalId, remotePreviousApprovalId, revisionFor } from "./approval-state";
import { fileSearchFileChanged } from "./file-search-dialog";
import { activeFileNodeId, fileBaseRevision, fileById } from "./lookups";
import { cinemaHolder, fileRowElement } from "./navigation";
import { render } from "./render";
import { errorMessage, failureOf } from "./narrow";
import { flushReviewState, state } from "./state";
import type { FileEntry, LineTarget, MembershipEntry, PageScroll, QueuedDiff } from "./types";

/** A file compared with its approved content. */
export type ApprovalComparison = Extract<ApprovalComparisonResponse, { ok: true }>;
/** A comparison page: loading, failed, or loaded. */
export type ComparisonPage = { loading: true; offset: number } | { error: string; offset: number } | ApprovalComparison;
export const approvalComparisons = new Map<string, ComparisonPage>();
// Files whose comparison also shows base changes; each visit starts with the stage's changes alone.
export const approvalBaseIncluded = new Set<string>();

/** A Markdown file's preview: loading, then its rendered HTML or an error. */
export interface MarkdownPreview {
  loading: boolean;
  entryId: string;
  html?: string;
  label?: string;
  error?: string;
}
export const markdownPreviews = new Map<api.FileContentJsonUrl, MarkdownPreview>();

// The revisions and view mode a diff page is requested for.
export const diffIdentity = (entry: FileEntry): string => JSON.stringify([fileBaseRevision(entry), entry.stage.headRevision, entry.file.revision,
  fileViewMode(entry.id) === "full" ? "full" : "changes"]);
export const diffRequests = new Map<string, Promise<void>>();
// An open file shows its diff once loaded. Run after each render, so a file
// opened, restored with the review, or adopted without its lines loads the
// diff its rendered row now waits for; the load renders again when done.
export function loadOpenDiffs(): void {
  Object.keys(state.activeFiles).forEach((fid) => {
    const entry = fileById.get(fid);
    if (!entry || !activeFileNodeId(fid) || !fileRowElement(fid)) return;
    if (!Array.isArray(entry.file.lines) && !entry.file._diffLoading && !entry.file._diffError) ensureFileDiff(entry);
  });
}
export async function ensureFileDiff(entry: FileEntry | null | undefined, offset = 0, force = false, target: LineTarget | null = null, pageScroll: PageScroll | null = null): Promise<void> {
  if (!entry) return;
  if (diffRequests.has(entry.id)) {
    if (target || force) entry.file._queuedDiff = { offset, force, target, pageScroll, identity: diffIdentity(entry) };
    return;
  }
  const mode: DiffMode = fileViewMode(entry.id) === "full" ? "full" : "changes";
  if (!force && !offset && Array.isArray(entry.file.lines) && entry.file._diffMode === mode) return;
  entry.file._diffLoading = true;
  delete entry.file._diffError;
  const page = {
    stage: entry.stage.id,
    path: entry.file.path,
    base: fileBaseRevision(entry),
    head: entry.stage.headRevision,
    mode, offset: String(offset),
  };
  const query: DiffQuery = target ? { ...page, side: target.side, line: String(target.line) } : page;
  const identity = diffIdentity(entry);
  // A live update replaces the file objects while a page loads, and the
  // reviewer may switch the view mode. The response, or its error, belongs to
  // the file that now holds the path if it is still the requested base, head,
  // file revision and mode; otherwise it is stale.
  const currentFile = () => {
    const current = fileById.get(entry.id);
    return current && diffIdentity(current) === identity ? current.file : null;
  };
  let pageLoaded = false, stale = false;
  const request = api.getDiff(query)
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(failureOf(payload).error || `Diff request failed with status ${response.status}.`);
      }
      if (!Array.isArray(payload.lines)) {
        throw new Error("Diff response did not include lines.");
      }
      const file = currentFile();
      if (!file) { stale = true; return; }
      const additions = Number(payload.additions) || 0, deletions = Number(payload.deletions) || 0, binary = Boolean(payload.binary);
      const shownChanged = file.additions !== additions || file.deletions !== deletions || Boolean(file.binary) !== binary;
      file.lines = payload.lines;
      file._diffMode = mode;
      file._pageOffset = payload.offset ?? offset;
      file.nextOffset = payload.nextOffset;
      file.additions = additions;
      file.deletions = deletions;
      file.binary = binary;
      file.truncated = Boolean(payload.truncated);
      delete file._ownership;
      if (shownChanged) fileSearchFileChanged?.(file);
      pageLoaded = true;
    })
    .catch((error) => {
      const file = currentFile();
      if (file) file._diffError = errorMessage(error) || "Diff could not be loaded.";
      else stale = true;
    })
    .finally(() => {
      const current = fileById.get(entry.id), file = current?.file;
      entry.file._diffLoading = false;
      if (file) file._diffLoading = false;
      diffRequests.delete(entry.id);
      let queued: QueuedDiff | null | undefined = file?._queuedDiff || entry.file._queuedDiff;
      delete entry.file._queuedDiff;
      if (file) delete file._queuedDiff;
      // A queued page belongs to the revisions and mode it was asked for; a
      // request for a line asks again for that line, and a page is dropped.
      if (queued && (!current || queued.identity !== diffIdentity(current)))
        queued = queued.target ? { offset: 0, force: true, target: queued.target, pageScroll: null } : null;
      // A stale request for a line asks again for that line in the current file.
      if (!queued && stale && target) queued = { offset: 0, force: true, target, pageScroll: null };
      if (queued) ensureFileDiff(current, queued.offset, queued.force, queued.target, queued.pageScroll);
      render();
      if (pageLoaded && pageScroll && !queued) scrollDiffPage(entry.id, pageScroll);
    });
  diffRequests.set(entry.id, request);
}

/* ---- diff panel ------------------------------------------------------- */
export function fileViewMode(id: string): "full" | "hunk" { return state.fileView[id] === "full" ? "full" : "hunk"; }

// Diff view controls: mode toggle + hide-removed. Added/deleted files render
// their full contents once, so neither control applies to them.
export function sinceApprovalEnabled(id: string): boolean { return approvalState(id) === "stale" && state.approvalComparisons[id] !== false; }
export function isMarkdown(entry: FileEntry): boolean { return /\.(md|markdown)$/i.test(entry.file.path); }
export function markdownMode(entry: FileEntry): boolean { return isMarkdown(entry) && Boolean(state.markdownPreview[entry.id]); }
/** The URL of a Markdown file's content as JSON; with a target, of the raw
 * resource it links, or null when the link leaves the repository. */
export function markdownUrl(entry: FileEntry): api.FileContentJsonUrl;
export function markdownUrl(entry: FileEntry, target: string, image?: boolean): string | null;
export function markdownUrl(entry: FileEntry, target?: string | null, image = false): string | null {
  const query = { stage: entry.stage.id, path: entry.file.path, base: fileBaseRevision(entry), head: entry.stage.headRevision };
  if (target == null) return api.fileContentJsonUrl(query);
  const filePath = entry.file.kind === "deleted" ? entry.file.previousPath || entry.file.path : entry.file.path;
  try {
    const root = new URL("https://repository.invalid/");
    const resolved = new URL(target, new URL(filePath.split("/").map(encodeURIComponent).join("/"), root));
    if (resolved.origin !== root.origin) return null;
    return api.fileContentUrl({ ...query, target: decodeURIComponent(resolved.pathname.slice(1)), raw: "1", ...(image ? { image: "1" } : {}) }, resolved.hash);
  } catch { return null; }
}

export function retainedApproval(id: string): ApprovalRecord | null {
  return approvalRecord(id) || approvalRecord(previousApprovalId(id) || "") || approvalRecord(remotePreviousApprovalId(id) || "");
}
export function comparisonKey(id: string, entry: FileEntry): string {
  return JSON.stringify([id, retainedApproval(id)?.snapshotId, fileBaseRevision(entry), entry.stage.headRevision, revisionFor(id), fileViewMode(entry.id), approvalBaseIncluded.has(id)]);
}
export function scrollDiffPage(id: string, navigation: PageScroll): void {
  // A response may arrive after this shared file was opened in another node.
  if (activeFileNodeId(id) !== navigation.nodeId) return;
  const scroller = cinemaHolder(id, navigation.nodeId)?.querySelector(".diff-scroll");
  if (scroller) scroller.scrollTop = navigation.direction === "backward" ? scroller.scrollHeight : 0;
}
export async function loadApprovalComparison(id: string, entry: MembershipEntry, offset = 0, pageScroll: PageScroll | null = null): Promise<void> {
  const approval = retainedApproval(id);
  if (!approval?.snapshotId) return;
  // The key and the request share one scope, even if the reviewer changes it during the flush.
  const key = comparisonKey(id, entry), mode = fileViewMode(entry.id) === "full" ? "full" : "changes";
  const scope = approvalBaseIncluded.has(id) ? "all" : "stage";
  const current = approvalComparisons.get(key);
  if (current && "loading" in current) return;
  approvalComparisons.set(key, { loading: true, offset }); render();
  let pageLoaded = false;
  try {
    await flushReviewState();
    const response = await api.compareApproval({ ...approvalEndpoint(entry), snapshotId: approval.snapshotId, offset, mode, scope });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not compare approved content.");
    approvalComparisons.set(key, result);
    pageLoaded = true;
  } catch (error) { approvalComparisons.set(key, { error: errorMessage(error), offset }); }
  for (const oldest of approvalComparisons.keys()) {
    if (approvalComparisons.size <= 32) break;
    approvalComparisons.delete(oldest);
  }
  render();
  if (pageLoaded && pageScroll && comparisonKey(id, entry) === key && sinceApprovalEnabled(id))
    scrollDiffPage(entry.id, pageScroll);
}
