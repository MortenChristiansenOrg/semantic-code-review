# Archive command

Use once the reviewed implementation is finished, normally after it has landed
on the target branch.

`<semantic-flow>` means `node` followed by the quoted installed script path
`scripts/semantic-flow.mjs`. Read `../scripts/api/workflow.d.ts` and
`../scripts/api/history.d.ts` only when additional contract detail is needed.
The helper resolves the artifact worktree.

## Preconditions

Require:

- No working stage.
- Feedback valid with no open threads.
- Stage branches at their recorded heads.

Archiving needs no checkout and is not blocked by the target branch: it adds
nothing to the target branch and records landing instead of requiring it.

## Archive

If the user named the commit or range (`<base>..<head>`) that landed the work,
pass it with `--landed`. Otherwise omit it. Run one helper, which validates the
artifact and resolved feedback before archiving. Do not run ordinary pre-landing
validation first:

```text
<semantic-flow> archive --json [--landed <revision|base..head>] [--project <artifact-worktree-path>]
```

The command publishes the artifact when the metadata branch does not already
hold it, stores the archive under `refs/semantic-review/archive/<implementation-id>`
with a landing record, and removes the active artifact. It does not delete
stage branches, metadata branches, feedback history, remote refs, or worktrees.
Branch cleanup is a separate explicit operation.

Report the landing outcome: found by ancestry, supplied, or unknown. When it is
unknown and the output suggests a matching commit or range, show it to the user
as a suggestion only: matching changes do not show that it landed them. Record
it only when the user confirms:

```text
<semantic-flow> implementation archive landing --id <implementation-id> [--landed <revision|base..head>]
```

Without `--landed`, this records landing once the target branch contains the
final stage head. Run this command and `archive share` from a worktree of the
archived implementation's repository; they take no `--project`.

## Share

Only when the user asks to share the archive, run:

```text
<semantic-flow> implementation archive share --id <implementation-id>
```

It creates the annotated tag `semantic-review/archive/<implementation-id>`,
which is never moved, so record landing first. Push the tag with the printed
command only to a remote the user named. Pushing it sends the artifact, its
evidence and the stage commits.
