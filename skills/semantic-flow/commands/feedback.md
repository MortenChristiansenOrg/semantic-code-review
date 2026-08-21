# Feedback command

Use after a reviewer has submitted feedback for the implementation agent to
address.

Read `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/API.d.ts`, and the selected operating-system guide before mutation.

## Load feedback

1. Resolve the active artifact worktree.
2. Require a clean worktree before branch changes.
3. Run:

   ```text
   <semantic-flow> validate --project <artifact-worktree-path>
   <review-feedback> next --json
   ```

4. If there is no submitted feedback, report that and stop.
5. If feedback is unclear, contradictory, stale, or cannot be assigned to a
   responsible stage, stop and ask the user. Do not guess at requested
   behavior.

## Address feedback

Process the earliest affected stage first:

1. Check out its recorded stage branch.
2. Inspect the feedback target and the complete stage diff.
3. Implement the correction directly on that stage branch.
4. Run relevant tests and commit the correction.
5. Update finalized context and validation evidence when the correction changes
   them.
6. Rerun `stage organize --finalized` when causes, files, hunks, line ranges,
   or item links changed.
7. Restack every later branch:

   ```text
   <semantic-review> restack --from <stage-id>
   ```

8. If rewritten later stages no longer match their organization, reorganize
   those stages before continuing.
9. Record each resolution with the submitted `previous-head` and the current
   assigned stage `rewritten-head`:

   ```text
   <review-feedback> comment resolve --input -
   ```

10. If a resolved stage changes again, use `resolution rebind`.

Repeat in stage order until all actionable submitted feedback is addressed.
Then run:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

Stop with the revised stack ready for human review. Do not approve feedback,
approve the stack, publish metadata, push rewritten branches, or merge.
