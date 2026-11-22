#!/usr/bin/env node
/** The semantic-flow executable. Workflow commands run directly; the
 * implementation, feedback and viewer groups load their module on first use. */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { parseArguments } from "./shared/arguments.js";
import { isolateGitEnvironment } from "./shared/git.js";
import { errorMessage } from "./shared/narrow.js";

/** The group a command line selects. `feedback` with only options, such as
 * `feedback --wait --json`, is the workflow command that collects pending
 * feedback; `feedback <command>` is the feedback group, wherever its options
 * stand. Both parse their arguments this way, so they agree on the positionals. */
function commandGroup(argv: readonly string[]): "implementation" | "feedback" | "viewer" | null {
  const [first, ...rest] = argv;
  if (first === "implementation" || first === "viewer") return first;
  if (first === "feedback") {
    const { positionals, options } = parseArguments(rest);
    if (positionals.length > 0 || options.has("help")) return "feedback";
  }
  return null;
}

async function main(typed: string[]): Promise<void> {
  // `help <group> [command]` is that group's own help.
  const [first, named, ...rest] = typed;
  const argv = first === "help" && (named === "implementation" || named === "feedback") ? [named, "help", ...rest] : typed;
  const group = commandGroup(argv);
  if (group === "implementation") return (await import("./semantic-implementation.js")).runImplementationCommand(argv.slice(1));
  if (group === "feedback") return (await import("./review-feedback.js")).runFeedbackCommand(argv.slice(1));
  if (group === "viewer") return (await import("./semantic-view.js")).runViewerCommand(argv.slice(1));
  return (await import("./semantic-flow.js")).runWorkflowCommand(argv);
}

if (isMainThread) {
  // Every command acts on the repository it selects, whatever Git variables a
  // hook or `git rebase --exec` left in the caller's environment.
  isolateGitEnvironment();
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
