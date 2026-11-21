// Live updates: polling the server for a new revision and adopting the
// implementation it sends without reloading the page.
import type { ImplementationData, ViewerSnapshot } from "../../scripts/src/shared/viewer-protocol";
import { adoptAgentStatus, agent, roundNotice } from "./agent";
import * as api from "./api";
import { approvalOps, reconcileApprovals } from "./approval-state";
import { data } from "./context";
import { compose, rememberDraftSnapshot } from "./editor";
import { exportWorking } from "./feedback-actions";
import { rebuildFileSearchIndex, refreshFileSearch } from "./file-search-dialog";
import { allAcceptance, artifactThreads, fileBaseRevision, fileById, fileByPreviousId, fileKey, flatFiles, nodeTitleById, requirements, stageById, stageNumberById } from "./lookups";
import { render } from "./render";
import { markReviewEnded } from "./saved-reviews";
import { flushReviewState, reviewEnded, reviewEndOf, state } from "./state";
import { errorMessage, failureOf } from "./narrow";
import { threadOps, usableNotes } from "./threads";

/** Counts completed local feedback writes; a poll response requested before one is out of date. */
let feedbackWrites = 0;
export function adoptViewerSnapshot(snapshot: Partial<ViewerSnapshot> | undefined): void {
  feedbackWrites += 1;
  // A local feedback write changes what the page shows, so no server
  // revision is fully shown any more; the next poll fetches again, even if
  // another session has since returned the server to the revision loaded.
  selectionRevision = notShown;
  if (!snapshot || typeof snapshot.revision !== "string") return;
  adoptAgentStatus(snapshot.agent);
}

export let polling = false;
export let refreshNotice = "";
export function setRefreshNotice(text: string): void { refreshNotice = text; }
export let refreshingRemote = false;


export let lastHiddenPoll = 0;
// The latest server revision a poll handled while a code selection deferred the
// full implementation (see below), notShown after a local feedback write
// (the page then matches no server revision), and null once the page shows
// data.viewerRevision.
export const notShown = Symbol("not shown");
export let selectionRevision: string | typeof notShown | null = null;
export const codeSelected = (): boolean => Boolean(window.getSelection()?.toString()) && !document.activeElement?.matches("input, textarea");
// Feedback anchors to stage revisions, so it may only join a diff from the same revisions.
export const diffRevisions = (implementation: ImplementationData): string => JSON.stringify((implementation.stages || []).map((stage) =>
  [stage.id, stage.baseRevision, stage.headRevision, (stage.files || []).map((file) => [file.path, file.baseRevision || null])]));
