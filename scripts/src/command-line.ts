/** How every command group reads its command line: help, command, then options. */
import {
  cliApis,
  commandOptionNames,
  fullCommand,
  renderCliHelp,
  renderCommandHelp,
  type CliSignature,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  flag,
  parseArguments,
  type Options,
  type ParsedArguments,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";

function unknownCommand(api: CliSignature, words: readonly string[]): never {
  fail(`Unknown command: ${words.join(" ")}.\n\n${renderCliHelp(api)}`);
}

function groupHelp(api: CliSignature, options: Options): string {
  // A group may share its name with a workflow command, as `feedback` does,
  // whose --help the group answers.
  const workflow = cliApis.find((other) => !other.group);
  const namesake = api.group ? workflow?.commands.find(({ command }) => command === api.group) : undefined;
  if (options.has("help")) {
    const known = [...api.globalOptions ?? [], ...namesake?.options ?? []];
    assertKnownOptions(options, new Set(known.map(({ name }) => name)));
  }
  const also = workflow && namesake ? `\n\nWithout a command:\n\n${renderCommandHelp(workflow, namesake)}` : "";
  return `${renderCliHelp(api)}${also}`;
}

function commandHelp(api: CliSignature, words: readonly string[]): string {
  const typed = words.join(" ");
  const signature = api.commands.find(({ command }) => command === typed);
  const longer = api.commands.filter(({ command }) => command.startsWith(`${typed} `));
  if (!signature) {
    // The first words of a command, such as `stage`, list the commands.
    if (longer.length) return renderCliHelp(api);
    unknownCommand(api, words);
  }
  // `archive` is a command and also begins `archive landing` and `archive share`.
  const also = longer.map(({ command }) => `\n  ${api.executable} ${fullCommand(api, command)} [options]`).join("");
  return `${renderCommandHelp(api, signature)}${also ? `\n\nSee also:${also}` : ""}`;
}

/** Returns the command with its validated options, or null once help is printed.
 * Reads nothing from the repository, so help also works outside one. */
export function readCommandLine(api: CliSignature, argv: string[], cwd: string): ParsedArguments | null {
  const { positionals, options } = parseArguments(argv);
  const helpCommand = positionals[0] === "help";
  if (!positionals.length || helpCommand || options.has("help")) {
    flag(options, "help");
    const words = helpCommand ? positionals.slice(1) : positionals;
    console.log(words.length ? commandHelp(api, words) : groupHelp(api, options));
    return null;
  }
  // `archive landing` is one command, not `archive` with an argument.
  const signature = [positionals.slice(0, 2).join(" "), positionals[0]]
    .map((name) => api.commands.find(({ command }) => command === name))
    .find((found) => found !== undefined);
  if (!signature) unknownCommand(api, positionals);
  const { command } = signature;
  const commandWords = command.split(" ").length;
  if (positionals.length > commandWords) {
    // In a group, a second word is a mistyped subcommand, as in `archive landed`.
    if (api.group && commandWords === 1) unknownCommand(api, positionals);
    fail(`Unexpected positional arguments: ${positionals.slice(commandWords).join(" ")}.`);
  }
  const allowedFor = (kind: string | undefined) =>
    (kind === undefined ? undefined : signature.optionsForKind?.(kind)) ?? commandOptionNames(api, command);
  const expanded = expandInputOptions(options, cwd, allowedFor);
  const kind = expanded.get("kind")?.[0];
  assertKnownOptions(expanded, allowedFor(typeof kind === "string" ? kind : undefined));
  return { positionals, options: expanded };
}
