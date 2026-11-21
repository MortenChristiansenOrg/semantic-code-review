import fs from "node:fs";
import path from "node:path";
import { FEEDBACK_MANIFEST_SCHEMA_ID, THREAD_SCHEMA_ID } from "./documents.js";
import { readDocument } from "./schema-validation.js";

/** How every command that reports on the stack counts finalized stages: all of
 * them, naming the marked empty ones. Stack preparation skips an empty stage,
 * but it stays a finalized stage of the implementation. */
export function describeFinalizedStages(count: number, emptyStages: readonly string[]): string {
  const empty = emptyStages.length ? ` (${emptyStages.length} empty: ${emptyStages.join(", ")})` : "";
  return `${count} finalized stage(s)${empty}`;
}

/** The marked empty stages of a stack, in stage order. */
export function emptyStageIds(stages: Iterable<{ id: string; change: { files: readonly unknown[] } }>): string[] {
  return [...stages].filter((stage) => stage.change.files.length === 0).map((stage) => stage.id);
}

/** The feedback threads on each of the stages: those assigned to it or
 * targeting it, split into resolved threads and the others, which are open.
 * Reads the feedback stored at feedbackRoot; a review without feedback has none. */
export function stageThreads(feedbackRoot: string, stageIds: readonly string[]): Map<string, { open: string[]; resolved: string[] }> {
  const result = new Map<string, { open: string[]; resolved: string[] }>();
  for (const id of stageIds) result.set(id, { open: [], resolved: [] });
  const manifest = path.join(feedbackRoot, "manifest.json");
  if (!fs.existsSync(manifest)) return result;
  for (const id of readDocument(FEEDBACK_MANIFEST_SCHEMA_ID, manifest).threads) {
    const thread = readDocument(THREAD_SCHEMA_ID, path.join(feedbackRoot, "threads", `${id}.json`));
    for (const stageId of new Set([thread.assignedStageId, thread.target.stageId])) {
      const entry = stageId === undefined ? undefined : result.get(stageId);
      entry?.[thread.status === "resolved" ? "resolved" : "open"].push(id);
    }
  }
  return result;
}
