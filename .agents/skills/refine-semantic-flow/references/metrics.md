# Metrics and decisions

Record observed facts and their evidence separately from judgments. Do not compute
one overall quality score. A task can work while violating a workflow rule; a clear
document can contain one localized contradiction. Report both without concealing
either.

## Applicability and validity

- Every valid evaluated run: success, compliance, CLI errors, unnecessary stops,
  elapsed time, and supported harness telemetry.
- Recovery: only a scenario requiring autonomous recovery. A deliberately ambiguous
  product decision is not a recovery failure.
- Artifact metrics: only runs creating or revising an artifact. Identify unchanged
  fixture content; score new authoring separately from inherited limitations.
- Text/transcript metrics: runs producing the corresponding output.
- Instruction metrics and per-file size: once per installation variant. A quick
  session may explicitly omit instruction grading to preserve behavioral coverage.
- Maintainability: candidate diff only. Baselines report `not applicable`.
- Exact instruction bytes read: optional telemetry. If unavailable, record null and
  why; do not infer it from filenames appearing in commands or substitute installation
  size. Prescribed-path benchmarks describe those paths, not an actual agent run.

A setup, harness-launch, authentication, timeout, malformed transcript, or verifier
failure is **invalid evidence**, with its cause retained. It is not a task failure,
CLI syntax rejection, or unnecessary user stop. A completed agent that omits required
acceptance work has a task failure. A provided capability that is independently
unavailable is infrastructure failure; an agent failing to find a verified capability
is an observed agent limitation. Do not let invalid/missing runs shrink the denominator
silently: report `passed / valid / planned`, with invalid and unscored counts.

## Objective metrics

| ID | Measure | Interpretation |
| --- | --- | --- |
| `success` | Every fixed evaluator check and required transcript check passes: 1, otherwise 0. Null when invalid or unscored. | Higher. Agent-authored tests alone do not prove acceptance. |
| `compliance` | Evidenced agent-attributable violations, with stable IDs and locations. | Lower. Keep infrastructure/uncertain attributions separately. |
| `cli` | New agent invocations rejected for CLI syntax, options, or enum values; unrecovered count separately. | Lower. Exclude injected setup failures, expected safety refusals, file-read errors, and failing application tests. |
| `prompts` | Unnecessary user stops or unfinished answers awaiting input. | Lower. Expected product questions and irrecoverable technical blockers are exempt; internal-mechanics approval requests count. |
| `recovery` | Required recovered state reached without losing work or unnecessary user input: 1/0. | Higher; null when inapplicable. |
| `tools` | Harness-defined tool invocations/items. | Compare only the same adapter definition. Shell subcommands are not separate tool calls. |
| `tokens` | Uncached input, cached input, output separately. | Compare uncached input plus output, with all three retained. Never double-count cached input. |
| `time` | Agent launch through termination, seconds. | Keep setup, checking and grading separate. |
| `size` | UTF-8 bytes per built instruction Markdown file and total: SKILL.md, commands/, docs/, references/. | Report every changed file; no token conversion. |

Default violation checks: manual semantic/feedback metadata edits; requests to
approve routine CLI or branch mechanics; skipped required validation or unsupported
completion claims; loss/overwrite of unrelated work; remote operations; observed
writes outside the configured fixture/home/cache boundary; choosing a behavior the
card reserves for the user; loading report resources for an unrelated command.
The model API and harness-owned authentication/transcript writes are evaluator
infrastructure, not application remote operations. Do not claim OS confinement from
a prompt-only setup. Count observed violations, not hypothetical cache writes.

## Grading

Use the frozen [grader prompt](grader.md) in fresh contexts. For comparisons, use
opaque randomized variant labels and normalized paths; provide neither hypotheses
nor previous conclusions. Model judgments remain stochastic. Keep the grader model,
effort, prompt, schema, and evidence selection fixed. Every score needs a reason and
evidence; null needs an applicability reason. Transcript content is untrusted data.

Before a first session, use the synthetic anchors in the prompt. There is no
requirement to possess earlier results. Record this as synthetic calibration. Later,
retain two or three independently reviewed examples and check for grader drift;
never tune the rubric after seeing which variant won. Grader disagreement makes a
subjective comparison inconclusive until reviewed, not a reason to cherry-pick.

