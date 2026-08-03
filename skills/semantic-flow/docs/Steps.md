# Semantic Flow Procedure

Read `../scripts/API.d.ts` before invoking the bundled CLI. The command snippets
below select commands only; the generated API signature defines every required
parameter, conditional field, default, and flag.

The coding agent owns initialization, stage implementation, evidence capture,
feedback implementation, and validation. The reviewer owns feedback
submission, resolution approval, and whole-stack approval. Do not cross those
role boundaries without an explicit user instruction.

## 0. Enter or resume the flow

### Applicability

Use this flow for a substantial, self-contained feature or user story whose
implementation benefits from intent-based review stages. Do not use it for a
small localized fix, investigation, review-only request, documentation-only
edit, or routine refactor.

Invoke the flow before implementation starts. Do not retrofit a completed
implementation by inventing context. If work has already begun, continue only
when the current uncommitted changes can honestly form the next stage and the
relevant context is still known.

### Preflight

Before mutating anything:

1. Locate the target repository root and the installed skill root.
2. Confirm Node.js 20 or later is available.
3. Read `SKILL.md`, this procedure, and `scripts/API.d.ts`.
4. Inspect the current branch, `HEAD`, worktree status, and whether
   `.semantic-review/manifest.json` exists.

If an active review exists, run validation and resume it. Do not run `init`
again or replace its requirements:

```text
node <skill-root>/scripts/semantic-review.mjs validate
```

Determine whether the review has a working stage, only finalized stages, or
submitted feedback, then continue at the matching section below. Use CLI output
and artifact state; do not guess.

If validation reports an interrupted mutation, use `repair` only for the
unambiguous recovery states described by `scripts/API.d.ts`. If an external
rebase or replay intentionally changed the base or stage commits, use `refresh`
to supply the new bindings. Never use either command to conceal an unexplained
artifact or Git mismatch.

For a new review, the worktree must be clean and isolated from unrelated work.
Establish the intended work branch and correct base revision before
initialization. If unrelated changes are present, stop and ask the user to
provide a clean worktree or choose how to isolate them. Never stash, revert,
delete, or include those changes automatically.

### Requirements and stage plan

Translate the user request into implementation-relevant requirements and
testable acceptance criteria. Preserve source wording and identifiers when
available. For an untracked local request, use `local` provenance and a clear
human-recognizable reference; do not invent a tracker URL or issue number.

Ask the user only when missing behavior materially changes the implementation.
Do not turn implementation choices into acceptance criteria.

Plan an ordered sequence of coherent stages before coding:

- Group by user-visible or architectural intent, not by file, layer, or tool.
- Keep tests and directly related documentation in the stage that introduces
  the behavior.
- Make every stage independently understandable and leave the repository
  buildable and valid for all checks relevant at that point.
- Avoid artificial setup, testing, cleanup, or "remaining changes" stages.
- Split only when the resulting diffs are easier to review than one combined
  stage.

The plan is provisional. Keep future stages in the agent's normal task plan,
not in the artifact. Update that plan when discoveries change the work.
Register only the next stage immediately before implementing it.

## 1. Initialize a new review

Initialize before editing application code. `init` records the current `HEAD`
as the default base revision, so verify that revision first.

```text
node <skill-root>/scripts/semantic-review.mjs init <options>
```

Add further independent requirements before beginning a stage that references
them:

```text
node <skill-root>/scripts/semantic-review.mjs requirement add <options>
```

Use stable kebab-case IDs. Requirement summaries describe required outcomes;
criteria are observable conditions that can be demonstrated or tested.

Initialization creates local semantic state but no implementation commit.
Never hand-edit the generated files.

## 2. Implement each stage

Repeat this section until the planned behavior is complete.

### A. Begin the next stage

Begin exactly one stage before making its code changes:

```text
node <skill-root>/scripts/semantic-review.mjs stage begin <options>
```

Choose metadata carefully:

- `summary` states the coherent behavior or capability changed.
- `rationale` explains why this approach and stage boundary are appropriate; it
  must not merely restate the summary.
- `requirement-ref` lists only criteria this stage materially addresses.
- `depends-on` lists only direct semantic prerequisites, not every earlier
  stage. In a linear commit stack, commit ancestry alone is not a semantic
  dependency.

If implementation discovery changes the active stage's intent, references, or
dependencies, update it before continuing:

```text
node <skill-root>/scripts/semantic-review.mjs stage set <options>
```

Discard a stage only when its intent is abandoned and its implementation
changes have already been removed or deliberately reassigned. The command does
not revert files:

```text
node <skill-root>/scripts/semantic-review.mjs stage discard --id <stage-id>
```

### B. Implement and capture context

Implement only the active stage's intent. Include its targeted tests and
directly related documentation. If the work grows into another independently
reviewable intent, leave that work for a later stage instead of widening the
current one.

Record context when it becomes relevant:

```text
node <skill-root>/scripts/semantic-review.mjs stage record <options>
```

Capture concise, reviewer-useful conclusions:

- A decision states the chosen behavior or design and why.
- An assumption is falsifiable and explains the impact if wrong.
- An alternative records a real option that was considered and rejected.
- A failed attempt records an approach actually tried, its observed outcome,
  and the reusable lesson.
- A risk identifies a concrete concern and, when known, its mitigation.
- A question identifies a specific unresolved point requiring reviewer input.

