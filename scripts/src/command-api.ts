import { INSIGHT_COLLECTIONS } from "./shared/documents.js";
import { EVIDENCE_EXTENSIONS } from "./shared/evidence.js";

export interface OptionSignature {
  name: string;
  value?: string;
  required?: boolean;
  repeatable?: boolean;
  /** What help adds to the option: when it is required, or what it accepts. */
  note?: string;
}

export interface CommandSignature {
  command: string;
  options?: OptionSignature[];
  /** The options the command takes for a `--kind`, where that narrows them. */
  optionsForKind?: (kind: string) => ReadonlySet<string>;
}

/** The one CLI executable; every command group runs inside it. */
export const CLI_EXECUTABLE = "semantic-flow.mjs";

export interface CliSignature {
  executable: typeof CLI_EXECUTABLE;
  /** Command group that prefixes every command, or null for the workflow commands. */
  group: string | null;
  title: string;
  commands: CommandSignature[];
  globalOptions?: OptionSignature[];
}

const option = (
  name: string,
  value?: string,
  settings: Omit<OptionSignature, "name" | "value"> = {},
): OptionSignature => ({ name, value, ...settings });

/** The options each `stage record` kind adds to the common ones. */
const insightKinds: Record<string, { required: readonly string[]; optional?: readonly string[] }> = {
  decision: { required: ["category", "summary", "rationale"] },
  assumption: { required: ["statement", "risk-if-wrong"] },
  alternative: { required: ["approach", "reason-rejected"] },
  "failed-attempt": { required: ["approach", "outcome", "lesson"] },
  risk: { required: ["summary"], optional: ["mitigation"] },
  question: { required: ["question"] },
};

export const INSIGHT_KINDS: readonly string[] = Object.keys(insightKinds);

/** An option that only some insight kinds take. */
function kindOption(name: string, value: string): OptionSignature {
  const requiredBy = INSIGHT_KINDS.filter((kind) => insightKinds[kind].required.includes(name));
  const takenBy = INSIGHT_KINDS.filter((kind) => insightKinds[kind].optional?.includes(name));
  const note = requiredBy.length ? `required for --kind ${requiredBy.join(" or ")}` : `only for --kind ${takenBy.join(" or ")}`;
  return option(name, value, { note });
}

const collectionValues = `<${INSIGHT_COLLECTIONS.join("|")}>`;
const stageWithFinalized = { note: "required with --finalized" };
const messageContent = { note: "--body or --attachments is required" };
const evidenceContent = { note: "one of --file, --before, --after or --inline is required" };
const evidenceFile = { repeatable: true, note: `${evidenceContent.note}; file types: ${EVIDENCE_EXTENSIONS.join(", ")}` };
/** The feedback round a command acts for; see roundRefusal. */
const roundClaim = option("claim", "<claim-id>", { note: "required while an agent listens to the review" });
/** The feedback round an implementation change belongs to; see roundRefusal. */
const roundChange = option("claim", "<claim-id>", { note: "the feedback round this change belongs to; required while a listening agent answers a round" });
const restackAction = { note: "exactly one of --from, --base, --continue or --abort is required" };
const releaseChoice = "not with --source";
const nodeRefs = option("node-ref", "<node-id>", { repeatable: true, note: "required once the stage is organized, unless --replace keeps the recorded nodes" });
const codeTargetOptions: OptionSignature[] = [
  option("code-path", "<repository-path>", { note: "required with --code-start or --code-end" }),
  option("code-start", "<line>", { note: "required with --code-path" }),
  option("code-end", "<line>", { note: "defaults to --code-start" }),
];

const specificationOptions: OptionSignature[] = [
  option("specification-id", "<id>", { required: true }),
  option("specification-title", "<title>", { required: true }),
  option("specification-summary", "<summary>", { required: true }),
  option("source-kind", "<kind>", { required: true }),
  option("source-reference", "<reference>", { required: true }),
  option("source-url", "<url>", { note: "required for --source-kind url" }),
  option("criterion", "<id>=<text>", { required: true, repeatable: true }),
];

