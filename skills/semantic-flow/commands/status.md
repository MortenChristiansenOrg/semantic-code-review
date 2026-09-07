# Status command

Use for a read-only overview of the current semantic-flow lifecycle.

`<semantic-flow>` means `node` followed by the quoted absolute path to
`<installed-skill-root>/scripts/semantic-flow.mjs`. This command is self-contained;
read `../scripts/api/workflow.d.ts` only when options or an unexplained error
require it. Reuse known runtime details; do not run separate discovery or
validation before the helper. Run:

```text
<semantic-flow> status --json [--project <repository-or-worktree-path>]
```

The helper resolves the artifact and reports lifecycle details, criterion
coverage, validation evidence counts, feedback states, metadata-branch
presence, and validator results. It does not fail merely because validation
finds a problem.

If no artifact exists, report that and include the target repository path.
Read artifact or feedback files only when the snapshot lacks detail needed for
the user's question.

## Report

Summarize:

- Implementation ID, title, artifact worktree, target branch, and base revision.
- Current checked-out branch and whether it matches an active or finalized
  stage.
- Working stage, finalized stage count, and criterion coverage.
- Failed, skipped, missing, or stale validation evidence.
- Branch movement, ancestry drift, or required restacking.
- Open and resolved feedback threads.
- Metadata publication and local preparation state when detectable.
- Whether the implementation is ready for continuation, review,
  feedback, preparation, or archive.
- One recommended next semantic-flow command.

Status must not switch branches, repair state, restack, publish, prepare,
archive, or launch the viewer.