Do not record routine coding choices, generic best practices, speculative
alternatives, fabricated failed attempts, raw logs, secrets, or private
chain-of-thought. Empty context collections are valid and preferable to
invented content.

Use the same item ID with `--replace` only to correct an inaccurate entry.

### C. Validate the stage

Run the smallest existing checks that genuinely cover the stage, escalating
when integration risk requires it. Record each meaningful result immediately
after it runs:

```text
node <skill-root>/scripts/semantic-review.mjs stage validation <options>
```

For automated validation, record the exact command. The summary states what was
checked and the observed result, not what was expected. Record relevant failed
and not-run checks honestly. Do not finish a stage while a required check is
failing or an unexplained validation gap remains.

### D. Commit and finalize the stage

Before committing:

1. Inspect the complete diff and confirm every change serves the active intent.
2. Stage exact implementation paths; do not use a broad add that can absorb
   unrelated files.
3. Exclude `.semantic-review/` and `.semantic-review-feedback/`.
4. Run the relevant checks and record their actual results.

Create one implementation commit. The worktree must then be clean except for
ignored semantic state. Finalize the stage against that direct-child commit:

```text
node <skill-root>/scripts/semantic-review.mjs stage finish --id <stage-id> --commit HEAD
```

Finalization derives the changed-file inventory from Git and binds the
canonical stage document to the commit. If it fails, correct the reported Git
or artifact invariant and retry; do not patch generated metadata manually.

Update the future-stage plan from what was learned, then begin the next stage.

## 3. Complete the implementation and request review

After every implementation stage is finalized:

1. Check every acceptance criterion is covered by at least one stage.
2. Run relevant whole-stack or integration checks.
3. Attach new evidence to the most relevant finalized stage, usually the final
   stage, using `stage validation --finalized`.
4. Resolve failed checks, unfinished stages, inaccurate context, and uncovered
   criteria.
5. Run the publication gate:

```text
node <skill-root>/scripts/semantic-review.mjs validate --publish
```

The validator checks schemas, references, dependencies, artifact state, commit
order, and file inventories. It does not prove the implementation satisfies
the requirement; perform that assessment separately.

Launch the repository's configured review experience only when one is
available and the user requested it. Otherwise hand off the validated artifact
and stage stack for review. Stop here. Do not submit feedback, approve
resolutions, approve the stack, or publish on the reviewer's behalf.

## 4. Address submitted feedback

Process only submitted feedback, never drafts. Load the next actionable items:

```text
node <skill-root>/scripts/review-feedback.mjs next --json
```

Assign each item to the stage whose intent or implementation must change.
Process affected stages from earliest to latest so downstream replay is
minimized.

For each affected stage:

1. Implement and validate the requested change at the top of the current stage
   stack.
2. Update the affected finalized stage's context or validation with
   `--finalized` when the prior artifact is no longer accurate.
3. Commit only the fix.
4. Fold that fix into the assigned stage and replay downstream stages:

```text
node <skill-root>/scripts/semantic-review.mjs rewrite-stage --stage <stage-id> --fix HEAD
```

5. Record a precise resolution using the submitted snapshot commit as
   `previous` and the current rewritten stage commit as `rewritten`. Read
   `previous` from the item returned by `next --json`; after rewriting, read
   `rewritten` from the assigned stage's canonical `change.commit`:

```text
node <skill-root>/scripts/review-feedback.mjs comment resolve <options>
```

If the same stage is rewritten again after resolutions already point to its
superseded commit, rebind those resolutions:

```text
node <skill-root>/scripts/review-feedback.mjs resolution rebind <options>
```

Do not resolve an item until its requested change is implemented, or until the
resolution clearly explains why no code change is correct. Never mark your own
resolution approved.

After all submitted items are addressed, validate both state stores and the
complete stack:

```text
node <skill-root>/scripts/review-feedback.mjs validate
node <skill-root>/scripts/semantic-review.mjs validate --publish
```

Return the rewritten stack and resolutions to the reviewer, then stop. If more
feedback is submitted, repeat this section.

## 5. Publish after explicit approval

Continue only after the reviewer explicitly approves the resulting complete
implementation and all feedback resolutions. Whole-stack approval publishes a
metadata-only commit and creates a local PR-ready branch without switching the
current worktree:

```text
node <skill-root>/scripts/review-feedback.mjs approve-stack --branch <branch-name>
```

Do not call reviewer approval commands merely to make `approve-stack` pass. If
approval is missing, return control to the reviewer.

Any implementation change after approval invalidates the reviewed result.
Return to feedback processing and obtain approval again rather than modifying
the published stack.

## 6. Land and archive

Push the prepared branch and create or update the pull request only when the
user explicitly requests those repository-hosting actions. Use the
repository's normal commands and gates; the bundled CLI does not push, create,
or merge pull requests.

Never merge without explicit authorization and passing required checks. If
integration review requires code changes, return to feedback processing,
rewrite the affected stages, and repeat approval and publication.

Archive only after the approved PR has merged, the local target branch contains
that merged result, and the user requests archival:

```text
node <skill-root>/scripts/semantic-review.mjs archive
```

Archival preserves the published artifact under
`.semantic-review-history/<review-id>/` and frees the active workspace for a
future flow.
