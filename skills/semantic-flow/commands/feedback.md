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

When the target branch has advanced by fast-forward, preflight automatically
restacks a clean finalized stage stack onto its current head. It temporarily
detaches a checked-out stage branch when needed and restores that checkout
afterward. The returned `targetRestack` describes rewritten stage heads. This
is routine synchronization. Never ask the user to approve it.

Use the returned `worktree` as the working directory for every remaining Git,
implementation, and feedback command.

If `stages` is empty, report that no feedback awaits a reply and stop. Read the
whole conversation in every returned thread. A thread marked `restacked: true`
was current before this preflight restacked its stage. Inspect its recorded
target against the rewritten diff and continue when the target remains clear;
do not ask merely because its recorded commit anchor moved. Preflight
automatically refreshes pending non-line anchors when their exact target still
exists; these threads are marked `reanchored: true`. Continue without asking
when their feedback remains clear. A remaining `stale: true` means a line
anchor moved or a non-line target could not be found. Inspect the current target
and ask only when applying the feedback is ambiguous. Also stop for unclear or
contradictory feedback, or when no responsible stage is clear. Do not guess.

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

## Restack conflicts

If restack reports a conflict, read `../docs/restack-conflicts.md` completely
and follow it. This is not an interrupted artifact write. Do not run `repair`
or ask for permission merely because Git reported a conflict.

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
