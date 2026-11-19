// Decorative icons shared by the page's templates.
import { html } from "lit-html";

/** A speech bubble: feedback threads. */
export const bubbleIcon = html`<svg class="bub" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;

/** A personal (browser-local) note, distinct from a feedback conversation. */
export const noteIcon = html`<svg class="tico" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13.5 3.5V8h4.5M9.5 12.5h6M9.5 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Two check marks: approving a group of files. */
export const doubleCheckIcon = html`<svg class="tico" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M2.5 12.5l4.5 4.5 9-10M11.5 16l1 1 9-10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** A downward chevron on disclosures. */
export const caretIcon = html`<svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** An arrow: jumps to what a note or thread is about. */
export const arrowIcon = html`<svg class="tico" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
