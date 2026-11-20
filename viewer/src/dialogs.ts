// The dialogs that show an insight's code context and its evidence.
import type { CodeTarget, Insight } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { clearInlineInsightHighlight, setSuppressedCodeInsight } from "./insight-preview";
import { INSIGHT, evidenceKindLabel } from "./insights";
import { allAcceptance, nodeTitleById } from "./lookups";
import { forceHidePop } from "./popover";
import { afterAnim, motionReduced } from "./util";
import type { ViewerStage } from "./types";
import { codeInsightView, evidenceView, type CodeContextView, type EvidenceAttachmentView } from "./views/insight-dialogs";
import { render as renderLit } from "lit-html";

export function codeContextModel(target: Omit<CodeTarget, "blobId">): CodeContextView {
  return { path: target.path, startLine: target.startLine, endLine: target.endLine, revision: target.revision.slice(0, 12),
    contextStartLine: target.contextStartLine, context: target.context };
}

export function openCodeInsight(stage: ViewerStage | undefined, ins: Insight | undefined, choices: Insight[] = ins ? [ins] : []): void {
  if (!stage || !ins?.codeTarget) return;
  forceHidePop();
  clearInlineInsightHighlight();
  const { dialog, dismiss, show } = insightDialog("code-insight-dialog", "code-insight-title", (opener) => {
    // Restore keyboard position without treating restored focus as a new
    // request to preview the range. A fresh hover/focus can highlight again.
    clearInlineInsightHighlight();
    setSuppressedCodeInsight(opener?.closest(".line-code-insights .code-insight-link") || null);
  });
  let chosen = ins;
  const paint = () => {
    const target = chosen.codeTarget;
    if (!target) return;
    const stale = target.status === "needs-review";
    renderLit(codeInsightView({
      choices: choices.length > 1 ? choices.map((item) => item.title) : [], chosen: choices.indexOf(chosen),
      status: stale ? "needs-review" : target.status === "mapped" ? "mapped" : "current", reason: stale ? target.reason : "",
      kindLabel: (INSIGHT[chosen.type] || INSIGHT.decision).label, title: chosen.title, body: chosen.body || "",
      shown: codeContextModel(stale ? target.original : target),
      original: !stale && target.status === "mapped" ? codeContextModel(target.original) : null,
      onChoose: (index) => { chosen = choices[index]; paint(); },
      onClose: dismiss,
    }), dialog);
  };
  paint(); show();
}
export function insightDialog(className: string, labelledBy: string, onClosed: (opener: Element | null) => void = () => {}) {
  const opener = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = className;
  dialog.setAttribute("aria-labelledby", labelledBy);
  let entering: Animation | null = null, closing = false;
  const dismiss = () => {
    if (closing) return;
    closing = true;
    if (motionReduced()) { dialog.close(); return; }
    const current = getComputedStyle(dialog);
    const from = { opacity: current.opacity, transform: current.transform };
    entering?.cancel();
    dialog.classList.add("is-closing");
    const animation = dialog.animate([from, { opacity: 0, transform: "translateY(8px) scale(.985)" }], { duration: 140, easing: "ease-in", fill: "forwards" });
    afterAnim(animation, 140, () => dialog.close());
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (opener?.isConnected && (opener instanceof HTMLElement || opener instanceof SVGElement)) opener.focus({ preventScroll: true });
    onClosed(opener);
  });
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
  });
  const show = () => {
    document.body.append(dialog); dialog.showModal();
    if (!motionReduced()) entering = dialog.animate([
      { opacity: 0, transform: "translateY(10px) scale(.985)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ], { duration: 180, easing: "cubic-bezier(.22,.7,.2,1)" });
  };
  return { dialog, dismiss, show };
}
export const EVIDENCE_TEXT_LIMIT = 200000;
export async function loadEvidenceText(url: string): Promise<string> {
  try {
    const response = await api.getEvidence(url);
    if (!response.ok) throw new Error();
    const text = await response.text();
    return text.length > EVIDENCE_TEXT_LIMIT ? `${text.slice(0, EVIDENCE_TEXT_LIMIT)}\n… Download the file for the rest.` : text;
  } catch { return "This evidence could not be loaded."; }
}
export function openEvidence(stage: ViewerStage | undefined, ins: Insight | undefined): void {
  if (!stage || !ins?.evidence) return;
  forceHidePop();
  const evidence = ins.evidence;
  const { dialog, dismiss, show } = insightDialog("code-insight-dialog evidence-dialog", "evidence-title");
  const zoomed = new Set<number>(), failed = new Set<number>(), texts = new Map<number, string>();
  const items = evidence.attachments.map((attachment, index) => {
    const type = attachment.mediaType;
    return { attachment, index, url: api.evidenceUrl({ stage: stage.id, item: ins.id, index: String(index) }),
      type: type.startsWith("image/") ? "image" as const : type.startsWith("video/") ? "video" as const : type.startsWith("text/") || type === "application/json" ? "text" as const : "file" as const };
  });
  const model = ({ attachment, index, url, type }: typeof items[number]): EvidenceAttachmentView => ({ index, type, url, caption: attachment.caption || "", download: `${ins.id}-${index + 1}`,
    name: attachment.caption || `${evidenceKindLabel(evidence.kind) || "Evidence"} ${index + 1}`,
    failed: failed.has(index), zoomed: zoomed.has(index), text: texts.get(index) ?? null });
  const role = (value: "before" | "after") => items.filter((item) => item.attachment.role === value).map(model);
  const paint = () => renderLit(evidenceView({
    captured: new Date(evidence.capturedAt).toLocaleString(), kindLabel: (evidence.kind === "other" && ins.meta) || evidenceKindLabel(evidence.kind) || evidence.kind, title: ins.title,
    reproduction: evidence.reproduction || "", before: role("before"), after: role("after"),
    others: items.filter((item) => !item.attachment.role).map(model), inline: evidence.inline || "",
    criteria: evidence.specificationRefs.map((ref) => ({ ref, text: allAcceptance.find((item) => item.ref === ref)?.text || "" })),
    nodes: (ins.nodeRefs || []).map((id) => nodeTitleById.get(`${stage.id}:${id}`) || id),
    onZoom: (index) => { if (!zoomed.delete(index)) zoomed.add(index); paint(); },
    onFailed: (index) => { failed.add(index); paint(); },
    onClose: dismiss,
  }), dialog);
  paint();
  for (const item of items) if (item.type === "text") void loadEvidenceText(item.url).then((text) => { texts.set(item.index, text); paint(); });
  show();
}
