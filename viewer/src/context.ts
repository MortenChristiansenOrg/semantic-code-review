// What the page is given when it loads: the implementation it reviews and the
// element it renders into.
import type { ImplementationData, ReviewContext, UnavailableImplementationData } from "../../scripts/src/shared/viewer-protocol";
import type { ViewerData } from "./types";

declare global {
  interface Window {
    /** Written by `implementation-data.js`. */
    SEMANTIC_IMPLEMENTATION: ImplementationData | UnavailableImplementationData;
    SEMANTIC_REVIEW_CONTEXT?: ReviewContext;
  }
}

const loaded = window.SEMANTIC_IMPLEMENTATION;
/** The implementation the page shows. An unavailable review shows no stages,
 * and its first poll loads the implementation, as no revision matches. */
export const data: ViewerData = "viewerRevision" in loaded ? loaded
  : { ...loaded, remote: null, skillVersion: null, viewerRevision: "", awaitingAgentReplies: 0 };

function appElement(): HTMLElement {
  const element = document.querySelector("#app");
  if (!(element instanceof HTMLElement)) throw new Error("The viewer page has no #app element.");
  return element;
}
export const app = appElement();
