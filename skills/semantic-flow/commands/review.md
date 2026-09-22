# Review command

Use to open the local semantic review viewer. This command is read-only with
respect to implementation artifacts and implementation branches.

`<semantic-flow>` means `node <installed-skill-root>/scripts/semantic-flow.mjs`.
Quote the script path. Launch:

```text
<semantic-flow> review [--project <repository-or-worktree-path>] [--implementation-id <id>]
<semantic-flow> review --branch <branch-name> [--project <repository-or-worktree-path>]
```

The helper resolves linked worktrees without requiring `targetBranch` to match
the invoking branch, then starts the bundled viewer as a detached background
process. It reports the local URL only after the server is listening and then
exits; do not run a separate inspect, validation, HTTP probe, or shell
backgrounding command. The detached viewer remains running after the agent turn
or terminal command completes.

The viewer renders stages, change nodes, project-grouped files, linked insights,
full-context diffs, and feedback threads. A user can add and edit draft notes
before sending. Sent notes become open threads; agent follow-ups appear in
the same thread after the feedback workflow runs. It refreshes changed artifacts and feedback in place, retaining drafts and
unchanged diffs. A matching healthy viewer is reused when reopening review.
Large files load in pages; full context remains available on demand.

Feedback and browser-local review state may be created through the viewer, but
the launch command itself must not mutate the artifact, switch branches,
approve work, or prepare outputs. Run feedback CLI commands from the resolved
artifact worktree root.

## Reviewing someone else's remote branch

Pass `--branch feature-name` to review the branch from `origin` (or the only
configured remote). Use `--branch upstream/feature-name` to select another
remote. This option cannot be combined with `--implementation-id` and works
without a local Semantic Flow artifact. Git uses your configured credentials;
no code from the reviewed branch is built or executed.

Remote reviews appear in Saved reviews with a **Remote** label. Their independent
Git clone lives at `~/.semantic-flow/reviews/<review-id>/checkout/` (or the
configured `SEMANTIC_FLOW_HOME`). Your project's checkout, refs and uncommitted
changes stay untouched. Deleting a review removes its clone, notes, attachments
and approved-content snapshots together.

The viewer allows personal notes and approvals only. It does not offer feedback
messages or send anything to an implementation agent or remote author. Do not
run the feedback, sync, reconcile or implementation workflows for these reviews.

Matching published Semantic Flow metadata supplies the original stages, nodes,
requirements and insights. Without usable metadata, the viewer reconstructs
stages from first-parent commits, including merge commits. Both presentations
include **All branch changes**, a cumulative diff with stable file approval
identities; use it to track approvals across remote updates or rewritten history.
The fallback compares against the merge base with the remote's default branch
(`main` or `master` if the remote does not advertise one). Git-derived groupings
provide commit messages and authors, but cannot recover undocumented intent.

Reopening a saved review retains the last reviewed snapshot. Choose **Refresh
branch** in the viewer to fetch updates. Changed file approvals become stale and
**Since approval** compares current content with the saved approved content,
including after force-pushes. Unchanged file content retains its approval when
the base and ownership are unchanged. Refresh failures keep the previous
snapshot available. Notes and approvals on removed commit stages remain saved
but those stages no longer appear in the current branch's history.
