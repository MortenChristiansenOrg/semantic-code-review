// Insight kinds, their order and labels, and the reviewer's reading marks on them.
import type { ChangeNode, EvidenceKind, Insight, InsightType } from "../../scripts/src/shared/viewer-protocol";
import { insightKey } from "./lookups";
import { state } from "./state";
import type { ViewerStage } from "./types";
import type { InsightReview } from "./views/insights";

export interface InsightKindInfo {
  glyph: string;
  label: string;
}

export const INSIGHT: Record<InsightType, InsightKindInfo> = {
  decision:    { glyph: "◆", label: "Decision" },
  assumption:  { glyph: "◇", label: "Assumption" },
  risk:        { glyph: "△", label: "Risk" },
  validation:  { glyph: "✓", label: "Check" },
  lesson:      { glyph: "↺", label: "Lesson" },
  alternative: { glyph: "⇄", label: "Alternative" },
  evidence:    { glyph: "▣", label: "Evidence" },
  question:    { glyph: "?", label: "Open question" }
};
export const INSIGHT_ORDER: InsightType[] = ["decision", "assumption", "risk", "lesson", "alternative", "validation", "evidence", "question"];

/* ---- reasoning tags (the signature) ----------------------------------- */
export interface ValidationStatus extends InsightKindInfo {
  key: "failed" | "notrun" | "passed";
}
export function vstatus(ins: Insight): ValidationStatus | null {
  if (ins.type !== "validation") return null;
  const s = String(ins.meta || "").toLowerCase();
  if (s === "failed") return { key: "failed", glyph: "✕", label: "Check failed" };
  if (s === "not-run" || s === "notrun" || s === "skipped")
    return { key: "notrun", glyph: "○", label: "Check not run" };
  return { key: "passed", glyph: "✓", label: "Check passed" };
}
export function insightSort(list: Insight[]): Insight[] {
  return list.slice().sort((a, b) => INSIGHT_ORDER.indexOf(a.type) - INSIGHT_ORDER.indexOf(b.type));
}
export function validationTypeLabel(type: string | undefined): string {
  return type === "automated" ? "Automated"
    : type === "manual" ? "Manual"
    : type === "analysis" ? "Analysis"
    : "";
}

const EVIDENCE_KIND: Record<EvidenceKind, string> = { screenshot: "Screenshot", recording: "Recording", terminal: "Terminal output", http: "HTTP exchange", log: "Log excerpt", "output-file": "Output file", measurement: "Measurement", report: "Report", other: "Evidence" };
const evidenceKindLabels = new Map<string, string>(Object.entries(EVIDENCE_KIND));
/** The label of an evidence kind; undefined for a kind this viewer does not know. */
export const evidenceKindLabel = (kind: string | undefined): string | undefined => kind === undefined ? undefined : evidenceKindLabels.get(kind);
// Evidence of a kind this viewer does not know arrives as "other"; its insight's meta holds the recorded kind.
export function fileCodeInsights(stage: ViewerStage, filePath: string | undefined): Insight[] {
  return stage.insights.filter(ins => ins.codeTarget && (ins.codeTarget.path === filePath || ins.codeTarget.original.path === filePath));
}
// Reviewed marks are personal reading progress, kept apart from approvals. The
// stored fingerprint reveals an insight rewritten after it was marked.
export function insightFingerprint(ins: Insight): string {
  const text = JSON.stringify([ins.type, ins.title, ins.body, ins.meta, ins.validationType, ...(ins.evidence ? [ins.evidence.attachments.map((item) => item.sha256), ins.evidence.inline] : [])]);
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0");
}
export function insightReviewState(stage: ViewerStage, ins: Insight): InsightReview {
  const record = state.insightReviews[insightKey(stage.id, ins.collection, ins.id)];
  if (!record) return "none";
  return record.fingerprint === insightFingerprint(ins) ? "reviewed" : "changed";
}
export const INSIGHT_REVIEW: Record<InsightReview, { mark: string; text: string; tooltip: string }> = {
  none: { mark: "", text: "Not reviewed", tooltip: "Not reviewed – click to mark as reviewed" },
  reviewed: { mark: "✓", text: "Reviewed", tooltip: "Reviewed – click to mark as not reviewed" },
  changed: { mark: "!", text: "Changed since reviewed", tooltip: "Changed since reviewed – click to mark as reviewed" }
};
// Evidence linked to several nodes hosts its one thread under the first of them.
export const hostsEvidenceThread = (ins: Insight, node: ChangeNode): boolean => Boolean(ins.evidence) && ins.nodeRefs?.[0] === node.id;
