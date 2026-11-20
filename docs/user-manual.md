# Semantic Code Review user manual

Semantic Code Review turns one implementation into an ordered stack of small,
intent-focused local branches. Each stage has its own branch based on the
branch immediately below it.

## Repository state

| State | Purpose |
| --- | --- |
| `refs/semantic-review/active/<implementation-id>` | Active requirements, stages, head revisions, reasoning, validation and the current unfinished stage, stored in Git and shared by every worktree |
| `semantic-flow/<implementation-id>/stages/<stage-id>` | Cumulative stage branch |
| `~/.semantic-flow/reviews/<review-id>/feedback/` | Local open and resolved feedback threads shared by viewer and CLI |
| `semantic-flow/<implementation-id>/metadata` | Published metadata outside implementation branches |
| `refs/semantic-review/archive/<implementation-id>` | Archived artifact and its landing record |

The default shared prefix uses `/`, so GitKraken presents the related branches
as a collapsible folder.

The viewer stores review progress, drafts, personal notes, and preferences under
`~/.semantic-flow/reviews/<review-id>/`. `SEMANTIC_FLOW_HOME` can override the user
data root and must be an absolute path. Each implementation has one review, with
a random review ID that `implementation init` stores in the private artifact and
that publication and archives leave out. All worktrees of the repository share
the review. The review records a worktree and the repository's Git directory only
to locate it; when that worktree is moved or removed, the next `review` or
`feedback` command run from another worktree, or opening the review there,
records the new location. Commands that only read the artifact, such as
`implementation export`, do not. Folder names use
`<repository>--<implementation>--<64 random hex characters>`, for example
`my-project--order-cancellation--<64 hex characters>`. The readable parts are
normalized and capped at 24 and 40 characters. Changing the display title does not
rename the folder. Deleting a review gives the implementation a new review ID, so
the next review starts empty; when the repository cannot be reached at that time,
the new ID is stored when a `review` or `feedback` command next runs from it. A review whose repository's
Git directory has been missing for 30 days is removed when saved reviews are listed
or another review is started. The period counts from when such a listing or start
first found the directory missing, however long the review was unused before. A
repository that is missing only for now, such as one on a drive that is not
mounted, keeps its review through that period, and a repository moved together
with its Git directory keeps its review whenever a `review` or `feedback` command
runs from the new location, which also starts the period over. An implementation started by an unreleased
development build may have no review ID; commands then fail and ask to start it
again. There is no migration
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

To keep track of which insights you have read, use the round check control on
an insight pill. It marks the insight as reviewed and clicking it again removes
the mark; clicking the rest of the pill still pins its tooltip. Reviewed pills
have a tinted background and a check mark, and each stage shows how many of its
insights are reviewed. If an insight's text changes after you marked it, the
control shows **!** and **Changed since reviewed** until you mark it again. These
marks are saved with the local review state, are never written to the artifact
or stage branches, and neither affect approvals nor are affected by them.

Press **T** or use **Find file** in the viewer toolbar to find a changed file
across the whole review. The shortcut is inactive while typing in a text field
or while another dialog is open. Search matches a contiguous substring of the
current filename, ignoring case; directories and previous names do not affect
matches. Results include every occurrence, grouped by stage and change node.
Each shows the filename above its directory, the same change glyph used in file
headers, and stage-level added/removed line counts (or a binary indicator).
The suggested filename remainder appears as muted text after what you type.
Press **Enter** to open the first result directly, **↑/↓** to select another
result, or **Esc** to close the dialog. Clicking a result also opens it. Files
appearing in multiple nodes or stages have a **Find occurrences** button beside
their row; it opens the same dialog scoped to that exact file, with its filename
selected so you can jump between its changes. Editing the query searches all
filenames again.

## 1. Build the bundled CLI

```text
npm ci --prefix ./scripts
npm run build --prefix ./scripts
```

