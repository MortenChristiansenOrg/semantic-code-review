# Prepare command

Use after human review to prepare hosting-neutral local outputs.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide before mutation. Resolve the active artifact worktree
and require it to be clean.

## Preconditions

Require:

- Every stage finalized.
- Publication validation passing.
- All feedback threads resolved.

Publication readiness only considers criteria referenced by the finalized
stages. Criteria in the requirement documents but outside those stage
references are outside the review and must not block preparation.

Run:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

## Outputs

For the stage stack, run:

```text
<semantic-implementation> publish
<semantic-implementation> validate-stack
```

For the first preparation of one cumulative branch, obtain the desired branch
name and run:

```text
<semantic-implementation> prepare-branch --branch <name>
```

This publishes the sibling metadata branch and binds the cumulative branch to
the implementation. After feedback changes and restacking, run:

```text
<semantic-implementation> prepare-branch
```

The command republishes metadata and moves the same cumulative branch from its
recorded prepared head to the revised final stage head in one ref transaction.
It refuses the update if another process or user moved the cumulative branch.
Use `--adopt` only when the user explicitly wants to replace the current tip of
the bound branch. Use `--branch <name> --rebind` to bind a different cumulative
branch; the old branch remains unchanged.

When a cumulative branch moves, tell the user to update the same remote branch
with an exact force-with-lease expecting the reported old head. This preserves
the source branch of an existing hosted review. Do not suggest a new branch
merely because feedback rewrote the stage stack.

`validate-stack --json` reports any existing cumulative branch binding. If
`/semantic-flow prepare` does not specify stack or branch output and the choice
is not already clear, ask the user which local output they want.

Preparation must not switch the worktree, overwrite an unbound or externally
moved branch without explicit adoption, push, create a hosted review, merge,
or delete stage branches. Stop after reporting the prepared local refs.
