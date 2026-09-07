## Restack conflicts

If any restack in this workflow reports a stage conflict, including automatic
target restacking during preflight, the command has already discarded its
temporary index and left every stage ref and artifact unchanged. This is not an
interrupted artifact write. Do not run `repair`, look for a rebase state,
merge lower-stage commits into the conflicting stage, or ask the user merely
because Git found conflicts.

Use the reported stage base, stage head, and new parent to resolve the stage's
net patch:

1. Record the original restack invocation and the complete conflict context.
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

7. Delete the temporary resolution branch and patch file. For `--from`, check
   out its requested stage branch. For `--base`, ensure no rewritten stage
   branch is checked out. Then rerun the original restack command. If another
   descendant conflicts, repeat from its newly reported context.

Stop and ask the user only when resolving the net patch requires a product
decision, stage ownership is unclear, a guarded ref update fails, or a branch
moved after the conflict report. On failure, retain every recovery branch and
report its name. After restacking and validation succeed, delete the recovery
branches.
