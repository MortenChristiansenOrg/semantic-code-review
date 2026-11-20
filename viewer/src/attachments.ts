// Files attached to notes and replies: uploading them from inputs, drops and
// pastes, and how they are shown.
import type { Attachment } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { compose, replyAttachments, replyTo } from "./editor";
import { errorMessage, failureOf } from "./narrow";
import { render } from "./render";
import { persist } from "./state";
import type { AttachmentEditorView, AttachmentView } from "./views/attachments";

/** Uploads in progress. */
export const uploadOps = new Set<Promise<void>>();
/** The uploads to an editor's attachments: queued files, and errors by file. */
interface UploadStatus {
  busy: boolean;
  error: string;
  errors: Map<string, string>;
  pending: File[];
}
export const uploadStatus = new WeakMap<Attachment[], UploadStatus>();

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export function attachmentModels(attachments: Attachment[] = []): AttachmentView[] {
  return attachments.map((file) => ({ id: file.id, filename: file.filename, size: (file.size / 1024).toFixed(1),
    preview: IMAGE_TYPES.includes(file.mediaType) ? api.attachmentUrl(file.id, true) : "" }));
}
export function attachmentEditorModel(attachments: Attachment[]): AttachmentEditorView {
  const status = uploadStatus.get(attachments);
  return { attachments: attachmentModels(attachments), uploading: Boolean(status?.busy), error: status?.error || "" };
}
export function editorAttachments(form: Element | null | undefined): Attachment[] | null {
  if (form?.matches("[data-note-form]") && compose) return compose.attachments ||= [];
  if (form instanceof HTMLElement && form.matches("[data-reply-form]") && replyTo === form.dataset.id) return replyAttachments;
  return null;
}
export function uploadFiles(files: File[], attachments: Attachment[] | null): void {
  if (!attachments || !files.length) return;
  const status = uploadStatus.get(attachments) || { busy: false, error: "", errors: new Map<string, string>(), pending: [] };
  status.pending.push(...files); uploadStatus.set(attachments, status);
  if (status.busy) { render(); return; }
  status.busy = true;
  const operation = Promise.resolve().then(async () => {
    for (let file = status.pending.shift(); file; file = status.pending.shift()) {
      let errorKey = JSON.stringify(["oversize", file.name, file.type, file.size]);
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: files must be 20 MiB or smaller.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
        errorKey = JSON.stringify([file.name, file.type, sha256]);
        if (attachments.length >= 10) {
          if (!attachments.some((item) => item.filename === file.name && item.size === file.size && item.sha256 === sha256)) throw new Error("Use at most 10 files per message.");
          // The exact content is already retained by this draft; no transfer is needed.
          status.errors.delete(errorKey); status.error = [...status.errors.values()].join(" "); continue;
        }
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        const response = await api.uploadAttachment({ filename: file.name, mediaType: file.type || "application/octet-stream", data: btoa(binary) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(failureOf(result).error || `Could not upload ${file.name}.`);
        if (!attachments.some((item) => item.id === result.attachment.id)) {
          if (attachments.length >= 10) throw new Error("Use at most 10 files per message.");
          attachments.push(result.attachment);
        }
        status.errors.delete(errorKey); status.error = [...status.errors.values()].join(" ");
        persist();
      } catch (error) { status.errors.set(errorKey, errorMessage(error)); status.error = [...status.errors.values()].join(" "); }
    }
  }).finally(() => { status.busy = false; uploadOps.delete(operation); render(); });
  uploadOps.add(operation); render();
}
export let fileDropTarget: HTMLTextAreaElement | null = null;
export function clearFileDropTarget(): void { fileDropTarget?.classList.remove("is-file-drop-target"); fileDropTarget = null; }
export function messageDropTarget(target: EventTarget | null): HTMLTextAreaElement | null {
  return target instanceof HTMLTextAreaElement && target.matches('textarea[name="nc-body"], textarea[name="reply-body"]') && target.closest("[data-note-form], [data-reply-form]") ? target : null;
}

/** Takes files from attachment inputs, drops and pastes. */
export function installAttachments(): void {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.matches("[data-attachment-input]")) {
      const files = [...(input.files || [])];
      input.value = ""; // The persistent input must allow selecting the same file again.
      uploadFiles(files, editorAttachments(input.closest("form")));
    }
  });
  document.addEventListener("dragover", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer || ![...transfer.types].includes("Files")) return;
    event.preventDefault();
    const target = messageDropTarget(event.target);
    transfer.dropEffect = target ? "copy" : "none";
    if (target !== fileDropTarget) { clearFileDropTarget(); fileDropTarget = target; }
    target?.classList.add("is-file-drop-target");
  });
  document.addEventListener("dragleave", (event) => { if (event.target === fileDropTarget) clearFileDropTarget(); });
  document.addEventListener("dragend", clearFileDropTarget);
  window.addEventListener("blur", clearFileDropTarget);
  document.addEventListener("drop", (event) => {
    clearFileDropTarget();
    const transfer = event.dataTransfer;
    if (!transfer?.files.length) return;
    event.preventDefault(); // Rejected file drops must not navigate away from the review.
    const target = messageDropTarget(event.target);
    if (target) uploadFiles([...transfer.files], editorAttachments(target.form));
  });
  document.addEventListener("paste", (event) => {
    const form = event.target instanceof Element ? event.target.closest("[data-note-form], [data-reply-form]") : null;
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file) => file !== null);
    if (form && files.length) { event.preventDefault(); uploadFiles(files, editorAttachments(form)); }
  });
}
