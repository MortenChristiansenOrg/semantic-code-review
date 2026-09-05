# Validate command

Use for read-only diagnosis of semantic artifact, feedback, and Git
consistency.

`<semantic-flow>` means `node` followed by the quoted absolute path to
`<installed-skill-root>/scripts/semantic-flow.mjs`. This command is self-contained;
read `../scripts/api/workflow.d.ts` only when options or an unexplained error
require it. Reuse known runtime details; do not run separate discovery or
validation before the helper.

Run:

```text
<semantic-flow> validate [--project <repository-or-worktree-path>]
```

The helper resolves the artifact worktree and validates feedback when present.

If the user explicitly requests publication-readiness validation, run:

```text
<semantic-flow> validate --publish [--project <repository-or-worktree-path>]
```

Report failures in actionable groups such as schema, missing references,
specification coverage, branch identity, ancestry, moved heads, file inventory,
node organization, feedback targets, stale snapshots, and open threads.

Do not automatically run `repair`, restack, edit metadata, switch branches, or
change implementation code. Recommend `continue`, `feedback`, or the separate
`semantic-flow-repair` skill according to the failure.
