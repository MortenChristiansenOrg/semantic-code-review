# Shared runtime rules

Read this file when a command file requires it.

## Installed skill and platform

The installed skill root is the directory containing the active
`semantic-flow/SKILL.md`. Do not edit the installed skill during ordinary
workflow commands. `update` is the only command that replaces it. Use the
`semantic-flow-repair` skill for defects in maintained sources.

Before invoking a bundled executable:

1. Determine the runtime operating system. If uncertain, run:

   ```text
   node -p "process.platform"
   ```

2. Use `../scripts/API.d.ts` as an index and read only the needed
   `scripts/api/*.d.ts` module. Read shared types only when their definitions
   matter. `API.full.d.ts` remains available for exceptional whole-contract inspection.
3. Read exactly one operating-system guide completely:
   - `linux`: `os/linux.md`
   - `win32`: `os/windows.md`

Treat WSL and Linux containers as Linux. Select the guide from Node.js, not
from repository path syntax. Stop before mutation on unsupported platforms.

The platform guide defines these placeholders:

```text
<semantic-flow> <command>
<semantic-implementation> <command>
<review-feedback> <command>
<semantic-view> review <project-path>
```

Never invoke a placeholder literally.

## Resolve the target repository

Use the Git repository containing the user's current working directory unless
the user supplied another project path. Keep this repository distinct from the
installed skill and its maintained source checkout.

## Resolve an active artifact worktree

Commands that need an existing artifact must not assume it lives in the current
worktree. Workflow helpers (`status`, `validate`, `review`, `feedback`, `prepare`,
`archive`) already resolve it: call the requested helper directly, without an
extra inspect. When a workflow needs discovery before individual implementation
commands, run:

```text
<semantic-flow> inspect --json
```

Use `--project <repository-path>` when the user supplied a project path and
`--implementation-id <implementation-id>` when it identifies the requested implementation. The command
inspects the repository and every linked worktree without mutating them. It
selects the current worktree's artifact when present, otherwise the only
matching artifact.

If several linked worktrees contain artifacts, use the implementation ID, title,
specification source reference, checked-out semantic stage branch, current
branch, and revisions only as clues. Select a candidate only when the
relationship is clear. Otherwise list each candidate's path, implementation ID, title,
target branch, and checked-out branch, then ask the user to choose.
If none contains an artifact, report that no active implementation was found. Do not
initialize a replacement or copy an artifact during discovery.

Run artifact and feedback commands from the resolved artifact worktree root.

## Mutation and Git safety

- Use the bundled CLI for every `.semantic-review/` and
  `.semantic-review-feedback/` mutation. Never hand-edit generated state.
- Preserve unrelated user changes. Never stash, discard, absorb, or revert
  them to satisfy the workflow.
- Require a clean worktree before commands that switch branches, create
  branches, restack, publish, prepare, or archive.
- Treat numbered branches below the manifest's `branchPrefix` as CLI-owned
  stage refs. Never create, rename, copy, reset, force-move, or delete them
  with raw Git ref-management commands. `stage begin` creates stage refs and
  `restack` rewrites them. Ordinary implementation and feedback commits may
  advance only the recorded branch while it is checked out.
- A branch ref does not define a stage boundary. The manifest order and each
  stage's recorded base and head revisions do. An extra numbered branch can
  point inside another stage's range and make its commits appear in that
  stage.
- Before making an implementation commit, require an active working stage and
  verify that its recorded branch is checked out. Do not commit stage work on
  an unregistered, preparatory, or future numbered branch.
- Semantic metadata must not be committed on implementation stage branches.
- Keep the stage branch chain linear. Merge commits are unsupported.
- Record only observed insights and review-relevant validation evidence. Never
  record routine execution of existing test suites. Never reconstruct or invent
  decisions, failures, evidence, or private chain-of-thought.
- Use operating-system temporary files or stdin for command JSON. Do not dirty
  the target repository with transient inputs.
- Store repository paths in Git's forward-slash form on every platform.
- Remote push, hosted review creation, merge, and remote branch deletion are
  outside the skill unless the user gives a separate explicit instruction.

## CLI input

All bundled commands accept `--input <json-file>` or `--input -` where the API
declares options. The input is one JSON object. Camel-case and kebab-case keys
are accepted, arrays supply repeated options, and `true` supplies a flag. Do
not provide the same option in both JSON and command-line arguments.

Commands operating on the active working stage infer it when `--stage` or
`--id` is omitted. `current` is accepted explicitly. Updates to a finalized
stage require its explicit stage ID and the relevant finalized flag.

Do not inspect generated `.mjs` bundles for routine usage. Read source only as
a last-resort defect investigation after the API, command guidance, and
observed error are insufficient.

## Reuse within the session

Reuse already-loaded instructions, platform details, and installed script paths
while they remain in context and the installation is unchanged. Do not reread
shared guides or run version/file-existence probes before every command. Reload
missing guidance after compaction or a skill update. Still check mutable Git and
artifact state at the operation's required safety boundaries.

Reuse a successful application check for the same application tree, test scope,
dependencies/configuration, and relevant environment. Semantic metadata edits
alone do not require rerunning application tests. Rerun after relevant changes,
restacks, inconclusive results, or when integration/acceptance coverage has not
yet been exercised. External services and time-sensitive inputs may invalidate
reuse. Do not persist routine test transcripts in the artifact to track this.

Inspect each relevant complete stage diff once per reviewed revision. After
editing, inspect the delta since that inspection and reload surrounding or full
context when needed to understand its effect. Never skip unreviewed changes.
