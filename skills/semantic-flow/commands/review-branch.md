# Review branch command

Opens the local review viewer on someone else's branch, read from a remote.
It needs no local Semantic Flow artifact and has no agent: nothing listens.
Do not run `feedback --wait` or the feedback, sync, reconcile or implementation
workflows for these reviews.

`<semantic-flow>` means `node` followed by the quoted `scripts/semantic-flow.mjs`
path under the installed skill root. Launch:

```text
<semantic-flow> review --branch <branch-name> [--project <repository-or-worktree-path>]
```

The command starts the viewer as a detached background process or reuses a
healthy one, reports the local URL once the server is listening, and exits. Do
not run a separate inspect, validation, HTTP probe, or shell backgrounding
command. Report the URL, or the error, in one line and stop.

## The reviewed branch

Pass `--branch feature-name` to review the branch from `origin` (or the only
configured remote). Use `--branch upstream/feature-name` to select another
remote. This option cannot be combined with `--implementation-id`. Git uses your configured credentials;
no code from the reviewed branch is built or executed.

Remote reviews appear in Saved reviews with a **Remote** label. Their independent
Git clone lives at `~/.semantic-flow/reviews/<review-id>/checkout/` (or the
configured `SEMANTIC_FLOW_HOME`). Your project's checkout, refs and uncommitted
changes stay untouched. Opening the same remote branch from any checkout reopens
its review. Deleting a review removes its clone, notes, attachments and
approved-content snapshots together.

The viewer allows personal notes and approvals only. It does not offer feedback
messages or send anything to an implementation agent or remote author.

Matching published Semantic Flow metadata supplies the original stages, nodes,
requirements and insights. Without usable metadata, the viewer reconstructs
stages from first-parent commits, including merge commits. Each later occurrence
of a file compares against the previous stage that changed it, skipping any
intervening stages. There is no duplicate cumulative stage.
The fallback compares against the merge base with the remote's default branch
(`main` or `master` if the remote does not advertise one). Git-derived groupings
provide commit messages and authors, but cannot recover undocumented intent.

Reopening a saved review retains the last reviewed snapshot. Choose **Refresh
branch** in the viewer to fetch updates. Changed file approvals become stale and
**Since approval** compares current content with the saved approved content,
including after force-pushes, and leaves out changes that came from the base when
they can be separated. In commit-based reviews, the newest occurrence of
a file can compare against its latest saved approval from an earlier commit.
Unchanged file content retains its approval when
the base and ownership are unchanged. Refresh failures keep the previous
snapshot available. A refresh that was interrupted, for example because the
viewer was stopped, may already have checked out the fetched revision; the
review then shows that revision when it is next opened or refreshed. Where
that revision cannot be shown again from the review's own copy of the
repository, opening the review fetches the branch, as **Refresh branch** does.
Notes and approvals on removed commit stages remain saved but those stages no
longer appear in the current branch's history.
