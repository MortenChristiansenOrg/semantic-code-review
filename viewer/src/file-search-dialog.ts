// The file search dialog: finds every occurrence of a file by its name and
// opens the one chosen in its step.
import type { ChangeNode } from "../../scripts/src/shared/viewer-protocol";
import { app, data } from "./context";
import { fileApprovalKey, fileKey, nodeFileList, stageNumberById } from "./lookups";
import { fileRowElement, jumpToElement } from "./navigation";
import { reviewEnded, state } from "./state";
import type { ViewerFile, ViewerStage } from "./types";
import { focusable, kindGlyph, kindLabel, splitPath } from "./util";
import { fileSearchView, type FileSearchNodeView, type FileSearchOptionView, type FileSearchStageView } from "./views/file-search";
import { render as renderLit } from "lit-html";

// Index memberships, not just paths: a shared file has a distinct destination
// in each node. Rebuild only when the implementation snapshot changes.
/** One occurrence of a file: in a step of a stage. */
export interface FileSearchEntry {
  stage: ViewerStage;
  node: ChangeNode;
  file: ViewerFile;
}
export let fileSearchEntries: FileSearchEntry[] = [];
export let fileOccurrenceCounts = new Map<string, number>();
export let refreshFileSearch: (() => void) | null = null, fileSearchFileChanged: ((file: ViewerFile) => void) | null = null;
// Counts picker openings, so a closed picker's late close event leaves a
// newer picker alone.
export let fileSearchSession = 0;
export function rebuildFileSearchIndex(): void {
  fileSearchEntries = [];
  fileOccurrenceCounts = new Map();
  for (const stage of data.stages) {
    for (const node of stage.nodes) {
      for (const file of nodeFileList(stage, node)) {
        fileSearchEntries.push({ stage, node, file });
        fileOccurrenceCounts.set(file.path, (fileOccurrenceCounts.get(file.path) || 0) + 1);
      }
    }
  }
}

export function matchesFileSearch(path: string, query: string): boolean {
  return splitPath(path).name.toLowerCase().includes(query);
}

// `origin` names the stage and node of the occurrence the picker was opened
// from, so that occurrence starts selected.
interface NodeGroup extends FileSearchNodeView {
  id: string;
  options: FileSearchOptionView[];
}
interface StageGroup extends FileSearchStageView {
  id: string;
  nodes: NodeGroup[];
}

