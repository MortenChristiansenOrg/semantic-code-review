// Approvals of files, steps and stages: whether each still holds for the
// implementation as it now stands, and the changes the reviewer makes to them.
import type { ApprovalEndpoint, ApprovalRecord, ChangeNode } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { aggregateApprovalState, type ApprovalState } from "./approvals";
import { data } from "./context";
import { activeFileNodeId, approvalEntry, fileApprovalKey, fileBaseRevision, flatFiles, nodeFileList, stageById, stageFileApprovals, stageOf } from "./lookups";
import { errorMessage, failureOf, isRecord } from "./narrow";
import { render } from "./render";
import { markReviewEnded } from "./saved-reviews";
import { endedElsewhere, persist, persistedState, reviewEnded, reviewEndOf, saveError, saveState, saveTimer, state } from "./state";
import type { MembershipEntry, ViewerFile, ViewerStage } from "./types";

/** Approval changes in progress, by approval ID. */
export const approvalOps = new Map<string, Promise<void>>();

export const approvalErrors = new Map<string, string>();
/** Approvals the end of the review cut off before they were saved, by approval ID:
 * what each approved, which the notice of the ended review lists. */
export const approvalsNotSaved = new Map<string, string>();
/** Thrown when the review ended before an approval was saved. */
class ApprovalCutOff extends Error {}
/** What each approval change not saved when another tab or session ended the
 * review changed: those the end cut off while they were made, and those made
 * but not saved yet, such as stage approvals and removals, which only schedule
 * a save that the end cancels. */
export function unsavedApprovalChanges(): string[] {
  const labels = new Map(approvalsNotSaved);
  if (!endedElsewhere) return [...labels.values()];
  const saved = isRecord(persistedState.approvals) ? persistedState.approvals : {};
  for (const id of new Set([...Object.keys(saved), ...Object.keys(state.approvals)])) {
    if (labels.has(id) || JSON.stringify(saved[id]) === JSON.stringify(state.approvals[id])) continue;
    // A record moved on from a file's previous path names nothing shown.
    const label = approvalEntry(id)?.file.path ?? stageById.get(id)?.title;
    if (label) labels.set(id, Object.hasOwn(state.approvals, id) ? label : `${label} (approval removed)`);
  }
  return [...labels.values()];
}

/* ---- helpers ---------------------------------------------------------- */
/* File approvals are scoped to a node and observe the complete file plus its ownership.
   Changes outside owned ranges conservatively make that approval stale too. */
