import { html, nothing, type TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { commentBody } from "./comment-body";

/** The agent works through a round of threads. */
export interface AgentWorkingView {
  kind: "working";
  total: number;
  answered: number;
  note: string;
  /** Whole minutes the round has run; 0 hides the duration. */
  minutes: number;
  /** Threads waiting for the next round. */
  queued: number;
  stopRequested: boolean;
}

/** Feedback waits while no agent listens. */
export interface AgentWaitingView {
  kind: "waiting";
  queued: number;
  command: string;
  commandCopied: boolean;
}

export interface TargetRefreshView {
  targetBranch: string;
  previousBaseRevision: string;
  baseRevision: string;
}

export interface AgentQuestionView {
  id: string;
  body: string;
  choices: readonly string[];
  /** The reviewer's unsent answer. */
  answer: string;
  busy: boolean;
  error: string;
}

export interface AgentBarView {
  status: AgentWorkingView | AgentWaitingView | null;
  targetRefresh: TargetRefreshView | null;
  questions: readonly AgentQuestionView[];
  /** Every question is minimized. */
  questionsMinimized: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function statusBar(status: AgentWorkingView | AgentWaitingView): TemplateResult {
  if (status.kind === "working") {
    const parts = [`${status.answered} of ${status.total} answered`, status.note,
      status.minutes ? `${status.minutes} min` : "", status.queued ? `${status.queued} queued for the next round` : ""].filter(Boolean);
    return html`<div class="agent-bar is-working" role="status"><strong>Agent working on ${plural(status.total, "thread")}</strong><span>${parts.join(" · ")}</span>${status.stopRequested ? html`<span>Stops after this round</span>` : nothing}</div>`;
  }
  return html`<div class="agent-bar is-offline" role="status"><strong>${plural(status.queued, "thread")} waiting for an agent</strong>
        <span>Run <code>${status.command}</code> in your agent to have feedback handled as you send it.</span>
        <button class="tb-btn" data-action="copy-agent-command" type="button">${status.commandCopied ? "Copied" : "Copy command"}</button></div>`;
}

function targetRefreshBar(refresh: TargetRefreshView): TemplateResult {
  return html`<div class="agent-bar is-refreshed" role="status"><strong>Moved onto the latest ${refresh.targetBranch}</strong>
      <span>The implementation was restacked from ${refresh.previousBaseRevision.slice(0, 12)} to ${refresh.baseRevision.slice(0, 12)}. Files the target branch changed may show stale approvals, but those edits are not review corrections.</span>
      <button class="tb-btn" data-action="dismiss-target-refresh" type="button">Dismiss</button></div>`;
}

function agentQuestion(question: AgentQuestionView): TemplateResult {
  return html`<section class="agent-question" aria-label="Question from the agent">
      <p class="comment-body">${commentBody(question.body)}</p>
      ${question.choices.length ? html`<div class="agent-choices">${question.choices.map((choice, index) => html`<button class="tb-btn" type="button" data-action="agent-choice" data-id=${question.id} data-choice=${index} ?disabled=${question.busy}>${choice}</button>`)}</div>` : nothing}
      <form class="agent-answer" data-agent-answer data-id=${question.id}>
        <textarea name="agent-answer-${question.id}" rows="3" placeholder=${question.choices.length ? "Or write a different answer…" : "Write your answer…"} ?disabled=${question.busy} .value=${live(question.answer)}></textarea>
        <div class="nc-actions"><button class="nc-save" type="submit" ?disabled=${question.busy}>${question.busy ? "Sending…" : "Send answer"}</button></div>
      </form>
      ${question.error ? html`<p class="tthread-err">${question.error}</p>` : nothing}
    </section>`;
}

function agentQuestions(questions: readonly AgentQuestionView[], minimized: boolean): TemplateResult | typeof nothing {
  if (!questions.length) return nothing;
  const heading = `The agent needs your answer${questions.length > 1 ? ` (${questions.length})` : ""}`;
  if (minimized) return html`<button class="agent-questions-show" data-action="show-agent-questions" type="button">${heading} · Show</button>`;
  return html`<div class="agent-questions" role="region" aria-label="Questions from the agent">
      <div class="agent-questions-h"><p class="agent-question-h">${heading}</p>
        <button class="tb-btn" data-action="minimize-agent-questions" type="button" title="Hide the question to read the review. It stays waiting for your answer.">Minimize</button></div>
      ${repeat(questions, (question) => question.id, agentQuestion)}</div>`;
}

// Round progress, an offline prompt when feedback waits, and the agent's questions.
export function agentBarView(view: AgentBarView): TemplateResult {
  return html`${view.status ? statusBar(view.status) : nothing}${view.targetRefresh ? targetRefreshBar(view.targetRefresh) : nothing}${agentQuestions(view.questions, view.questionsMinimized)}`;
}
