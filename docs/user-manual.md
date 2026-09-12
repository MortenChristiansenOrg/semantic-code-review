# Semantic Code Review user manual

Semantic Code Review turns one implementation into an ordered stack of small,
intent-focused local branches. Each stage has its own branch based on the
branch immediately below it.

## Repository state

| State | Purpose |
| --- | --- |
| `.semantic-review/` | Active requirements, stages, branch snapshots, reasoning, and validation |
| `.semantic-review/.work/` | Current unfinished stage |
| `semantic-flow/<implementation-id>/<NN>-<stage-id>` | Cumulative stage branch |
| `~/.semantic-flow/reviews/<review-id>/feedback/` | Local open and resolved feedback threads shared by viewer and CLI |
| `semantic-flow/<implementation-id>/metadata` | Published metadata outside implementation branches |
| `.semantic-review-history/<implementation-id>/` | Archived artifact after landing |

The default shared prefix uses `/`, so GitKraken presents the related branches
as a collapsible folder.

The viewer stores review progress, drafts, personal notes, and preferences under
`~/.semantic-flow/reviews/<review-id>/`. `SEMANTIC_FLOW_HOME` can override the user
data root and must be an absolute path. Review identity combines the canonical artifact-worktree path and
implementation ID, independently of browser ports. Moving a worktree creates a new
review identity; the old data remains available for cleanup. There is no migration
from browser storage. Simultaneous independent edits merge; conflicting edits to
the same field or draft list fail visibly rather than overwrite another tab.
Unfinished composers are shared review state; preserve conflicting text before
reloading. Wait for the saving indicator to clear before closing the viewer.

Approvals remain personal sign-offs. Approvals can be recorded for the
complete change set, a stage, a change node, or a file within one stage.
Approving a parent visually approves its descendants and makes their controls
read-only; removing that parent approval restores each descendant's explicit
status. File approvals are fingerprinted from the stage patch, so a changed
file becomes unapproved while remaining marked as previously approved.

## 1. Build the bundled CLI

```text
npm ci --prefix ./scripts
npm run build --prefix ./scripts
```

Before continuing, follow the operating-system selection in
`skills/semantic-flow/SKILL.md` and read either
`skills/semantic-flow/docs/os/linux.md` or
`skills/semantic-flow/docs/os/windows.md`. The examples below reuse the
platform guide's concrete invocations as:

```text
<semantic-flow> <command>
<semantic-implementation> <command>
<review-feedback> <command>
```

Substitute the selected guide's invocation; do not run these placeholders
literally.

The installed skill also supports intent-level commands:

```text
/semantic-flow implement
/semantic-flow review
/semantic-flow feedback
/semantic-flow reconcile
/semantic-flow simulate
/semantic-flow status
/semantic-flow continue
/semantic-flow sync
/semantic-flow validate
/semantic-flow prepare
/semantic-flow archive
/semantic-flow version
/semantic-flow update
/semantic-flow help [command]
```

Natural-language invocation remains supported:

```text
Implement the current user story using semantic flow
```

`skills/semantic-flow/SKILL.md` indexes each command to its installed workflow
file. `/semantic-flow help <command>` reads those installed files and explains
the current behavior rather than returning a separately maintained help text.
The bundled `<semantic-flow>` helper handles linked-worktree discovery,
combined validation, status inspection, viewer launch, version reporting, and
safe skill updates on Linux and Windows.

## 2. Initialize at trunk

Start with a clean worktree at the local target branch head:

```json
{
  "implementationId": "customer-order-cancellation",
  "title": "Allow customers to cancel pending orders",
  "summary": "Add guarded cancellation and expose it through the API.",
  "targetBranch": "main",
  "specificationId": "cancel-order",
  "specificationTitle": "Customer cancels an order",
  "specificationSummary": "A customer can cancel before fulfilment starts.",
  "sourceKind": "local",
  "sourceReference": "customer-order-cancellation",
  "criterion": [
    "cancel-pending=A pending order can be cancelled.",
    "reject-shipped=A shipped order cannot be cancelled."
  ]
}
```

Pass that document from an operating-system temporary file or through stdin as
described by the selected platform guide:

```text
<semantic-implementation> init --input <implementation-input.json>
```

Initialization records `main`'s current head as `baseRevision`. Override the
default branch folder with `--branch-prefix`; otherwise it is
`semantic-flow/customer-order-cancellation`.

## 3. Begin a stage

Place long mutation options in JSON:

```json
{
  "id": "add-cancellation-policy",
  "title": "Define the cancellation policy",
  "summary": "Add the domain transition and rejection outcomes.",
  "rationale": "Every caller must use the same transition rule.",
  "specificationRef": [
    "cancel-order#cancel-pending",
    "cancel-order#reject-shipped"
  ]
}
```

