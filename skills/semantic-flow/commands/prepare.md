# Prepare command

Use after human review to prepare hosting-neutral local outputs.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide before mutation. Resolve the active artifact worktree
and require it to be clean.

## Preconditions

Require:

- Every stage finalized.
- Complete criterion coverage.
- Publication validation passing.
- All feedback threads resolved.

Run:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

Publish metadata:

```text
<semantic-review> publish
```

This creates or updates the sibling metadata branch so its heads match the
reviewed stage heads. Re-running `prepare` after later changes republishes it.

## Outputs

For the stage stack, run:

```text
<semantic-review> validate-stack
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
