// When the reviewer selects a token in a diff, every other occurrence of that
// text in the same diff's code is highlighted. The matches are painted with
// the CSS Custom Highlight API (the `::highlight(sel-hit)` rule), which styles
// ranges without changing the DOM, so the text nodes that lit renders, and the
// reviewer's selection inside them, are never split or replaced. Browsers
// without the API simply show no matches.
export const HIGHLIGHT = "sel-hit";

const supported = () => typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS;

/** Whether matches are currently highlighted. */
export function hasSelectionHits(): boolean {
  return supported() && CSS.highlights.has(HIGHLIGHT);
}

export function clearSelectionHits(): void {
  if (supported()) CSS.highlights.delete(HIGHLIGHT);
}

// Source rows only: not gutters, notices, inline insights, line threads or the
// banners and gaps between rows.
const CODE = ".drow:not(.d-gap, .d-newfile, .d-oldfile, .drow-thread) > code";

function overlaps(selected: Range | null, node: Text, start: number, end: number): boolean {
  if (!selected) return false;
  const match = document.createRange();
  match.setStart(node, start); match.setEnd(node, end);
  return match.compareBoundaryPoints(Range.END_TO_START, selected) < 0 && match.compareBoundaryPoints(Range.START_TO_END, selected) > 0;
}

// Lowercasing can change a string's length (`İ` becomes `i̇`), so offsets in
// lowercased text are not offsets in the original. Fold each code point on its
// own and keep, for every unit of the folded text, the original offset of the
// code point it came from, and whether it starts that code point.
interface Folded { text: string; offsets: number[]; starts: boolean[] }
const ASCII = /^[\x00-\x7f]*$/;
function fold(text: string): Folded {
  if (ASCII.test(text)) return { text: text.toLowerCase(), offsets: [], starts: [] };
  let folded = "";
  const offsets: number[] = [], starts: boolean[] = [];
  for (let index = 0; index < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(index)!);
    const lower = point.toLowerCase();
    for (let unit = 0; unit < lower.length; unit++) { offsets.push(index); starts.push(unit === 0); }
    folded += lower;
    index += point.length;
  }
  offsets.push(text.length); starts.push(true);
  return { text: folded, offsets, starts };
}
// The original range of a match in folded text, or null when the match starts
// or ends inside a code point that folding expanded.
function originalRange(folded: Folded, start: number, end: number): [number, number] | null {
  if (!folded.offsets.length) return [start, end];
  if (!folded.starts[start] || !folded.starts[end]) return null;
  return [folded.offsets[start], folded.offsets[end]];
}

/** Highlights each case-insensitive occurrence of `term` in the code of `grid`, except the selected one. */
export function highlightSelectionHits(grid: Element, term: string, selected: Range | null): void {
  clearSelectionHits();
  if (!supported() || !term) return;
  const needle = fold(term).text;
  const highlight = new Highlight();
  for (const code of grid.querySelectorAll(CODE)) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const folded = fold(node.data);
      for (let index = folded.text.indexOf(needle); index !== -1; index = folded.text.indexOf(needle, index + needle.length)) {
        const bounds = originalRange(folded, index, index + needle.length);
        if (!bounds || bounds[1] <= bounds[0] || bounds[1] > node.length) continue;
        if (overlaps(selected, node, bounds[0], bounds[1])) continue;
        highlight.add(new StaticRange({ startContainer: node, startOffset: bounds[0], endContainer: node, endOffset: bounds[1] }));
      }
    }
  }
  if (highlight.size) CSS.highlights.set(HIGHLIGHT, highlight);
}
