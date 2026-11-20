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

// Whether a match overlaps the reviewer's selection, which is not highlighted.
function overlaps(selected: Range | null, match: StaticRange): boolean {
  if (!selected) return false;
  const range = document.createRange();
  range.setStart(match.startContainer, match.startOffset); range.setEnd(match.endContainer, match.endOffset);
  return range.compareBoundaryPoints(Range.END_TO_START, selected) < 0 && range.compareBoundaryPoints(Range.START_TO_END, selected) > 0;
}

// Lowercasing can change a string's length (`İ` becomes `i̇`), so offsets in
// lowercased text are not offsets in the original. Fold each code point on its
// own and keep, for every unit of the folded text, the original offset of the
// code point it came from, and whether it starts that code point. Lowercasing
// a whole string picks the final form of sigma (`ς`) by context, which a single
// code point cannot, so both sigmas fold to `σ`; both are one unit long.
interface Folded { text: string; offsets: number[]; starts: boolean[] }
const ASCII = /^[\x00-\x7f]*$/;
function fold(text: string): Folded {
  if (ASCII.test(text)) return { text: text.toLowerCase(), offsets: [], starts: [] };
  let folded = "";
  const offsets: number[] = [], starts: boolean[] = [];
  for (let index = 0; index < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(index)!);
    const lower = point.toLowerCase().replaceAll("ς", "σ");
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

// A code row's text is split across the spans of its syntax highlighting, so
// matches are found in the row's combined text and mapped back to the text
// nodes where they start and end; a highlight range may span several nodes.
// Matches come in increasing order, so one cursor walks the nodes once for the
// starts and another for the ends.
interface Piece { node: Text; start: number }
function cursor(pieces: Piece[], end: boolean): (offset: number) => [Text, number] {
  let index = 0;
  return (offset) => {
    // A match ends in the node it ends inside, not at the start of the next one.
    while (index + 1 < pieces.length && (end ? pieces[index + 1].start < offset : pieces[index + 1].start <= offset)) index++;
    return [pieces[index].node, offset - pieces[index].start];
  };
}

/** Highlights each case-insensitive occurrence of `term` in the code of `grid`, except the selected one. */
export function highlightSelectionHits(grid: Element, term: string, selected: Range | null): void {
  clearSelectionHits();
  if (!supported() || !term) return;
  const needle = fold(term).text;
  const highlight = new Highlight();
  for (const code of grid.querySelectorAll(CODE)) {
    const pieces: Piece[] = [];
    let text = "";
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!node.length) continue;
      pieces.push({ node, start: text.length });
      text += node.data;
    }
    if (!pieces.length) continue;
    const folded = fold(text), start = cursor(pieces, false), end = cursor(pieces, true);
    for (let index = folded.text.indexOf(needle); index !== -1; index = folded.text.indexOf(needle, index + needle.length)) {
      const bounds = originalRange(folded, index, index + needle.length);
      if (!bounds || bounds[1] <= bounds[0] || bounds[1] > text.length) continue;
      const [startContainer, startOffset] = start(bounds[0]);
      const [endContainer, endOffset] = end(bounds[1]);
      const match = new StaticRange({ startContainer, startOffset, endContainer, endOffset });
      if (!overlaps(selected, match)) highlight.add(match);
    }
  }
  if (highlight.size) CSS.highlights.set(HIGHLIGHT, highlight);
}
