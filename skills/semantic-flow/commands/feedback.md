# Feedback command

Use after a reviewer has sent feedback for the implementation agent to
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

4. If there is no open feedback awaiting a reply, report that and stop.
5. Read every user comment in each returned thread.
6. If feedback is unclear, contradictory, stale, or cannot be assigned to a
   responsible stage, stop and ask the user. Do not guess at requested
   behavior.

## Address feedback

Process the earliest affected stage first:

1. Check out its recorded stage branch.
2. Inspect each thread, its target, and the complete stage diff.
3. If a thread is a question that requires no code change, prepare a direct
   answer and do not rewrite the stage.
4. For a change instruction, implement the correction directly on that stage
   branch.
5. Run relevant tests and commit the correction.
6. Update finalized context and validation evidence when the correction changes
   them.
7. Rerun `stage organize --finalized` when causes, files, hunks, line ranges,
   or item links changed.
8. Restack every later branch:

   ```text
   <semantic-review> restack --from <stage-id>
   ```

9. If rewritten later stages no longer match their organization, reorganize
   those stages before continuing.
10. Reply to each thread with an assistant comment that answers the question or
    states what changed. Never resolve a thread — closing a conversation is
    always the reviewer's decision.

    ```text
    <review-feedback> thread reply --id <thread-id> --comment-id <comment-id> \
      --author assistant --body <answer-or-change-summary>
    ```

You cannot mark threads resolved. Reply to every open thread you address,
then leave them open for the reviewer to resolve or continue. Repeat in stage
order until every returned thread has an assistant reply.
Then run:

```text
<semantic-flow> validate --publish --project <artifact-worktree-path>
```

Stop with the revised stack ready for human review. Do not resolve threads,
approve feedback, approve the stack, publish metadata, push rewritten branches,
or merge.
