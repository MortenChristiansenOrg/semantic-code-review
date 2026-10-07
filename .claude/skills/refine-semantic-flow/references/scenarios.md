# Scenario contracts

Built-ins are maintained in `scripts/evaluations/refinement/scenarios.mjs`; the
harness uses them directly. They have fresh repositories, no remotes, private
review homes and no scripted replies. Their exact requests are frozen in each
run's prompt. Setup errors consume no model calls. Never expose checks or expected
outcomes to evaluated agents.

The broad set is six independent requests: `implement-small`,
`cli-recovery-category`, `feedback-compatible`, `feedback-conflicting-intent`,
`status`, and `help-feedback`. Splitting status/help makes the call budget accurate.

| Scenario | Deterministic acceptance | Required transcript evidence |
| --- | --- | --- |
| implement-small | Independent discount assertions (default, bounds, fractions, invalid numbers, no input mutation), final-head tests, artifact publication and stack validation. | Complete acceptance path exercised; insight policy followed. Empty insights pass when no significant observation arose; evidenced omissions or filler fail. |
| cli-recovery-category | Real unsupported-category failure injected before resumption; independent discount assertions, tests, finalized publication/stack and retained engineering decision. | Contract/help inspected, one-caller rationale preserved, work continued without asking about syntax. |
| feedback-compatible | Enabled HTML confirmations, retries=2, delivery.md preserved; valid artifact/stack/feedback; exactly one agent reply, thread open, no pending reply; temporary recovery branches removed. | Prescribed recovery, original checkout restored before feedback edits, concise accurate reply, no mechanics question. |
| feedback-conflicting-intent | Existing refs, implementation artifact, original application files and feedback preserved; diagnostic recovery refs may remain. | Ask whether to retain delivery pause or enable confirmations/retries; do not claim completion or choose a product behavior. This expected question is exempt from prompts. |
| status | Refs, checkout, repository content, artifact and review-home snapshots unchanged. | Accurate stage/state summary; focused reads only. |
| help-feedback | Same read-only snapshots. | Explain feedback without executing it; focused reading may include files explicitly required by the selected help path. |

Implementation validation runs from the actual registered artifact worktree. Tests
and independent acceptance use an export of its immutable final cumulative commit.
Unused setup directories and arbitrary `.semantic-review` discoveries do not count.

Every transcript-check ID has an explicit pass/fail and applicability rule in
`transcriptCriteria`, supplied only to graders. IDs alone are not acceptance
definitions. `insight-policy-followed` checks appropriate recording, not existence:
do not require an insight from routine work. The insights quality metric is null
when nothing substantive arose. Category recovery separately supplies a material
decision and requires preserving its rationale, so that case still measures actual
insight recording. Missing evidence of an observation is not evidence that the model
concealed one.

For a completed implementation, the exact structural checks are:

```text
node <skill>/scripts/semantic-implementation.mjs validate --publish
node <skill>/scripts/semantic-implementation.mjs validate-stack --json
```

For compatible feedback, additionally run the read-only feedback validator:

```text
node <skill>/scripts/review-feedback.mjs validate
```

Read thread JSON to verify reply/open/pending state. Do not run feedback preflight or
`next` merely to inspect results: those commands may refresh state. **Do not substitute
`semantic-flow validate --publish` here**: that also requires the reviewer to resolve
open threads, which this feedback scenario intentionally does not do. Artifact
publication validity and whole-workflow readiness are different checks.

Category recovery resumes after a real failed CLI call, not a tool-interception
experiment. Count the injected failure separately. File-read errors, safety refusals,
and test failures are not CLI syntax rejections. Reference evaluations:
[CLI recovery](../../../../skills/semantic-flow/docs/cli-recovery-evaluation.md) and
[feedback recovery](../../../../skills/semantic-flow/docs/feedback-recovery-evaluation.md).

## Extending coverage

A custom scenario supplies the [adapter contract](harness.md#custom-project-scenarios)
and a card recording: pinned fixture/source, request, capabilities, check IDs and
commands/assertions, transcript checks, expected questions, metric applicability,
and any exclusions. Use evaluator-controlled acceptance shared by all repetitions;
agent-authored tests provide additional evidence. Add fixtures with both passing and
failing outputs to test the verifier itself.

The concurrent-ref-movement safety control requires a harness that can pause before
a guarded write. The current runner does not support that interception; mark it
unsupported rather than claiming coverage from deterministic CLI tests. Similar
limitations apply to interactive scripted replies: the built-ins exercise either
completion without questions or a correct question-and-stop boundary. A scenario
requiring a follow-up needs an explicitly budgeted conversational adapter.

Baseline screens can use one repetition and report observations only. Comparison
mode requires at least three per selected scenario/model/variant, including the broad
set. Matching full comparison results also serve as the final broad check; no duplicate
run is necessary unless inputs, capabilities or revisions changed.
