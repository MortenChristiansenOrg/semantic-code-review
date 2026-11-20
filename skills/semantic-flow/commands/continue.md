# Continue command

Use to resume interrupted semantic-flow implementation.

Read `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/api/stages.d.ts`, and the selected operating-system guide before mutation.

Recover from CLI usage and validation errors under the runtime's
“Recoverable CLI errors” rules. Unsupported insight kinds or decision categories
and missing or invalid arguments require inspecting the installed API declaration
or command help, correcting the invocation, and continuing without asking for
approval. A metadata recording failure does not pause otherwise valid work.

## Locate and assess

1. Resolve the active artifact worktree using the shared runtime rules.
2. Inspect its branch, `HEAD`, worktree status, manifest, finalized stages, and
   working stage.
3. Run:

   ```text
   <semantic-flow> validate --project <artifact-worktree-path>
   ```

4. Inspect feedback state when `inspect --json` reports `selected.feedbackExists`.
   Its `selected.feedbackDirectory` is in the shared user-local store. If open
   feedback is the work awaiting action, explain that and follow
   `feedback.md` rather than treating it as ordinary implementation.

Do not discard or overwrite partial application changes. If unrelated changes
prevent safe continuation, preserve them and explain which work blocks the
requested changes. Apply `../docs/user-decisions.md`; ask only if their inclusion
or intended behavior needs clarification.

## Resume from state

- If a working stage exists, check that its recorded branch is checked out,
  and that no other branch below the implementation's branch prefix is being
  used for its commits. Continue on
  the recorded branch through implementation, insight capture, organization,
  validation, and finalization.
- If no working stage exists and acceptance criteria remain uncovered, require
  `HEAD` at the last finalized stage head. `stage begin` rejects a stage ID
  whose branch already exists. Then plan the next coherent stage and let
  `stage begin` create its branch before editing.
- If a stage branch below the implementation's branch prefix belongs to no
  working or finalized stage, stop and report the inconsistent state: describe
  the unassigned work and the risk of incorporating it, with the ref as
  diagnostic detail. Do not ask for approval of branch repair, absorb its
  commits into another stage, or begin a stage with that ID.
- If all stages are finalized, run the complete acceptance path and whole-stack
  validation described by `implement.md`.
- If a finalized lower branch changed, restack from the earliest changed stage.
- If the target branch advanced, check out a branch that will not be rewritten,
  then run `<semantic-flow> implementation restack --base <target-branch>`, only when the
  artifact and Git state make that safe.
- If the request is specifically to bring the latest target changes into the
  stack, follow `sync.md` instead. For any restack conflict, follow
  `../docs/restack-conflicts.md`.

Follow the stage procedure and quality rules in `implement.md` for all resumed
work. Stop when the implementation is ready for `/semantic-flow review`.
Do not approve or publish metadata.
