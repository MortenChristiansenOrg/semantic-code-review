// Files attached to a note, reply or thread message, and the editor that adds them.
import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";

export interface AttachmentView {
  id: string;
  filename: string;
  /** The size in KiB, as shown. */
  size: string;
  /** A preview URL for images the page can show; empty otherwise. */
  preview: string;
}

export interface AttachmentEditorView {
  attachments: readonly AttachmentView[];
  uploading: boolean;
  /** Why the last uploads failed; empty when they did not. */
  error: string;
}

const fileIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/></svg>`;
const paperclipIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9a1 1 0 0 0 2 2l8-8"/></svg>`;
const removeIcon = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>`;

function attachment(file: AttachmentView, editable: boolean): TemplateResult {
  return html`<div class="attachment">
      ${file.preview ? html`<img src=${file.preview} alt=${file.filename} loading="lazy">` : html`<span class="attachment-icon">${fileIcon}</span>`}
      <span class="attachment-name" data-clippable data-tooltip-clipped=${file.filename || nothing}>${file.filename}</span><small>${file.size} KiB</small>
      ${editable ? html`<button class="attachment-remove" type="button" data-action="remove-attachment" data-id=${file.id} aria-label="Remove ${file.filename}">${removeIcon}</button>` : nothing}</div>`;
}

/** A message's attachments; nothing when it has none. */
export function attachmentList(attachments: readonly AttachmentView[], editable = false): TemplateResult | typeof nothing {
  if (!attachments.length) return nothing;
  return html`<div class="attachments">${repeat(attachments, (file) => file.id, (file) => attachment(file, editable))}</div>`;
}

/** The attachments of a message being written, with a picker and upload status. */
export function attachmentEditor(view: AttachmentEditorView): TemplateResult {
  return html`${attachmentList(view.attachments, true)}<div class="attachment-tools"><label class="attach-files">${paperclipIcon}<span>Attach files</span><input type="file" multiple data-attachment-input aria-label="Attach files"></label>
      <span class="attachment-help" data-tooltip="Up to 10 files per message, 20 MiB each">or drop into the text field / paste an image</span></div>
      ${view.uploading ? html`<p role="status">Uploading files…</p>` : nothing}${view.error ? html`<p class="tthread-err" role="alert">${view.error}</p>` : nothing}`;
}