export const semanticImplementationApi: CliSignature = {
  executable: CLI_EXECUTABLE,
  group: "implementation",
  title: "Semantic implementation artifact commands",
  globalOptions: [option("help"), option("input", "<json-file>")],
  commands: [
    {
      command: "init",
      options: [
        option("implementation-id", "<id>", { required: true }),
        option("title", "<title>", { required: true }),
        option("summary", "<summary>", { required: true }),
        option("base-revision", "<revision>"),
        option("target-branch", "<branch>", { required: true }),
        option("branch-prefix", "<prefix>"),
        ...specificationOptions,
      ],
    },
    { command: "specification add", options: [...specificationOptions, roundChange] },
    {
      command: "stage begin",
      options: [
        option("json"),
        option("id", "<stage-id>", { required: true }),
        option("title", "<title>", { required: true }),
        option("summary", "<summary>", { required: true }),
        option("rationale", "<text>", { required: true }),
        option("depends-on", "<stage-id>", { repeatable: true }),
        option("specification-ref", "<specification-id>#<criterion-id>", {
          required: true,
          repeatable: true,
        }),
        roundChange,
      ],
    },
    { command: "stage record-batch", options: [option("stage", "<stage-id>", stageWithFinalized), option("finalized"), option("items", "<json-array>", { required: true, note: "a plain array in --input JSON; each item takes the options of stage record, or of stage validation with kind validation, except stage, finalized and claim, which belong outside the items" }), roundChange] },
    { command: "stage plan", options: [option("stage", "<stage-id>", stageWithFinalized), option("finalized"), option("selectors")] },
    {
      command: "stage set",
      options: [
        option("id", "<stage-id|current>", stageWithFinalized),
        option("finalized"),
        option("title", "<title>", { note: "at least one option to update is required" }),
        option("summary", "<summary>"),
        option("rationale", "<text>"),
        option("depends-on", "<stage-id>", { repeatable: true }),
        option("specification-ref", "<specification-id>#<criterion-id>", {
          repeatable: true,
        }),
        roundChange,
      ],
    },
    {
      command: "stage record",
      optionsForKind: (kind) => insightOptionNames(kind),
      options: [
        option("stage", "<stage-id|current>", stageWithFinalized),
        option("kind", `<${INSIGHT_KINDS.join("|")}>`, { required: true }),
        option("item-id", "<id>", { required: true }),
        option("replace"),
        option("finalized"),
        ...codeTargetOptions,
        kindOption("category", "<specification|engineering>"),
        kindOption("summary", "<text>"),
        kindOption("rationale", "<text>"),
        kindOption("statement", "<text>"),
        kindOption("risk-if-wrong", "<text>"),
        kindOption("approach", "<text>"),
        kindOption("reason-rejected", "<text>"),
        kindOption("outcome", "<text>"),
        kindOption("lesson", "<text>"),
        kindOption("mitigation", "<text>"),
        kindOption("question", "<text>"),
        nodeRefs,
        roundChange,
      ],
    },
    {
      command: "stage target",
      options: [option("stage", "<stage-id|current>", stageWithFinalized), option("finalized"),
        option("collection", collectionValues, { required: true }), option("item-id", "<id>", { required: true }),
        option("remove", undefined, { note: "not with --code-path, --code-start or --code-end" }),
        option("code-path", "<repository-path>", { note: "required without --remove" }),
        option("code-start", "<line>", { note: "required without --remove" }),
        option("code-end", "<line>", { note: "defaults to --code-start" }), roundChange],
    },
    {
      command: "stage organize",
      options: [
        option("stage", "<stage-id|current>", stageWithFinalized),
        option("file", "<json-file>", { required: true }),
        option("finalized"),
        roundChange,
      ],
    },
    {
      command: "stage validation",
      options: [
        option("stage", "<stage-id|current>", stageWithFinalized),
        option("item-id", "<id>", { required: true }),
        option("type", "<automated|manual|analysis>", { required: true }),
        option("status", "<passed|failed|not-run>", { required: true }),
        option("summary", "<text>", { required: true }),
        option("command", "<command>", { note: "required for --type automated" }),
        nodeRefs,
        option("replace"),
        option("finalized"),
        ...codeTargetOptions,
        roundChange,
      ],
    },
    {
      command: "stage evidence",
      options: [
        option("stage", "<stage-id|current>", stageWithFinalized),
        option("item-id", "<id>", { required: true }),
        option("kind", "<screenshot|recording|terminal|http|log|output-file|measurement|report>", { required: true }),
        option("summary", "<text>", { required: true }),
        option("file", "<path>[=<caption>]", evidenceFile),
        option("before", "<path>[=<caption>]", evidenceFile),
        option("after", "<path>[=<caption>]", evidenceFile),
        option("inline", "<text>", evidenceContent),
        option("reproduction", "<text>"),
        option("specification-ref", "<specification-id>#<criterion-id>", { repeatable: true }),
        nodeRefs,
        option("replace"),
        option("finalized"),
        ...codeTargetOptions,
        roundChange,
      ],
    },
    { command: "stage evidence-remove", options: [option("stage", "<stage-id|current>", stageWithFinalized), option("item-id", "<id>", { required: true }), option("finalized"), roundChange] },
    { command: "stage no-evidence", options: [option("stage", "<stage-id|current>", stageWithFinalized), option("reason", "<text>", { note: "required without --remove" }), option("remove", undefined, { note: "not with --reason" }), option("finalized"), roundChange] },
    {
      command: "stage finish",
      options: [option("json"), option("id", "<stage-id|current>"), roundChange],
    },
    {
      command: "stage discard",
      options: [option("id", "<stage-id|current>"), roundChange],
    },
    {
      command: "stage remove",
      options: [option("json"), option("id", "<stage-id>", { required: true }), option("implementation-id", "<implementation-id>"), roundChange],
    },
    {
      command: "restack",
      options: [
        option("from", "<stage-id>", restackAction),
        option("base", "<revision>", restackAction),
        option("continue", undefined, restackAction),
        option("abort", undefined, restackAction),
        option("json"),
        roundChange,
      ],
    },
    { command: "publish", options: [option("message", "<commit-message>")] },
    { command: "export", options: [option("destination", "<directory>")] },
    {
      command: "validate-stack",
      options: [option("json")],
    },
    {
      command: "prepare-branch",
      options: [
        option("branch", "<branch-name>", { note: "required for the first preparation and with --rebind" }),
        option("adopt"),
        option("rebind"),
      ],
    },
    {
      command: "archive",
      options: [
        option("landed", "<revision|base..head>"),
        option("message", "<commit-message>"),
      ],
    },
    {
      command: "archive landing",
      options: [
        option("id", "<implementation-id>", { required: true }),
        option("landed", "<revision|base..head>"),
      ],
    },
    {
      command: "archive share",
      options: [
        option("id", "<implementation-id>", { required: true }),
        option("message", "<tag-message>"),
      ],
    },
    {
      command: "validate",
      options: [option("schema-only", undefined, { note: "not with --publish" }), option("publish", undefined, { note: "not with --schema-only" })],
    },
  ],
};

