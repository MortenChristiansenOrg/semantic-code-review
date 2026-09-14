## Restack conflicts

If any restack in this workflow reports a stage conflict, including automatic
target restacking during preflight, the command has already discarded its
temporary index and left every stage ref and artifact unchanged. This is not an
interrupted artifact write. Do not run `repair`, look for a rebase state,
merge lower-stage commits into the conflicting stage, or ask the user merely
because Git found conflicts.

The steps below are prescribed reversible recovery within the active request.
Run them without asking permission for their internal operations. Apply
`user-decisions.md` if implementation intent or safe recovery is uncertain.

Use the reported stage base, stage head, and new parent to resolve the stage's
net patch:

1. Record the original restack invocation and the complete conflict context.
   If `feedback` or `sync` preflight triggered the restack, the invocation to
   resume is `<semantic-implementation> restack --base <target-branch>` in the
   artifact worktree. Record the original checkout too. Do not rerun the outer
   helper until the underlying restack succeeds: recovery moves a stage head
   that automatic preflight deliberately rejects. A target fast-forward done
   by sync is retained; do not fetch or advance it again during recovery.
   Confirm the stage and target branches have not moved.
2. Create a uniquely named recovery branch outside `branchPrefix` at the
   reported stage head. Keep it until the revised stack validates.
3. Create and check out a second temporary branch, also outside
   `branchPrefix`, at the reported new parent.
4. Write `git diff --binary --full-index --find-renames=50% <stage-base>
   <stage-head> --` to an OS temporary file outside the repository, then apply
   it with `git apply --3way --index <temporary-patch>`. A nonzero exit with
   unmerged files is expected.
5. Resolve only those conflicts. Preserve the lower stages already represented
   by the new parent and the conflicting stage's recorded intent. Run the
   smallest relevant checks, stage the complete resolution, and commit it.
6. Move the conflicting stage branch with compare-and-swap:

   ```text
   git update-ref refs/heads/<stage-branch> <resolution-head> <reported-stage-head>
   ```

7. Check out a safe branch or detach, then delete the temporary resolution
   branch and patch file. For `--from`, check out its requested stage branch.
   For `--base`, ensure no rewritten stage
   branch is checked out. Then rerun the original restack command. If another
   descendant conflicts, repeat from its newly reported context.

After successful target restacking, restore the original branch, or detach at
the rewritten stage/base revision if originally detached there, and rerun the
outer helper (`sync --local` for synchronization) to validate and refresh
pending feedback anchors. If validation reports invalid node selectors, use
`stage organize --finalized` for the affected stages before rerunning it.

If resolving the net patch requires a product or code-intent decision, or stage
ownership changes the implementation, ask about that behavior in plain language
under `user-decisions.md`. Preserve the unresolved work while awaiting the answer.

If a guarded ref update fails or a branch moved after the conflict report, stop
the write and inspect what changed. Follow `user-decisions.md` to determine
whether documented safe recovery is still possible; never force the update or
blindly retry with a new expected head. If blocked, explain the affected work and
why continuing could overwrite or misapply it. Do not ask the user to approve a
compare-and-swap retry. Retain every recovery branch on failure and include its
name as diagnostic detail. After restacking and validation succeed, delete the
recovery branches.
