## Restack conflicts

A restack that conflicts, including automatic target restacking during
`feedback` or `sync` preflight, stops without moving any stage ref and records
itself as pending in the artifact. It reports the conflicting stage and files
and a scratch worktree outside the user's checkouts that holds normal Git
conflict state. Do not ask the user merely because Git found conflicts.

The steps below are prescribed recovery within the active request. Run them
without asking permission for their internal operations. Apply
`user-decisions.md` if implementation intent or safe recovery is uncertain.

1. In the reported worktree, inspect the conflict with ordinary Git commands
   such as `git status` and `git diff`. `HEAD` there is the new parent: the
   lower stages and target already restacked.
2. Resolve only the conflicts. Preserve the lower stages represented by `HEAD`
   and the conflicting stage's recorded intent. Run the smallest relevant
   checks there when they need no setup. Stage the complete resolution with
   `git add` or `git rm`. Do not commit, switch, or reset in that worktree.
3. A branch the restack moves may not stay checked out: if a stage branch is
   checked out in the artifact worktree, run `git switch --detach` there first,
   and restore the original checkout after the restack completes. A stage
   branch that `sync` or `feedback` detached after a conflict needs neither:
   `--continue` switches the worktree back to it once the restack completes.
   Then run, from the artifact worktree:

   ```text
   <semantic-flow> implementation restack --continue
   ```

   In a feedback round, add the round's `--claim <claim>`.

   It replays the remaining stages. If another stage conflicts, repeat from
   step 1 with the newly reported worktree.

After the restack completes, rerun the outer helper (`sync --local` for
synchronization, `feedback --json` for feedback) to validate and refresh
pending feedback anchors. If validation reports invalid node selectors, use
`stage organize --finalized` for the affected stages before rerunning it. A
stage whose changes the target or the stages below already contain stays as a
marked empty stage; validation accepts it and stack preparation skips it. When
the rerun helper's `emptyStageThreads` lists it without unresolved threads,
remove it from the artifact worktree, naming the rerun helper's
`implementationId`, and report the removal; otherwise keep it and report it:

```text
<semantic-flow> implementation stage remove --id <stage-id> --implementation-id <implementation-id> --json
```

In a feedback round, add the round's `--claim <claim>` here too.

The command refuses the only remaining stage; keep it and report that the
implementation no longer changes anything.

If resolving requires a product or code-intent decision, ask about that
behavior in plain language under `user-decisions.md`. The pending restack and
its worktree stay while you await the answer.

If `--continue` reports that a ref or the artifact changed since the restack
began, inspect what changed instead of retrying. `<semantic-flow>
implementation restack --abort` discards the pending restack and its worktree;
no ref has moved, so start the restack again from the current state. It also
switches back a stage branch that `sync` or `feedback` detached. If the
artifact worktree is still detached after `--continue` or `--abort`, for
example because either reports that it left the worktree as it is, check out
the original branch there yourself. Never move a stage ref with raw Git
commands.
