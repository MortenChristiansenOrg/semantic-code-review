# Semantic Review Feedback Format

**Status:** Proposal 0.1

Feedback is mutable local workflow state under `.semantic-review-feedback/`.
It references stable semantic IDs and immutable stage head snapshots.

```text
.semantic-review-feedback/
  manifest.json
  batches/<batch-id>.json
  threads/<thread-id>.json
```

## Lifecycle

Batches move through `draft`, `submitted`, `addressing`, `resolved`, and
`approved`. Threads move through `draft`, `submitted`, `resolved`, and
`approved`.

Each thread contains an ordered `comments` timeline. The opening comment is
authored by the user. Draft user comments may be edited until batch submission.
Submission freezes existing comments, targets, assignments, and
`assignedStageHead`.

The implementation agent resolves a thread by adding an assistant comment with
either:

- An answer to the user's question.
- An explanation of how the requested change was handled.

Change resolutions also record the stage ID, `previousHead`, and
`rewrittenHead`. Answer-only resolutions omit Git rewrite metadata. Every
resolution records a resolved timestamp and may later record an approval
timestamp.

If the same stage changes again, resolution rebinding changes only
`rewrittenHead`.

## Targets

Stage, context, file, and line targets store:

- `stageId`
- `stageBranch`
- `stageHead`

Context targets add collection and item IDs. File targets add a path. Line
targets add path, side, and a line number that exists in that side's immutable
Git snapshot.

The branch identifies the persistent PR surface; the head preserves the exact
reviewed snapshot. Tools mark an anchor stale when the stage's current
`headRevision` differs.

## Agent processing

1. Select submitted feedback for the earliest affected stage.
2. Check out its recorded stage branch.
3. Implement, validate, and commit the correction there.
4. Run `restack --from <stage>` to refresh that branch and replay every branch
   above it.
5. Add an assistant follow-up and resolve each thread. Include the submission
   and rewritten heads for change requests; omit them for answer-only threads.
6. Rebind older resolutions if the stage changes again.

This is identical whether the correction was authored by the agent or committed
manually by the user.

Every feedback mutation and stack approval holds a repository-scoped lock.
Stack approval requires all batches to be approved, publishes semantic metadata
on the sibling metadata branch, and reports the local reviewed branch chain.

Feedback state remains independent from the implementation artifact and is not
committed on stage branches.