export function revisionFor(id: string): string | null {
  const entry = approvalEntry(id);
  if (!entry?.file.revision) return null;
  const m = entry.membership;
  // An unknown classification keys the approval as recorded, as it did before the server narrowed it.
  return JSON.stringify([entry.file.revision, m.classification ?? m.recordedClassification, m.hunks || null, m.lineRanges || null]);
}
export function approvalRevision(rec: ApprovalRecord): string | null {
  // Older approvals included the base commit, although the file revision
  // already identifies both sides of the diff. Preserve their ownership key.
  try {
    const parts: unknown = JSON.parse(String(rec.rev));
    if (Array.isArray(parts) && parts.length === 5) return JSON.stringify([parts[0], ...parts.slice(2)]);
  } catch { /* Unknown records remain stale. */ }
  return rec.rev;
}
export function approvalEndpoint(entry: MembershipEntry): ApprovalEndpoint {
  return { stageId: entry.stage.id, nodeId: entry.nodeId, path: entry.file.path,
    baseRevision: fileBaseRevision(entry), headRevision: entry.stage.headRevision, fileRevision: entry.file.revision, ownership: structuredClone(entry.membership) };
}
/** The approval of `id` as the server last saved it. */
function storedApproval(id: string): unknown {
  const approvals = persistedState.approvals;
  return isRecord(approvals) ? approvals[id] : undefined;
}
export function changeApproval(id: string, kind: string | undefined): Promise<void> | undefined {
  if (approvalOps.has(id)) return;
  const stage = kind === "stage" ? stageById.get(id) : null;
  if (stage && !stageNodesApproved(stage)) return;
  const entry = approvalEntry(id), rev = revisionFor(id), previousId = previousApprovalId(id);
  if (!stage && !rev) return;
  const remove = approvalState(id) === "approved";
  const operation = Promise.resolve().then(async () => {
    try {
      let snapshotId: string | undefined;
      if (entry && !remove) {
        const response = await api.captureApprovalSnapshot(approvalEndpoint(entry));
        const retained = await response.json();
        if (!response.ok || !retained.ok) {
          const failure = failureOf(retained), end = reviewEndOf(failure);
          if (end) { markReviewEnded(end, true); throw new ApprovalCutOff(); }
          throw new Error(failure.error || "Could not retain approved content.");
        }
        snapshotId = retained.snapshotId;
        // The review ended while the content was retained; nothing saves it now.
        if (reviewEnded) throw new ApprovalCutOff();
      }
      if (previousId) delete state.approvals[previousId];
      if (remove) delete state.approvals[id];
      else {
        state.approvals[id] = { rev, at: Date.now(), ...(entry ? {
          ...approvalEndpoint(entry), snapshotId,
        } : {}) } satisfies ApprovalRecord;
        delete state.approvalComparisons[id];
      }
      approvalErrors.delete(id);
      if (previousId) approvalErrors.delete(previousId);
      persist();
      if (entry && !remove) {
        // An older save may already be in flight. Wait until this approval
        // is stored before collapsing its diff; a failed save leaves it open.
        const stored = () => JSON.stringify(storedApproval(id)) === JSON.stringify(state.approvals[id]);
        do {
          clearTimeout(saveTimer);
          await saveState();
          // A review that ended saves nothing more.
          if (reviewEnded && !stored()) throw new ApprovalCutOff();
          if (saveError) throw new Error(saveError);
        } while (!stored());
        // A review that ended after the save shows no diff to collapse.
        if (reviewEnded) return;
        if (activeFileNodeId(entry.id) === entry.nodeId) {
          delete state.activeFiles[entry.id];
          persist();
        }
      }
    } catch (error) {
      if (error instanceof ApprovalCutOff || reviewEnded) approvalsNotSaved.set(id, entry?.file.path || stage?.title || id);
      else approvalErrors.set(id, `${entry?.file.path || id}: ${errorMessage(error)}`);
    }
    finally { approvalOps.delete(id); reconcileApprovals(); render(); }
  });
  approvalOps.set(id, operation); render();
  return operation;
}
// Approvals follow the implementation they were given for. Run whenever the
// implementation or the approvals change: when the viewer starts, adopts a
// snapshot, or finishes an approval change.
export function reconcileApprovals(): void {
  retainApprovalRenames();
  revokeInvalidStageApprovals();
}
// Retain each observed rename edge by moving the reference, never the captured endpoint.
export function retainApprovalRenames(): void {
  let changed = false;
  for (const { stage, file } of flatFiles) for (const membership of file.memberships || []) {
    const id = fileApprovalKey(stage.id, membership.nodeId, file.path), previousId = previousApprovalId(id);
    const previousError = previousId ? approvalErrors.get(previousId) : undefined;
    if (previousId && previousError !== undefined) {
      if (!approvalErrors.has(id)) approvalErrors.set(id, previousError);
      approvalErrors.delete(previousId);
    }
    if (!approvalRecord(id) && previousId && approvalRecord(previousId)) {
      state.approvals[id] = state.approvals[previousId]; delete state.approvals[previousId]; changed = true;
    }
  }
  if (changed) persist();
}
export function previousApprovalId(id: string): string | null {
  const entry = approvalEntry(id);
  return entry?.file.kind === "renamed" && entry.file.previousPath
    ? fileApprovalKey(entry.stage.id, entry.nodeId, entry.file.previousPath) : null;
}
// Commit IDs change after an amend/rebase. The newest occurrence can still use
// the reviewer's last full-file sign-off, while historical approvals stay put.
export function remotePreviousApprovalId(id: string): string | null {
  const entry = approvalEntry(id);
  if (!data.remote || !entry?.stage.id.startsWith("commit-") || entry.nodeId !== "changes") return null;
  const index = flatFiles.findIndex((item) => item.id === entry.id);
  if (flatFiles.slice(index + 1).some((item) => item.file.path === entry.file.path || item.file.previousPath === entry.file.path)) return null;
  const paths = [entry.file.path, entry.file.previousPath, ...(entry.file.previousPaths || [])].filter((path): path is string => Boolean(path));
  // Only valid records pass the filter, so each one sorted has a time.
  const savedAt = (key: string) => approvalRecord(key)?.at ?? 0;
  return Object.keys(state.approvals).filter((key) => {
    if (key === id || !key.startsWith("m:")) return false;
    try {
      const parts: unknown = JSON.parse(key.slice(2));
      if (!Array.isArray(parts)) return false;
      const [stageId, nodeId, filePath] = parts;
      const saved = approvalRecord(key);
      return typeof stageId === "string" && stageId.startsWith("commit-") && nodeId === "changes" && typeof filePath === "string" && paths.includes(filePath) &&
        saved?.snapshotId && saved.stageId === stageId && saved.nodeId === nodeId && saved.path === filePath;
    } catch { return false; }
  }).sort((a, b) => savedAt(b) - savedAt(a))[0] || null;
}
export function approvalRecord(id: string): ApprovalRecord | null {
  const rec = state.approvals[id];
  if (!rec || typeof rec !== "object" || !Number.isFinite(rec.at)) return null;
  if (id.startsWith("m:")) return typeof rec.rev === "string" && rec.rev.length > 0 ? rec : null;
  return stageById.has(id) && rec.rev === null ? rec : null;
}
export function approvalState(id: string): ApprovalState {
  const rec = approvalRecord(id);
  if (rec) {
    if (id.startsWith("m:")) return approvalRevision(rec) === revisionFor(id) && rec.path === approvalEntry(id)?.file.path ? "approved" : "stale";
    return "approved";
  }
  // An approval inherited from before a rename can never still match the file
  // as it stands now, so surface it as stale to prompt a fresh look.
  const prevId = previousApprovalId(id);
  if (prevId && approvalRecord(prevId) || remotePreviousApprovalId(id)) return "stale";
  return "none";
}
export const approved = (id: string): boolean => approvalState(id) === "approved";
export function nodeApprovalState(stage: ViewerStage, node: ChangeNode): ApprovalState {
  return aggregateApprovalState(
    nodeFileList(stage, node).map((file) => approvalState(fileApprovalKey(stage.id, node.id, file.path))),
  );
}
export function stageNodesApproved(stage: ViewerStage): boolean {
  return stage.nodes.every((node) => nodeApprovalState(stage, node) === "approved");
}
export function stageApprovalState(stage: ViewerStage): ApprovalState {
  return stageNodesApproved(stage) ? approvalState(stage.id) : "none";
}
export function stageApproved(stage: ViewerStage): boolean {
  return stageApprovalState(stage) === "approved";
}
export function revokeInvalidStageApprovals(): void {
  let changed = false;
  data.stages.forEach((stage) => {
    if (state.approvals[stage.id] && !stageNodesApproved(stage)) {
      delete state.approvals[stage.id];
      changed = true;
    }

  });
  if (changed) persist();
}

