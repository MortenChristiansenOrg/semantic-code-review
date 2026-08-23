# Validate command

Use for read-only diagnosis of semantic artifact, feedback, and Git
consistency.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide.

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
requirement coverage, branch identity, ancestry, moved heads, file inventory,
node organization, feedback targets, stale snapshots, and unresolved
resolutions.

Do not automatically run `repair`, restack, edit metadata, switch branches, or
change implementation code. Recommend `continue`, `feedback`, or the separate
`semantic-flow-repair` skill according to the failure.
