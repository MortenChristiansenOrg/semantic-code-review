# Metrics and decision rules

Score every run on the objective metrics. Score artifact metrics on every run
that creates or revises an implementation artifact. Score text metrics on every
run whose output a human would read, such as stage and node descriptions,
insights, feedback replies, questions, and reports. Score instruction metrics
once per variant. Mark a metric `not measured` when the harness cannot supply
it; never estimate it.

## Objective metrics

| ID | Metric | Measurement | Better |
| --- | --- | --- | --- |
| `success` | Task success | All of the scenario card's pass checks hold (1) or not (0). Report the pass rate per scenario and model. | Higher |
| `compliance` | Workflow rule violations | Count of the card's violation checks seen in the transcript or repository. The defaults are listed below. | Lower |
| `cli` | CLI usage | Invocations rejected by the CLI for wrong syntax, arguments, or enum values, and whether each was recovered without user help. | Fewer rejected, all recovered |
| `prompts` | Unnecessary stops | Times the agent stopped to ask the user something or ended the run unfinished while waiting for input. Two kinds of stop are exempt: a critical technical problem with the CLI that the prescribed recovery cannot resolve (for example a crash, a missing runtime, or a repeated internal error), and a decision the card lists as expected. Requests to approve internal mechanics always count. In non-interactive runs, a stop shows as a question in the transcript or a final answer that awaits input. Harness permission prompts or denials count when the transcript records them and the skill caused them, for example through an avoidable compound or destructive command. | Lower |
| `recovery` | Recovery success | For injected failures: the agent reached the card's recovered state without losing work or asking the user (1) or not (0). | Higher |
| `tools` | Tool calls | Total tool invocations in the run. | Lower |
| `tokens` | Token usage | Input, cached input, and output tokens from the harness, recorded separately. Compare uncached input plus output. | Lower |
| `time` | Elapsed time | Wall-clock seconds from the request to the final answer. | Lower |
| `size` | Skill size | Per variant: UTF-8 bytes of each instruction file in the built skill (`SKILL.md`, `commands/`, `docs/`, and the Markdown files in `references/`), and their total. Per run: bytes of the skill files the agent read. For prescribed paths, `npm run benchmark --prefix scripts` reports `instructionBytes`. Report per-file changes, not just the total. | Lower |

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

### Instruction metrics

Grade these on the skill itself. At the baseline, grade every instruction
file. For a candidate, regrade the files it changed and the files that
reference them.

| ID | Metric | 1 | 3 | 5 |
| --- | --- | --- | --- | --- |
| `clarity` | Clarity and understandability, graded and reported per document | Steps can be read in more than one way, depend on unstated context, or a developer new to the skill cannot tell what the document is for. | One reading is clear, but the reader must infer an order, a condition, or a term. | The purpose is evident, each step has one reading, and preconditions and outputs are stated. |
| `consistency` | Consistency | Contradicts another command, a shared doc, or the glossary in AGENTS.md. | Consistent, but with differing terms or duplicated rules that could drift apart. | Uses glossary terms, and states each rule once and references it elsewhere. |
| `maintainability` | Maintainability of the edit (graded on the diff) | Adds duplication, special cases, or wording that tests or other files must mirror. | Neutral. | Removes duplication or ambiguity, and stays local. |

### Artifact metrics

Grade these on the implementation artifact and the stage diffs the run
produced.

| ID | Metric | 1 | 3 | 5 |
| --- | --- | --- | --- | --- |
| `organization` | Grouping of stages and nodes | Stages or nodes mix unrelated changes, or one unit is too large to review in one sitting. | Grouping is coherent, but some unit combines changes that could be reviewed separately, or splits one change across units. | Each stage can be validated on its own, each node is one logical change, and no unit is larger than it needs to be. |
| `insights` | Insight selection and code ranges | Significant decisions, assumptions, or risks visible in the transcript or diff are missing, or recorded insights are noise. | The important insights are present, but some are vague, of the wrong kind, or lack a code range where one clearly applies. | The insights a reviewer needs are present, each has the right kind and links to the right nodes, and code-specific insights name a precise range. |
| `traceability` | Links from acceptance criteria to targets | Criteria are unlinked or linked to unrelated stages or nodes. | Every criterion is linked, but some links are too broad, such as a whole stage where one node applies, or miss a target. | Each criterion links to exactly the stages and nodes that implement and validate it. |

### Text metrics

Grade these on the text the agent wrote for people: stage and node
descriptions, insights, feedback replies, questions, and the final answer.

| ID | Metric | 1 | 3 | 5 |
| --- | --- | --- | --- | --- |
| `readability` | Ease of following for a developer outside the project | Needs project or skill jargon, or knowledge that is not common among developers, to understand. Sentences are dense or ambiguous. | Understandable, but some terms or references are left unexplained or the wording is heavier than needed. | Plain wording, terms explained or common, and nothing relies on knowledge the reader is unlikely to have. |
| `responses` | Accuracy of review replies and questions | Inaccurate, claims unverified completion, or asks about mechanics. | Accurate, but misses what changed or why, or the question is not the real decision. | Accurate and complete about what changed and why. A question names the actual decision. |

### Transcript metrics

| ID | Metric | 1 | 3 | 5 |
| --- | --- | --- | --- | --- |
| `followability` | Ease of following the instructions | The agent rereads, backtracks, or follows a wrong path because of the instructions. | Minor hesitation or a redundant read. | The agent proceeds directly through the prescribed path. |

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
  10% and the interquartile ranges of the two variants do not overlap,
- a median subjective score changes by at least one point,
- `size` changes at all, because it is measured, not sampled, or
- for the counts `compliance`, `prompts`, and rejected `cli` invocations, the
  number of runs with at least one occurrence changes by the pass-rate
  threshold above. Compare per-run occurrence rather than totals, so that one
  run with many repeats cannot outweigh the others. A violation of a kind the
  other variant never showed is real once it occurs in two runs.

When a result is borderline, add repetitions to both variants, up to five
unless the user agreed on a different cap. Report pass counts such as `2/3`
instead of percentages.

## Decision rules

Evaluate per model, in this order. The first rule that applies decides.

1. **Hard gates (revert).** Any real regression on any model in `success`,
   `compliance`, or `recovery`, a new unrecovered `cli` failure, or a failing
   deterministic test.
2. **No effect (revert).** No real improvement on the metrics the focus targets
   on any model. A reduction in `size` with all other metrics neutral counts as
   an improvement, because a smaller skill is better. A clearer edit with
   neutral metrics may be kept only when the focus is an instruction metric and
   the subjective gain is real.
3. **Efficiency tradeoff.** If the focus metric improves but `tokens`, `time`,
   or `tools` regress by more than 10% on a model, or the skill grows by more
   than 5% in a changed file, keep the change only when it improves `success`,
   `compliance`, `recovery`, or `prompts` on that model. Otherwise revert or
   try a variant that costs less.
4. **Cross-model tradeoff.** If one model improves and another regresses on a
   non-gate metric, keep the change only when the regression is within noise.
   Otherwise look for a model-neutral variant. Never trade one model's gate
   metric for another model's gain.
5. **Keep.** Otherwise the change is kept.

Use subjective metrics as a gate only for subjective focuses, and as the
tiebreaker between otherwise equal variants. Two exceptions apply. A drop of
one point or more in `organization`, `insights`, `traceability`, or
`readability` counts as a regression when the run produces an artifact. The
same drop in `responses` counts as a regression when the run produces review
replies.
