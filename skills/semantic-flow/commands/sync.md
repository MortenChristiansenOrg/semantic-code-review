# Sync command

Use to bring the current implementation stack up to date with its target
branch, including requests to bring the latest master/main changes into the
implementation. This restacks the existing stages and stops after validation.

These placeholders mean `node` followed by the quoted script path under the
installed skill root:

```text
<semantic-flow>           scripts/semantic-flow.mjs
<semantic-implementation> scripts/semantic-implementation.mjs
```

## Synchronize

Run:

```text
<semantic-flow> sync --json [--project <repository-or-worktree-path>] [--implementation-id <id>]
```

The helper discovers the artifact worktree, checks metadata and feedback,
requires a clean finalized stack with stage heads matching the artifact,
fetches the recorded target branch's configured upstream, and fast-forwards
the local target. It preserves a locally ahead target and rejects divergence.
It updates a target checked out in another clean worktree through that checkout.
Other worktrees must not have stage branches checked out. It then restacks all
stages onto the local target, restores the artifact checkout, validates the
stack, and refreshes eligible pending non-line feedback anchors.

Use `--local` when the user requests the current local target without fetching,
or when completing the recovery below. With no configured upstream, ask for
the intended upstream or whether to use the local target. Do not silently
substitute local history for a request for the latest remote changes. If the
user names a branch or upstream that differs from the recorded configuration,
clarify the intended source before running the helper; sync does not retarget
an implementation.

Do not ask for approval for routine synchronization or clear conflict
resolutions. Preserve unfinished work: do not stash, discard, finalize an
incomplete stage, or absorb unrecorded commits merely to pass preflight.
Report blocked state and the specific prerequisite. Never merge the target
into a stage branch; merge commits in stage ranges are unsupported.

## Conflicts and validation failures

Use the reported artifact worktree for every subsequent command. A failed
restack leaves stage refs and artifacts unchanged; an earlier fast-forward of
the target is retained. Record the original checkout and reported revisions.

For a patch conflict, read `../docs/restack-conflicts.md` completely. Recover
using the underlying `<semantic-implementation> restack --base <target-branch>`
invocation. Do not re-enter sync preflight between recovery and the successful
restack: the recovery intentionally moves a stage head, which preflight rejects.
Do not fetch again during recovery. Restore the original branch after the
restack succeeds; for an originally detached stage/base checkout, detach at its
new recorded stage/base revision. Retain recovery refs until validation passes.

If node ownership, hunk selectors, or line ranges no longer fit the rewritten
diff, read `../scripts/api/stages.d.ts` and reorganize only the affected finalized
stages with `stage plan --finalized` and `stage organize --finalized`. Use the
CLI for metadata edits. Then rerun `sync --local --json` in the artifact worktree.

## Complete

Inspect rewritten stage diffs for preserved intent and node coverage. Read
`../docs/runtime.md`'s validation reuse rules and run relevant application tests
and the implementation's acceptance path on the updated cumulative head.
Restore the original checkout after testing. Pending line feedback may remain
stale; report its thread IDs without guessing new anchors, answering feedback,
or resolving threads. Refreshed non-line anchors do not constitute approval.

Report the target/upstream revisions, rewritten stages, checkout, validation
results, and any remaining stale anchors. Stop after synchronization. Do not
continue implementation, approve, publish metadata, push, prepare, or merge
unless the user separately requested those actions.
