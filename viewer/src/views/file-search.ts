// The file search dialog: a filename combobox over every file occurrence,
// grouped by stage and step.
import { html, nothing, type TemplateResult } from "lit-html";
import { guard } from "lit-html/directives/guard.js";
import { repeat } from "lit-html/directives/repeat.js";

export interface FileSearchOptionView {
  /** The option's position among all matches. */
  index: number;
  key: string;
  name: string;
  dir: string;
  kind: string;
  kindLabel: string;
  kindGlyph: string;
  binary: boolean;
  additions: number;
  deletions: number;
}

export interface FileSearchNodeView {
  key: string;
  /** The position of the group's first match, which names its heading. */
  index: number;
  title: string;
  options: readonly FileSearchOptionView[];
}

export interface FileSearchStageView {
  key: string;
  index: number;
  /** The stage number, padded to two digits. */
  number: string;
  title: string;
  nodes: readonly FileSearchNodeView[];
}

export interface FileSearchView {
  /** The grouped matches; the same array until the matches change, so the results only render when they or the selection change. */
  stages: readonly FileSearchStageView[];
  matches: number;
  selected: number;
  /** The typed query, shown under the input so the completion lines up. */
  typed: string;
  /** The completion suggested after the typed text; empty for none. */
  suffix: string;
  onInput: (event: Event) => void;
  onKeydown: (event: KeyboardEvent) => void;
  /** Refreshes the completion when the caret or composition changes. */
  onCaret: (event: Event) => void;
  onChoose: (index: number) => void;
  onClose: () => void;
}

export const optionId = (index: number) => `file-search-option-${index}`;

function option(view: FileSearchView, item: FileSearchOptionView): TemplateResult {
  return html`<div role="option" id=${optionId(item.index)} data-index=${item.index} aria-selected=${String(item.index === view.selected)} @click=${() => view.onChoose(item.index)}>
          <span class="kind k-${item.kind}" role="img" aria-label=${item.kindLabel} title=${item.kindLabel}>${item.kindGlyph}</span>
          <span class="file-search-path"><strong>${item.name}</strong>${item.dir ? html`<small>${item.dir}</small>` : nothing}</span>
          <span title="Total line changes for this file in this stage">${item.binary ? "Binary" : html`<span class="metrics"><i class="add">+${item.additions}</i><i class="del">−${item.deletions}</i></span>`}</span></div>`;
}

function nodeGroup(view: FileSearchView, node: FileSearchNodeView): TemplateResult {
  return html`<div role="group" aria-labelledby="file-search-node-${node.index}"><h4 id="file-search-node-${node.index}">${node.title}</h4>${repeat(node.options, (item) => item.key, (item) => option(view, item))}</div>`;
}

function stageGroup(view: FileSearchView, stage: FileSearchStageView): TemplateResult {
  return html`<div role="group" aria-labelledby="file-search-stage-${stage.index}"><h3 id="file-search-stage-${stage.index}">${stage.number} · ${stage.title}</h3>${repeat(stage.nodes, (node) => node.key, (node) => nodeGroup(view, node))}</div>`;
}

export function fileSearchView(view: FileSearchView): TemplateResult {
  const caret = view.onCaret;
  return html`<header><h2 id="file-search-title">Find a file</h2><button type="button" class="tb-btn" aria-label="Close file search" @click=${view.onClose}>Esc</button></header>
      <div class="file-search-field">
        <input id="file-search-input" type="text" role="combobox" aria-label="Filename" aria-autocomplete="both" aria-expanded="true" aria-controls="file-search-results" aria-describedby="file-search-help"
          aria-activedescendant=${view.matches ? optionId(view.selected) : nothing} placeholder="Filename…" autocomplete="off" spellcheck="false"
          @input=${view.onInput} @keydown=${view.onKeydown} @focus=${caret} @blur=${caret} @select=${caret} @keyup=${caret} @click=${caret} @scroll=${caret}
          @compositionstart=${caret} @compositionend=${caret}>
        <div class="file-search-completion" aria-hidden="true"><span class="file-search-completion-text"><span class="file-search-typed">${view.typed}</span><span class="file-search-suffix">${view.suffix}</span></span></div>
      </div>
      <p id="file-search-status" role="status">${view.matches ? `${view.matches} file occurrence${view.matches === 1 ? "" : "s"} · line counts are per stage` : "No matching files"}</p>
      <div id="file-search-results" role="listbox" aria-label="File changes">${guard([view.stages, view.selected], () => repeat(view.stages, (stage) => stage.key, (stage) => stageGroup(view, stage)))}</div>
      <footer id="file-search-help">↑ ↓ select · Enter open · Esc close</footer>`;
}
