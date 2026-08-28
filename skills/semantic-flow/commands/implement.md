# Implement command

Use for `/semantic-flow implement <request>` and natural-language requests such
as "implement the current user story using semantic flow".

Read `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/API.d.ts`, and the selected operating-system guide before changing
application code or invoking the CLI.

## Enter the flow

Use semantic flow for a substantial feature or user story that benefits from
ordered intent-based review stages. The user's explicit request to use semantic
flow is sufficient. Do not silently downgrade to an ordinary implementation.

Inspect the current branch, `HEAD`, and worktree state. Run
`<semantic-flow> inspect --json` to find active artifacts across linked
worktrees. If one already represents the requested work, follow `continue.md`
instead of initializing another implementation.

For new work:

1. Require a clean source worktree at the intended target branch head.
2. Create or use a clean isolated implementation worktree.
3. Gather the source work items and apply the specification boundaries in
   `../docs/artifact-quality.md`. Default each requested user story or source
   work item to one specification with all of its acceptance criteria. Create
   multiple requirements only for independently trackable source obligations.
4. Plan coherent ordered stages. Keep future stages in the agent's task plan
   and register only the next stage.
5. Initialize from the isolated worktree:

   ```text
   <semantic-implementation> init <options>
   ```

Initialization records the target branch head as `baseRevision`. The default
branch prefix is `semantic-flow/<implementation-id>`. Initialization creates the
first specification. When the boundary rules identify additional requirements,
add each with `specification add` before a stage references it. Do not turn
acceptance criteria or implementation stages into requirements.

## Implement each stage

### Begin

Run `stage begin` before creating any implementation commit. Do not create a
preparatory branch or a future stage branch with Git.

From the current stack tip:

```text
<semantic-implementation> stage begin --input -
```

The command creates and checks out the deterministic stage branch. The first
stage starts at the target branch; each later stage starts at the previous
stage head. Its numeric prefix is the next finalized manifest position, not
the stage's planned position. Treat the branch reported by the command as the
only branch for that ordinal. `depends-on` records direct semantic
prerequisites.

Before running the command, list local refs below the manifest's
`branchPrefix`. Compute the next ordinal as the finalized stage count plus one,
padded to at least two digits. If any existing branch already starts with that
ordinal, stop instead of creating a second branch for it.

Before editing or committing, verify that the reported branch remains checked
out. Keep every commit for the active stage on that branch until `stage
finish`.

Use `stage set` when discovery changes active metadata or scope. Do not discard
and begin a replacement merely to rename or reorder the stage. `stage discard`
removes the generated stage branch when it still points at its creation head, so
a clean discard frees the ordinal for reuse. If the branch already carries local
commits, discard keeps it and reports that you must delete it manually before
reusing the ordinal. If the immutable stage ID or order is wrong, stop and ask
the user rather than creating another numbered branch.

### Implement and capture insights

Implement only the active stage intent. Record review-relevant insights when they
arise:

```text
<semantic-implementation> stage record --input -
```

Run focused checks while implementing. Do not record routine execution of
existing test suites. Preserve only review-relevant validation, such as
temporary tests or probes that are later removed, manual checks, and noteworthy
failures or skipped checks.

### Commit and organize

Commit the stage implementation. Multiple linear commits are allowed. Exclude
`.semantic-review/` and `.semantic-review-feedback/`.

Create an organization document conforming to
`../references/stage-organization.schema.json`, then run:

```text
<semantic-implementation> stage organize --file <organization-json>
```

Every changed file must be covered. Whole-file ownership needs no selector.
Shared files must use `hunks` or `lineRanges` consistently and cover every
changed hunk or line exactly once. Include `itemLinks` for every recorded
insight and validation evidence.

### Validate and finish

Run the smallest existing checks that cover the organized stage. Run them from
the artifact/implementation worktree, and confirm the working directory and
repository root are that worktree before running so checks never execute against
the source checkout. Routine test-suite execution is implied and must not be
recorded as validation evidence. Record only review-relevant results under the
rules in `../docs/artifact-quality.md`:

```text
<semantic-implementation> stage validation --input -
```

Inspect the complete stage diff. Update its summary, rationale, dependencies,
or specification references when needed. Regenerate organization after any
change that affects the diff or recorded insights.

Finalize:

```text
<semantic-implementation> stage finish
```

Run `<semantic-flow> validate --project <artifact-worktree-path>` before
beginning the next stage. Repeat for each planned stage.

## Complete implementation

After all stages:

1. Confirm every acceptance criterion is covered.
2. Exercise the complete acceptance path.
3. Put any discovered omission into the earliest responsible stage, then
   restack later stages.
4. Run whole-stack checks from the artifact worktree. Attach evidence to
   relevant finalized stages only when it meets the review-relevance rules in
   `../docs/artifact-quality.md`.
5. Run:

   ```text
   <semantic-flow> validate --publish --project <artifact-worktree-path>
   <semantic-implementation> validate-stack
   ```

Stop with the local stack ready for human review. Do not approve, publish
metadata, push branches, create a hosted review, or merge. Direct the user to
`/semantic-flow review`.