export const reviewFeedbackApi: CliSignature = {
  executable: CLI_EXECUTABLE,
  group: "feedback",
  title: "Semantic review feedback commands",
  globalOptions: [option("help"), option("input", "<json-file>")],
  commands: [
    { command: "init" },
    { command: "attachment add", options: [option("file", "<local-file>", { required: true }), option("media-type", "<type>")] },
    { command: "attachment show", options: [option("id", "<attachment-id>", { required: true })] },
    {
      command: "thread add",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>", { required: true }),
        option("body", "<text>", messageContent),
        option("attachments", "<attachment-id>", { repeatable: true, ...messageContent }),
        option("label", "<text>", { required: true }),
        option(
          "target-kind",
          "<specification|criterion|stage|node|insight|file|line>",
          { required: true },
        ),
        option("specification", "<specification-id>", { note: "required for --target-kind specification or criterion" }),
        option("criterion", "<criterion-id>", { note: "required for --target-kind criterion" }),
        option("stage", "<stage-id>", { note: "required for --target-kind stage, node, insight, file or line" }),
        option("node", "<node-id>", { note: "required for --target-kind node" }),
        option("collection", collectionValues, { note: "required for --target-kind insight" }),
        option("item", "<item-id>", { note: "required for --target-kind insight" }),
        option("path", "<repository-path>", { note: "required for --target-kind file or line" }),
        option("side", "<old|new>", { note: "required for --target-kind line" }),
        option("line", "<positive-integer>", { note: "required for --target-kind line" }),
        option("assigned-stage", "<stage-id>", { note: "required for --target-kind specification or criterion; otherwise defaults to --stage" }),
      ],
    },
    {
      command: "thread add-batch",
      options: [option("threads", "<json-array>", { required: true, note: "a plain array in --input JSON; each item takes the options of thread add, named in kebab-case" }), option("partial")],
    },
    {
      command: "next",
      options: [option("json", undefined, { note: "required with --compact or --claim" }), option("compact"), option("claim", undefined, { note: "required with --session" }), option("session", "<session-id>")],
    },
    {
      command: "thread reply",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>", { required: true }),
        option("body", "<text>", messageContent),
        option("attachments", "<attachment-id>", { repeatable: true, ...messageContent }),
        option("author", "<user|agent>", { note: "defaults to user" }),
        option("claim", "<claim-id>", { note: "only with --author agent" }),
      ],
    },
    {
      command: "thread reply-batch",
      options: [option("replies", "<json-array>", { required: true, note: "a plain array in --input JSON; each item takes the options of thread reply, named in kebab-case" }), option("partial"), option("claim", "<claim-id>")],
    },
    {
      command: "thread resolve",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>", { note: "required with --body" }),
        option("body", "<text>", { note: "required with --comment-id" }),
      ],
    },
    {
      command: "thread reopen",
      options: [option("id", "<thread-id>", { required: true })],
    },
    {
      command: "validate",
      options: [option("require-resolved")],
    },
    {
      command: "agent ask",
      options: [
        option("id", "<request-id>", { required: true, note: "lowercase and hyphenated, up to 80 characters" }),
        option("body", "<text>", { required: true, note: "up to 4000 characters" }),
        option("choice", "<text>", { repeatable: true, note: "up to six, each up to 200 characters" }),
        roundClaim,
      ],
    },
    { command: "agent progress", options: [option("body", "<text>", { required: true, note: "up to 200 characters" }), roundClaim] },
  ],
};