```text
<semantic-implementation> stage begin --input <semantic-stage.json>
```

The command creates and checks out:

```text
semantic-flow/customer-order-cancellation/01-add-cancellation-policy
```

A later stage might be:

```text
semantic-flow/customer-order-cancellation/02-persist-cancellation
```

It starts at stage 1's head and records stage 1 as its base branch.

## 4. Implement and record insights

Record insights when they become relevant:

```json
{
  "kind": "decision",
  "itemId": "keep-policy-in-aggregate",
  "category": "engineering",
  "summary": "Put cancellation rules on the Order aggregate.",
  "rationale": "Other callers must not bypass the rule."
}
```

```text
<semantic-implementation> stage record --input <decision.json>
```

Commit the implementation, then describe its causal change nodes in an
organization document:

```json
{
  "$schema": "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json",
  "nodes": [
    {
      "id": "enforce-cancellation-policy",
      "description": "Move cancellation rules into the Order aggregate and update callers to use the guarded transition.",
      "changes": [
        {
          "path": "src/Orders/Order.cs",
          "classification": "behavior"
        },
        {
          "path": "src/Orders/OrderService.cs",
          "classification": "refactor"
        }
      ]
    }
  ],
  "itemLinks": [
    {
      "collection": "decisions",
      "itemId": "keep-policy-in-aggregate",
      "nodeRefs": [
        "enforce-cancellation-policy"
      ]
    }
  ]
}
```

```text
<semantic-implementation> stage organize --file <stage-organization.json>
```

Every changed file belongs to a node. If multiple nodes share one file, each
membership supplies `hunks` or `lineRanges`, using one selector style and
covering every changed hunk or line exactly once.

## 5. Run final validation and finalize

Record observed validation and link it to the relevant nodes:

```json
{
  "itemId": "domain-tests",
  "type": "automated",
  "status": "passed",
  "summary": "Covers cancellation and rejection after shipment.",
  "command": "dotnet test tests/Orders.Domain.Tests",
  "nodeRef": ["enforce-cancellation-policy"]
}
```

```text
<semantic-implementation> stage validation --input <validation.json>
<semantic-implementation> stage finish
```

A stage may contain several linear commits. Finalization rejects merge commits,
requires the recorded stage branch to be checked out, and captures:

- Stage and base branch.
- Immutable base and head revisions.
- Exact changed-file inventory for the stage-only diff.
- Descriptive nodes with classified whole-file, hunk, or line-range ownership.
- Node references on all recorded insights and validation evidence.

Repeat begin, implement, commit, and finish for each stage.

## 6. Validate and review

```text
<semantic-flow> validate --publish --stack
```

```text
<semantic-flow> review
```

The UI leads with each stage's node descriptions, then shows their classified
file or hunk membership, linked insights, branch snapshots, and
Git-backed diffs.

Add `--json` for machine-readable worktree, branch, base, and head entries.
It neither contacts a remote nor creates hosted reviews.

The viewer refreshes external feedback and metadata in place, keeping drafts and
unchanged diffs. Changes appear automatically while the tab is visible. Large
files have paged changes and full-context views; line-thread navigation loads
the relevant page. Reopening review reuses a healthy viewer for the same worktree,
implementation, and installed viewer version.

## 7. Send feedback

In **Review queue**, add notes containing change instructions or questions.
Notes remain editable browser-local drafts until sent. Sending creates open
threads and records the responsible stage head, which lets the UI detect a
stale anchor after restacking.

## 8. Edit a lower stage and restack

The agent or user may check out any stage branch and commit a correction:

```text
git switch semantic-flow/customer-order-cancellation/01-add-cancellation-policy
# edit, test
git commit -am "Handle paid pending orders"
<semantic-implementation> restack --from add-cancellation-policy
```

The command:

1. Accepts the edited lower branch's current head.
2. Replays every branch above it, bottom-up.
3. Moves all affected refs only after every replay succeeds.
4. Refreshes base/head snapshots and file inventories.
5. Leaves the edited branch checked out.

Several stage branches may be edited before one restack. Check out the earliest
edited stage before running `restack --from`; the command accepts later edited
heads and replays each descendant once. Reorganize a descendant afterward only
when its rewritten diff no longer matches its node coverage.

Default output is a one-line summary. Add `--json` when exact old and new
revisions are needed.

To bring the latest target changes into the implementation, ask the agent:

```text
/semantic-flow sync
```

