---
name: refine-semantic-flow
description: Use when invoked by the user. The command must be invoked explicitly, not just as a prose reference to refining Semantic Flow.
---

# Refine Semantic Flow

Evaluate the built Semantic Flow skill in disposable repositories. Use **baseline**
mode to establish how it behaves; use **compare** mode to test one evidence-based
instruction change. Model behavior is stochastic; make preparation, checks, and
records reproducible rather than promising deterministic model outputs.

This is a repository-local maintainer skill. Never implement work with Semantic
Flow in this source repository. Evaluation installations, application repositories,
worktrees, caches, and private review homes belong in the owned temporary workspace.
No remote repository operations or live deployments are part of evaluation.

For realistic project scenarios, the default test project is
`/home/morten/code/chat-app` (Windows:
`\\wsl.localhost\Ubuntu\home\morten\code\chat-app`), which exists for this purpose.
Use another project when the user specifies it. Pin a committed source revision
and evaluate fresh disposable copies with the custom adapter described in
[harness.md](references/harness.md#custom-project-scenarios); preserve the original
checkout, local changes, configuration and secrets. Keep the built-in fixtures as
the broad workflow controls. This maintainer skill is shared by Codex and Claude
through `.agents/skills/` and `.claude/skills/` respectively.

## Choose the session

Reuse the user's choices and authorization. Ask only for missing information that
materially affects cost or scope; do not reconfirm an already settled budget.
When the user delegates specifics, propose these defaults and proceed within their
limits:

- **Mode:** baseline for first use, a health check, or a quick evaluation. It makes
  no candidate edits. Compare only when improvement work is requested.
- **Models:** one explicitly identified implementer and a separate fresh grader,
  with exact model IDs and effort. A grader is not a second implementer. Add more
  implementer models when the user wants cross-model evidence; report them separately.
- **Baseline scope:** the six built-in scenarios, three repetitions of
  `implement-small` and one of each other scenario. This is eight evaluated runs
  plus four grading contexts, within a default 45-minute / 12-call ceiling.
  User project scenarios can replace or extend that plan within the budget.
- **Compare scope:** one candidate at a time, three repetitions per scenario,
  including the full broad set for both variants. A one-model comparison needs
  at least 36 evaluated runs plus grading. Budget before editing or launching.
- **Metrics:** all applicable metrics by default. Null values require reasons;
  unavailable measurements and metrics irrelevant to the mode are not failures.

Read [harness.md](references/harness.md) to configure and run the maintained helper.
Use [scenarios.md](references/scenarios.md) for scenario contracts and custom project
acceptance checks, and [metrics.md](references/metrics.md) for scoring and decisions.
Do not invent a replacement runner inside a session directory.

## Establish a baseline

1. Inspect the source branch and changes. Preserve unrelated work. Use an existing
   appropriate working branch or create an evaluation branch; a baseline alone
   does not require source changes or commits.
2. Run `npm test --prefix scripts` (which builds the skill). A failure blocks model
   evaluation until fixed or explicitly excluded with a reason. Do not rebuild
   again without changed inputs.
3. Copy the sample config from `assets/baseline.json`, set model IDs and paths, and
   run the helper's `plan`. It counts every implementer and grader call. Reduce
   scope when necessary; do not quietly reduce repetitions in a comparison.
4. Run `prepare` into a new `.refinement/<date>-<focus>/` directory. It checks
   prerequisites and harness capabilities, freezes installation hashes, records
   harness versions, creates fresh fixtures, and pins the rubric before any model call. Investigate setup
   failures as evaluator failures; do not give their expected outcomes to agents.
5. Run `run`, `verify`, `grade`, and `report`. Evaluated agents receive only the
   task, installation, fixture, available capabilities, and isolation rules.
   Questions stay in their transcript; the built-in cards have no scripted replies.
   Grade only completed, valid evidence in fresh contexts. Inspect failing checks
   and grader findings before reporting. Never fix evaluated output to make it pass.
   If runs must remain unattempted, verify existing attempts and use `grade --partial`;
   it records the omission and permanently closes further evaluations in that session.
6. Report the baseline using [records.md](references/records.md). Stop here in
   baseline mode. Retain artifacts and offer cleanup; do not start hill climbing.

If a harness, adapter, fixture, acceptance check, or rubric is wrong, preserve the
original evidence and classify affected results as invalid or superseded. Document
any read-only verification correction and use the helper’s `invalidate` command
for an evidence-based exclusion; when it could affect agent behavior or A/B
comparability, start a fresh matched session. Do not count environment failures as
skill regressions or silently retry failed model calls.

## Compare one candidate

Record a hypothesis tied to observed evidence and a primary metric. Change only
that hypothesis in `skills/semantic-flow/`; follow repository instructions. Preserve
an immutable original baseline installation. Test and build the candidate, then
prepare a comparison using the same fixtures, prompts, models, effort, capabilities,
permissions, rubric, and check versions. Do not reuse old behavioral runs when these
conditions changed. The runner alternates variant order and hides variant identities
from graders; it does not supply the hypothesis or earlier scores.

The comparison includes the full broad set at full repetitions. These runs also
serve as the final broader-workflow check; do not rerun unchanged checks merely to
satisfy a second heading. Screens may help select a hypothesis but cannot establish
an improvement or absence of regression.

Apply [the decision rules](references/metrics.md) per implementer and scenario.
Keep only an evidenced improvement with satisfied gates and sufficient coverage.
Commit a kept source change and rebuilt outputs together, naming the candidate ID.
For a rejected or inconclusive candidate, restore only the changes owned by that
candidate, preserving user edits. Record every decision and attribution.

For another candidate, the last kept installation becomes the baseline. Retain the
session's original installation and compare it again whenever accumulated changes
need an end-to-end check. Reuse existing matched evidence where valid. Stop at the
user's budget, target, three consecutive unsuccessful candidates, or no supported
hypothesis. Budget exhaustion does not authorize a final extra run: report missing
coverage and leave the candidate unproven. Open a PR only when requested.
