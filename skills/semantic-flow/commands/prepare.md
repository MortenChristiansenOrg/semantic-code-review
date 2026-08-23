# Prepare command

Use after human review to create hosting-neutral local outputs.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide before mutation. Resolve the active artifact worktree
and require it to be clean.

## Preconditions

Require:

- Every stage finalized.
- Complete criterion coverage.
- Publication validation passing.
- All submitted feedback addressed and resolved.
- Explicit human whole-stack approval.

Run:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

If whole-stack approval has not been recorded, do not infer it from the
`prepare` invocation. Ask the user for explicit approval. After approval,
publish metadata:

```text
<review-feedback> approve-stack
```

This validates feedback and creates or updates the sibling metadata branch so
its heads match the reviewed stage heads. Re-running `prepare` after later
changes republishes it.

## Outputs

For the stage stack, run:

```text
<semantic-review> prepare-stack
```

For one cumulative branch, obtain the desired branch name and run:

```text
<semantic-review> prepare-branch --branch <name>
```

If `/semantic-flow prepare` does not specify stack or branch output and the
choice is not already clear, ask the user which local output they want.

Preparation must not switch the worktree, overwrite a branch pointing
elsewhere, push, create a hosted review, merge, or delete stage branches. Stop
after reporting the prepared local refs.
