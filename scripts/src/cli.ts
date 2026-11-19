#!/usr/bin/env node
/** The semantic-flow executable. Workflow commands run directly; the
 * implementation, feedback and viewer groups load their module on first use. */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { errorMessage } from "./shared/narrow.js";

/** The group a command line selects. A bare `feedback` is the workflow command
 * that collects pending feedback; `feedback <command>` is the feedback group. */
function commandGroup(argv: readonly string[]): "implementation" | "feedback" | "viewer" | null {
  const [first, second] = argv;
  if (first === "implementation" || first === "viewer") return first;
  if (first === "feedback" && second !== undefined && (second === "--help" || !second.startsWith("--"))) return "feedback";
  return null;
}

async function main(argv: string[]): Promise<void> {
  const group = commandGroup(argv);
  if (group === "implementation") return (await import("./semantic-implementation.js")).runImplementationCommand(argv.slice(1));
  if (group === "feedback") return (await import("./review-feedback.js")).runFeedbackCommand(argv.slice(1));
  if (group === "viewer") return (await import("./semantic-view.js")).runViewerCommand(argv.slice(1));
  return (await import("./semantic-flow.js")).runWorkflowCommand(argv);
}

if (isMainThread) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
} else {
  // The viewer's data source runs in worker threads started from this file.
  await import("./semantic-view.js");
}
