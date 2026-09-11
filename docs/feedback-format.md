# Semantic Review Feedback Format

**Status:** Proposal 0.1

Feedback is mutable local workflow state under
`~/.semantic-flow/reviews/<review-id>/feedback/`. The viewer and CLI use the
same store, keyed by canonical artifact-worktree path and implementation ID.
`semantic-flow inspect --json` exposes each candidate's resolved `feedbackDirectory`;
use that output instead of constructing a path. `SEMANTIC_FLOW_HOME` overrides
the user data root and must be an absolute path. There is no migration or fallback
to worktree-local feedback. Feedback connects reviewer comments to semantic targets
and the stage snapshot used to process them.

```text
~/.semantic-flow/reviews/<review-id>/feedback/
  manifest.json
  threads/<thread-id>.json
```

## Lifecycle

Threads are either `open` or `resolved`. Each thread contains an ordered
comment timeline that begins with a user comment.

Adding a thread captures its responsible stage and that stage's current head.
The implementation agent replies after answering the question or making the
requested change. Only the reviewer resolves or reopens the thread.

Draft notes persist as private viewer state in the same review directory. They
enter the submitted feedback format only when the reviewer sends them.

## Targets

Specification, criterion, stage, change node, insight, file, and line targets
use stable semantic IDs. Stage-backed targets also store:

- `stageId`
- `stageBranch`
- `stageHead`

Node targets add a node ID. Insight targets add collection and item IDs. File
targets add a path. Line targets add a diff side and line number.

The thread's `assignedStageId` identifies where the agent should make a change.
Its `stageHead` records the assigned stage snapshot. Before returning pending
feedback, the CLI refreshes non-line anchors when the exact target still exists.
Line anchors remain fixed because the referenced content may have moved. A
thread remains stale when a line's stage changed or a non-line target
disappeared.

## Agent processing

1. Select open feedback for the earliest affected stage.
2. Check out that stage branch.
3. Answer the question or implement, validate, and commit the correction.
4. Run `restack --from <stage>` after a code change.
5. Add an agent reply explaining the answer or change.

The agent does not resolve threads.

Feedback mutations and validation share the per-review lock used by viewer state.
Batch reads in the viewer use the same lock. Feedback files are replaced atomically,
and successful feedback writes update the review's last-edited timestamp.
Publication-readiness validation requires every thread to be resolved. Metadata publication and
local branch preparation are separate implementation-artifact operations.

Feedback remains independent from the implementation artifact and is not
committed on stage branches.

## Local message attachments

Feedback v0.1 comments may include `attachments`, with up to ten managed file
references. Each reference records `id`, original `filename`, `mediaType`, byte
`size`, `sha256`, and a review-relative `path` of
`attachments/<id>/content.bin`. The comment must have nonblank `body` text or at
least one attachment. An empty body is valid for attachment-only context.

Bytes are stored unchanged in the owning review under `~/.semantic-flow`, never
in implementation metadata or stage branches. IDs derive from the filename,
normalized media type, and content hash, making upload retries idempotent.
References are validated against the managed metadata and contained file.
CLI feedback output adds an absolute `localPath` for agent access; that path is
not persisted in the feedback artifact. Experimental v0.1 changes in place.

## Deletion and retention

A review owns its feedback and files exclusively; identical attachments in
separate reviews have separate stored copies. Explicit review deletion removes
local feedback together with drafts, notes, approvals, attachments, and snapshots.
The implementation artifact and archived or published provenance are unaffected.
Deletion first records the retired generation under `~/.semantic-flow/deletions/`
and moves its files into `~/.semantic-flow/trash/`. Pending removal remains
retryable; a fresh session cannot start until it finishes. Stale writes fail.

Unused-file cleanup keeps every persisted reference and protects fresh uploads
and snapshots for one hour. Unreferenced files are retired inside the owning
review's `.cleanup/` folder before removal, so interrupted cleanup can be retried
without exposing half-removed attachments to new messages.
