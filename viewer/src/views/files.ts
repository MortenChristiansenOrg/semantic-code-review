// A step's changed files, grouped by project, with each open file's diff after its row.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { ApprovalState } from "./controls";
import { diffPanelView, type DiffPanelView } from "./diff";
import { bubbleIcon, doubleCheckIcon, noteIcon } from "./icons";
import { fileNotesView, type ThreadListView } from "./thread";

export interface FileNoteBadgeView {
  /** Unresolved file threads. */
  threads: number;
  /** Personal notes. */
  personal: number;
  /** The file's notes show below its open diff. */
  expanded: boolean;
}

/** An open file: its diff and its notes. */
export interface OpenFileView {
  diff: DiffPanelView;
  notes: ThreadListView;
}

export interface FileRowView {
  /** The file's stage-scoped ID. */
  id: string;
  stageId: string;
  nodeId: string;
  path: string;
  /** The shortened directory shown before the name, with a trailing slash. */
  dir: string;
  name: string;
  kind: string;
  kindLabel: string;
  kindGlyph: string;
  /** Where a renamed file came from; empty otherwise. */
  previousPath: string;
  previousShort: string;
  classification: string;
  classificationLabel: string;
  /** The part of a shared file this step owns; empty when the file is not split. */
  sharedHint: string;
  additions: number;
  deletions: number;
  approvalId: string;
  approval: ApprovalState;
  /** The approval cannot be toggled now. */
  approvalDisabled: boolean;
  /** Occurrences of the path across the review, shown when above one. */
  occurrences: number;
  /** Code insights linked to this file. */
  insights: number;
  notes: FileNoteBadgeView | null;
  /** Unresolved line comments. */
  lineComments: number;
  /** Present while the file is open in this step. */
  open: OpenFileView | null;
}

export interface FileGroupView {
  name: string;
  approved: number;
  files: readonly FileRowView[];
  /** Unapproved files can be approved together now. */
  canApprove: boolean;
}

export interface NodeFilesView {
  stageId: string;
  nodeId: string;
  allApproved: boolean;
  groups: readonly FileGroupView[];
}

function noteBadge(row: FileRowView, notes: FileNoteBadgeView): TemplateResult {
  const label = `${notes.threads} file comment${notes.threads === 1 ? "" : "s"}, ${notes.personal} personal note${notes.personal === 1 ? "" : "s"}`;
  return html`<button class="mini-count mini-threads ${notes.expanded ? "is-open" : ""}" data-action="toggle-file-notes" data-id=${row.id} data-node-id=${row.nodeId} type="button" aria-expanded=${String(notes.expanded)} title=${label} aria-label=${label}>${bubbleIcon}<b>${notes.threads}</b>${noteIcon}<b>${notes.personal}</b></button>`;
}

function fileRow(row: FileRowView): TemplateResult {
  const active = Boolean(row.open);
  const on = row.approval === "approved", stale = row.approval === "stale";
  const lines = `${row.lineComments} line comments`;
  return html`<div class="frow-wrap ${active ? "is-open-wrap" : ""}">
      <div class="frow ${on ? "is-approved" : ""} ${stale ? "is-stale" : ""} ${active ? "is-active is-open" : ""}" data-file=${row.id}>
        <div class="frow-open" data-action="open-file" data-id=${row.id} data-node-id=${row.nodeId} role="button" tabindex="0" title=${row.path}>
          <span class="kind k-${row.kind}" role="img" aria-label=${row.kindLabel} title=${row.kindLabel}>${row.kindGlyph}</span>
          <span class="fp"><small>${row.dir}</small><strong class="fp-name">${row.name}</strong>${row.previousPath
            ? html`<span class="fp-from" data-tooltip-focus title="Renamed from ${row.previousPath}">← ${row.previousShort}</span>`
            : nothing}</span>
          <span class="cls cls-${row.classification}">${row.classificationLabel}</span>${row.sharedHint
            ? html`<span class="cls cls-shared" title="Split across steps — this step owns ${row.sharedHint}.">shared</span>`
            : nothing}
          <span class="metrics"><i class="add">+${row.additions}</i><i class="del">−${row.deletions}</i></span>
        </div>
        <div class="frow-act">
          ${row.occurrences > 1 ? html`<button class="file-occurrences" data-action="file-search" data-path=${row.path} data-stage-id=${row.stageId} data-node-id=${row.nodeId} type="button" title="Find all occurrences of this file" aria-label="Find occurrences of ${row.path}">↗ ${row.occurrences}</button>` : nothing}
          ${row.insights ? html`<button class="code-insight-link" type="button" data-action="file-insights" data-stage=${row.stageId} data-node-id=${row.nodeId} data-path=${row.path}>Insights · ${row.insights}</button>` : nothing}
          ${row.notes ? noteBadge(row, row.notes) : nothing}${row.lineComments
            ? html`<button class="mini-count mini-lines" data-action="open-file" data-id=${row.id} data-node-id=${row.nodeId} type="button" aria-expanded=${String(active)} title=${lines} aria-label=${lines}>${bubbleIcon}<b>${row.lineComments}</b><small>lines</small></button>`
            : nothing}
          <button class="mini-approve ${on ? "is-on" : ""} ${stale ? "is-stale" : ""}" data-action="approve" data-id=${row.approvalId} ?disabled=${row.approvalDisabled} type="button" aria-pressed=${String(on)} title=${stale ? "Changed since approval — re-approve" : on ? "Approved" : "Approve file"}><span>${stale ? "!" : on ? "✓" : ""}</span></button>
        </div>
      </div>
      ${row.open ? html`<div class="cinema-diff">${diffPanelView(row.open.diff)}${fileNotesView(row.open.notes)}</div>` : nothing}
    </div>`;
}

function fileGroup(view: NodeFilesView, group: FileGroupView): TemplateResult {
  const allDone = group.approved === group.files.length;
  const label = allDone ? `All files in ${group.name} approved` : `Approve all files in ${group.name}`;
  return html`<div class="fgroup ${allDone ? "all-done" : ""}">
        <div class="fgroup-h">
          <span class="fg-name">${group.name}</span>
          <span class="fg-done" aria-label="${group.approved} of ${group.files.length} files approved">${allDone ? "✓ " : ""}${group.approved}/${group.files.length}</span>
          <button class="fg-approve ${allDone ? "is-on" : ""}" data-action="approve-group" data-stage=${view.stageId} data-node-id=${view.nodeId} data-group=${group.name} type="button" ?disabled=${!group.canApprove} title=${label} aria-label=${label}>${doubleCheckIcon}</button>
        </div>
        <div class="flist">${repeat(group.files, (row) => row.id, fileRow)}</div>
      </div>`;
}

/** Every file of a step. Files are always visible: a step is rarely worth
 * opening without also inspecting its files. Groups are keyed by name so a
 * focused group control keeps acting on its own group when groups change; a
 * file that changes group is rendered anew, and the render wrapper restores
 * the scroll of its open diff or preview. */
export function nodeFiles(view: NodeFilesView): TemplateResult {
  return html`<div class="payload ${view.allApproved ? "all-done" : ""}" data-node-files=${view.nodeId}>
      <div class="fgroups">${repeat(view.groups, (group) => group.name, (group) => fileGroup(view, group))}</div>
    </div>`;
}