const projectSelectionOptions: OptionSignature[] = [
  option("project", "<repository-path>"),
  option("implementation-id", "<implementation-id>"),
];

export const semanticFlowApi: CliSignature = {
  executable: CLI_EXECUTABLE,
  group: null,
  title: "Semantic flow",
  globalOptions: [option("help"), option("input", "<json-file>")],
  commands: [
    {
      command: "inspect",
      options: [...projectSelectionOptions, option("json")],
    },
    {
      command: "validate",
      options: [...projectSelectionOptions, option("publish"), option("stack"), option("json")],
    },
    {
      command: "prepare",
      options: [...projectSelectionOptions, option("branch", "<branch>"), option("json")],
    },
    {
      command: "archive",
      options: [...projectSelectionOptions, option("landed", "<revision|base..head>"), option("json")],
    },
    {
      command: "status",
      options: [...projectSelectionOptions, option("json")],
    },
    {
      command: "review",
      options: [...projectSelectionOptions, option("branch", "<branch-name>", { note: "not with --implementation-id" })],
    },
    {
      command: "feedback",
      options: [...projectSelectionOptions, option("json", undefined, { note: "required with --wait" }), option("wait", undefined, { note: "required with --session or --timeout" }), option("session", "<session-id>"), option("timeout", "<seconds>", { note: "1 to 86400" })],
    },
    {
      command: "sync",
      options: [...projectSelectionOptions, option("local"), option("json")],
    },
    {
      command: "refresh-target",
      options: [option("project", "<repository-path>"), option("target-branch", "<branch>", { required: true }), option("json")],
    },
    {
      command: "version",
      options: [option("json")],
    },
    {
      command: "update",
      options: [
        option("version", "<version>", { note: `required with --allow-downgrade; ${releaseChoice}` }),
        option("allow-downgrade", undefined, { note: releaseChoice }),
        option("prerelease", undefined, { note: releaseChoice }),
        option("source", "<repository-path>", { note: "required with --use-current-source" }),
        option("use-current-source"),
      ],
    },
  ],
};

