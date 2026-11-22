/** How every command group reads its command line: help, command, then options. */
import {
  cliApis,
  commandOptionNames,
  renderCliHelp,
  renderCommandHelp,
  type CliSignature,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  flag,
  parseArguments,
  type ParsedArguments,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";

function unknownCommand(api: CliSignature, words: readonly string[]): never {
  fail(`Unknown command: ${words.join(" ")}.\n\n${renderCliHelp(api)}`);
}

function helpText(api: CliSignature, words: readonly string[]): string {
  if (!words.length) {
    // A group may share its name with a workflow command, as `feedback` does,
    // whose --help the group answers.
    const workflow = cliApis.find((other) => !other.group);
    const namesake = api.group ? workflow?.commands.find(({ command }) => command === api.group) : undefined;
    const also = workflow && namesake ? `\n\nWithout a command:\n\n${renderCommandHelp(workflow, namesake)}` : "";
    return `${renderCliHelp(api)}${also}`;
  }
  const typed = words.join(" ");
  const signature = api.commands.find(({ command }) => command === typed);
  if (signature) return renderCommandHelp(api, signature);
  // The first words of a command, such as `stage`, list the commands.
  if (api.commands.some(({ command }) => command.startsWith(`${typed} `))) return renderCliHelp(api);
  unknownCommand(api, words);
}

/** Returns the command with its validated options, or null once help is printed.
 * Reads nothing from the repository, so help also works outside one. */
export function readCommandLine(api: CliSignature, argv: string[], cwd: string): ParsedArguments | null {
  const { positionals, options } = parseArguments(argv);
  const helpCommand = positionals[0] === "help";
  if (!positionals.length || helpCommand || options.has("help")) {
    flag(options, "help");
    console.log(helpText(api, helpCommand ? positionals.slice(1) : positionals));
    return null;
  }
  // `archive landing` is one command, not `archive` with an argument.
  const command = [positionals.slice(0, 2).join(" "), positionals[0]]
    .find((name) => api.commands.some((signature) => signature.command === name));
  if (command === undefined) unknownCommand(api, positionals);
  const extra = positionals.slice(command.split(" ").length);
  if (extra.length) fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  const allowed = commandOptionNames(api, command);
  const expanded = expandInputOptions(options, cwd, allowed);
  assertKnownOptions(expanded, allowed);
  return { positionals, options: expanded };
}
