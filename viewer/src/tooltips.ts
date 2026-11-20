// Hints the viewer shows in its own tooltip, rendered as `data-tooltip` instead
// of native titles. An element whose hint only repeats its visible label shows
// it as `data-tooltip-clipped`, only while a `[data-clippable]` label is cut off.
// Free of lit-html, so the separately bundled Markdown renderer can share it.

const normalized = (value: string) => value.replace(/\s+/g, " ").trim();

/** Whether a hint only repeats the visible label it describes. */
export function repeatsLabel(hint: string, label: string): boolean {
  return normalized(hint) === normalized(label);
}

/** Joins hints, each once, leaving out empty ones. */
export function joinHints(...hints: readonly (string | null | undefined)[]): string {
  return joinHintList(hints);
}

/** Joins a list of hints of any length, each once, leaving out empty ones. */
export function joinHintList(hints: readonly (string | null | undefined)[]): string {
  return [...new Set(hints.filter(Boolean))].join(" · ");
}

export interface LabelHint {
  /** The hint shown while the label shows in full; empty when there is none. */
  tooltip: string;
  /** The fuller hint shown while the label is cut off; empty when the same. */
  clipped: string;
}

/**
 * The hint of an element showing `label`: its own hint, then the hints of the
 * decorative parts it holds, which share its keyboard stop. An own hint that
 * repeats the label is left out unless the label is cut off.
 */
export function labelHint(own: string, label: string, hints: readonly string[] = []): LabelHint {
  const repeats = Boolean(own) && repeatsLabel(own, label);
  return { tooltip: joinHintList([repeats ? "" : own, ...hints]), clipped: repeats ? joinHintList([own, ...hints]) : "" };
}