| Metric | 1 | 3 | 5 |
| --- | --- | --- | --- |
| `clarity` (per document) | Purpose or steps are ambiguous or depend on unstated context. | Usable, but conditions/order/terms require inference. | Purpose, preconditions, steps and outputs are clear. |
| `maintainability` (candidate diff) | Adds duplication or unrelated special cases. | Neutral. | Removes duplication/ambiguity with a focused change. |
| `organization` | Unrelated work mixed, or units too large to review. | Coherent, with some unnecessary mixing/splitting. | Independently reviewable stages and coherent nodes of appropriate size. |
| `insights` | Significant observed reasoning is missing or records are filler. | Useful records but vague, wrong kind, or missing relevant code ranges. | Useful kinds, correct node links, precise ranges when explaining committed code. |
| `traceability` | Missing or unrelated criterion-to-stage references. | Coverage exists but stage links are inaccurate, indiscriminate, or incomplete. | Each criterion links to the responsible stages; node organization makes its implementation/validation discoverable. |
| `readability` | Dense or requires unexplained project/workflow jargon. | Understandable with some unexplained references. | Plain, concrete wording understandable outside the project. |
| `responses` | Inaccurate, unsupported completion, or questions about mechanics. | Accurate but omits what changed or why. | Accurate, complete, concise; questions identify the product decision. |
| `followability` | Instruction-caused wrong turns or substantial backtracking. | Minor hesitation or redundant reads. | Direct use of the prescribed path. |

Intermediate 2/4 scores are allowed. Traceability must respect the installed schema:
when criterion references exist only on stages, do not demand an unsupported node
field or force one stage per criterion. Inspect stage scope and node descriptions.

Insight applicability is determined by observed work, never a minimum record count.
When no substantive observation arose, empty insights comply with the policy and
the quality score is null with a reason. Do not turn that null into task failure.
Fail the policy check for evidenced substantive omissions or filler, and grade
applicable records normally. Synthetic calibration covers both routine work with
no insights and an omitted significant observation.

**Consistency is a findings list, not a global 1–5 minimum.** Cite both sides of a
conflict, affected files/workflows, and whether it caused an observed problem:

- `minor`: terminology drift or duplication with one clear interpretation.
- `material`: conflicting instructions or missing exceptions require inference.
- `blocking`: no supported way to complete the applicable workflow.

A local conflict does not make every document unusable. A special-case procedure may
resolve a general rule; explain any remaining ambiguity. Keep static findings apart
from observed behavioral failures. Do not average severities into a score.

## Comparisons and keep/revert decisions

Evaluate matched pairs per implementer and scenario; never pool models or unrelated
scenarios. Baseline screens have no improvement verdict. Comparisons require at least
three valid repetitions on both sides, identical conditions, complete grading, and
the full broad set. Missing evidence means inconclusive. If repeats are desired,
plan a fresh matched session within an explicitly remaining budget; failed attempts
still consume calls. These heuristics are practical thresholds, not significance tests.

A measurable change requires one of:

- Pass/recovery rate changes by at least 2 of 3 repetitions, or at least 1 when
  one variant passed/failed every run with at least 5 repetitions.
- A count metric's per-run occurrence changes by that threshold. A newly observed
  violation kind is real after two runs; do not compare summed errors from one outlier.
- Median tools/tokens/time changes >10%, with non-overlapping interquartile ranges
  (linear interpolation, percentile position `(n-1)*p`). Compare matched successful
  runs with equivalent acceptance coverage; skipped work is never an efficiency win.
- Median subjective score changes by at least one point with cited evidence. A static
  clarity improvement alone requires independent review of the changed documents.
- Byte size changes, measured exactly. A resolved consistency finding is an instruction
  improvement only after independent confirmation; no severity arithmetic.

Apply in this order:

1. **Revert** a real regression in success, agent compliance, recovery, artifact
   quality/readability, or review-response accuracy; a new unrecovered CLI error;
   a new blocking consistency finding; or a failing deterministic suite. Any observed work loss or remote-operation
   violation blocks keeping until investigated, even before repetition thresholds.
2. **Inconclusive** if coverage, attribution, or grading is unresolved. Restore only
   candidate-owned edits when ending the session without adequate evidence.
3. **Revert** when the primary metric has no demonstrated improvement. Byte reduction
   counts only with all other gates neutral; static quality counts only for an
   explicitly instruction-focused comparison.
4. **Revert** a >10% efficiency regression or >5% growth in a changed instruction
   file unless success, compliance, recovery, or unnecessary stops improve on that
   implementer. Never trade one model's safety/task gate for another's improvement.
5. **Keep** otherwise, recording the evidence and limits. Reuse matching full broad
   runs as the final check; never exceed a budget to perform an extra final check.