Before continuing, follow the operating-system selection in
`skills/semantic-flow/SKILL.md` and read either
`skills/semantic-flow/docs/os/unix.md` (Linux and macOS) or
`skills/semantic-flow/docs/os/windows.md`. The examples below reuse the
platform guide's concrete invocations as:

```text
<semantic-flow> <command>
<semantic-flow> implementation <command>
<semantic-flow> feedback <command>
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

Before new work, the skill brings the local target branch up to date with its
configured upstream:

```text
<semantic-flow> refresh-target --json --target-branch main
```

It fetches the upstream and fast-forwards the local branch, through its
checkout when the branch is checked out in a clean worktree. Local commits
ahead of the upstream are kept, and a branch without an upstream is left as
is. Divergence, a failed fetch, or a dirty target checkout that needs to
advance stops the command without changing local branches.

Implementation and simulation use isolated worktrees. An explicit destination
takes precedence over an established repository location and naming convention.
When neither applies, the default is `<main-project-path>.worktrees/<feature-slug>`:
for a project at `/code/my-todo`, work on “my feature” goes in
`/code/my-todo.worktrees/my-feature`, even if the session starts in another linked
worktree. The skill reports the selected absolute path before creation. Occupied
automatic destinations receive `-2`, `-3`, etc.; an occupied explicit destination
requires another path unless the command permits reuse. Implementation may reuse
the intended clean worktree in this repository at the required revision;
simulation creates a new worktree. Existing contents are never overwritten. See the
[shared location rules](../skills/semantic-flow/docs/runtime.md#choose-an-isolated-worktree-location)
for selection and safe reuse.

Initialize from the clean isolated worktree at the local target branch head:

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
<semantic-flow> implementation init --input <implementation-input.json>
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
<semantic-flow> implementation stage begin --input <semantic-stage.json>
```

The command creates and checks out:

```text
semantic-flow/customer-order-cancellation/stages/add-cancellation-policy
```

A later stage might be:

```text
semantic-flow/customer-order-cancellation/stages/persist-cancellation
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
<semantic-flow> implementation stage record --input <decision.json>
```

All insight kinds can optionally link to a line or a span of committed code.
Pass `--code-path <path> --code-start <line> [--code-end <line>]` to `stage record`
or `stage validation` (also supported in batch items). Omit the end for a single
line. Capture after committing; these coordinates refer to the stage head, not
uncommitted working files. For a finalized stage, synchronize its recorded head
before retargeting.

Attach or retarget an existing insight without replacing its text:

```text
<semantic-flow> implementation stage target --collection decisions --item-id keep-policy-in-aggregate --code-path src/Orders/Order.cs --code-start 24 --code-end 31
```

Use `--stage <id> --finalized` for a finalized stage. Use `--remove` instead of
code coordinates to remove only the link. Collections are `decisions`,
`assumptions`, `alternatives`, `failedAttempts`, `risks`, `openQuestions`, and
`validation`.

In the viewer, choose **View code** beside an insight, **Insights** on a file,
or an insight beside its linked line. The dialog shows the full insight alongside
highlighted code with surrounding context; both panes scroll independently.
**Needs review** links show the saved original code and why mapping failed.
Review the revised code and reasoning before retargeting. Unchanged spans can
follow line shifts and file renames automatically; that does not confirm that
the insight's reasoning still holds after surrounding behavior changes.

### Evidence

Evidence lets a reviewer see a feature working without checking out the branch.
Capture it by exercising the committed stage head, then record it from the stage
branch with a clean worktree:

```bash
<semantic-flow> implementation stage evidence --item-id settings-button --kind screenshot \
  --summary "Settings shows the new button" --after /tmp/settings.png \
  --specification-ref story#button --reproduction "Open /settings"
```

Use `--file` for a single capture, `--before` and `--after` for a comparison, and
`--inline` for short terminal output. Add a caption with `path=caption`. Prefer a
screenshot or recording when the change has visible output. Supported files are
PNG, JPEG, GIF, WebP, MP4, WebM, text, log, CSV, Markdown, JSON, and PDF, up to
25 MiB each and 100 MiB per stage. Files are copied into the artifact's `evidence/`
folder, which never appears in a stage diff; publishing and archiving include them, so
check captures for secrets and personal data first.

