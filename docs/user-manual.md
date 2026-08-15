# Semantic Review user manual

Semantic Review turns one implementation into an ordered stack of small,
intent-focused local branches. Each stage has its own branch based on the
branch immediately below it.

## Repository state

| State | Purpose |
| --- | --- |
| `.semantic-review/` | Active requirements, stages, branch snapshots, reasoning, and validation |
| `.semantic-review/.work/` | Current unfinished stage |
| `semantic-review/<review-id>/<NN>-<stage-id>` | Cumulative stage branch |
| `.semantic-review-feedback/` | Local mutable feedback and approvals |
| `semantic-review/<review-id>/metadata` | Published metadata outside implementation branches |
| `.semantic-review-history/<review-id>/` | Archived artifact after landing |

The default shared prefix uses `/`, so GitKraken presents the related branches
as a collapsible folder.

The review workspace stores review-progress approvals in
`.semantic-review-feedback/approvals.json`. Approvals can be recorded for the
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
<semantic-review> <command>
<review-feedback> <command>
```

Substitute the selected guide's invocation; do not run these placeholders
literally.

## 2. Initialize at trunk

Start with a clean worktree at the local target branch head:

```json
{
  "reviewId": "customer-order-cancellation",
  "title": "Allow customers to cancel pending orders",
  "summary": "Add guarded cancellation and expose it through the API.",
  "targetBranch": "main",
  "requirementId": "cancel-order",
  "requirementTitle": "Customer cancels an order",
  "requirementSummary": "A customer can cancel before fulfilment starts.",
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
<semantic-review> init --input <review-input.json>
```

Initialization records `main`'s current head as `baseRevision`. Override the
default branch folder with `--branch-prefix`; otherwise it is
`semantic-review/customer-order-cancellation`.

## 3. Begin a stage

Place long mutation options in JSON:

```json
{
  "id": "add-cancellation-policy",
  "title": "Define the cancellation policy",
  "summary": "Add the domain transition and rejection outcomes.",
  "rationale": "Every caller must use the same transition rule.",
  "requirementRef": [
    "cancel-order#cancel-pending",
    "cancel-order#reject-shipped"
  ]
}
```

```text
<semantic-review> stage begin --input <semantic-stage.json>
```

The command creates and checks out:

```text
semantic-review/customer-order-cancellation/01-add-cancellation-policy
```

A later stage might be:

```text
semantic-review/customer-order-cancellation/02-persist-cancellation
```

It starts at stage 1's head and records stage 1 as its base branch.

## 4. Implement and record context

Record context when it becomes relevant:

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
<semantic-review> stage record --input <decision.json>
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
<semantic-review> stage organize --file <stage-organization.json>
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
<semantic-review> stage validation --input <validation.json>
<semantic-review> stage finish
```

A stage may contain several linear commits. Finalization rejects merge commits,
requires the recorded stage branch to be checked out, and captures:

- Stage and base branch.
- Immutable base and head revisions.
- Exact changed-file inventory for the stage-only diff.
- Descriptive nodes with classified whole-file, hunk, or line-range ownership.
- Node references on every recorded context and validation item.

Repeat begin, implement, commit, and finish for each stage.

## 6. Validate and review

```text
<semantic-review> validate
<semantic-review> validate --publish
<semantic-review> prepare-stack
```

```powershell
npm start --prefix .\poc
```

The UI leads with each stage's node descriptions, then shows their classified
file or hunk membership, linked semantic context, branch snapshots, and
Git-backed diffs.

`prepare-stack --json` emits machine-readable branch, base, and head entries.
It neither contacts a remote nor creates hosted reviews.

## 7. Submit feedback

In **Review queue**, create a batch, add comments, and submit it. Submission
freezes the assigned stage head. This immutable snapshot lets the UI detect a
stale anchor after restacking.

## 8. Edit a lower stage and restack

The agent or user may check out any stage branch and commit a correction:

```text
git switch semantic-review/customer-order-cancellation/01-add-cancellation-policy
# edit, test
git commit -am "Handle paid pending orders"
<semantic-review> restack --from add-cancellation-policy
```

The command:

1. Accepts the edited lower branch's current head.
2. Replays every branch above it, bottom-up.
3. Moves all affected refs only after every replay succeeds.
4. Refreshes base/head snapshots and file inventories while requiring node
   partitions to remain valid for the rewritten diffs.
5. Leaves the edited branch checked out.

If trunk advanced:

```text
git switch main
git pull --ff-only
<semantic-review> restack --base main
```

Do not run a restack while an upper branch that must move is checked out.

If branches were already pushed, updating rewritten remote refs is a separate
hosting operation and should use lease-protected force pushes where available.

## 9. Resolve and approve feedback

Get work grouped by stage:

```text
<review-feedback> next --json
```

After restacking, resolve each item with the submission snapshot and current
head:

```json
{
  "id": "<feedback-id>",
  "summary": "Updated the cancellation rule.",
  "stage": "add-cancellation-policy",
  "previousHead": "<submitted-head>",
  "rewrittenHead": "<current-head>"
}
```

```text
<review-feedback> comment resolve --input <resolution.json>
```

If the stage changes again, use `resolution rebind` with
`--previous-head` and `--rewritten-head`.

## 10. Approve and prepare local outputs

After explicit approval:

```text
<review-feedback> approve-stack
```

This publishes `.semantic-review/` to:

```text
semantic-review/customer-order-cancellation/metadata
```

The metadata branch is parented by the final stage head but remains separate
from implementation branches.

The reviewed stack is now ready locally:

```text
<semantic-review> prepare-stack
```

To create a single cumulative branch for a conventional remote review:

```text
<semantic-review> prepare-branch --branch review/customer-order-cancellation
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
<semantic-review> archive
```

## Recovery

- `restack --from <stage>`: lower stage branch changed.
- `restack --base <target>`: trunk changed.
- `repair`: interrupted artifact file mutation with an unambiguous recovery.
- `validate`: explain schema, reference, branch, ancestry, or inventory drift.
