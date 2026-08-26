# Semantic Review Feedback Format

**Status:** Proposal 0.1

Feedback is mutable local workflow state under `.semantic-review-feedback/`.
It connects reviewer comments to semantic targets and the exact stage snapshot
that was reviewed.

```text
.semantic-review-feedback/
  manifest.json
  threads/<thread-id>.json
```

## Lifecycle

Threads are either `open` or `resolved`. Each thread contains an ordered
comment timeline that begins with a user comment.

Adding a thread captures its responsible stage and that stage's current head.
The implementation agent replies after answering the question or making the
requested change. Only the reviewer resolves or reopens the thread.

Draft notes stay in the viewer until the reviewer sends them. They are not part
of the persisted feedback format.

## Targets

Requirement, criterion, stage, context, file, and line targets use stable
semantic IDs. Stage-backed targets also store:

- `stageId`
- `stageBranch`
- `stageHead`

Context targets add collection and item IDs. File targets add a path. Line
targets add a diff side and line number.

The thread's `assignedStageId` identifies where the agent should make a change.
Its `stageHead` records the assigned stage snapshot when the reviewer sent the
feedback. The viewer marks the thread stale when the current stage head differs.

## Agent processing

1. Select open feedback for the earliest affected stage.
2. Check out that stage branch.
3. Answer the question or implement, validate, and commit the correction.
4. Run `restack --from <stage>` after a code change.
5. Add an assistant reply explaining the answer or change.

The agent does not resolve threads. Later restacks do not require feedback
metadata updates because the original review snapshot remains historical.

Every feedback mutation holds a repository-scoped lock. Publication-readiness
validation requires every thread to be resolved. Metadata publication and
local branch preparation are separate implementation-artifact operations.

Feedback remains independent from the implementation artifact and is not
committed on stage branches.
