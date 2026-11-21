// How a review shows each stage's files: compared with their last occurrence
// in the ordered review, independently of intervening stages.

/** A file as a stage's inventory records it. */
export interface InventoryFile {
  path: string;
  previousPath?: string;
}

/** A stage's files as the review shows them: each compared with the head of the
 * last stage that changed it, under the path it had there, or with the stage's
 * base. `previousPath` is that path when it differs. */
export type ShownFile<File extends InventoryFile> = Omit<File, "previousPath"> & {
  previousPath?: string;
  previousPaths: string[];
  baseRevision: string;
  previousStageId?: string;
};

export function shownStageFiles<File extends InventoryFile>(
  stages: readonly { id: string; change: { baseRevision: string; headRevision: string; files: readonly File[] } }[],
): ShownFile<File>[][] {
  const previous = new Map<string, { stageId: string; headRevision: string; path: string; previousPaths: string[] }>();
  return stages.map((stage) => {
    const files = stage.change.files.map((file): ShownFile<File> => {
      const last = (file.previousPath && previous.get(file.previousPath)) || previous.get(file.path);
      const { previousPath: ignored, ...current } = file;
      const oldPath = last ? last.path : file.previousPath;
      const previousPaths = [...new Set([oldPath, ...(last?.previousPaths || [])].filter((item): item is string => Boolean(item) && item !== file.path))];
      return { ...current, ...(oldPath && oldPath !== file.path ? { previousPath: oldPath } : {}),
        previousPaths, baseRevision: last ? last.headRevision : stage.change.baseRevision,
        ...(last ? { previousStageId: last.stageId } : {}) };
    });
    for (const file of stage.change.files) if (file.previousPath) previous.delete(file.previousPath);
    for (const file of files) {
      previous.set(file.path, { stageId: stage.id, headRevision: stage.change.headRevision, path: file.path, previousPaths: file.previousPaths });
    }
    return files;
  });
}
