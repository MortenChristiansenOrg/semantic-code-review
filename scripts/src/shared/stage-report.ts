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
