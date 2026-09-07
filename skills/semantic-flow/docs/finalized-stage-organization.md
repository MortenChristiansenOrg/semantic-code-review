# Reorganize a finalized stage

Use only when a feedback or reconciliation correction changes a finalized
stage's node coverage or item links. Run from the artifact worktree with the
stage's recorded branch checked out and the correction committed. Preserve
unrelated user changes.

## Prepare the organization input

Read `../references/stage-organization.schema.json`. Reuse the loaded platform
guide, or read `os/windows.md` for Windows and `os/linux.md` for Linux, for
temporary-file handling.

Obtain the complete committed stage file inventory:

```text
<semantic-implementation> stage plan --finalized --stage <stage-id>
```

Add `--selectors` only when nodes share files through hunks or line ranges.
Use the complete stage diff, not just the latest correction commit.

Create a separate UTF-8 organization JSON file in the OS temporary directory,
outside the repository. It must contain:

- `$schema`: `https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json`.
- `nodes`: the complete replacement node list, preserving existing IDs,
  descriptions, and ownership where still accurate.
- `itemLinks`: one entry for every recorded insight and validation item, with
  `collection`, `itemId`, and its complete `nodeRefs`. Preserve unchanged links;
  this is not just the unlinked items reported by `stage plan`.

Start from the selected stage's existing nodes and recorded items. Remove
memberships for paths no longer in the complete stage diff, add newly changed
paths, and refresh affected selectors and links. A deletion relative to the
stage base is still a change and needs ownership. Remove empty nodes and
reassign their item links to the nodes that now explain those items.

Cover every changed file. Shared-file ownership must cover each changed hunk
or line exactly once, using either hunks or line ranges consistently.

## Apply and return to the workflow

```text
<semantic-implementation> stage organize --finalized --stage <stage-id> --file <organization-json>
```

Both `--stage` and `--file` are required here. `--file` is the temporary
organization document, not the manifest or an existing stage artifact.
Passing organization fields through `--input` does not replace `--file`.
Use the CLI to update the artifact; never hand-edit its nodes or revisions.
Remove the temporary input afterward.

A correction commit can leave the branch ahead of the recorded stage head
until organization and restacking finish. That is expected during this
workflow, not by itself a schema migration or interrupted-write problem.
Return to the calling command's batched restack procedure; do not restack after
each organization or restart feedback preflight midway through the corrections.
