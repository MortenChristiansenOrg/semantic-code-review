# Semantic Review Feedback Format

**Status:** Proposal 0.1

Feedback is mutable local workflow state under
`~/.semantic-flow/reviews/<review-id>/feedback/`. The viewer and CLI use the
same store, keyed by the review ID stored in the implementation's active artifact,
so all worktrees of a repository share it.
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

An agent comment may record `respondsTo`, the ID of the latest user comment it
answers. A thread awaits the agent while a user comment follows the latest
answered comment, so a follow-up sent while the agent works is not lost when the
reply lands. Agent comments without `respondsTo` answer every earlier comment.

### Rounds and listening agents

Runtime coordination lives in the review's `agent.json`, outside the feedback
format. When an agent takes pending feedback it claims those threads for one
round, recording the latest user comment of each; its reply to a claimed thread
answers through that comment. Other runs skip claimed threads. A claim ends when
every thread has a reply, and expires after 30 minutes without agent activity.

An interactive review (`review -i`) records one listening session with a
heartbeat. Starting another session replaces it, and ending a session returns
threads its unfinished round claimed to the queue. A round waiting for the
reviewer's answer to `agent ask` keeps its claim until the answer arrives. The viewer shows the session, the running round, and questions the
agent asks with `agent ask`; reviewer answers, stop requests, and completing the
review are written to the same file. A viewer send marks itself in progress so a
listener takes its notes and replies as one round.

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
Deletion first moves the review's folder to a pending name, so stale writes fail,
records in that folder the new review ID it is about to store, stores it in the
implementation's artifact, and only then removes the folder; when the new ID
cannot be stored, the folder is moved back and nothing changes. Files are removed
only once the folder is renamed as deleted, never from a folder whose deletion may
still roll back. Cleanup, registration and deletion settle an interrupted deletion
by what the repository records. A registration run from a worktree whose artifact
still holds the old ID moves the folder back. Otherwise the deletion is completed
once the active artifact holds the new ID the deletion recorded, or the deletion
marked the old ID retired, and the folder is moved back while the recorded
repository still holds the old ID. Anything else proves nothing, since the
repository may have moved and another one may sit at its old location, so the
folder stays pending until
a `review` or `feedback` command runs from the repository or the repository has been missing for 30
days. When the repository cannot be reached or holds no snapshot with the old ID,
deletion still succeeds and marks the old ID
retired; the next registration that finds the old ID in the artifact stores a new
one first, and starts the fresh review even while the folder waits for cleanup.
The mark is removed once a new ID is stored and no folder of the deletion is left. A folder left behind by a completed deletion is
removed by a later cleanup. A fresh review starts under the new ID.
Cleanup records when it first finds a local review's Git directory missing and
removes the review once it has been missing for 30 days; finding the directory
again, or running a `review` or `feedback` command from the repository, starts that period over. Only a
missing path counts; a directory that cannot be checked, for example for lack of
permission, keeps its review.

Unused-file cleanup keeps every persisted reference and protects fresh uploads
and snapshots for one hour. Unreferenced files are retired inside the owning
review's `.cleanup/` folder before removal, so interrupted cleanup can be retried
without exposing half-removed attachments to new messages.
