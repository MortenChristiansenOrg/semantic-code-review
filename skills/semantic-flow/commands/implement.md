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
instead of initializing another review.

For new work:

1. Require a clean source worktree at the intended target branch head.
2. Create or use a clean isolated implementation worktree.
3. Gather the requirement source, title, summary, and acceptance criteria.
4. Plan coherent ordered stages. Keep future stages in the agent's task plan
   and register only the next stage.
5. Initialize from the isolated worktree:

   ```text
   <semantic-review> init <options>
   ```

Initialization records the target branch head as `baseRevision`. The default
branch prefix is `semantic-review/<review-id>`. Add independent requirements
with `requirement add` before a stage references them.

## Implement each stage

### Begin

From the current stack tip:

```text
<semantic-review> stage begin --input -
```

The command creates and checks out the deterministic stage branch. The first
stage starts at the target branch; each later stage starts at the previous
stage head. `depends-on` records direct semantic prerequisites.

Use `stage set` when discovery changes active metadata. Use `stage discard`
only after deciding what happens to any implementation changes on the
abandoned branch.

### Implement and capture context

Implement only the active stage intent. Record review-relevant context when it
arises:

```text
<semantic-review> stage record --input -
```

Run focused checks while implementing. Preserve useful failures and skipped
checks for later evidence.

### Commit and organize

Commit the stage implementation. Multiple linear commits are allowed. Exclude
`.semantic-review/` and `.semantic-review-feedback/`.

Create an organization document conforming to
`../references/stage-organization.schema.json`, then run:

```text
<semantic-review> stage organize --file <organization-json>
```

Every changed file must be covered. Whole-file ownership needs no selector.
Shared files must use `hunks` or `lineRanges` consistently and cover every
changed hunk or line exactly once. Include `itemLinks` for every recorded
context and validation item.

### Validate and finish

Run the smallest existing checks that cover the organized stage. Record each
observed result:

```text
<semantic-review> stage validation --input -
```

Inspect the complete stage diff. Update its summary, rationale, dependencies,
or requirement references when needed. Regenerate organization after any
change that affects the diff or semantic context.

Finalize:

```text
<semantic-review> stage finish
```

Repeat for each planned stage.

## Complete implementation

After all stages:

1. Confirm every acceptance criterion is covered.
2. Exercise the complete acceptance path.
3. Put any discovered omission into the earliest responsible stage, then
   restack later stages.
4. Run whole-stack checks and attach final evidence to relevant finalized
   stages.
5. Run:

   ```text
   <semantic-flow> validate --publish --project <artifact-worktree-path>
   <semantic-review> prepare-stack
   ```

Stop with the local stack ready for human review. Do not approve, publish
metadata, push branches, create a hosted review, or merge. Direct the user to
`/semantic-flow review`.
