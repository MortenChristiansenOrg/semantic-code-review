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
targets add a path. Line targets add a path, a diff side and a line number. The
path is the file's path in the stage on both sides, also for a removed line of a
file the stage renames; the side says which revision counts the line: `old` the
stage's base, where a renamed file still has its previous path, and `new` the
stage head. A line target given by the previous path of a renamed file is refused
with the path to use. A thread stored before this rule by that previous path is
read by the file's path while its stage head is the anchored one.

The thread's `assignedStageId` identifies where the agent should make a change.
Its `stageHead` records the assigned stage snapshot. Before returning pending
feedback, the CLI refreshes non-line anchors when the exact target still exists.
A non-line thread remains stale when its target disappeared.

The assigned stage and the stage of a stage-backed target must be stages of the
implementation, except in a resolved thread, which may keep a stage that
`implementation stage remove` took out of the stack. Such a thread stays
readable but can no longer be replied to or reopened, and no new thread can
name the removed stage.

Line anchors remain fixed. A stage's head commit changes at every fold and
restack, also when its content stays the same, so the head says nothing about
one line. While the stage head is the anchored one, the line is where it was
written. Otherwise it is followed through Git's diff of its path from the
anchored snapshot to the stage's current diff: the new side from the target's
`stageHead`, the old side from that commit's first parent, since a stage holds
one commit on its base. Superseded heads stay reachable as parents of the
artifact snapshot. Lines are compared as the viewer's diff shows them, with the
settings of the stage inventory, whatever the Git configuration. A line thread is current while the
same line stands unchanged at the same path and on the same side, and the
current diff shows it there; its current line number may differ from the stored
one. Otherwise the thread is stale: the line changed or was removed, the file
moved or left the stage, its diff shows no lines, or the line is no longer shown
on that side. A removed line of a file the stage renames is followed along the
file's previous path while the anchored head renamed the file from that path
too, and is current while the stage's diff, which pairs the two paths as the
stage inventory does, still removes it. The viewer and `feedback next
--compact` give the same answer.

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

A review the agent listens to (`/semantic-flow review`) records one listening
session with a heartbeat. Starting another session replaces it and returns the
threads of every running round to the queue. Afterwards a replaced round can
post no reply, progress note or question that names it, and can change the
implementation only to abort a restack it left pending while no other round runs
and no other session listens; the agent that took over finishes it instead. Every command that changes the
implementation accepts the round's `claim` and checks it under the review lock,
in the same step as the snapshot and ref transaction, so a takeover cannot come
between the check and the change. While a listening session's round runs, a
change that names no round is refused. Ending a session returns threads its unfinished round
claimed to the queue. A round waiting for the
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
and snapshots for one hour. It reads the feedback manifest and every thread it
lists, and any other thread file it finds; while any of them cannot be read, or
one of them or the `feedback` or `feedback/threads` folder is a symbolic link or
junction, it removes no attachment. Unreferenced files are retired inside the owning
review's `.cleanup/` folder before removal, so interrupted cleanup can be retried
without exposing half-removed attachments to new messages.
