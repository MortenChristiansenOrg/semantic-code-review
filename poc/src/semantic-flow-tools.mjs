import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptsDirectory = path.resolve(
  sourceDirectory,
  "..",
  "..",
  "skills",
  "semantic-flow",
  "scripts",
);

export const semanticReviewCli = path.join(
  scriptsDirectory,
  "semantic-review.mjs",
);
export const reviewFeedbackCli = path.join(
  scriptsDirectory,
  "review-feedback.mjs",
);
