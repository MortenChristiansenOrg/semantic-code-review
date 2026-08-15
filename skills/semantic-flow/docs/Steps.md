# Semantic Flow Procedure

Read `../scripts/API.d.ts` before invoking the bundled CLI. It defines every
required parameter, default, and flag.

The coding agent owns initialization, stage implementation, evidence capture,
feedback implementation, restacking, and validation. The reviewer owns
feedback submission, resolution approval, and whole-stack approval.

## 0. Enter or resume the flow

Use this flow for a substantial feature or user story that benefits from
intent-based review stages. Do not use it for a small fix, investigation,
review-only request, documentation-only edit, or routine refactor.

Before mutation:

1. Locate the repository and installed skill roots.
2. Complete the required reading selected by `SKILL.md`, including the one
   operating-system guide for the current environment.
3. Complete that guide's preflight, confirm Node.js 20 or later and Git are
   available, and define the concrete `<semantic-review>` and
   `<review-feedback>` invocations.
4. Inspect the current branch, `HEAD`, worktree, and active artifact.

If an active review exists, run:

```text
<semantic-review> validate
```

Resume from its working stage, finalized branches, or submitted feedback. Use
`repair` only for unambiguous interrupted artifact writes. If a lower stage
branch was edited manually or trunk advanced, use `restack`; never hand-edit
branch bindings.

For new work, require a clean worktree at the current target branch head.

Plan coherent, ordered stages:

- Group by user-visible or architectural intent, not file or layer.
- Keep tests and directly related documentation with the behavior.
- Make every stage independently understandable and valid.
- Split only when each resulting branch diff is easier to review.
- Treat `depends-on` as a direct behavioral prerequisite. Do not mirror Git
  ancestry or list a stage merely because it happened earlier.

Keep future stages in the agent's task plan. Register only the next stage.

## 1. Initialize

```text
<semantic-review> init <options>
```

Long commands may put options in a JSON object and pass `--input <json-file>`,
or pipe the object to `--input -`; camelCase and kebab-case keys are accepted,
arrays supply repeated options, and `true` supplies a flag. Prefer stdin or an
operating-system temporary file so inputs do not dirty the repository.

Initialization records the target branch head as `baseRevision` and defaults
`branchPrefix` to:

```text
semantic-review/<review-id>
```

Every stage branch is created below this prefix:

```text
semantic-review/<review-id>/01-<stage-id>
semantic-review/<review-id>/02-<stage-id>
```

The shared slash prefix groups the stack as folders in Git clients such as
GitKraken.

Add independent requirements before a stage references them:

```text
<semantic-review> requirement add <options>
```

Never hand-edit generated state.

## 2. Implement each stage branch

### A. Begin

From the current stack tip:

```text
<semantic-review> stage begin --input -
```

The command creates and checks out the next deterministic branch. The first
stage starts at `targetBranch`; every later stage starts at the previous stage
head. `depends-on` records semantic prerequisites, not Git ancestry.

Use `stage set` when discovery changes active metadata. Use `stage discard`
only after implementation changes are removed or deliberately retained on the
abandoned branch.

### B. Implement and capture context

Implement only the active stage intent. Record reviewer-useful decisions,
assumptions, alternatives, failed attempts, risks, and questions when they
arise:

```text
<semantic-review> stage record --input -
```

Do not record routine choices, fabricated history, secrets, raw logs, or
private chain-of-thought.

### C. Commit and organize the complete diff

Run focused checks while implementing, then commit the stage implementation.
Multiple linear commits are allowed; merge commits are not. Exclude
`.semantic-review/` and `.semantic-review-feedback/`.

```text
<semantic-review> stage organize --file <organization-json>
```

The organization document uses
`references/stage-organization.schema.json`. Create intent-oriented nodes whose
descriptions collectively explain the stage. Every changed file must appear:

- Once without a selector when one node owns the whole file.
- In every relevant node with either `hunks` or `lineRanges` when causes share
  a file. Use one selector style per shared file and cover every changed hunk
  or line exactly once.