It fetches the recorded target branch's configured upstream, fast-forwards the
local target, and restacks the finalized stages. The target may be checked out
in another clean worktree. Local target commits ahead of upstream are preserved;
divergence, unfinished stages, dirty affected worktrees, and unrecorded stage
head changes require attention before synchronization. The agent resolves clear
conflicts, checks node coverage and feedback anchors, and runs relevant tests.
It stops after synchronization without processing pending feedback or publishing.

The helper is also available directly:

```text
<semantic-flow> sync --json
<semantic-flow> sync --local --json
```

`--local` uses only the current local target head, without fetching or requiring
an upstream. `--project` and `--implementation-id` select a linked artifact.
If replay conflicts, the target fast-forward is retained, while stage refs and
artifacts remain unchanged. Follow the skill's `docs/restack-conflicts.md`,
resume the underlying restack directly, then run `sync --local` to validate.

For a direct restack after the local target has already advanced:

```text
git switch main
<semantic-implementation> restack --base main
```

Do not run a restack while an upper branch that must move is checked out.

If branches were already pushed, updating rewritten remote refs is a separate
hosting operation and should use lease-protected force pushes where available.

## 9. Reply to and resolve feedback

Get work grouped by stage:

```text
<semantic-flow> feedback --json
```

After answering or restacking, the implementation agent sends all replies in
one batch:

```text
<review-feedback> thread reply-batch --input <replies-json>
```

The same reply flow handles questions that require no code change. The
reviewer then resolves the thread in the viewer or with:

```text
<review-feedback> thread resolve --id <thread-id>
```

Reopening or replying to a resolved thread makes it open again. Later stage
rewrites require no feedback metadata updates.

## 10. Publish and prepare local outputs

Once human review is complete, validate readiness, publish metadata, and report
the local stack in one operation:

```text
<semantic-flow> prepare
```

The default metadata branch is:

```text
semantic-flow/customer-order-cancellation/metadata
```

The metadata branch is parented by the final stage head but remains separate
from implementation branches.

For a single cumulative branch, the first preparation chooses its durable
name:

```text
<semantic-flow> prepare --branch review/customer-order-cancellation
```

This publishes metadata, creates the branch at the final reviewed stage head,
and records a private local binding. After feedback changes and restacking,
prepare again with the same branch name:

```text
<semantic-flow> prepare --branch review/customer-order-cancellation
```

The command republishes metadata and moves the same cumulative branch with a
compare-and-swap guard. It reports an exact force-with-lease command for
updating the same remote source branch, so an existing pull request remains
attached to it.

Use `--adopt` only to take ownership of an existing branch and replace its tip.
This is also the migration path for cumulative branches created by older
versions. Use `--branch <name> --rebind` to choose a different output branch;
the previous branch remains unchanged.

The flow stops here. A user may later push only the cumulative branch, or push
the stage branches and let a compatible remote represent them as a stack. The
tool does not assume how reviews are created or merged.

## 11. Archive after landing

After the chosen remote workflow has landed the code and the target branch is
current:

```text
<semantic-flow> archive
```

## Recovery

