---
name: semantic-story-implementation
description: Implement a user story as semantic review stages while capturing requirements, rationale, decisions, assumptions, alternatives, failures, risks, and validation evidence at the moment they occur. Use when beginning or continuing feature implementation that must produce a .semantic-review artifact.
---

# Semantic story implementation

Use the bundled CLI for all artifact creation and mutation:

```text
node .github/skills/semantic-story-implementation/scripts/semantic-review.mjs <command>
```

Run commands from the target Git repository root. The CLI validates every JSON
document against the version 0.1 schemas after each mutation, then validates
references, dependencies, and Git state when applicable.

## Non-negotiable workflow

Do not implement the whole story and document it afterwards.

1. Initialize the review before changing production code.
2. Divide the story into independently reviewable, ordered stages.
3. Begin each stage before editing its code.
4. Record decisions, assumptions, alternatives, failed attempts, risks, open
   questions, and validation results immediately when they occur.
5. Commit only the implementation for that stage.
6. Finalize the stage immediately after its commit. The CLI derives the commit
   hash and file inventory from Git.
7. Run full validation before reporting completion.

Never invent context retrospectively to fill an array. Empty arrays are valid.
Never hand-edit `manifest.json`, canonical stage `change` data, or stage order.

## Setup

Install the skill's script dependencies once:

```text
npm ci --prefix .github/skills/semantic-story-implementation
```

If the skill is installed outside this repository, set
`SEMANTIC_REVIEW_SCHEMA_DIR` to the directory containing the version 0.1
schemas.

## Start a story

Initialize from the current `HEAD`. Supply each acceptance criterion as
`id=text`:

```text
node .github/skills/semantic-story-implementation/scripts/semantic-review.mjs init \
  --review-id customer-order-cancellation \
  --title "Allow customers to cancel pending orders" \
  --summary "Add guarded cancellation and expose it through the API." \
  --target-branch main \
  --requirement-id cancel-order \
  --requirement-title "Customer cancels an order" \
  --requirement-summary "A customer can cancel before fulfilment starts." \
  --source-kind azure-devops \
  --source-reference "AB#4821" \
  --source-url "https://dev.azure.com/example/project/_workitems/edit/4821" \
  --criterion "cancel-pending=A pending order owned by the caller can be cancelled." \
  --criterion "reject-shipped=An order in fulfilment cannot be cancelled."
```

Use `--base-revision <revision>` when the stage stack should begin somewhere
other than the current `HEAD`.

Use `requirement add` for another requirement. Do not duplicate requirement
text across stage files; stages reference criteria as `requirement#criterion`.

## Implement one stage

Choose a stage that has one coherent intent and can be one commit.

Begin it before code edits:

```text
node .github/skills/semantic-story-implementation/scripts/semantic-review.mjs stage begin \
  --id add-cancellation-policy \
  --title "Define the order cancellation policy" \
  --summary "Add the domain transition and explicit rejection outcomes." \
  --rationale "The aggregate must enforce the transition for every caller." \
  --requirement-ref cancel-order#cancel-pending \
  --requirement-ref cancel-order#reject-shipped
```

For a later stage, include only direct dependencies:

```text
--depends-on add-cancellation-policy
```

### Capture context during work

Call `stage record` as soon as the context exists.

```text
# Engineering or requirement decision
... stage record --stage add-cancellation-policy --kind decision \
  --item-id keep-policy-in-aggregate --category engineering \
  --summary "Put cancellation rules on the Order aggregate." \
  --rationale "Other callers must not bypass the transition rule."

# Assumption
... stage record --stage add-cancellation-policy --kind assumption \
  --item-id pending-means-not-fulfilled \
  --statement "All pre-fulfilment states are safe to cancel." \
  --risk-if-wrong "Paid orders may require compensation."

# Rejected alternative
... stage record --stage add-cancellation-policy --kind alternative \
  --item-id handler-only-policy \
  --approach "Guard only in the command handler." \
  --reason-rejected "Future callers could bypass it."

# Failed attempt
... stage record --stage add-cancellation-policy --kind failed-attempt \
  --item-id enum-order-check \
  --approach "Compare state enum ordinals." \
  --outcome "A future inserted state would silently change behavior." \
  --lesson "Use an explicit allow-list."

# Risk
... stage record --stage add-cancellation-policy --kind risk \
  --item-id payment-compensation \
  --summary "Paid orders may need a refund." \
  --mitigation "Keep this visible for product confirmation."

# Open question
... stage record --stage add-cancellation-policy --kind question \
  --item-id refund-scope \
  --question "Is payment compensation part of this story?"
```

