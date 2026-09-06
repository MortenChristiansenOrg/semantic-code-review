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
ask which local output the user wants. Then run exactly one helper:

```text
<semantic-flow> prepare [--project <artifact-worktree-path>]
<semantic-flow> prepare --branch <name> [--project <artifact-worktree-path>]
```

Choose the first for the existing stage stack, the second for a named cumulative
branch. The helper validates artifact and feedback, publishes matching metadata,
and prepares the selected output. Do not precede or follow it with duplicate
validate, publish, or validate-stack commands. Feedback stays locked through
preparation; conflicting refs and unrelated worktree changes are rejected.

Preparation must not switch the worktree, overwrite a branch pointing
elsewhere, push, create a hosted review, merge, or delete stage branches. Stop
after reporting the prepared local refs.
