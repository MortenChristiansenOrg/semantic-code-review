// The whole page as one lit template. Regions not yet migrated are applied
// from legacy HTML strings, which keep their existing DOM between renders.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { agentBarView, type AgentBarView } from "./agent-bar";
import { coverageView, type CoverageView } from "./coverage";
import { legacyHtml } from "./legacy-html";
import { noticesView, type NoticesView } from "./notices";
import { scrimView } from "./scrim";
import { storyView, type StoryView } from "./story";
import { topbarView, type TopbarView } from "./topbar";

export interface PageView {
  topbar: TopbarView;
  /** Absent for remote reviews and before the agent status is known. */
  agentBar: AgentBarView | null;
  notices: NoticesView;
  story: StoryView;
  coverage: CoverageView;
  /** The notes side panel, as legacy HTML. */
  notes: string;
}

export function pageView(view: PageView): TemplateResult {
  return html`${topbarView(view.topbar)}${view.agentBar ? agentBarView(view.agentBar) : nothing}${noticesView(view.notices)}
      <main class="shell v-cinema">${storyView(view.story)}</main>
      ${coverageView(view.coverage)}${legacyHtml(view.notes)}
      ${scrimView(view.coverage.open || view.topbar.notesOpen)}`;
}

/** Renders the page into `container`, or clears it when `view` is null. */
export function renderPage(container: HTMLElement, view: PageView | null): void {
  render(view ? pageView(view) : nothing, container);
}