Use `stage evidence --replace` after recapturing and `stage evidence-remove` to
delete a capture. If a stage can't have evidence, such as a pure refactor, record
why with `stage no-evidence --reason <text>`. Finishing and validating a stage
warn about behavior changes with neither; they do not block.

In the viewer, choose **View evidence** on an evidence pill to see images,
recordings, text, before/after comparisons, and the linked criteria and changes.
Select an image to zoom it.

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
<semantic-flow> implementation stage organize --file <stage-organization.json>
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
<semantic-flow> implementation stage validation --input <validation.json>
<semantic-flow> implementation stage finish
```

A stage may collect several linear commits while you work on it. Finalization
rejects merge commits, requires the recorded stage branch to be checked out,
folds the commits into one stage commit, and captures:

- The immutable head revision of that commit. Its message is the stage title
  and summary; authors of the folded commits become `Co-authored-by` trailers.
  The stage and base branch, the base revision and
  the exact changed-file inventory of the stage-only diff follow from it and
  from the stage below.
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

Each link the review command prints or opens works once and for ten minutes. A
tab keeps working across reloads while its viewer runs. A new tab, a bookmark,
or a tab left open while the viewer restarted (for example after an update)
shows that the page needs a fresh link: run the review again to get one.

On Linux and macOS the review command opens the browser through a private file
in `~/.semantic-flow` that forwards to the link, because other users of the
machine can see the arguments of the program that opens the browser. On Windows
it opens the link directly. Set `SEMANTIC_VIEW_OPEN_URL=1` to open the link
directly on any platform, for example when the browser is sandboxed and cannot
read `~/.semantic-flow` (such as Firefox installed as a snap), or when `.html`
files open in an editor instead of the browser. The link then appears in that
program's arguments while it starts.

The viewer trusts other software serving on the machine's loopback address
(`127.0.0.1`), so do not use it on a host shared with untrusted users.

## 7. Send feedback

In **Review queue**, add notes containing change instructions or questions.
Notes remain editable browser-local drafts until sent. Sending creates open
threads and records the responsible stage head, which lets the UI detect a
stale anchor after restacking.

## 8. Edit a lower stage and restack

The agent or user may check out any stage branch and commit a correction:

```text
git switch semantic-flow/customer-order-cancellation/stages/add-cancellation-policy
# edit, test
git commit -am "Handle paid pending orders"
<semantic-flow> implementation restack --from add-cancellation-policy
```

The command:

1. Accepts the edited lower branch's current head and folds the correction into
   its one stage commit.
2. Replays every branch above it, bottom-up, by cherry-picking its stage commit
   in a scratch worktree under the user data root, outside your checkouts. A
   stage whose changes the target already contains stays as a marked empty
   stage, which validation accepts and preparation skips.
3. Moves all affected refs only after every replay succeeds. On a conflict it
   moves nothing and keeps the scratch worktree with normal Git conflict state:
   resolve and `git add` there, then run `restack --continue`, or discard the
   restack with `restack --abort`. `--continue` moves refs only if the target,
   stage and artifact refs are unchanged since the restack began.
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
If replay conflicts, the target fast-forward is retained and stage refs remain
unchanged. Resolve the conflict in the reported worktree as the skill's
`docs/restack-conflicts.md` describes, run `implementation restack --continue`,
then run `sync --local` to validate.

For a direct restack after the local target has already advanced:

```text
git switch main
<semantic-flow> implementation restack --base main
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
<semantic-flow> feedback thread reply-batch --input <replies-json>
```

The same reply flow handles questions that require no code change. The
reviewer then resolves the thread in the viewer or with:

```text
<semantic-flow> feedback thread resolve --id <thread-id>
```

Reopening or replying to a resolved thread makes it open again. Later stage
rewrites require no feedback metadata updates.

### Interactive review

`/semantic-flow review -i` opens the viewer and keeps the agent listening, so
you never run the feedback command between rounds. The agent waits with:

```text
<semantic-flow> feedback --json --wait [--session <session-id>] [--timeout <seconds>]
```

Each send from the viewer becomes a round. The agent claims its threads, answers
questions in parallel as soon as they are ready, makes code changes (one
subagent per stage when several stages change independently), restacks once, and
replies. Feedback you send meanwhile is queued for the next round, including
follow-ups to threads in progress.

While an agent is listening, tick **Send automatically** next to **Prepare
feedback** to send each feedback note and reply as soon as you save it.
Earlier drafts wait for **Prepare feedback**, and personal notes stay local.
A draft cannot be edited while it is being sent. The viewer remembers the
choice for later reviews.

The viewer shows whether an agent is listening or working, each thread as
queued, in progress, or answered, and a notice with unread markers when a round
finishes; it can also notify you while the tab is hidden. When the agent needs
a decision that is not about one thread, its question appears at the top of the
viewer. **Stop agent** ends listening after the current round, as does marking
the review complete or two hours without feedback.

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

After the chosen remote workflow has landed the code:

```text
<semantic-flow> archive [--landed <revision|base..head>]
```

Archiving needs no checkout and adds nothing to the target branch. It publishes
the artifact if the metadata branch does not hold it yet, stores it under
`refs/semantic-review/archive/<implementation-id>` with a landing record, and
removes the active artifact. Stage and metadata branches are kept.

Landing is found when the target branch contains the final stage head, as after
a fast-forward or merge. After a squash or rebase merge it is unknown unless you
name the landing commit or range with `--landed`; the command may suggest a
target commit whose changes match, which you confirm before recording it:

```text
<semantic-flow> implementation archive landing --id <implementation-id> --landed <revision|base..head>
```

To share the archive, create its annotated tag and push it:

```text
<semantic-flow> implementation archive share --id <implementation-id>
git push <remote> refs/tags/semantic-review/archive/<implementation-id>
```

The tag never moves, so record landing first. Pushing it sends the artifact, its
evidence and the stage commits.

## Recovery

For a suspected defect in the skill, CLI, or viewer, use
`/semantic-flow report <problem>` to diagnose it and prepare an upstream bug
report. It supports external users and manual submission without a source checkout.
See [installation and usage](../README.md#report-a-semantic-flow-problem). Ordinary
comments about the implementation being reviewed still use Semantic Flow feedback.

- `restack --from <stage>`: lower stage branch changed.
- `restack --base <target>`: trunk changed.
- `validate`: explain schema, reference, branch, or ancestry problems.
- `implementation export [--destination <directory>]`: show the artifact in its
  full form, with each stage's branch, base revision and file inventory, for
  inspection.

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
title and ID, repository/worktree path, last edit, and availability. The animated
picker dims and blocks the page behind it; Close, Escape, or clicking outside
dismisses it without rebuilding the page or losing an unfinished message. Switching
saves the current draft, starts or reuses the selected review's service, and
opens its page. If saving or opening fails, the current page and draft remain.
A review whose recorded worktree was removed, or whose implementation is no
longer active, remains listed with an explanation until a command from another
worktree records its new location.

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
`snapshots/` directory. A stale file opens with **Since approval** enabled in
the normal diff toolbar, beside **Hide removed**. Turn it off for the normal
stage base-to-head diff. **Changes**, **Full file**, and **Hide removed** work in
either comparison. Lines in the current file take line comments in either
comparison; lines removed since approval do not, because they are no longer in
the file. Reapproving the file removes the comparison toggle until
the approval becomes stale again. The comparison reports changed ownership and
stage bases. When the stage base changed, it leaves out changes from the target
branch or a lower stage so that it shows only what changed in this stage;
**Include base changes** adds them back. When those changes overlap the stage's
own edits they cannot be separated, and the comparison says so. A restack that
follows an advanced target branch also shows a notice at the top of the viewer
until you dismiss it. Binary content shows hashes instead of a line diff; unavailable
content produces an explicit error. Approving or unapproving a file keeps its
diff open. The combined file-comment and personal-note counts toggle the notes
without closing the diff. The **Add note** footer stays visible when existing
comments are collapsed.

**Wrap lines** enables soft wrapping in file and diff views, including long
unbroken strings. It starts off and is remembered across files in the review.
Wrapped rows keep their source line numbers and feedback anchors.

Markdown files (`.md` and `.markdown`, case insensitive) offer **Source / Preview**.
Preview shows the complete file at the labeled head revision, or the base revision
for a deleted file. Return to Source to inspect diffs or leave line feedback;
existing drafts, notes, and source-view settings are retained. Preview supports
headings, lists, links, tables, task lists, and fenced code. Embedded scripts,
unsafe links, and interactive HTML are removed.

Relative links open repository files as plain text at the displayed revision;
PNG, JPEG, GIF, and WebP images render from that same revision. Missing targets,
unsupported images, binary files, and files above the 4 MiB preview limit remain
unavailable without affecting the source view. Rendered diffs and feedback on
rendered elements are not supported.

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

Use **Attach files**, drop files onto the highlighted message text field, or
paste an image. Other parts of the editor do not accept file drops.
New messages, personal notes, and replies support up to ten files of 20 MiB each,
with or without text. Uploads and drafts survive reloads and review switches.
Attachments appear as compact rows with image thumbnails where supported.
The viewer does not offer file downloads; agents access the managed local files
through feedback commands.
Saving a message keeps it local until you prepare feedback, unless it is sent
automatically in an interactive review.

The CLI can register context too:

```text
<semantic-flow> feedback init
<semantic-flow> feedback attachment add --file <local-file>
<semantic-flow> feedback thread reply --id <thread-id> --comment-id <comment-id> --attachments <attachment-id>
<semantic-flow> feedback attachment show --id <attachment-id>
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
Completion never deletes data automatically; unavailable reviews can be cleaned
too. Only a review whose repository's Git directory has been missing for 30 days
is removed without asking. Source files, branches, implementation
artifacts, publications, and archives are preserved.

