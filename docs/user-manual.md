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
| `.semantic-review-feedback/` | Local open and resolved feedback threads |
| `semantic-flow/<implementation-id>/metadata` | Published metadata outside implementation branches |
| `.semantic-review-history/<implementation-id>/` | Archived artifact after landing |

The default shared prefix uses `/`, so GitKraken presents the related branches
as a collapsible folder.

The viewer stores review-progress approvals in browser-local state. Approvals can be recorded for the
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

If trunk advanced:

```text
git switch main
git pull --ff-only
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

To create a single cumulative branch for a conventional remote review:

```text
<semantic-flow> prepare --branch review/customer-order-cancellation
```

This creates the named branch at the final reviewed stage head without
switching the worktree. It refuses to overwrite an existing branch that points
elsewhere.

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

- `restack --from <stage>`: lower stage branch changed.
- `restack --base <target>`: trunk changed.
- `repair`: interrupted artifact file mutation with an unambiguous recovery.
- `validate`: explain schema, reference, branch, ancestry, or inventory drift.
