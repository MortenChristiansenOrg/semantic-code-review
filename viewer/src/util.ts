// Small helpers for text, paths and motion shared by the page's modules.
import type { FileKind } from "../../scripts/src/shared/viewer-protocol";

export function fmtTime(v: string | number | undefined): string {
  const d = new Date(v ?? NaN);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return { dir: i >= 0 ? path.slice(0, i + 1) : "", name: i >= 0 ? path.slice(i + 1) : path };
}
export function dirShort(dir: string): string {
  const trimmed = dir.replace(/\/$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/");
  return (parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : trimmed) + "/";
}
export function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
export function kindGlyph(kind: FileKind): string {
  return kind === "added" ? "A" : kind === "deleted" ? "D" : kind === "renamed" ? "R" : "M";
}
export function kindLabel(kind: FileKind): string {
  return kind === "added" ? "Added" : kind === "deleted" ? "Deleted" : kind === "renamed" ? "Renamed" : "Modified";
}

export const storageSize = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;

export const reduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function cssEsc(v: string): string { return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"); }

export const ANIM_EASE = "cubic-bezier(.22,.7,.2,1)";
export const motionReduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Run `cb` once when the animation ends, with a safety timeout so a stuck or
// non-resolving `finished` promise can never leave the UI mid-animation.
export function afterAnim(anim: Animation, ms: number, cb: () => void): void {
  let done = false;
  const run = () => { if (done) return; done = true; cb(); };
  anim.finished.catch(() => {}).then(run);
  setTimeout(run, (ms || 0) + 80);
}

/** An element that can take focus, as the page's controls can; null for any other. */
export function focusable(el: Element | null | undefined): HTMLElement | SVGElement | null {
  return el instanceof HTMLElement || el instanceof SVGElement ? el : null;
}
