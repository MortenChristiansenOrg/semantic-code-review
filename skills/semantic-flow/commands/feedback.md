# Feedback command

Use after a reviewer has sent feedback for the implementation agent to
address.

The command is self-contained. Do not read the shared runtime guide, platform
guide, artifact-quality guide, or full API declaration unless a listed command
fails with an error that this file does not explain.

These placeholders mean `node` followed by the quoted script path under the
installed skill root:

```text
<semantic-flow>           scripts/semantic-flow.mjs
<semantic-implementation> scripts/semantic-implementation.mjs
<review-feedback>         scripts/review-feedback.mjs
```

## Load once

Run one preflight:

```text
<semantic-flow> feedback --json [--project <repository-or-worktree-path>] [--implementation-id <id>]
```

This resolves the artifact worktree, validates the implementation and feedback,
reports local changes, and returns only threads awaiting an agent reply. Do not
run `inspect`, `validate`, or `review-feedback next` first.

Use the returned `worktree` as the working directory for every remaining Git,
implementation, and feedback command.

If `stages` is empty, report that no feedback awaits a reply and stop. Read the
whole conversation in every returned thread. Stop and ask the user when a
thread has `stale: true`, feedback is unclear or contradictory, or no
responsible stage is clear. Do not guess.

## Address feedback

Work in returned stage order. Handle all threads assigned to one stage
together:

1. Inspect the thread targets and complete stage diff once.
2. Answer questions directly. If the stage needs code changes, require
   `worktreeChanges` from preflight to be empty, then check out its recorded
   branch. Preserve unrelated user changes and stop if the worktree is dirty.
3. Apply all requested code corrections for the
   stage as one coherent edit, then run relevant tests and commit.
4. Update finalized insights only when the recorded reasoning changed. Do not
   record normal test runs as validation evidence.
5. Run `stage organize --finalized` only when the corrected diff changes node
   ownership, hunks, line ranges, or links.

Do not restack after each stage. Track the earliest stage with a code change.
After all affected branches are committed and organized, check out that
earliest changed branch and run one restack:

```text
<semantic-implementation> restack --from <earliest-changed-stage-id>
```

This accepts every edited stage head and replays each descendant once. If a
later correction cannot be implemented coherently until it includes an earlier
correction, restack before that stage, then continue and restack once more from
the earliest stage changed after that point.

After restacking, reorganize only descendants whose node coverage no longer
matches their rewritten diff.

If restacking reports a stage conflict, the command has already discarded its
temporary index and left every stage ref and artifact unchanged. This is not an
interrupted artifact write. Do not run `repair`, look for a rebase state, merge
lower-stage commits into the conflicting stage, or ask the user merely because
Git found conflicts.

Use the reported stage base, stage head, and new parent to resolve the stage's
net patch:

1. Record the original earliest changed stage and the complete conflict
   context. Confirm the stage and target branches have not moved.
2. Create a uniquely named recovery branch outside `branchPrefix` at the
   reported stage head. Keep it until the revised stack validates.
3. Create and check out a second temporary branch, also outside
   `branchPrefix`, at the reported new parent.
4. Write `git diff --binary --full-index --find-renames=50% <stage-base>
   <stage-head> --` to an OS temporary file outside the repository, then apply
   it with `git apply --3way --index <temporary-patch>`. A nonzero exit with
   unmerged files is expected.
5. Resolve only those conflicts. Preserve the lower stages already represented
   by the new parent and the conflicting stage's recorded intent. Run the
   smallest relevant checks, stage the complete resolution, and commit it.
6. Move the conflicting stage branch with compare-and-swap:

   ```text
   git update-ref refs/heads/<stage-branch> <resolution-head> <reported-stage-head>
   ```

7. Check out the original earliest changed branch, delete the temporary
   resolution branch and patch file, then rerun the original restack command.
   If another descendant conflicts, repeat from its newly reported context.

Stop and ask the user only when resolving the net patch requires a product
decision, stage ownership is unclear, a guarded ref update fails, or a branch
moved after the conflict report. On failure, retain every recovery branch and
report its name. After restacking and validation succeed, delete the recovery
branches.

Do not create a new stage for corrections that belong in an existing stage.
Question-only feedback needs no checkout, commit, organization, or restack.

## Reply once

After all stages are ready, send every answer in one atomic batch. Pass this
object with `--input -`, or use an OS temporary file outside the repository:

```text
<review-feedback> thread reply-batch --input -
{"replies":[{"id":"<thread-id>","comment-id":"<new-comment-id>","author":"agent","body":"<answer-or-change-summary>"}]}
```

Include one reply per addressed thread. Never resolve a thread. Closing the
conversation is the reviewer's decision.

Finally rerun `<semantic-flow> feedback --json --project
<artifact-worktree-path>`. It validates the revised stack and feedback in one
call. `stages` must be empty. Stop with the stack ready for human review. Do
not approve, publish, push, merge, or resolve threads.