export function acceptanceStatus(ref: string): { key: "uncovered" | "approved" | "pending"; stages: number[] } {
  const stages = data.stages
    .map((s, i) => ({ s, i }))
    .filter((x) => (x.s.specificationRefs || []).includes(ref));
  if (!stages.length) return { key: "uncovered", stages: [] };
  // An empty stage has nothing to approve, so it holds no criterion back.
  const allApproved = stages.every((x) => x.s.empty || stageApproved(x.s));
  return { key: allApproved ? "approved" : "pending", stages: stages.map((x) => x.i + 1) };
}

/** The stages with something to approve: every stage but the empty ones. */
export const approvableStages = (): ViewerStage[] => data.stages.filter((s) => !s.empty);
export function reviewable(): number {
  let n = 0;
  approvableStages().forEach((s) => { n += 1 + s.nodes.length + stageFileApprovals(s).length; });
  return n;
}
export function approvedCount(): number {
  let n = 0;
  approvableStages().forEach((s) => {
    if (stageApproved(s)) n += 1;
    s.nodes.forEach((node) => { if (nodeApprovalState(s, node) === "approved") n += 1; });
    stageFileApprovals(s).forEach((key) => { if (approved(key)) n += 1; });
  });
  return n;
}
export const pct = (): number => reviewable() ? Math.round((approvedCount() / reviewable()) * 100) : 0;

// A group's unapproved or stale file approvals that can be captured now.
export function groupPendingApprovals(stage: ViewerStage, node: ChangeNode, files: ViewerFile[]): string[] {
  return files.map((f) => fileApprovalKey(stage.id, node.id, f.path))
    .filter((id) => !approved(id) && revisionFor(id) && !approvalOps.has(id));
}
export function approveGroup(stageId: string | undefined, nodeId: string | undefined, group: string | undefined): Promise<unknown> | undefined {
  const stage = stageOf(stageId), node = stage?.nodes.find((n) => n.id === nodeId);
  if (!stage || !node) return;
  const files = nodeFileList(stage, node).filter((f) => (f.project || "Other") === group);
  return Promise.all(groupPendingApprovals(stage, node, files).map((id) => changeApproval(id, "file")));
}
