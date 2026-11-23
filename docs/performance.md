# Operation performance and validation coverage

Issues #13 and #2 reduce repeated instruction reads, CLI round trips, immutable
Git reads, and viewer work. Artifact schemas, feedback storage, browser storage,
and approval behavior are unchanged. The agent loop that listens for feedback
(#1) came later; incremental viewer refresh is available independently.

## Reproduce

Run `npm run benchmark` in `scripts/`. To compare the same fixtures against an
older checkout, run `node benchmarks/operations.mjs --baseline --scripts
/path/to/old/skills/semantic-flow/scripts`. For a build with the single
`semantic-flow.mjs` outside its source checkout, add `--source /path/to/checkout`
so the viewer measurements can load its source. The baseline below is commit
`84b6d1c98ce2d19b6baa1aa06eacbcc5c46cfc20`. The script creates and removes temporary
repositories; Git process counts use `GIT_TRACE2_EVENT`.

These are individual local observations on Linux, Node 24.14.0, rather than
statistical benchmarks or cross-platform guarantees. Instruction sizes are UTF-8
bytes along the documented Linux entry paths, excluding the common skill entry.
No harness tokenizer was available: bytes are not token counts or dollar savings,
and prompt caching affects actual spending. CLI counts represent invocations in
the prescribed workflow, not measured LLM turns.

## Measurements

| Operation / fixture | Before | After |
| --- | ---: | ---: |
| Status instruction reads | 30,837 bytes | 1,659 bytes |
| Implement entry instruction reads | 41,336 bytes | 29,261 bytes |
| Feedback instructions, ordinary path | 6,789 bytes | 4,850 bytes |
| Completion, continuation, reconcile/simulate: ten-stage verification | 2 CLI calls, 109 Git calls, 505 ms | 1 CLI call, 56 Git calls, 252 ms |
| Prepare ten-stage stack | 3 CLI calls, 171 Git calls, 770 ms | 1 CLI call, 65 Git calls, 276 ms |
| Status of ten-stage stack | 57 Git calls, 273 ms | 57 Git calls, 289 ms |
| Archive landed stack | 68 Git calls, 270 ms | 73 Git calls, 294 ms |
| Validate 100 line threads on one blob | 100 blob reads, 743 ms | 1 blob read, 115 ms |
| Reply among 100 line threads | 200 blob reads, 1,361 ms | 1 blob read, 123 ms |
| Validate 300 line threads on one blob | 300 blob reads, 1,979 ms | 1 blob read, 124 ms |
| Reply among 300 line threads | 600 blob reads, 3,243 ms | 1 blob read, 141 ms |
| Feedback preflight, 300 threads | 315 Git calls, 2,142 ms | 16 Git calls, 319 ms |
| Open a small file beside a 14 MB mostly unchanged file | 15,300,959 captured Git bytes, 162 ms | 2,028 captured Git bytes, 98 ms |
| Twenty unchanged snapshot polls, 300 threads | Full document reads per poll | 0 document content reads |

The prepare/archive figures include the final mutable-state guards; other rows
are from the preceding run of the same fixtures. Rerun for current timings. Archive's
baseline measures the successful standalone command: the old skill's preceding
validation incorrectly rejected an advanced, landed target. The combined archive
adds feedback validation and worktree resolution, so no archive speedup is claimed.
Status runtime is unchanged; its improvement is the instruction path.

Completion output fell from 1,634 to 1,520 bytes and prepare from 1,768 to 1,653
bytes. Feedback preflight remains 65,268 bytes in this fixture: pending context is
preserved. The small-file fixture exercises small-stage batching with bounded
context. Large changed stages use streamed per-file pages instead.

In a live browser fixture with 2,401 lines, full context loaded in pages of 900
rows; jumping to a thread on line 1,901 loaded the correct page. Twenty synchronous
removed-line toggle clicks on a 900-row page fell from a median 87.9 ms (maximum
109.8 ms) to 0.1 ms (maximum 1.8 ms) by retaining the DOM and toggling CSS.
These event-handler timings exclude asynchronous paint. External agent replies
appeared without navigation while preserving an unsaved textarea draft, focus,
and selected characters. Reopening the same viewer reused its process ID.

## Check coverage

| Entry point | Checks and reuse |
| --- | --- |
| `stage begin` / `finish` | Existing full artifact, branch, ancestry, clean-tree and organization checks; begin also refuses an existing stage branch of the same ID. Optional JSON returns next-step snapshots. The skill omits a redundant standalone validate immediately after finish. |
| `stage record-batch` | Validates existing artifact, applies insight/evidence edits in memory, validates the result, then writes once. Invalid input leaves the stage unchanged. Individual commands remain. |
| `stage plan` | Validates artifact and checked-out stage identity; returns scoped inventory, optional hunk geometry, and unlinked IDs. The agent still assigns semantic ownership. |
| `flow validate [--publish] [--stack]` | Resolves the artifact worktree once; validates feedback when present and the complete artifact/stack. `--publish` additionally requires resolved feedback and publication readiness; it does not publish. |
| `flow prepare [--branch]` | Holds the feedback lock and requires resolved threads; validates publication readiness once; re-reads mutable documents/refs at each mutation and checks the clean worktree. Existing metadata checks, compare-and-swap publication, and output-branch overwrite refusal remain. |
| `flow archive` | Feedback gate plus full validation with landed-target semantics; fresh documents/refs, clean target checkout, ancestry and published metadata identity; existing archive rollback remains. |
| All feedback mutations / preflight | Complete existing-store validation, schema/target checks, locking and rollback. Only immutable blob/rename/schema facts are shared within an operation. Stale/resolved history remains validated. |
| `thread add-batch` / `reply-batch --partial` | Existing CLI batches stay atomic by default. Explicit partial mode reports each invalid input, commits the accepted subset transactionally, and recognizes identical retries. Lock/storage failures remain global errors. Viewer export uses one batch instead of per-item fallbacks. |
| Viewer data and diffs | Immutable base/head binding, rename and shared-node ownership, bounded caches, complete context through paging. Worker jobs keep heavy Git/feedback work off the HTTP event loop and coalesce concurrent identical reads. |
| Viewer refresh/reopen | File identity/size/nanosecond timestamps detect external writes; ten-second content rescans catch missed metadata signals. Successful mutations force a scan. Failed scans retain the last good cache. Reuse requires matching worktree, implementation and installed assets, plus a live worker. |
| Application tests and review reads | Reuse only for the same tree, scope, dependencies/configuration and relevant environment. Restacks, changed inputs, inconclusive results and new required coverage trigger another check. |

Regression tests cover shared-blob reads and invalidation after restack, partial
batch retries and invalid stores, atomic authoring, stage branch collisions, combined
workflow feedback gates and landed archival, external snapshot edits/deletion and
failed scans, distant diff pages/line jumps and rename/recreated-path separation,
single-CLI mixed-validity export, and focused/full API contract drift checks.
Existing publication, restack, recovery, feedback and viewer tests remain enabled.

## Artifact stored in Git (#172)

The active artifact moved from `.semantic-review/` files to snapshot commits of
`refs/semantic-review/active/<implementation-id>`. A read lists the active refs
with one `git for-each-ref`, lists the snapshot tree once with `git ls-tree`,
and reads every document of it with one `git cat-file --batch`; a process reads
each snapshot commit's tree only once. A write stores changed blobs with one
`git hash-object --stdin-paths`, builds the tree in a temporary index, and moves
the ref and any stage branches in one `git update-ref --stdin` transaction.

Same fixtures, Linux, Node 24.20.0; before is the folder store with derived
stage data, after is the Git store:

| Operation / fixture | Before | After |
| --- | ---: | ---: |
| Completion, continuation, reconcile/simulate: ten-stage verification | 47 Git calls, 535 ms | 55 Git calls, 568 ms |
| Status of ten-stage stack | 47 Git calls, 523 ms | 55 Git calls, 553 ms |
| Prepare ten-stage stack | 58 Git calls, 588 ms | 67 Git calls, 621 ms |
| Archive landed stack | 67 Git calls, 620 ms | 78 Git calls, 662 ms |
| Validate 300 line threads | 3 Git calls, 422 ms | 7 Git calls, 445 ms |
| Reply among 300 line threads | 3 Git calls, 440 ms | 8 Git calls, 463 ms |
| Feedback preflight, 300 threads | 14 Git calls, 486 ms | 23 Git calls, 533 ms |
| Twenty unchanged snapshot polls, 300 threads | 0 document reads | 0 document reads |

Each command now spends a few more short Git processes, about 20–50 ms, mostly
on listing the active refs again for each read. The listing is not cached:
long-running processes such as the viewer and feedback waits must see writes
from other processes. An unchanged viewer poll costs one `for-each-ref`, since
the snapshot commit identifies the artifact's content.

## Archive as a ref (#176)

`archive` no longer stages and commits files in the target checkout. It builds
the archive commit from the published tree and moves the refs in one
`git update-ref --stdin` transaction. Same fixture (ten stages, landed by
fast-forward), Linux, Node 24.20.0, two runs each:

| Operation / fixture | Before | After |
| --- | ---: | ---: |
| Archive landed stack | 101 Git calls, 745–754 ms | 89 Git calls, 694–756 ms |

The time is dominated by validation, which is unchanged. When landing is
unknown, matching target commits for a suggestion adds a `git log -p` over at
most 1,000 target commits and two `git patch-id` runs.

## One commit per finalized stage (#177)

`stage finish` folds the stage's commits into one with `git commit-tree`,
reading the authors and co-author trailers of the folded commits. A stage of
three commits, before (commits kept) and after, Linux, Node 24.20.0, two runs
each:

| Operation / fixture | Before | After |
| --- | ---: | ---: |
| Finish a stage of three commits | 21 Git calls, 447–449 ms | 28 Git calls, 493–494 ms |

The other measured operations are unchanged: validation already listed each
stage's commits, and now also counts them.

## Restack by cherry-pick (#177)

Restack replays each stage with `git cherry-pick --no-commit` in a scratch
worktree instead of applying its patch with `git apply --3way` to a temporary
index, so renames and moved directories merge as Git merges them. The
worktree is checked out once per restack, which is what a larger checkout
pays for. Ten stages restacked onto an advanced target, before (patch replay,
one-commit stages) and after, Linux, Node 24.20.0, two runs each:

| Operation / fixture | Before | After |
| --- | ---: | ---: |
| Restack, small checkout | 139 Git calls, 958–970 ms | 175 Git calls, 1,107–1,123 ms |
| Restack, 2,000-file checkout | 139 Git calls, 1,013–1,037 ms | 175 Git calls, 1,497–1,750 ms |

A restack in which every stage already sits on its parent creates no worktree.

## Approving a group of files (#266)

"Approve all files" in a group approved each file as if it were clicked: one
request to retain its content, which ran about six Git processes and took the
review lock, and two renders of the whole page. The renders made the page's time
grow with the square of the group's size. The viewer now sends the files 200 at a
time in one request, records the approvals whose content was retained, and saves
them in one save per request. The server lists the files with one `ls-tree` per
revision (per few hundred paths), reads their sizes with one `cat-file
--batch-check` and their content with one `cat-file --batch`, outside the review
lock, then writes the snapshots holding the lock for at most 100 at a time.
A single file approval goes the same way.

A stage of one group of files, from the click until the group shows every file
approved, Linux, Node 24.20.0, other test suites running meanwhile:

| Files | Before | After |
| --- | ---: | ---: |
| 50 | 50 requests, 4 saves, 307 Git runs, 2.1 s | 1 request, 1 save, 10 Git runs, 0.5 s |
| 300 | 300 requests, 3 saves, 1,805 Git runs, 21–27 s | 2 requests, 2 saves, 14–16 Git runs, 1.0–1.7 s |
| 1,000 | not measured | 5 requests, 5 saves, 40 Git runs, 4.5 s |

`viewer-git-runs.test.mjs` checks that a request for 61 files runs the same Git
commands as one for a single file, and the browser tests count the requests and
saves of a 450-file group.

## Functional effects and limits

- API references are grouped under `scripts/api/`; `API.d.ts` is the small index
  and `API.full.d.ts` retains the complete generated contract. Recovery guidance
  is loaded on demand; it is not removed.
- Large/full-context diffs load in pages. Complete content remains accessible;
  long-distance jumps may scan preceding Git output to locate a page.
- Hidden tabs defer polling until visible. Refresh also waits while review text
  is selected or feedback is being sent. Draft text survives refresh. A line draft
  whose revision changed must be copied to a new note on the current diff, so it
  cannot silently target a different line. Surviving non-line targets can refresh.
- Snapshot polling still stats documents, and its periodic fallback reads them.
  No daemon is added to ordinary CLI commands; the worker exists only inside the
  already-running viewer. Windows/macOS behavior requires platform verification.
- Stage planning/batching and test-result reuse reduce prescribed tool round
  trips; no end-to-end LLM spending benchmark or semantic-ownership automation
  is claimed.
