# Archive command

Use after the reviewed implementation has landed on the target branch.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide before mutation. Resolve the active artifact worktree.

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

Run final validation:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

Then run:

```text
<semantic-review> archive
```

The command stores the active artifact under:

```text
.semantic-review-history/<review-id>/.semantic-review/
```

and records the archive on the target branch. It must not delete stage
branches, metadata branches, feedback history, remote refs, or worktrees.
Branch cleanup is a separate explicit operation.
