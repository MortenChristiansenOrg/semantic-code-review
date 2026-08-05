# Semantic Review Feedback Format

**Status:** Proposal 0.1

Feedback is mutable local workflow state under `.semantic-review-feedback/`.
It references stable semantic IDs and immutable stage head snapshots.

## Lifecycle

Batches move through `draft`, `submitted`, `addressing`, `resolved`, and
`approved`. Items move through `draft`, `submitted`, `addressed`, and
`approved`.

Submitting a batch freezes comment text, targets, assignments, and
`assignedStageHead`. A resolution records:

- Explanation and stage ID.
- `previousHead`: submitted stage snapshot.
- `rewrittenHead`: current stage snapshot after restacking.
- Addressed and optional approval timestamps.

If the same stage changes again, resolution rebinding changes only
`rewrittenHead`.

## Targets

Stage, context, file, and line targets store:

- `stageId`
- `stageBranch`
- `stageHead`

Context targets add collection and item IDs. File targets add a path. Line
targets add path, side, and line number.

The branch identifies the persistent PR surface; the head preserves the exact
reviewed snapshot. Tools mark an anchor stale when the stage's current
`headRevision` differs.

## Agent processing

1. Select submitted feedback for the earliest affected stage.
2. Check out its recorded stage branch.
3. Implement, validate, and commit the correction there.
4. Run `restack --from <stage>` to refresh that branch and replay every branch
   above it.
5. Record resolutions using the submission head and current rewritten head.
6. Rebind older resolutions if the stage changes again.

This is identical whether the correction was authored by the agent or committed
manually by the user.

Every feedback mutation and stack approval holds a repository-scoped lock.
Stack approval requires all batches to be approved, publishes semantic metadata
on the sibling metadata branch, and reports the local reviewed branch chain.

Feedback state remains independent from the implementation artifact and is not
committed on stage branches.