If a captured item was inaccurate, rerun its command with the same item ID and
`--replace`. Do not leave known-false reasoning in the artifact.

If the stage's intent changes, update its draft rather than relying on memory:

```text
... stage set --id add-cancellation-policy \
  --rationale "Updated rationale based on the discovered aggregate invariant."
```

If the stage is no longer needed and has not been finalized, discard only its
working document:

```text
... stage discard --id add-cancellation-policy
```

This does not revert code edits. Remove or preserve them intentionally before
starting another stage.

### Record evidence

After every relevant test or check, record its real status. Preserve failures
and skipped checks that matter to review.

```text
... stage validation --stage add-cancellation-policy \
  --item-id domain-tests \
  --type automated \
  --status passed \
  --summary "Covers success and rejection after fulfilment." \
  --command "dotnet test tests/Orders.Domain.Tests --filter OrderCancellationTests"
```

Use the same validation ID with `--replace` when a later run changes its status.
Do not overwrite a meaningful failure with a pass when both runs matter; use a
new ID instead.

### Commit and finalize

The CLI adds `.semantic-review/` to `.git/info/exclude`. Stage commits must not
contain artifact files. It also requires a clean worktree when a story or stage
begins and when a stage is finalized. Stage only the implementation paths,
commit them, then:

```text
... stage finish --id add-cancellation-policy --commit HEAD
```

`stage finish` verifies the linear parent chain, derives the complete file
inventory, creates the canonical stage, updates the manifest, removes the
working draft, and runs full validation transactionally.

If a check can only run against the canonical stage, record it immediately
after finalization with `--finalized`:

```text
... stage validation --stage add-cancellation-policy --finalized \
  --item-id canonical-review-load \
  --type automated \
  --status passed \
  --summary "The review tool loaded the finalized stage." \
  --command "npm test --prefix poc"
```

`stage record --finalized` is also available for a decision, assumption,
alternative, failed attempt, risk, or question discovered during that check.
Finalized updates can only change these context collections; commit and graph
data remain owned by `stage finish` and `refresh`.

Repeat this process for each stage. Do not begin multiple stages concurrently.

## Rebases and replay

After commits are rewritten, update all affected stage bindings atomically:

```text
... refresh \
  --base <new-base-revision> \
  --stage add-cancellation-policy=<new-full-sha-or-ref> \
  --stage persist-cancellation=<new-full-sha-or-ref>
```

Omit `--base` when the stack was rewritten onto the same base. Include it when
rebasing onto an updated target branch.

The CLI recomputes file inventories and verifies the resulting chain. Update
captured rationale separately only if the implementation decisions changed.

## Interrupted mutation recovery

Artifact writes are transactional during normal failures, but a terminated
process can stop between file updates. If validation reports an unlisted stage
or a stage that is both working and finalized, run:

```text
... repair
```

The command restores the last manifest-defined state when it can do so without
guessing. It refuses ambiguous repairs.

## Approval, publication, and landing

The CLI locally excludes `.semantic-review/` so artifact files cannot enter a
stage commit. After human approval, publish the validated artifact as one
metadata-only commit:

```text
... publish --message "Publish order cancellation semantic review"
```

Create a PR-ready branch without switching the current worktree:

```text
... prepare-pr --branch review/order-cancellation
```

The command accepts either the final stage commit or its direct metadata-only
child, refuses unrelated commits, and never moves an existing branch.

After that branch is merged into the target branch, switch to the updated target
and archive the review so another active `.semantic-review` can be initialized:

```text
... archive
```

The default destination is
`.semantic-review-history/<review-id>/.semantic-review`. Archival creates its
own commit and refuses an untracked or unpublished artifact.

## Completion gate

Run:

```text
... validate --publish
```

Do not claim completion unless it succeeds. Publication validation rejects an
empty review, unfinished drafts, schema violations, unresolved references,
invalid dependency graphs, stale file inventories, and broken commit chains.

## Command reference

```text
init
requirement add
stage begin
stage set
stage record
stage validation
stage finish
stage discard
refresh
repair
publish [--message <commit-message>]
prepare-pr --branch <branch-name>
archive [--destination <path>] [--message <commit-message>]
validate [--schema-only] [--publish]
```

Use `--help` for exact options. Read
`docs/artifact-format.md` only when format semantics are unclear; let the CLI
handle mechanical structure.
