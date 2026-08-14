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

## 1. Build the bundled CLI

```powershell
npm ci --prefix .\scripts
npm run build --prefix .\scripts

$semantic = ".\skills\semantic-flow\scripts\semantic-review.mjs"
$feedback = ".\skills\semantic-flow\scripts\review-feedback.mjs"
```

## 2. Initialize at trunk

Start with a clean worktree at the local target branch head:

```powershell
node $semantic init `
  --review-id customer-order-cancellation `
  --title "Allow customers to cancel pending orders" `
  --summary "Add guarded cancellation and expose it through the API." `
  --target-branch main `
  --requirement-id cancel-order `
  --requirement-title "Customer cancels an order" `
  --requirement-summary "A customer can cancel before fulfilment starts." `
  --source-kind local `
  --source-reference "customer-order-cancellation" `
  --criterion "cancel-pending=A pending order can be cancelled." `
  --criterion "reject-shipped=A shipped order cannot be cancelled."
```

Initialization records `main`'s current head as `baseRevision`. Override the
default branch folder with `--branch-prefix`; otherwise it is
`semantic-review/customer-order-cancellation`.

For long mutations, place options in JSON and use `--input`:

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

```powershell
node $semantic stage begin --input $env:TEMP\semantic-stage.json
```

To avoid creating a file, pipe JSON through stdin:

```powershell
@'
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
'@ | node $semantic stage begin --input -
```

## 3. Begin a stage

```powershell
node $semantic stage begin `
  --id add-cancellation-policy `
  --title "Define the cancellation policy" `
  --summary "Add the domain transition and rejection outcomes." `
  --rationale "Every caller must use the same transition rule." `
  --requirement-ref cancel-order#cancel-pending `
  --requirement-ref cancel-order#reject-shipped
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

## 4. Implement, record, and validate

Record context when it becomes relevant:

```powershell
node $semantic stage record `
  --kind decision `
  --item-id keep-policy-in-aggregate `
  --category engineering `
  --summary "Put cancellation rules on the Order aggregate." `
  --rationale "Other callers must not bypass the rule."
```

Record observed validation:

```powershell
node $semantic stage validation `
  --item-id domain-tests `
  --type automated `
  --status passed `
  --summary "Covers cancellation and rejection after shipment." `
  --command "dotnet test tests/Orders.Domain.Tests"
```

## 5. Commit and finalize the branch

```powershell
git add <implementation-paths>
git commit -m "Define order cancellation policy"
node $semantic stage finish
```

A stage may contain several linear commits. Finalization rejects merge commits,
requires the recorded stage branch to be checked out, and captures:

- Stage and base branch.
- Immutable base and head revisions.
- Exact changed-file inventory for the stage-only diff.

Repeat begin, implement, commit, and finish for each stage.

## 6. Validate and review

```powershell
node $semantic validate
node $semantic validate --publish
node $semantic prepare-stack
npm start --prefix .\poc
```

The UI shows each stage's branch, base, head snapshot, semantic context, and
Git-backed diff.

`prepare-stack --json` emits machine-readable branch, base, and head entries.
It neither contacts a remote nor creates hosted reviews.

## 7. Submit feedback

In **Review queue**, create a batch, add comments, and submit it. Submission
freezes the assigned stage head. This immutable snapshot lets the UI detect a
stale anchor after restacking.

## 8. Edit a lower stage and restack

The agent or user may check out any stage branch and commit a correction:

```powershell
git switch semantic-review/customer-order-cancellation/01-add-cancellation-policy
# edit, test
git commit -am "Handle paid pending orders"
node $semantic restack --from add-cancellation-policy
```

The command:

1. Accepts the edited lower branch's current head.
2. Replays every branch above it, bottom-up.
3. Moves all affected refs only after every replay succeeds.
4. Refreshes base/head snapshots and file inventories.
5. Leaves the edited branch checked out.

If trunk advanced:

```powershell
git switch main
git pull --ff-only
node $semantic restack --base main
```

Do not run a restack while an upper branch that must move is checked out.

If branches were already pushed, updating rewritten remote refs is a separate
hosting operation and should use lease-protected force pushes where available.

## 9. Resolve and approve feedback

Get work grouped by stage:

```powershell
node $feedback next --json
```

After restacking, resolve each item with the submission snapshot and current
head:

```powershell
node $feedback comment resolve `
  --id <feedback-id> `
  --summary "Updated the cancellation rule." `
  --stage add-cancellation-policy `
  --previous-head <submitted-head> `
  --rewritten-head <current-head>
```

If the stage changes again, use `resolution rebind` with
`--previous-head` and `--rewritten-head`.

## 10. Approve and prepare local outputs

After explicit approval:

```powershell
node $feedback approve-stack
```

This publishes `.semantic-review/` to:

```text
semantic-review/customer-order-cancellation/metadata
```

The metadata branch is parented by the final stage head but remains separate
from implementation branches.

The reviewed stack is now ready locally:

```powershell
node $semantic prepare-stack
```

To create a single cumulative branch for a conventional remote review:

```powershell
node $semantic prepare-branch --branch review/customer-order-cancellation
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

```powershell
node $semantic archive
```

## Recovery

- `restack --from <stage>`: lower stage branch changed.
- `restack --base <target>`: trunk changed.
- `repair`: interrupted artifact file mutation with an unambiguous recovery.
- `validate`: explain schema, reference, branch, ancestry, or inventory drift.