export const cliApis = [
  semanticImplementationApi,
  reviewFeedbackApi,
  semanticFlowApi,
] as const;

/** The command as typed after the executable, including its group. */
export function fullCommand(api: CliSignature, command: string): string {
  return api.group ? `${api.group} ${command}` : command;
}

export function commandOptionNames(
  api: CliSignature,
  command: string,
): ReadonlySet<string> {
  const signature = api.commands.find(
    (candidate) => candidate.command === command,
  );
  if (!signature) {
    throw new Error(`Missing command signature: ${api.executable} ${fullCommand(api, command)}`);
  }
  return new Set((signature.options ?? []).map((candidate) => candidate.name));
}

/** The keys one `stage record-batch` item may have. Its kind narrows them;
 * without a usable kind, an item may have those of any kind. */
export function batchItemKeys(kind: string | undefined): ReadonlySet<string> {
  const outside = (name: string) => name !== "stage" && name !== "finalized" && name !== "claim";
  const validation = ["kind", ...commandOptionNames(semanticImplementationApi, "stage validation")].filter(outside);
  if (kind === "validation") return new Set(validation);
  if (kind !== undefined && INSIGHT_KINDS.includes(kind)) return new Set([...insightOptionNames(kind)].filter(outside));
  return new Set([...[...commandOptionNames(semanticImplementationApi, "stage record")].filter(outside), ...validation]);
}

/** The options `stage record` takes for one kind. */
export function insightOptionNames(kind: string): ReadonlySet<string> {
  if (!INSIGHT_KINDS.includes(kind)) return commandOptionNames(semanticImplementationApi, "stage record");
  const specific = (name: string) => INSIGHT_KINDS.filter((candidate) =>
    [...insightKinds[candidate].required, ...insightKinds[candidate].optional ?? []].includes(name));
  return new Set([...commandOptionNames(semanticImplementationApi, "stage record")].filter((name) => {
    const kinds = specific(name);
    return !kinds.length || kinds.includes(kind);
  }));
}

function optionUsage(signature: OptionSignature): string {
  const value = signature.value ? ` ${signature.value}` : "";
  return `--${signature.name}${value}${signature.repeatable ? " ..." : ""}`;
}

export function renderCliHelp(api: CliSignature): string {
  const groups = api.group ? [] : cliApis.filter((other) => other.group).map((other) => `  ${api.executable} ${other.group} <command> [options]`);
  return [
    api.title,
    "",
    "Usage:",
    ...api.commands.map(
      ({ command, options }) =>
        `  ${api.executable} ${fullCommand(api, command)}${options?.length ? " [options]" : ""}`,
    ),
    ...(groups.length ? ["", "Command groups (use <group> --help):", ...groups] : []),
    "",
    "Global options:",
    ...(api.globalOptions ?? []).map(
      (signature) => `  ${optionUsage(signature)}`,
    ),
    "",
    "Use <command> --help for a command's options.",
    "Use scripts/API.d.ts to select a focused parameter contract; API.full.d.ts contains every command.",
  ].join("\n");
}

/** One command's options, which of them are required, and the values they allow. */
export function renderCommandHelp(api: CliSignature, { command, options = [] }: CommandSignature): string {
  const describe = (signature: OptionSignature) => {
    const notes = [signature.required ? "required" : undefined, signature.note].filter(Boolean).join("; ");
    return `  ${optionUsage(signature)}${notes ? `  (${notes})` : ""}`;
  };
  return [
    "Usage:",
    `  ${api.executable} ${fullCommand(api, command)}${options.length ? " [options]" : ""}`,
    "",
    "Options:",
    ...(options.length ? options.map(describe) : ["  none"]),
    "",
    "Global options:",
    ...(api.globalOptions ?? []).map(describe),
    "",
    "Values separated by | are alternatives; ... marks an option that can repeat.",
    "Keys in --input JSON are these option names without --, in kebab-case or camelCase.",
  ].join("\n");
}
