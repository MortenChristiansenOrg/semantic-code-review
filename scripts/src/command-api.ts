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

const requirementOptions: OptionSignature[] = [
  option("requirement-id", "<id>", { required: true }),
  option("requirement-title", "<title>", { required: true }),
  option("requirement-summary", "<summary>", { required: true }),
  option("source-kind", "<kind>", { required: true }),
  option("source-reference", "<reference>", { required: true }),
  option("source-url", "<url>"),
  option("criterion", "<id>=<text>", { required: true, repeatable: true }),
];

export const semanticReviewApi: CliSignature = {
  executable: "semantic-review.mjs",
  title: "Semantic review artifact CLI",
  globalOptions: [option("help"), option("input", "<json-file>")],
  commands: [
    {
      command: "init",
      options: [
        option("review-id", "<id>", { required: true }),
        option("title", "<title>", { required: true }),
        option("summary", "<summary>", { required: true }),
        option("base-revision", "<revision>"),
        option("target-branch", "<branch>", { required: true }),
        option("branch-prefix", "<prefix>"),
        ...requirementOptions,
      ],
    },
    { command: "requirement add", options: requirementOptions },
    {
      command: "stage begin",
      options: [
        option("id", "<stage-id>", { required: true }),
        option("title", "<title>", { required: true }),
        option("summary", "<summary>", { required: true }),
        option("rationale", "<text>", { required: true }),
        option("depends-on", "<stage-id>", { repeatable: true }),
        option("requirement-ref", "<requirement-id>#<criterion-id>", {
          required: true,
          repeatable: true,
        }),
      ],
    },
    {
      command: "stage set",
      options: [
        option("id", "<stage-id|current>"),
        option("title", "<title>"),
        option("summary", "<summary>"),
        option("rationale", "<text>"),
        option("depends-on", "<stage-id>", { repeatable: true }),
        option("requirement-ref", "<requirement-id>#<criterion-id>", {
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
        option("category", "<requirement|engineering>"),
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
      options: [option("id", "<stage-id|current>")],
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
      ],
    },
    { command: "repair" },
    { command: "publish", options: [option("message", "<commit-message>")] },
    {
      command: "prepare-stack",
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
      command: "batch create",
      options: [
        option("id", "<batch-id>", { required: true }),
        option("title", "<title>", { required: true }),
      ],
    },
    {
      command: "batch delete",
      options: [option("id", "<batch-id>", { required: true })],
    },
    {
      command: "comment add",
      options: [
        option("batch", "<batch-id>", { required: true }),
        option("id", "<feedback-id>", { required: true }),
        option("body", "<text>", { required: true }),
        option("label", "<text>", { required: true }),
        option(
          "target-kind",
          "<requirement|criterion|stage|context|file|line>",
          { required: true },
        ),
        option("requirement", "<requirement-id>"),
        option("criterion", "<criterion-id>"),
        option("stage", "<stage-id>"),
        option("collection", "<collection>"),
        option("item", "<item-id>"),
        option("path", "<repository-path>"),
        option("side", "<old|new>"),
        option("line", "<positive-integer>"),
        option("assigned-stage", "<stage-id>"),
      ],
    },
    {
      command: "comment edit",
      options: [
        option("id", "<feedback-id>", { required: true }),
        option("body", "<text>", { required: true }),
      ],
    },
    {
      command: "comment delete",
      options: [option("id", "<feedback-id>", { required: true })],
    },
    {
      command: "comment assign",
      options: [
        option("id", "<feedback-id>", { required: true }),
        option("stage", "<stage-id>", { required: true }),
      ],
    },
    {
      command: "batch submit",
      options: [option("id", "<batch-id>", { required: true })],
    },
    { command: "next", options: [option("json")] },
    {
      command: "comment resolve",
      options: [
        option("id", "<feedback-id>", { required: true }),
        option("summary", "<text>", { required: true }),
        option("stage", "<stage-id>", { required: true }),
        option("previous-head", "<full-sha>", { required: true }),
        option("rewritten-head", "<full-sha>", { required: true }),
      ],
    },
    {
      command: "resolution rebind",
      options: [
        option("stage", "<stage-id>", { required: true }),
        option("previous-head", "<full-sha>", { required: true }),
        option("rewritten-head", "<full-sha>", { required: true }),
      ],
    },
    {
      command: "comment approve",
      options: [option("id", "<feedback-id>", { required: true })],
    },
    {
      command: "batch approve-all",
      options: [option("id", "<batch-id>", { required: true })],
    },
    { command: "approve-stack" },
    { command: "validate" },
  ],
};

const projectSelectionOptions: OptionSignature[] = [
  option("project", "<repository-path>"),
  option("review-id", "<review-id>"),
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
      options: [...projectSelectionOptions, option("publish")],
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
  semanticReviewApi,
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
    "Use scripts/API.d.ts for the complete typed parameter contract.",
  ].join("\n");
}