export function openFileSearch(path = "", origin: { stageId: string; nodeId: string | undefined } | null = null): void {
  if (reviewEnded || document.querySelector("dialog[open]")) return;
  const opener = document.activeElement;
  const session = ++fileSearchSession;
  const dialog = document.createElement("dialog");
  dialog.className = "file-search";
  dialog.setAttribute("aria-labelledby", "file-search-title");
  let matches: FileSearchEntry[] = [], selected = 0, navigating = false, composing = false, input: HTMLInputElement | null = null;
  // Keep occurrence navigation scoped to the exact file until the user edits
  // its filename. Directory text never participates in the search query.
  let exactPath = path || null;
  let originEntry = path && origin ? origin : null;
  function completion() {
    if (!input) return "";
    const name = matches[selected] ? splitPath(matches[selected].file.path).name : "";
    const query = input.value.toLowerCase();
    const index = name.toLowerCase().indexOf(query);
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    // For an interior substring, suggest only the remainder after that match.
    return query && index >= 0 && atEnd && !composing && document.activeElement === input
      ? name.slice(index + input.value.length) : "";
  }
  // The grouped results, rebuilt only when the matches or the data they show change.
  let grouped: StageGroup[] = [], groupedMatches: FileSearchEntry[] | null = null;
  function groups(): StageGroup[] {
    if (groupedMatches === matches) return grouped;
    groupedMatches = matches;
    const stages: StageGroup[] = grouped = [];
    let stage: StageGroup | null = null, node: NodeGroup | null = null;
    matches.forEach(({ stage: s, node: n, file }, index) => {
      if (stage?.id !== s.id) {
        stage = { key: s.id, id: s.id, index, number: String(stageNumberById.get(s.id)).padStart(2, "0"), title: s.title, nodes: [] };
        stages.push(stage); node = null;
      }
      if (node?.id !== n.id) { node = { key: n.id, id: n.id, index, title: n.title, options: [] }; stage.nodes.push(node); }
      const { name, dir } = splitPath(file.path);
      node.options.push({ index, key: file.path, name, dir, kind: file.kind, kindLabel: kindLabel(file.kind), kindGlyph: kindGlyph(file.kind),
        binary: Boolean(file.binary), additions: file.additions, deletions: file.deletions });
    });
    return stages;
  }
  function draw() {
    renderLit(fileSearchView({
      stages: groups(), matches: matches.length, selected, typed: input?.value || "", suffix: completion(),
      onInput: () => { exactPath = null; originEntry = null; matches = []; paint(); },
      onKeydown, onCaret, onChoose: choose, onClose: () => dialog.close(),
    }), dialog);
    input ||= dialog.querySelector("input");
    // CSSOM only: the typed text under the input follows its horizontal scroll.
    const typed = dialog.querySelector(".file-search-completion-text");
    if (typed instanceof HTMLElement && input) typed.style.transform = `translateX(${-input.scrollLeft}px)`;
  }
  function onCaret(event: Event) {
    if (event.type === "compositionstart") composing = true;
    else if (event.type === "compositionend") composing = false;
    draw();
  }
  function select(index: number, scroll = true) {
    selected = index;
    draw();
    if (scroll) dialog.querySelector(`[role="option"][data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function paint() {
    if (!input) return;
    const previous = matches[selected];
    const query = input.value.toLowerCase();
    matches = fileSearchEntries.filter(({ file }) => exactPath
      ? file.path === exactPath
      : matchesFileSearch(file.path, query));
    const wanted = previous ? { stageId: previous.stage.id, nodeId: previous.node.id, path: previous.file.path }
      : originEntry ? { ...originEntry, path: exactPath } : null;
    const previousIndex = wanted ? matches.findIndex((entry) => entry.stage.id === wanted.stageId && entry.node.id === wanted.nodeId && entry.file.path === wanted.path) : -1;
    select(previousIndex >= 0 ? previousIndex : 0, false);
  }
  function choose(index: number) {
    const entry = matches[index];
    if (!entry) return;
    navigating = true;
    dialog.close();
    const id = fileKey(entry.stage.id, entry.file.path);
    state.markdownPreview[id] = false;
    state.approvalComparisons[fileApprovalKey(entry.stage.id, entry.node.id, entry.file.path)] = false;
    jumpToElement("file", id, entry.stage.id, entry.node.id);
    requestAnimationFrame(() => focusable(fileRowElement(id, entry.node.id)?.querySelector(".frow-open"))?.focus({ preventScroll: true }));
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && matches.length) {
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1 : (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      select(index);
    } else if (event.key === "Enter") {
      event.preventDefault(); choose(selected);
    }
  }
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (session !== fileSearchSession) return;
    refreshFileSearch = fileSearchFileChanged = null;
    if (!navigating) focusable(opener?.isConnected ? opener : app.querySelector('[data-action="file-search"]'))?.focus({ preventScroll: true });
  });
  // A loaded diff page can change a file's line counts or binary flag, which
  // the results show; redraw only when a listed file changed.
  fileSearchFileChanged = (file) => {
    if (!matches.some((match) => match.file === file)) return;
    groupedMatches = null; draw();
  };
  refreshFileSearch = paint;
  document.body.append(dialog); draw();
  // The input draw found.
  const field = dialog.querySelector("input");
  if (!field) return;
  field.value = splitPath(path).name;
  paint(); dialog.showModal(); field.focus(); field.select();
  // Set the initial viewport after opening and focusing, when layout exists.
  const results = dialog.querySelector('[role="listbox"]');
  if (!results) return;
  results.scrollTo({ top: 0, behavior: "instant" });
  if (selected > 0) results.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "center", behavior: "instant" });
}
