# Metrics and decision rules

Score every run on the objective metrics. Score subjective metrics on every
run whose output a human would read, such as feedback replies, questions, and
reports. Score instruction-quality metrics once per variant. Mark a metric
`not measured` when the harness cannot supply it; never estimate it.

## Objective metrics

| ID | Metric | Measurement | Better |
| --- | --- | --- | --- |
| `success` | Task success | All of the scenario card's pass checks hold (1) or not (0). Report the pass rate per scenario and model. | Higher |
| `compliance` | Workflow rule violations | Count of the card's violation checks seen in the transcript or repository. The defaults are listed below. | Lower |
| `cli` | CLI usage | Invocations rejected by the CLI for wrong syntax, arguments, or enum values, and whether each was recovered without user help. | Fewer rejected, all recovered |
| `prompts` | Unnecessary prompts | Questions to the user that the card does not expect, plus requests to approve internal mechanics. Harness permission prompts count when the skill caused them, for example through an avoidable compound or destructive command. | Lower |
| `recovery` | Recovery success | For injected failures: the agent reached the card's recovered state without losing work or asking the user (1) or not (0). | Higher |
| `tools` | Tool calls | Total tool invocations in the run. | Lower |
| `tokens` | Token usage | Input, cached input, and output tokens from the harness, recorded separately. Compare uncached input plus output. | Lower |
| `time` | Elapsed time | Wall-clock seconds from the request to the final answer. | Lower |
| `instructions` | Instruction bytes | UTF-8 bytes of the skill files read in the run. For prescribed paths, `npm run benchmark --prefix scripts` reports `instructionBytes`. | Lower |

Default violation checks, extended by each card:

- hand-editing `.semantic-review/` metadata or feedback files instead of using
  the CLI
- asking the user to approve CLI invocations, restacking, temporary branches,
  guarded ref updates, or artifact repair
- skipping a required validation, or claiming success after a failed one
- overwriting, dropping, or force-moving work the agent did not create
- remote operations, or writes outside the disposable repository and review home
- choosing a behavior when the card expects the user to decide
- loading `commands/report.md` resources for a non-reporting command

## Subjective metrics

A grader scores each metric from 1 to 5 using the anchors below. The grader is
an independent agent in a fresh context, or the maintainer. Graders see
outputs labelled A and B in random order, never which one is the candidate.
Use the same grader model and prompt for a whole session. Record a one-line
justification with each score.

| ID | Metric | 1 | 3 | 5 |
| --- | --- | --- | --- | --- |
| `clarity` | Instruction clarity (graded on the changed files) | Steps can be read in more than one way, or depend on unstated context. | One reading is clear, but the reader must infer an order or condition. | Each step has one reading, states its preconditions, and names its outputs. |
| `consistency` | Consistency | Contradicts another command, a shared doc, or the glossary in AGENTS.md. | Consistent, but with differing terms or duplicated rules that could drift apart. | Uses glossary terms, and states each rule once and references it elsewhere. |
| `followability` | Ease of following (graded on the transcript) | The agent rereads, backtracks, or follows a wrong path because of the instructions. | Minor hesitation or a redundant read. | The agent proceeds directly through the prescribed path. |
| `responses` | Quality of review responses and questions | Inaccurate, claims unverified completion, or asks about mechanics. | Accurate but vague, verbose, or missing what changed. | Accurate, specific about what changed and why, and concise. A question names the actual decision in plain language. |
| `maintainability` | Maintainability of the edit (graded on the diff) | Adds duplication, special cases, or wording that tests or other files must mirror. | Neutral. | Removes duplication or ambiguity, and stays local. |

Before a session, calibrate the grader on two or three outputs from earlier
runs, and adjust the grader prompt until its scores match the anchors.

## Variability

Agent runs are stochastic. Use the same fixture, request text, model ID,
harness version, effort setting, permissions, and fresh context for both
variants. Run at least three repetitions. Treat a difference as real only when:

- a pass rate changes by at least two runs out of the repetitions run, or by one
  run when the other variant passed or failed every run at five or more
  repetitions,
- a median count or duration (`tools`, `tokens`, `time`) changes by more than
  10% and the interquartile ranges of the two variants do not overlap, or
- a median subjective score changes by at least one point.

When a result is borderline, add repetitions to both variants, up to five
unless the user agreed on a different cap. Report pass counts such as `2/3`
instead of percentages.

## Decision rules

Evaluate per model, in this order. The first rule that applies decides.

1. **Hard gates (revert).** Any real regression on any model in `success`,
   `compliance`, or `recovery`, a new unrecovered `cli` failure, or a failing
   deterministic test.
2. **No effect (revert).** No real improvement on the metrics the focus targets
   on any model. A smaller or clearer edit with neutral metrics may be kept only
   when the focus is `clarity` or `maintainability` and the subjective gain is
   real.
3. **Efficiency tradeoff.** If the focus metric improves but `tokens`, `time`,
   or `tools` regress by more than 10% on a model, keep the change only when it
   improves `success`, `compliance`, `recovery`, or `prompts` on that model.
   Otherwise revert or try a variant that costs less.
4. **Cross-model tradeoff.** If one model improves and another regresses on a
   non-gate metric, keep the change only when the regression is within noise.
   Otherwise look for a model-neutral variant. Never trade one model's gate
   metric for another model's gain.
5. **Keep.** Otherwise the change is kept.

Use subjective metrics as a gate only for subjective focuses, and as the
tiebreaker between otherwise equal variants. A drop of one point or more in
`responses` counts as a regression when the scenario produces review responses.
