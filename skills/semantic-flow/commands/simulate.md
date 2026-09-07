# Simulate command

Use for `/semantic-flow simulate` and its `sim` alias when a completed
implementation was created outside semantic flow and the user wants it
reconstructed as a reviewable semantic stage stack.

Read `implement.md`, `../docs/runtime.md`, `../docs/artifact-quality.md`,
`../scripts/api/stages.d.ts`, and the selected operating-system guide before mutation.

The source implementation remains untouched. Simulation always creates a
separate normal semantic-flow stack. The same stack supports either a
read-only review of someone else's work or adoption as the user's continued
implementation; no branch mode distinguishes those uses.

## Locate and assess

1. Use the Git repository containing the active working directory unless the
   user supplied another project path.
2. Before running artifact discovery or changing Git state, require that the
   active working directory does not contain
   `.semantic-review/manifest.json`. If it does, stop and direct the user to
   the command matching that active implementation.
3. If `.semantic-review/` exists without a manifest and is not empty, stop and
   ask the user to inspect or remove it. Do not reuse or overwrite it.
4. Require a clean working tree, including no staged, unstaged, or untracked
   files. Require the completed implementation to be committed.
5. Record the source branch and immutable source `HEAD`. Do not move, rewrite,
   commit on, or delete the source branch.
6. Resolve the intended target branch. Prefer an explicit user value or
   reliable pull-request metadata. If the target is not clear, ask the user.
   Record its current head as the simulation base. Require the target tree not
   contain `.semantic-review/manifest.json`.
7. Inspect the source request, linked issue or specification, pull-request
   description when available, commit history, changes since the source merge
   base, complete target-to-source comparison, tests, and relevant
   documentation.
8. Require the source commit to differ from the target. The snapshot procedure
   performs the final effective-change check.

Do not select an existing artifact from another linked worktree as the
simulation destination. Choose an implementation ID and branch prefix that do
not collide with existing local refs or artifacts.

## Preserve the desired tree

Construct the expected integrated result before creating semantic stages:

1. Create a clean isolated worktree at the recorded target head.
2. In that worktree, create a uniquely named temporary recovery branch outside
   the planned semantic branch prefix.
3. Squash-merge the recorded source commit into the recorded target head and
   require the resulting staged tree to differ from the target. If it does not,
   abort and report that the source contributes no effective change. Otherwise
   commit the result as a temporary simulation snapshot.
4. Record the temporary branch name, snapshot commit, source branch and commit,
   target branch and commit, and isolated worktree path.
5. Require the target branch still to point to the recorded target commit.

The snapshot is the required final application tree. It is not a semantic
stage and must not use a numbered branch name. If integration conflicts can be
resolved mechanically without changing behavior, resolve them and inspect the
result. If resolution requires a product or design choice, stop and ask the
user. Keep the source branch and working directory unchanged.

If no snapshot commit was created, abort the squash merge and remove the
temporary branch and isolated worktree created by this command. If a snapshot
commit exists, retain its branch and report its name and commit.

## Reconstruct requirements and stages

Return the isolated worktree to the recorded target head without moving the
temporary snapshot branch. Initialize a normal semantic implementation with
the recorded target branch and target head.

Use the source request or linked work item as the specification. Preserve
separate source obligations as separate requirements according to
`../docs/artifact-quality.md`. Derive acceptance criteria from authoritative
requirements and observable promised behavior, not from low-level
implementation details. If no reliable requirement boundary or acceptance
criteria can be established, ask the user rather than inventing them.

Plan coherent ordered stages from the complete diff between the recorded
target commit and snapshot:

- Group changes by behavior and semantic cause, not by source commit, file,
  directory, technical layer, or patch size.
- Use source commits and their messages as evidence, but do not preserve their
  boundaries when they make poor review stages.
- Keep tests and directly related documentation with the behavior they verify
  or describe.
- Make each stage independently understandable and valid.
- Include every snapshot change exactly once across the stack.

Register only the next stage. For every stage, follow the begin, implement,
organize, validate, and finish procedure in `implement.md`. Let `stage begin`
create the numbered branch. Recreate that stage's assigned portion of the
snapshot on its branch and commit it. Do not cherry-pick merge commits or
create stage refs with raw Git.

## Capture retrospective insights honestly

Simulation cannot recover the original author's private reasoning. Record only
review-relevant facts and observations supported by the source, diff, commit
messages, tests, or analysis performed during simulation.

- Record decisions made during reconstruction and observable implementation
  choices without attributing unverified intent to the author.
- In the first stage, record that the stack is a retrospective simulation and
  identify the source ref and commit, target ref and commit, and snapshot
  commit. Link this provenance to the stage's change nodes.
- Record assumptions, risks, alternatives, and open questions discovered
  during analysis.
- Record failed attempts only when they were directly observed during
  simulation. Commit history alone does not prove that an approach failed.
- Record validation only after performing it, under the normal
  review-relevance rules.
- Do not invent historical decisions, rejected alternatives, failures,
  evidence, or rationale to make the artifact appear as if semantic flow had
  been used originally.

Stage rationale may explain why the reconstructed boundary is useful and what
the code demonstrably does. It must not claim knowledge of why the original
author chose an approach unless the source material says so.

## Verify and finish

1. Compare the final stage tree with the temporary snapshot. They must contain
   identical application content, including added, renamed, and deleted files.
   Exclude `.semantic-review/` and `.semantic-review-feedback/` from this
   comparison.
2. Confirm the source branch and source commit are unchanged.
3. Confirm the target branch still points to the recorded target commit. If it
   moved, retain the snapshot and stop; do not silently change the simulated
   integration base.
4. Exercise the complete acceptance path and run whole-stack checks from the
   artifact worktree.
5. Run:

   ```text
   <semantic-flow> validate --publish --stack --project <artifact-worktree-path>
   ```

6. Check out the final stage branch at its recorded head.
7. Delete the temporary recovery branch:

   ```text
   git branch --delete --force <temporary-recovery-branch>
   ```

8. Verify that `refs/heads/<temporary-recovery-branch>` no longer exists. A
   successful simulation is incomplete while that ref remains.

If any step after snapshot creation fails, retain the temporary branch and
report its name and commit so the intended integrated tree remains
recoverable. Stop with the generated stack ready for `/semantic-flow review`.
Do not modify the original source branch, approve the stack, publish metadata,
push branches, create a hosted review, or merge.
