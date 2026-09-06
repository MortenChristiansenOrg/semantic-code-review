# Archive command

Use after the reviewed implementation has landed on the target branch.

`<semantic-flow>` means `node` followed by the quoted installed script path
`scripts/semantic-flow.mjs`. Read `../scripts/api/workflow.d.ts` only when
additional contract detail is needed. The helper resolves the artifact worktree.

## Preconditions

Require:

- No working stage.
- Feedback valid with no open threads.
- Published metadata matching the artifact.
- The target branch containing the final reviewed stage head.
- The artifact worktree clean.
- The target branch checked out in the artifact worktree, as required by the
  archive CLI.

If another linked worktree already has the target branch checked out, do not
copy the artifact or force branch movement. Explain the conflict and ask the
user how to free the target branch for archival.

Run one helper, which validates the landed artifact and resolved feedback before
archiving. Do not run ordinary pre-landing validation first:

```text
<semantic-flow> archive [--project <artifact-worktree-path>]
```

The command stores the active artifact under:

```text
.semantic-review-history/<implementation-id>/.semantic-review/
```

and records the archive on the target branch. It must not delete stage
branches, metadata branches, feedback history, remote refs, or worktrees.
Branch cleanup is a separate explicit operation.
