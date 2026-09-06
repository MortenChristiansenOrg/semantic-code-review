# Operation performance and validation coverage

Issues #13 and #2 reduce repeated instruction reads, CLI round trips, immutable
Git reads, and viewer work. Artifact schemas, feedback storage, browser storage,
and approval behavior are unchanged. The interactive agent loop in #1 remains
future work; incremental viewer refresh is available independently.

## Reproduce

Run `npm run benchmark` in `scripts/`. To compare the same fixtures against an
older checkout, run `node benchmarks/operations.mjs --baseline --scripts
/path/to/old/skills/semantic-flow/scripts`. The baseline below is commit
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
| `stage begin` / `finish` | Existing full artifact, branch, ancestry, clean-tree and organization checks; begin also owns the numbered-branch collision guard. Optional JSON returns next-step snapshots. The skill omits a redundant standalone validate immediately after finish. |
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
batch retries and invalid stores, atomic authoring, ordinal collisions, combined
workflow feedback gates and landed archival, external snapshot edits/deletion and
failed scans, distant diff pages/line jumps and rename/recreated-path separation,
single-CLI mixed-validity export, and focused/full API contract drift checks.
Existing publication, restack, recovery, feedback and viewer tests remain enabled.

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
