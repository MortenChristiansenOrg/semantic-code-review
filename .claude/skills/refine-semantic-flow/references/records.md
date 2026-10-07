# Records and reporting

Keep sessions under the gitignored `.refinement/<date>-<focus>/` directory. The
maintained harness produces these files; do not hand-write a competing result format:

```text
session.json             config, expanded jobs, versions, source state, hashes, workspace
preflight/               model-free harness capability results and diagnostics
rubric/                  frozen metrics, grader prompt, and operating guidance
runs/<job>/fixture.json   exact repository, initial state, request
runs/<job>/prompt.txt     exact prompt
runs/<job>/result.json    attempt status, command, timing and telemetry
runs/<job>/transcript.jsonl  raw stdout (plain text for text adapters)
runs/<job>/stderr.log     harness diagnostics
runs/<job>/checks.json    deterministic checks plus evidence
runs/<grader>/grades.json   validated judgments, reasons and attributions
runs/<grader>/output-schema.json  exact generated output contract
exclusions/<run>.json    immutable operator annotations; raw evidence remains intact
blind-map.json           operator-only variant mapping
results.jsonl            one row for every planned evaluation, including omissions
report.md                generated metric tables and limitations
```

The disposable workspace, whose path and ownership ID are in session.json, contains
copied installations, case repositories/worktrees/caches/review homes, and normalized
grader packets. Keep it with the records until cleanup is authorized. Harness secrets
and authentication files are never copied into fixtures or packets.

Result `state` is `scored`, `invalid`, `unscored`, or `not-run`. `success` is 1/0 only
when deterministic and required transcript checks are complete and not excluded.
`fixedChecksPassed` reports the independent checks separately; it does
not imply full success or cancel an infrastructure exclusion. Null telemetry means
not measured; null subjective scores need applicability reasons in grades.json.
New sessions pin their integer 1–10 subjective scale in
`session.json` under `rubric.subjectiveScale`; historical sessions without that
metadata retain their 1–5 labels and raw grades. Objective binary checks and count
metrics keep their existing units.
Record all three token fields; `input` excludes cached input. `violations` retains
stable IDs, evidence and agent/infrastructure/uncertain attribution. The compliance
count contains agent-attributable occurrences only. Do not infer absent violations
from a missing transcript or grade.

Append an operator conclusion to report.md or a separate `decision.md` after inspecting
the evidence. Include:

- Mode, scope, models/roles, actual calls and elapsed time against budget.
- Per implementer/scenario: pass / valid / planned counts, invalid/omitted runs,
  recovery, errors/stops, and measured efficiency with its tool-count definition.
- Applicable subjective metrics, per-document clarity and size, and localized
  consistency findings with severity and affected workflows. No overall quality score.
- Evidence corrections, infrastructure contributions, calibration type and limits.
- Baseline mode: strongest observations and next hypotheses; no improvement verdict.
- Comparison mode: primary hypothesis, matched conditions, all gates, per-file size
  changes, broad coverage and keep/revert/inconclusive rationale. Keep the original
  baseline and every rejected result. An unproven candidate is not an improvement.

A kept candidate's commit names its ID. Bulky outputs remain uncommitted. Preserve
unrelated source changes on revert; do not reset the whole checkout. A fix to the
runner or rubric is a separate hypothesis and invalidates affected comparisons.

Do not rewrite the first evaluation's historical scores using a new rubric without
labeling the regrade, preserving the originals and budgeting the new grader calls.
