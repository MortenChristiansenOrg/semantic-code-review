# Semantic Review user manual

Semantic Review turns one implementation into an ordered set of reviewable
stages. The coding agent uses the `semantic-story-implementation` skill while
it works; the reviewer uses the local web application to inspect those stages,
leave feedback, and approve the result.

## What the workflow adds to the repository

| Repository state | Purpose | Tracked by Git? |
| --- | --- | --- |
| `.semantic-review/` | Active requirements, stage descriptions, reasoning, validation, and commit references | Ignored while work is active; tracked only when published |
| `.semantic-review/.work/` | The current unfinished stage | No |
| Semantic stage commits | The implementation, one coherent commit per stage | Yes |
| `.semantic-review-feedback/` | Draft comments, submitted feedback, resolutions, and approvals | No |
| Metadata commit | The validated `.semantic-review/` artifact after approval | Yes |
| PR-ready branch | A stable branch pointing to the approved implementation and metadata | Yes |
| `.semantic-review-history/<review-id>/` | The published artifact after the review is merged and archived | Yes |

Version 0.1 uses one linear Git commit stack: each stage commit is the direct
child of the previous stage. Initialization does not create a branch or change
production code.

## Roles

**The coding agent** initializes the review, records context while implementing,
creates and finalizes stage commits, applies feedback, and runs validation.

**The reviewer** reads the requirements, reasoning, evidence, and diffs; submits
feedback; approves resolutions; and approves the complete stack.

The scripts own artifact structure and Git invariants. Do not hand-edit the
manifest, finalized stage commit data, or stage order.

## 1. Install the skill dependencies

You need Node.js 20 or later. From the repository root, run once:

```powershell
npm ci --prefix .\skills\semantic-story-implementation
```

The commands below use:

```powershell
$semantic = ".\skills\semantic-story-implementation\scripts\semantic-review.mjs"
$feedback = ".\skills\semantic-story-implementation\scripts\review-feedback.mjs"
```

## 2. Initialize the implementation review

Start with a clean Git worktree. There can be only one active
`.semantic-review` artifact.

```powershell
node $semantic init `
  --review-id customer-order-cancellation `
  --title "Allow customers to cancel pending orders" `
  --summary "Add guarded cancellation and expose it through the API." `
  --target-branch main `
  --requirement-id cancel-order `
  --requirement-title "Customer cancels an order" `
  --requirement-summary "A customer can cancel before fulfilment starts." `
  --source-kind azure-devops `
  --source-reference "AB#4821" `
  --source-url "https://dev.azure.com/example/project/_workitems/edit/4821" `
  --criterion "cancel-pending=A pending order can be cancelled." `
  --criterion "reject-shipped=A shipped order cannot be cancelled."
```

Initialization:

1. Uses the current `HEAD` as the commit before the first stage. Supply
   `--base-revision` to use another commit.
2. Creates `.semantic-review/manifest.json`.
3. Creates the first requirement document under
   `.semantic-review/requirements/`.
4. Records the target branch, source reference, and acceptance criteria.
5. Adds `.semantic-review/` to `.git/info/exclude`, which is local repository
   configuration and is not committed.
6. Validates the new artifact.

It does not edit application files, create a stage commit, or create the
PR-ready branch. Add further requirements with `requirement add`.

## 3. Begin a semantic stage

A stage should have one coherent purpose and be suitable for one commit. Begin
it before editing implementation files:

```powershell
node $semantic stage begin `
  --id add-cancellation-policy `
  --title "Define the cancellation policy" `
  --summary "Add the domain transition and rejection outcomes." `
  --rationale "Every caller must use the same transition rule." `
  --requirement-ref cancel-order#cancel-pending `
  --requirement-ref cancel-order#reject-shipped
```

For a later stage, add its direct prerequisite:

```powershell
--depends-on add-cancellation-policy
```

This creates a schema-validated working document under
`.semantic-review/.work/stages/`. Only one stage may be working at a time.

## 4. Implement and record context as it occurs

The agent now edits the implementation. At the moment a decision, assumption,
alternative, failed attempt, risk, or open question becomes relevant, it records
that item against the working stage:

```powershell
node $semantic stage record `
  --stage add-cancellation-policy `
  --kind decision `
  --item-id keep-policy-in-aggregate `
  --category engineering `
  --summary "Put cancellation rules on the Order aggregate." `
  --rationale "Other callers must not bypass the rule."
```

This context is captured during implementation rather than reconstructed
afterwards. Use the same item ID with `--replace` to correct an inaccurate
entry.

After a relevant check, record its actual result:

```powershell
node $semantic stage validation `
  --stage add-cancellation-policy `
  --item-id domain-tests `
  --type automated `
  --status passed `
  --summary "Covers successful cancellation and rejection after shipment." `
  --command "dotnet test tests/Orders.Domain.Tests"