For a suspected defect in the skill, CLI, or viewer, use the separate
`/semantic-flow-report <problem>` skill to diagnose it and prepare an upstream bug
report. It supports external users and manual submission without a source checkout.
See [installation and usage](../README.md#report-a-semantic-flow-problem). Ordinary
comments about the implementation being reviewed still use Semantic Flow feedback.

- `restack --from <stage>`: lower stage branch changed.
- `restack --base <target>`: trunk changed.
- `repair`: interrupted artifact file mutation with an unambiguous recovery.
- `validate`: explain schema, reference, branch, ancestry, or inventory drift.

File and line notes keep the step in which they were created. For submitted
feedback, the viewer retains that context through the browser's exported-note
record; clearing browser storage or opening the review in another browser can
remove that provenance. A shared-file comment with no known original step stays
visible in Notes & feedback under “Other targets / original step unknown”, with
an explanation and no misleading jump. Files belonging to just one step can
resolve their context unambiguously. This does not change feedback schemas.

Dimmed shared-file sections explain their owning step and provide a jump to that
step at the same line. File rows show file and line feedback counts separately,
with personal notes in their own badge.
Use Ctrl+Enter in a note or reply input to submit it; ordinary Enter adds a line.

Concurrent reviews use separate localhost services. Opening a different review
keeps existing viewers available; reopening the same review reuses its healthy
service. A review first tries its recorded port. With no recorded port it tries
`SEMANTIC_VIEW_PORT` (29180 by default). If that port is occupied by another
review or application, it chooses and records another port. A service restart
retains review state, and a skill update restarts matching registered services
for the current repository's worktrees.

Every viewer command belongs to the review that initiated it. The server resolves
that review's registry identity to its artifact worktree and retains the context
through queued work and subprocesses. It never uses the launching directory as a
fallback. A removed worktree, changed implementation, or deleted session produces
an explicit error. Future viewer command handlers must use the shared review
command runner and explicitly validate any associated working worktree.

Use **Reviews** in the viewer toolbar to revisit any saved review without asking
an agent to run another review command. The list shows each implementation's
title and ID, repository/worktree path, last edit, and availability. Switching
saves the current draft, starts or reuses the selected review's service, and
opens its page. If saving or opening fails, the current page and draft remain.
A removed or changed worktree remains listed with an explanation; its stored
review data is never silently reassigned to another worktree.

**Mark complete** and **Reopen review** change only the local review's lifecycle.
Completion does not approve files, land an implementation, stop its service, or
delete data. Opening an already completed review leaves it completed. Last edit
tracks comments, feedback, approvals, typed draft text, and lifecycle changes;
opening a page or changing navigation preferences does not update it.

File approvals belong to a particular stage and change node. When a file appears
in two nodes, approve each appearance separately. Node and stage summaries and
coverage count those individual file reviews; unapproving one does not revoke
another node's sign-off on the same file.

A file review becomes stale if the full file diff changes, the stage base changes,
or that node's classification or owned hunks/line ranges change. Changes outside
the node's owned range also invalidate its approval because the sign-off records
the whole file state. A rename retains a stale indicator only in the same node.
Approvals remain personal review notes and do not gate CLI workflows.

Approving a file retains its complete head content under that review's local
`snapshots/` directory. Open an approved or stale file and choose **Since approval**
to compare that retained content with the current head. **Current stage diff**
keeps the normal stage base-to-head comparison. The comparison names both paths
and revisions and reports changed ownership, stage bases, existence, and file
modes. Binary content shows hashes and sizes instead of a line diff; unavailable
content produces an explicit error.

Approval snapshots retain file content up to 20 MiB per endpoint. Larger files
retain their actual size and Git object identity, with an explicit unavailable
comparison and no claimed SHA-256 content hash. This limit does not prevent
recording a personal approval.

Snapshots survive restacking and Git garbage collection. Reapproval captures a
new snapshot; saving reapproval or removing approval releases the previous
snapshot when no approval references it. Failed or abandoned captures remain
owned by the review for cleanup. Historical comparisons have no line-comment
controls. Jumping to a line note restores the current stage diff, preserving its
actual feedback anchor.

### Attach context to messages

Use **Attach files**, drop files into an open message editor, or paste an image.
New messages, personal notes, and replies support up to ten files of 20 MiB each,
with or without text. Uploads and drafts survive reloads and review switches.
Attachments appear as compact rows with image thumbnails where supported.
The viewer does not offer file downloads; agents access the managed local files
through feedback commands.
Saving a message keeps it local until you prepare feedback.

The CLI can register context too:

```text
<review-feedback> init
<review-feedback> attachment add --file <local-file>
<review-feedback> thread reply --id <thread-id> --comment-id <comment-id> --attachments <attachment-id>
<review-feedback> attachment show --id <attachment-id>
```

`attachment add` and `attachment show` print metadata and `localPath` as JSON.
Repeat `--attachments` for multiple IDs, or supply an array through JSON input.
Feedback commands include these local paths so an agent can read the files.
Only local uploads are supported. Cancelled drafts and failed sends leave files
owned by the review for explicit cleanup; retries reuse the same managed file.

### Delete review data or clean unused files

Open **Reviews → Delete data…** to inspect a review's location, lifecycle status,
storage size, drafts, personal notes, approvals, feedback, attachments, and saved
snapshots. **Delete review data** confirms removal of that review's local data.
Unsent drafts and unresolved feedback are highlighted before confirmation.
Completion never deletes data automatically; unavailable worktrees can be cleaned
too. Source files, branches, implementation artifacts, publications, and archives
are preserved.

**Clean unused files** reclaims unreferenced uploads and snapshots separately.
Files referenced by saved messages, drafts, feedback, or approvals are retained.
Recent uploads and snapshots have a one-hour grace period to protect in-flight
work; uploading the same file again renews that protection. Cleanup runs only
when requested, not automatically when that hour expires. Deleting a whole
review removes its data regardless of age. If another process
changes the data after the preview, refresh the details before confirming.

Deletion invalidates the old session before removing files. Stale tabs and CLI
requests cannot recreate it. If a file is locked or removal is interrupted,
**Retry deletion…** remains in Saved reviews. You can still open other reviews
after deleting the current one, including after a page reload. A tab whose data
was deleted elsewhere keeps unsent text visible for copying. Running review
explicitly again in the original worktree starts a fresh session once pending
removal is complete.