export async function pollViewerRevision(): Promise<void> {
  if (reviewEnded || polling) return;
  // Hidden tabs keep checking slowly while an agent listens or works, so a finished round can notify.
  if (document.hidden && (!(agent?.working || agent?.listening) || Date.now() - lastHiddenPoll < 5000)) return;
  if (document.hidden) lastHiddenPoll = Date.now();
  polling = true;
  try {
    const response = await api.getRevision();
    if (!response.ok) {
      const failure = await response.json();
      const end = reviewEndOf(failureOf(failure));
      if (end) markReviewEnded(end, true);
      return;
    }
    const snapshot = await response.json();
    if (!snapshot.ok) return;
    // Once the selection clears, a deferred implementation is adopted whatever the revision now is.
    const handled = selectionRevision === null ? snapshot.revision === data.viewerRevision
      : selectionRevision !== notShown && snapshot.revision === selectionRevision && codeSelected();
    if (handled) { adoptAgentStatus(snapshot.agent); return; }
    // Let local feedback writes finish before adopting a server snapshot.
    if (approvalOps.size || exportWorking() || Object.values(threadOps).some((op) => op?.busy)) return;
    const writesBefore = feedbackWrites;
    const nextResponse = await api.getImplementation();
    if (!nextResponse.ok) return;
    const payload = await nextResponse.json();
    if (!payload.ok || payload.implementation.implementationId !== data.implementationId) return;
    // A feedback write that finished meanwhile may be missing from this response; the next poll fetches again.
    if (feedbackWrites !== writesBefore) return;
    if (approvalOps.size || exportWorking() || Object.values(threadOps).some((op) => op?.busy)) return;
    // A code selection must not prevent an open conversation from refreshing.
    // Keep metadata aligned with the visible diff until the selection clears:
    // adopt only the threads, so rendering leaves the selected code rows alone,
    // and only while the stage revisions match the shown diff (a restack waits).
    // Leave viewerRevision unchanged so the first poll after it still adopts the
    // full snapshot; until then this revision is not fetched again, and only
    // changed feedback renders, as each render closes an open tooltip.
    // Thread lists the selection runs through keep what they show (see heldThreads).
    const feedback = payload.implementation.feedback || [];
    if (codeSelected()) {
      // Record the revision of the data adopted; the server may have moved on since the probe.
      selectionRevision = payload.implementation.viewerRevision;
      if (diffRevisions(payload.implementation) === diffRevisions(data) && JSON.stringify(feedback) !== JSON.stringify(artifactThreads)) {
        artifactThreads.splice(0, artifactThreads.length, ...feedback);
        if (!roundNotice) refreshNotice = "Review updated";
        render();
      }
    } else {
      selectionRevision = null;
      adoptImplementation(payload.implementation);
      if (!roundNotice) refreshNotice = "Review updated";
      render();
    }
    adoptAgentStatus(snapshot.agent);
  } catch {
    // External artifact writes can be transient; retry without replacing good data.
  } finally { polling = false; }
}

export async function refreshRemote(): Promise<void> {
  refreshingRemote = true; refreshNotice = ""; render();
  try {
    await flushReviewState();
    const response = await api.refreshRemote();
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(failureOf(result).error || "Could not refresh the remote branch.");
    await pollViewerRevision();
    refreshNotice = "Remote branch refreshed";
  } catch (error) { refreshNotice = `Refresh failed: ${errorMessage(error)}`; }
  finally { refreshingRemote = false; render(); }
}

export function adoptImplementation(next: ImplementationData): void {
  usableNotes().filter((note) => !note.exported).forEach(rememberDraftSnapshot);
  if (compose) rememberDraftSnapshot(compose);
  const previousFiles = new Map(fileById);
  Object.assign(data, next);
  nodeTitleById.clear(); stageById.clear(); stageNumberById.clear();
  fileById.clear(); fileByPreviousId.clear(); flatFiles.length = 0;
  data.stages.forEach((stage, index) => {
    stageById.set(stage.id, stage); stageNumberById.set(stage.id, index + 1);
    stage.nodes.forEach((node) => nodeTitleById.set(`${stage.id}:${node.id}`, node.title));
    stage.files.forEach((file) => {
      const id = fileKey(stage.id, file.path);
      const previous = previousFiles.get(id);
      if (previous && fileBaseRevision(previous) === (file.baseRevision || stage.baseRevision) && previous.stage.headRevision === stage.headRevision && previous.file.revision === file.revision && previous.file.kind === file.kind && Array.isArray(previous.file.lines)) {
        file.lines = previous.file.lines; file._diffMode = previous.file._diffMode;
        file.nextOffset = previous.file.nextOffset; file._pageOffset = previous.file._pageOffset;
      }
      const entry = { id, stage, file };
      flatFiles.push(entry); fileById.set(id, entry);
      if (file.previousPath) fileByPreviousId.set(fileKey(stage.id, file.previousPath), entry);
    });
  });
  rebuildFileSearchIndex();
  refreshFileSearch?.();
  requirements.splice(0, requirements.length, ...(data.requirements || []));
  allAcceptance.splice(0, allAcceptance.length, ...requirements.flatMap((r) => (r.acceptance || []).map((a) => ({ ...a, reqId: r.id, ref: `${r.id}#${a.id}` }))));
  artifactThreads.splice(0, artifactThreads.length, ...(data.feedback || []));
  reconcileApprovals();
}
