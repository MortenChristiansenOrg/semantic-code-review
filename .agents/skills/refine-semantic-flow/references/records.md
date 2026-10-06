# Records

Keep each session in `.refinement/<YYYY-MM-DD>-<focus>/` at the repository
root. The directory is gitignored. Store transcripts and bulky outputs there,
never in commits. Commits record kept candidates. The log keeps every decision.

```text
.refinement/2026-10-06-feedback/
  session.md        conditions, budget, and the candidate log
  results.jsonl     one row per scenario run
  installs/         copied skill per variant (baseline-0, c1, …)
  transcripts/      <variant>/<model>/<scenario>-<repetition>.jsonl
```

## session.md

```markdown
# Refinement: <focus>

## Conditions
- Focus: <command/section/aspect>; targeted metrics: <ids>
- Target branch and start commit: <branch> <sha>
- Models: <exact model id> via <harness> <version>, effort <setting>; …
- Grader: <model or maintainer>, prompt: <path or inline>
- Scenarios: focus <ids>; broad <ids>
- Repetitions: <default>/<cap>; budget: <candidates>, <runs or spend>, <time>
- Target: <optional>

## Baseline-0
<per-model table: scenario, success x/n, compliance, prompts, median tools/tokens/time, subjective medians>

## C1: <short title>
- Hypothesis and rationale: <evidence from runs → expected metric change>
- Change: <files and summary>; commit <sha if kept>
- Conditions: <same as baseline, or what differs and why>
- Results: <per-model comparison against the current baseline>
- Decision: keep | revert | inconclusive (reverted); rule <number from metrics.md>
- Tradeoffs: <per-model notes, or none>

## Broad check after C<n>
<per-model comparison against the current and original baselines; action taken>

## Final report
<as described in the skill's stop step>
```

## results.jsonl

One JSON object per run. Use `null` for metrics that were not measured. List
each violation check that failed in `violations`, by a short stable name such as
`hand-edited-metadata`, so that `compliance` decisions can be reproduced.

```json
{"variant":"c1","model":"<id>","harness":"<name version>","scenario":"feedback-compatible","repetition":2,
 "success":1,"compliance":0,"violations":[],"cliRejected":1,"cliUnrecovered":0,"prompts":0,"recovery":null,
 "tools":41,"tokens":{"input":18000,"cachedInput":160000,"output":5200},"seconds":312,"instructionBytes":null,
 "subjective":{"followability":4,"responses":5},"notes":"retried enum once after reading API.d.ts",
 "transcript":"transcripts/c1/<id>/feedback-compatible-2.jsonl"}
```
