import { html, type TemplateResult } from "lit-html";

/** Dims the page behind an open side panel; clicking it closes the panels. */
export function scrimView(on: boolean): TemplateResult {
  return html`<div class="scrim ${on ? "is-on" : ""}" data-action="close-panels"></div>`;
}
