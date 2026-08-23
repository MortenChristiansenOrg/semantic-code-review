# Continue command

Use to resume interrupted semantic-flow implementation.

Read `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/API.d.ts`, and the selected operating-system guide before mutation.

## Locate and assess

1. Resolve the active artifact worktree using the shared runtime rules.
2. Inspect its branch, `HEAD`, worktree status, manifest, finalized stages, and
   working stage.
3. Run:

   ```text
   <semantic-flow> validate --project <artifact-worktree-path>
   ```

4. Inspect feedback state when `.semantic-review-feedback/` exists. If
   submitted feedback is the work awaiting action, explain that and follow
   `feedback.md` rather than treating it as ordinary implementation.

Do not discard or overwrite partial application changes. If unrelated changes
prevent safe continuation, stop and identify them.

## Resume from state

- If a working stage exists, check that its recorded branch is checked out,
  then continue its implementation, context capture, organization, validation,
  and finalization.
- If no working stage exists and acceptance criteria remain uncovered, plan
  the next coherent stage and begin it before editing.
- If all stages are finalized, run the complete acceptance path and whole-stack
  validation described by `implement.md`.
- If a finalized lower branch changed, restack from the earliest changed stage.
- If the target branch advanced, check out a branch that will not be rewritten,
  then run `<semantic-review> restack --base <target-branch>`, only when the
  artifact and Git state make that safe.
- Use `repair` only for the unambiguous interrupted artifact writes supported
  by the CLI. Do not use it to conceal missing or inconsistent data.

Follow the stage procedure and quality rules in `implement.md` for all resumed
work. Stop when the implementation is ready for `/semantic-flow review`.
Do not approve or publish metadata.