```

Failures and meaningful skipped checks should also be recorded.

## 5. Commit and finalize the stage

Commit only the implementation paths. Do not force-add `.semantic-review/` to a
stage commit.

```powershell
git add <implementation-paths>
git commit -m "Define order cancellation policy"
node $semantic stage finish --id add-cancellation-policy --commit HEAD
```

Finalization requires a clean worktree and verifies that the commit directly
follows the previous stage or the review base. It then:

- Derives the complete changed-file inventory from Git.
- Creates `.semantic-review/stages/add-cancellation-policy.json`.
- Adds the stage ID to the manifest.
- Removes the working-stage document.
- Validates the artifact and linear commit chain.

Repeat steps 3–5 for each stage. The result is a linear stack of implementation
commits, with one semantic artifact document describing each commit.

## 6. Validate and inspect the active review

Run full validation at any time:

```powershell
node $semantic validate
```

Before publication, use the stricter completion gate:

```powershell
node $semantic validate --publish
```

To inspect the review in the browser:

```powershell
npm start --prefix .\poc
```

Open <http://127.0.0.1:4173>. The application shows requirements, the stage
stack, rationale and recorded context, validation evidence, changed files, and
Git-backed diffs. Use **Reload** after repository state changes.

## 7. Submit reviewer feedback

Open **Review queue** in the application:

1. Select **Start review**.
2. Create and select a feedback batch.
3. Comment on requirements, criteria, reasoning items, files, or diff lines.
4. Edit or delete draft comments as needed.
5. Select **Submit feedback** when the batch is complete.

One batch may contain comments for several stages. Submission freezes comment
text, targets, stage assignments, and stage commit snapshots.

Feedback is stored under `.semantic-review-feedback/`. The tool adds this path
to local Git exclusions; it is mutable review state and is not included in
semantic stage or metadata commits.

## 8. Apply feedback and rewrite affected stages

The agent processes submitted feedback from the earliest affected stage
forward. It implements and tests one temporary fix commit on top of the current
stack, then folds that change into the original stage:

```powershell
node $semantic rewrite-stage `
  --stage add-cancellation-policy `
  --fix HEAD
```

The command recreates the affected stage commit and every downstream stage
commit, moves the current branch only after replay succeeds, refreshes artifact
commit references, and rolls back on validation failure. The temporary fix
commit is not part of the resulting stack.

The agent records a resolution for each addressed comment. The UI shows the
explanation and the previous and rewritten stage commits. The reviewer selects
**Approve resolution** or **Approve all resolutions**.

## 9. Approve and publish the complete stack

Whole-stack approval is available when no feedback batches exist or every
batch is approved. In the UI, confirm the branch name and select
**Approve changes**.

The equivalent CLI command is:

```powershell
node $feedback approve-stack --branch review/order-cancellation
```

Approval:

1. Validates the complete review and feedback state.
2. Creates one metadata-only commit containing `.semantic-review/`.
3. Creates the named PR-ready branch at that metadata commit.
4. Refuses to overwrite an existing branch pointing elsewhere.

The tool creates the branch locally; it does not push it, open a hosted pull
request, or merge it.

Without the feedback workflow, the same result can be produced explicitly:

```powershell
node $semantic publish --message "Publish order cancellation review"
node $semantic prepare-pr --branch review/order-cancellation
```

## 10. Merge and archive

Push or otherwise publish the PR-ready branch using the repository's normal
workflow. After it is merged, switch to the updated target branch and archive
the active review:

```powershell
node $semantic archive
```

Archival moves the tracked artifact to:

```text
.semantic-review-history/<review-id>/.semantic-review/
```

and creates an archive commit. This preserves the approved review while freeing
`.semantic-review/` for the next implementation.

## Maintenance and recovery

After an external rebase or replay, update affected artifact bindings with
`refresh`. If a process was interrupted between artifact writes, use `repair`;
it restores only states that can be recovered without guessing.

If the application cannot load the review, run:

```powershell
node $semantic validate
```

Correct the reported artifact or Git mismatch, then select **Reload**.

## Current limitations

- The review application runs only on localhost.
- Feedback state is local and is not published with the artifact.
- Version 0.1 keeps all stage commits on one linear branch. Branch-per-stage
  stacked diffs are a possible future improvement.
- The UI does not persist a separate whole-stack approval badge; the created
  Git branch is the durable approval result.
- Hosted pull-request creation and merging remain external operations.
