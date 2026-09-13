# Prepare command

Use after human review to prepare hosting-neutral local outputs.

`<semantic-flow>` means `node` followed by the quoted installed script path
`scripts/semantic-flow.mjs`. The helper resolves the artifact worktree and
checks clean Git state, publication readiness, and resolved feedback. Read
`../scripts/api/workflow.d.ts` only when additional contract detail is needed.

## Preconditions

Require:

- Every stage finalized.
- Publication validation passing.
- All feedback threads resolved.

Publication readiness only considers criteria referenced by the finalized
stages. Criteria in the requirement documents but outside those stage
references are outside the review and must not block preparation.

## Outputs

If stack or cumulative-branch output is not specified and cannot be inferred,
ask whether the user wants the changes kept as separate review steps or combined
into one branch for a conventional code review. Apply `../docs/user-decisions.md`
and infer the branch name when possible. Then run exactly one helper:

```text
<semantic-flow> prepare [--project <artifact-worktree-path>]
<semantic-flow> prepare --branch <name> [--project <artifact-worktree-path>]
```

Choose the first for the existing stage stack, the second for a named cumulative
branch. The helper validates artifact and feedback, publishes matching metadata,
and prepares the selected output. Do not precede or follow it with duplicate
validate, publish, or validate-stack commands. Feedback stays locked through
preparation; conflicting refs and unrelated worktree changes are rejected.

The first cumulative preparation binds the branch to the implementation. After
feedback changes and restacking, repeat the helper with the same `--branch`.

The command republishes metadata and moves the same cumulative branch from its
recorded prepared head to the revised final stage head in one ref transaction.
It refuses the update if another process or user moved the cumulative branch.
For explicit adoption or rebinding, use `<semantic-implementation> prepare-branch`
after validating publication readiness and resolved feedback. Read
`../scripts/api/history.d.ts` for its contract. Use `--adopt` only when the user
explicitly wants to replace the current tip of the bound branch. Use
`--branch <name> --rebind` to bind a different cumulative branch; the old branch
remains unchanged.

When a cumulative branch moves, tell the user to update the same remote branch
with an exact force-with-lease expecting the reported old head. This preserves
the source branch of an existing hosted review. Do not suggest a new branch
merely because feedback rewrote the stage stack.

`validate-stack --json` reports any existing cumulative branch binding. If
`/semantic-flow prepare` does not specify stack or branch output and the choice
is not already clear, use the same user-facing output choice above. If a guarded
update is rejected, inspect the newly discovered work and explain what replacement
would affect under `../docs/user-decisions.md`. Never offer `--adopt` or `--rebind`
as an opaque permission question; preserve their explicit-authorization guards.

Preparation must not switch the worktree, overwrite an unbound or externally
moved branch without explicit adoption, push, create a hosted review, merge,
or delete stage branches. Stop after reporting the prepared local refs.