Classify each file-to-node link as `behavior`, `refactor`, `test`,
`documentation`, `configuration`, `dependency`, `migration`, `generated`,
`chore`, or `trivial`. Include one `itemLinks` entry for every recorded
decision, assumption, alternative, failed attempt, risk, validation result,
and open question.

### D. Run final validation and finalize

Run the smallest existing checks that cover the organized stage and record
observed results with `--node-ref` for every relevant node:

```text
<semantic-review> stage validation --input -
```

Inspect the complete stage diff and use `stage set` if its boundary, rationale,
requirement references, or direct dependencies changed. If any implementation
or metadata context changed after organization, regenerate the organization
document before finalizing. Do not finalize with a known acceptance gap that
belongs to this stage.

```text
<semantic-review> stage finish
```

Finalization captures:

- Stage and base branch names.
- Immutable base and head revisions.
- The complete diff from the base branch snapshot to the stage head.
- Descriptive change nodes, classified file or hunk membership, and links from
  recorded context to the relevant nodes.

Then begin the next stage from this branch.

## 3. Complete and request review

After all stages:

1. Confirm every criterion is covered.
2. Exercise the complete acceptance path using the repository's available
   runtime workflow, not only isolated tests. For user-facing changes, inspect
   representative desktop and mobile browser states. For reactive interfaces,
   verify mutation pending/success/error states and confirm live server updates
   do not erase unsaved local input.
3. If this review finds an omission or defect that belongs to a finalized
   stage, check out the earliest responsible stage branch, implement and commit
   the correction there, then run `restack --from <stage>`. Add updated context
   or validation to that finalized stage with the CLI. Do not create a later
   cleanup, stabilization, or acceptance-gap stage unless it introduces a
   genuinely new independently reviewable behavior.
4. Run whole-stack checks.
5. Attach final evidence to the relevant finalized stage.
6. Run:

```text
<semantic-review> validate --publish
<semantic-review> prepare-stack
```

`prepare-stack` prints the hosting-neutral local branch/base/head chain. It
does not contact a remote or create hosted reviews.

## 4. Address feedback and manual edits

Load submitted feedback:

```text
<review-feedback> next --json
```

Process the earliest affected stage first:

1. Check out its recorded branch.
2. Implement, validate, and commit the change directly on that branch.
3. Update finalized context or evidence when needed.
4. Cascade the change through every branch above it:

```text
<semantic-review> restack --from <stage-id>
```

`restack` refreshes the edited branch snapshot, replays each upper branch onto
its new base, updates all affected refs only after replay succeeds, and
refreshes artifact heads and file inventories. Existing node partitions must
still match the rewritten diffs; if a stage's causes or hunk boundaries change,
rerun `stage organize --finalized` for that stage before continuing. This also
supports changes committed manually by the user on any lower stage branch.

If trunk advanced, check out a branch that will not be moved and run:

```text
<semantic-review> restack --base <target-branch>
```

Record resolutions with the submitted `previous-head` and current stage
`rewritten-head`. If a stage changes again, use `resolution rebind`.

Afterward:

```text
<review-feedback> validate
<semantic-review> validate --publish
```

If branches were already pushed, updating rewritten remote refs is outside this
flow and should use lease-protected force pushes where available.

## 5. Approve and publish metadata

Only after explicit whole-stack approval:

```text
<review-feedback> approve-stack
```

Approval validates feedback, creates or updates
`<branch-prefix>/metadata`, and prints the local branch chain. The metadata
branch is separate so review JSON never pollutes implementation diffs.

## 6. Prepare local outputs and stop

The validated stage branches are already a stack-ready local output:

```text
<semantic-review> prepare-stack
```

For one cumulative branch:

```text
<semantic-review> prepare-branch --branch <name>
```

This creates a local branch at the final reviewed stage head without switching
the worktree and without overwriting a branch that points elsewhere.

Stop here. The user may later push the cumulative branch for one normal hosted
review, or push the stage branches for a host that supports stacked reviews.
Remote push, review creation, linking, and merge behavior are outside the
protocol and require separate explicit instructions.

## 7. Archive after landing

After the chosen external workflow has landed the code and the target branch is
current:

```text
<semantic-review> archive
```

Archival stores the published artifact under
`.semantic-review-history/<review-id>/`.
