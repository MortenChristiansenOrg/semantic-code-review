export interface OptionSignature {
  name: string;
  value?: string;
  required?: boolean;
  repeatable?: boolean;
}

export interface CommandSignature {
  command: string;
  options?: OptionSignature[];
}

export interface CliSignature {
  executable: string;
  title: string;
  commands: CommandSignature[];
  globalOptions?: OptionSignature[];
}

const option = (
  name: string,
  value?: string,
  settings: Omit<OptionSignature, "name" | "value"> = {},
): OptionSignature => ({ name, value, ...settings });

const specificationOptions: OptionSignature[] = [
  option("specification-id", "<id>", { required: true }),
  option("specification-title", "<title>", { required: true }),
  option("specification-summary", "<summary>", { required: true }),
  option("source-kind", "<kind>", { required: true }),
  option("source-reference", "<reference>", { required: true }),
  option("source-url", "<url>"),
  option("criterion", "<id>=<text>", { required: true, repeatable: true }),
];

export const semanticImplementationApi: CliSignature = {
  executable: "semantic-implementation.mjs",
  title: "Semantic implementation artifact CLI",
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
    { command: "specification add", options: specificationOptions },
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
      ],
    },
    { command: "stage record-batch", options: [option("stage", "<stage-id>"), option("finalized"), option("items", "<json-array>", { required: true })] },
    { command: "stage plan", options: [option("stage", "<stage-id>"), option("finalized"), option("selectors")] },
    {
      command: "stage set",
      options: [
        option("id", "<stage-id|current>"),
        option("title", "<title>"),
        option("summary", "<summary>"),
        option("rationale", "<text>"),
        option("depends-on", "<stage-id>", { repeatable: true }),
        option("specification-ref", "<specification-id>#<criterion-id>", {
          repeatable: true,
        }),
      ],
    },
    {
      command: "stage record",
      options: [
        option("stage", "<stage-id|current>"),
        option(
          "kind",
          "<decision|assumption|alternative|failed-attempt|risk|question>",
          { required: true },
        ),
        option("item-id", "<id>", { required: true }),
        option("replace"),
        option("finalized"),
        option("category", "<specification|engineering>"),
        option("summary", "<text>"),
        option("rationale", "<text>"),
        option("statement", "<text>"),
        option("risk-if-wrong", "<text>"),
        option("approach", "<text>"),
        option("reason-rejected", "<text>"),
        option("outcome", "<text>"),
        option("lesson", "<text>"),
        option("mitigation", "<text>"),
        option("question", "<text>"),
        option("node-ref", "<node-id>", { repeatable: true }),
      ],
    },
    {
      command: "stage organize",
      options: [
        option("stage", "<stage-id|current>"),
        option("file", "<json-file>", { required: true }),
        option("finalized"),
      ],
    },
    {
      command: "stage validation",
      options: [
        option("stage", "<stage-id|current>"),
        option("item-id", "<id>", { required: true }),
        option("type", "<automated|manual|analysis>", { required: true }),
        option("status", "<passed|failed|not-run>", { required: true }),
        option("summary", "<text>", { required: true }),
        option("command", "<command>"),
        option("node-ref", "<node-id>", { repeatable: true }),
        option("replace"),
        option("finalized"),
      ],
    },
    {
      command: "stage finish",
      options: [option("json"),option("id", "<stage-id|current>")],
    },
    {
      command: "stage discard",
      options: [option("id", "<stage-id|current>")],
    },
    {
      command: "restack",
      options: [
        option("from", "<stage-id>"),
        option("base", "<revision>"),
        option("json"),
      ],
    },
    { command: "repair" },
    { command: "publish", options: [option("message", "<commit-message>")] },
    {
      command: "validate-stack",
      options: [option("json")],
    },
    {
      command: "prepare-branch",
      options: [option("branch", "<branch-name>", { required: true })],
    },
    {
      command: "archive",
      options: [
        option("destination", "<repository-path>"),
        option("message", "<commit-message>"),
      ],
    },
    {
      command: "validate",
      options: [option("schema-only"), option("publish")],
    },
  ],
};

export const reviewFeedbackApi: CliSignature = {
  executable: "review-feedback.mjs",
  title: "Semantic review feedback CLI",
  globalOptions: [option("help"), option("input", "<json-file>")],
  commands: [
    { command: "init" },
    {
      command: "thread add",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>", { required: true }),
        option("body", "<text>", { required: true }),
        option("label", "<text>", { required: true }),
        option(
          "target-kind",
          "<specification|criterion|stage|node|insight|file|line>",
          { required: true },
        ),
        option("specification", "<specification-id>"),
        option("criterion", "<criterion-id>"),
        option("stage", "<stage-id>"),
        option("node", "<node-id>"),
        option("collection", "<collection>"),
        option("item", "<item-id>"),
        option("path", "<repository-path>"),
        option("side", "<old|new>"),
        option("line", "<positive-integer>"),
        option("assigned-stage", "<stage-id>"),
      ],
    },
    {
      command: "thread add-batch",
      options: [option("threads", "<json-array>", { required: true }), option("partial")],
    },
    {
      command: "next",
      options: [option("json"), option("compact")],
    },
    {
      command: "thread reply",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>", { required: true }),
        option("body", "<text>", { required: true }),
        option("author", "<user|agent>"),
      ],
    },
    {
      command: "thread reply-batch",
      options: [option("replies", "<json-array>", { required: true }), option("partial")],
    },
    {
      command: "thread resolve",
      options: [
        option("id", "<thread-id>", { required: true }),
        option("comment-id", "<comment-id>"),
        option("body", "<text>"),
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
  ],
};

const projectSelectionOptions: OptionSignature[] = [
  option("project", "<repository-path>"),
  option("implementation-id", "<implementation-id>"),
];

export const semanticFlowApi: CliSignature = {
  executable: "semantic-flow.mjs",
  title: "Semantic flow workflow helper",
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
      options: [...projectSelectionOptions, option("json")],
    },
    {
      command: "status",
      options: [...projectSelectionOptions, option("json")],
    },
    {
      command: "review",
      options: projectSelectionOptions,
    },
    {
      command: "feedback",
      options: [...projectSelectionOptions, option("json")],
    },
    {
      command: "version",
      options: [option("json")],
    },
    {
      command: "update",
      options: [
        option("source", "<repository-path>"),
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

export function commandOptionNames(
  api: CliSignature,
  command: string,
): ReadonlySet<string> {
  const signature = api.commands.find(
    (candidate) => candidate.command === command,
  );
  if (!signature) {
    throw new Error(`Missing command signature: ${api.executable} ${command}`);
  }
  return new Set((signature.options ?? []).map((candidate) => candidate.name));
}

function optionUsage(signature: OptionSignature): string {
  const value = signature.value ? ` ${signature.value}` : "";
  return `--${signature.name}${value}${signature.repeatable ? " ..." : ""}`;
}

export function renderCliHelp(api: CliSignature): string {
  return [
    api.title,
    "",
    "Usage:",
    ...api.commands.map(
      ({ command, options }) =>
        `  ${api.executable} ${command}${options?.length ? " [options]" : ""}`,
    ),
    "",
    "Global options:",
    ...(api.globalOptions ?? []).map(
      (signature) => `  ${optionUsage(signature)}`,
    ),
    "",
    "Use scripts/API.d.ts to select a focused parameter contract; API.full.d.ts contains every command.",
  ].join("\n");
}