**Clean unused files** reclaims unreferenced uploads and snapshots separately.
Files referenced by saved messages, drafts, feedback, or approvals are retained.
Recent uploads and snapshots have a one-hour grace period to protect in-flight
work; uploading the same file again renews that protection. Cleanup runs only
when requested, not automatically when that hour expires. Deleting a whole
review removes its data regardless of age. If another process
changes the data after the preview, refresh the details before confirming.

Deletion moves the review's folder aside, then gives the implementation a new
review ID, then removes the folder. Once the folder is moved, stale tabs and CLI
requests fail and cannot recreate the deleted review; an open viewer of the review
treats it as deleted only once the deletion has completed. Files that cannot be
removed at once are removed by a later cleanup. If the folder cannot be moved, or
the new review ID cannot be stored, deletion fails without changing anything and
can be retried. If the folder then cannot be moved back either, the review's data
is kept under its pending name and the review is unavailable: restore access to
the folder, then open the review from its repository again, which moves it back. If the repository cannot be reached, deletion succeeds and the new
review ID is stored when a `review` or `feedback` command next runs from the
repository. The error
identifies the failing file or folder and filesystem error code. When available, a bounded lookup also
lists process names, PIDs, and files in use (`lsof` on Linux/macOS, Windows Restart
Manager through PowerShell on Windows). Lookup may be unavailable, lack permission,
or miss a directory-only lock; an unidentified process is not evidence of no lock.
No processes are terminated automatically.

Close the application or terminal using the reported location, or release the
lock and check access permissions. Choose **Delete data…** again afterward. For
**Clean unused files**, saved
messages and referenced files stay intact; use the same button again to remove
remaining retired files. Neither operation requires manual file deletion.

You can still open other reviews
after deleting the current one, including after a page reload. A tab whose data
was deleted elsewhere keeps unsent text visible for copying. Running review
explicitly again in the original worktree starts a fresh session once pending
removal is complete.
