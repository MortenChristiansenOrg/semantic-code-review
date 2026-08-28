# Reconcile command

Use for `/semantic-flow reconcile` and its `rc` alias after a user has manually
edited the final stage worktree and wants those edits placed in the responsible
stages.

Read `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/API.d.ts`, and the selected operating-system guide before mutation.

## Locate and assess

1. Resolve the active artifact worktree using the shared runtime rules.
2. Inspect its branch, `HEAD`, worktree status, manifest, finalized stages, and
   feedback state.
3. Run:

   ```text
   <semantic-flow> validate --project <artifact-worktree-path>
   ```

4. Require at least one finalized stage and no working stage.
5. Require the final stage branch to be checked out at its recorded head before
   the uncommitted edits. Every other stage branch and the target branch must
   still match the artifact.
6. Require application edits to reconcile. Reject edits to
   `.semantic-review/` or `.semantic-review-feedback/`; those artifacts may
   only be changed through their bundled CLIs.
7. Inspect staged, unstaged, deleted, renamed, and untracked files. If some
   edits are unrelated to the requested reconciliation, stop and ask the user
   which edits belong to it. Do not capture unrelated work.

## Preserve the desired tree

Before switching branches, preserve the complete desired application tree on a
temporary recovery branch:

1. Create a uniquely named non-stage branch outside the manifest's
   `branchPrefix`, based on the recorded final stage head.
2. Add only the application edits approved for reconciliation. Never add
   semantic artifact or feedback files.
3. Commit the captured tree with a message that identifies it as a temporary
   reconciliation snapshot.
4. Record the temporary branch name, snapshot commit, original final stage
   head, and original stage branch.
5. Require a clean worktree before continuing.

Do not use a numbered branch or move a CLI-owned stage ref while capturing the
tree. Keep the recovery branch until reconciliation and validation succeed. If
capture fails, leave the user's edits intact and stop.

## Assign edits to stages

Compare the snapshot with the original final stage head. Read every affected
stage's intent, specification references, complete stage diff, change nodes,
and relevant insights.

Assign each change by semantic cause:

- Put a correction in the earliest existing stage responsible for that
  behavior.
- Keep tests and directly related documentation with the behavior they verify
  or describe.
- Split a file or user edit across stages when it contains several causes.
- Do not assign solely by file ownership or line similarity.
- Do not create a cleanup stage for work that belongs in an existing stage.

The snapshot describes the required final tree, not patches that must apply
unchanged. When an edit depends on code introduced by a later stage, implement
the underlying correction in the responsible earlier stage and adapt later
stages as needed.

If ownership is materially ambiguous, the edit changes requirements or stage
boundaries, or two plausible assignments produce different intermediate
behavior, stop and ask the user. Do not guess.

## Reconcile the stack

Process affected stages from earliest to latest:

1. Check out the stage's recorded branch.
2. Recreate its assigned correction so the stage remains coherent and valid in
   isolation.
3. Run the smallest existing checks that cover the correction.
4. Commit the correction on that stage branch.
5. Update finalized insights and validation evidence only when the
   reconciliation produced a new review-relevant observation. Never invent the
   user's reasoning or reconstruct history.
6. Rerun `stage organize --finalized` when causes, files, hunks, line ranges,
   or item links changed.
7. Restack from the changed stage:

   ```text
   <semantic-implementation> restack --from <stage-id>
   ```

8. Reinspect later assigned changes against the rewritten branches. Reorganize
   any descendant whose existing node coverage no longer matches its diff.

Resolve replay conflicts according to the captured final tree and the recorded
stage intents. If that cannot be done without choosing new product behavior,
stop and ask the user. Leave the recovery branch intact.

## Verify and finish

1. Compare the final stage tree with the snapshot. They must contain the same
   application content, including new, renamed, and deleted files.
2. Exercise the complete acceptance path and run whole-stack checks from the
   artifact worktree.
3. Run:

   ```text
   <semantic-flow> validate --publish --project <artifact-worktree-path>
   <semantic-implementation> validate-stack
   ```

4. Check out the final stage branch at its refreshed recorded head.
5. Delete the recorded temporary recovery branch:

   ```text
   git branch --delete --force <temporary-recovery-branch>
   ```

6. Verify that `refs/heads/<temporary-recovery-branch>` no longer exists. A
   successful reconciliation is incomplete while that ref remains.

If any step fails, retain the recovery branch and report its name and snapshot
commit so the desired tree remains recoverable. Stop with the reconciled stack
ready for human review. Do not reply to or resolve feedback threads, approve
the stack, publish metadata, push branches, or merge.
