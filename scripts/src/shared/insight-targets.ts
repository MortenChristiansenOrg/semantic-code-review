import { git } from "./git.js";
import { immutableFact } from "./validation-context.js";

/** Immutable authoring anchor. Context survives publication and pruning of old commits. */
export interface CodeTarget {
  path: string;
  revision: string;
  blobId: string;
  startLine: number;
  endLine: number;
  contextStartLine: number;
  context: string[];
}

const hash = /^[0-9a-f]{40}$/;
function assertPath(value: string) {
  if (!value || /[\\\0\r\n]/.test(value) || value.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Code target requires a repository-relative file path.");
  }
}
function blobAt(root: string, revision: string, file: string) {
  const tree = immutableFact(JSON.stringify(["insight-tree", root, revision, file]), () =>
    git(["--literal-pathspecs", "ls-tree", "-z", revision, "--", file], { cwd: root, allowFailure: true }));
  const entry = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree || "");
  return entry?.[3] === file ? entry[2] : null;
}
function blobLines(root: string, blob: string): string[] | null {
  return immutableFact(JSON.stringify(["insight-blob", root, blob]), () => {
    const bytes: Buffer | null = git(["cat-file", "blob", blob], { cwd: root, allowFailure: true, encoding: "buffer" });
    if (!bytes || bytes.includes(0)) return null;
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  });
}
function contextFor(lines: string[], startLine: number, endLine: number) {
  const contextStartLine = Math.max(1, startLine - 3);
  return { contextStartLine, context: lines.slice(contextStartLine - 1, endLine + 3) };
}
export function captureCodeTarget(root: string, revision: string, file: string, startLine: number, endLine: number): CodeTarget {
  assertPath(file);
  if (!hash.test(revision)) throw new Error("Code target requires an immutable commit revision.");
  const blobId = blobAt(root, revision, file);
  const lines = blobId && blobLines(root, blobId);
  if (!blobId || !lines) throw new Error("Code target must name an available regular text file at the stage's committed head (files over Git's read limit are unsupported).");
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error("Code target line range is invalid or outside the committed file.");
  }
  return { path: file, revision, blobId, startLine, endLine, ...contextFor(lines, startLine, endLine) };
}
export function validateCodeTarget(root: string, target: CodeTarget, checkGit: boolean) {
  assertPath(target.path);
  if (target.endLine < target.startLine || target.contextStartLine > target.startLine ||
      target.contextStartLine + target.context.length - 1 < target.endLine) {
    throw new Error("Code target context must contain its complete ordered line range.");
  }
  if (checkGit && git(["cat-file", "-e", `${target.revision}^{commit}`], { cwd: root, allowFailure: true }) !== null) {
    const actual = captureCodeTarget(root, target.revision, target.path, target.startLine, target.endLine);
    if (actual.blobId !== target.blobId || actual.contextStartLine !== target.contextStartLine || JSON.stringify(actual.context) !== JSON.stringify(target.context)) {
      throw new Error("Code target snapshot does not match its recorded revision.");
    }
  }
}

/** Conservative resolution: edits inside a span and ambiguous repeated text require review. */
export function resolveCodeTarget(root: string, target: CodeTarget, head: string) {
  const original = { ...target };
  const stale = (reason: string, currentPath = target.path) => ({ status: "needs-review", reason, original, path: currentPath });
  let currentPath = target.path;
  // Follow Git's rename identity even if another file now occupies the old path.
  if (head !== target.revision) {
    const changes = immutableFact(JSON.stringify(["insight-renames", root, target.revision, head]), () =>
      git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames=50%", target.revision, head, "--"], { cwd: root, allowFailure: true }));
    if (changes === null) return stale("Original revision unavailable; inspect the saved context and retarget.");
    const fields = changes.split("\0");
    for (let i = 0; i < fields.length && fields[i];) {
      const status = fields[i++], oldPath = fields[i++];
      if (status.startsWith("R") || status.startsWith("C")) {
        const newPath = fields[i++];
        if (oldPath === target.path && status.startsWith("R")) currentPath = newPath;
      } else if (status === "D" && oldPath === target.path) return stale("Target file was deleted.");
    }
  }
  const blob = blobAt(root, head, currentPath), lines = blob && blobLines(root, blob);
  if (!blob || !lines) return stale("Target file is missing or cannot be read as text.", currentPath);
  let startLine = target.startLine, endLine = target.endLine;
  if (blob !== target.blobId) {
    const originalLines = blobLines(root, target.blobId);
    if (!originalLines) return stale("Original file unavailable; inspect the saved context and retarget.", currentPath);
    const selected = target.context.slice(target.startLine - target.contextStartLine, target.endLine - target.contextStartLine + 1);
    const occurrences = (source: string[]) => {
      const haystack = "\n" + source.join("\n") + "\n", needle = "\n" + selected.join("\n") + "\n";
      const first = haystack.indexOf(needle);
      return first < 0 ? 0 : haystack.indexOf(needle, first + 1) < 0 ? 1 : 2;
    };
    if (occurrences(originalLines) > 1 || occurrences(lines) > 1) return stale("Repeated code makes the line mapping ambiguous.", currentPath);
    const patch = immutableFact(JSON.stringify(["insight-patch", root, target.blobId, blob]), () =>
      git(["diff", "--no-ext-diff", "--no-textconv", "--unified=0", target.blobId, blob], { cwd: root, allowFailure: true }));
    if (patch === null) return stale("Cannot compare the original and current file.", currentPath);
    let shift = 0;
    for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const oldStart = Number(match[1]), oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1);
      // Changed immediate boundaries can indicate a block moved out of its scope.
      const overlaps = oldCount === 0
        ? oldStart >= target.startLine && oldStart < target.endLine
        : oldStart <= target.endLine + 1 && oldStart + oldCount >= target.startLine;
      if (overlaps) return stale("Targeted code was edited, moved, or deleted; review the insight before retargeting.", currentPath);
      if (oldCount === 0 ? oldStart < target.startLine : oldStart + oldCount <= target.startLine) shift += newCount - oldCount;
    }
    startLine += shift; endLine += shift;
    if (JSON.stringify(lines.slice(startLine - 1, endLine)) !== JSON.stringify(selected)) return stale("Code could not be mapped reliably.", currentPath);
  }
  return { status: head === target.revision ? "current" : "mapped", original, path: currentPath,
    revision: head, startLine, endLine, ...contextFor(lines, startLine, endLine) };
}
