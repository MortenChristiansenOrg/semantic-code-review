---
name: refine-semantic-flow
description: Use when invoked by the user. The command must be invoked explicitly, not just as a prose reference to refining Semantic Flow.
---

# Refine Semantic Flow

Improve `skills/semantic-flow/` by hill climbing: measure a baseline, make one
focused edit, evaluate it under the same conditions, keep improvements, revert
regressions, and repeat. This is a maintainer tool. It lives outside
`skills/semantic-flow/`, so builds and release archives never include it.

Never run Semantic Flow on this repository. Evaluated agents work only in
disposable repositories with a copied built skill, a private
`SEMANTIC_FLOW_HOME`, and no remote operations.

## Resources

- [Metrics and decision rules](references/metrics.md): what to measure, how to
  score it, and how to judge conflicting results.
- [Scenarios](references/scenarios.md): scenario cards, the focus catalog,
  the broad regression set, and reusable fixtures.
- [Records](references/records.md): the run workspace, result rows, and the
  candidate log.

## 1. Agree on the session

Settle these with the user before spending budget. Propose defaults rather than
asking open questions.

- **Focus**: a command (`feedback`, `implement`, …), a section of a file, or an
  aspect across files (recovery, artifact quality, instruction clarity, skill
  size, efficiency, review responses, user questions). Note which metrics it
  targets.
- **Models**: at least two that users actually run Semantic Flow with, ideally
  from different vendors or capability tiers. Record exact model IDs,
  harness, harness version, and reasoning or effort settings.
- **Scenarios**: focus scenarios plus the broad regression set from
  [scenarios](references/scenarios.md). Add new cards when the focus lacks
  coverage.
- **Budget**: maximum candidates (default 5), maximum evaluated runs or spend,
  and wall-clock limit. Repetitions default to 3 per scenario, model, and
  variant.
- **Target** (optional): a concrete goal, such as "feedback scenarios pass 3/3
  on every model" or "median tokens down 15% with no success regression".

Work on a branch from the target branch. Create the run workspace described in
[records](references/records.md) and record the agreed conditions before any
evaluation.

## 2. Establish the baseline

1. Run `npm test --prefix scripts` and `npm run build --prefix scripts`. A red
   deterministic suite must be fixed or excluded from the session first.
2. Copy the built `skills/semantic-flow/` outside the source checkout as the
   baseline installation for this session.
3. Run every selected scenario for every model and repetition, each in a fresh
   agent context. Capture the transcript and the telemetry listed in
   [metrics](references/metrics.md).
4. Score the runs and write result rows. Summarize per model and per
   scenario; never collapse models into one number.

The baseline is the reference for the first candidate. After a candidate is
kept, its results become the new baseline.

## 3. Propose one candidate

Choose a single hypothesis from observed evidence: failed checks, confusion in
transcripts, unnecessary questions, wasted tool calls, or reread instructions.
State in the log what changes, why, and which metric should move. Do not
combine independent ideas; a mixed candidate cannot be attributed.

Prefer edits that remove ambiguity or duplication over edits that add text.
Follow the existing skill conventions and [AGENTS.md](../../../AGENTS.md).
Do not tailor instructions to one model or harness unless the skill already
has a dedicated place for that variation.

## 4. Evaluate the candidate

1. Edit the source skill, then run `npm test --prefix scripts` and rebuild. A
   failing deterministic test either reverts the candidate or is fixed as part
   of the same hypothesis when the test asserts outdated wording.
2. Copy the built skill to a new candidate installation.
3. Run the same scenarios, models, and repetitions with the same settings.
   Interleave baseline and candidate runs, or rerun the baseline when the
   model, harness, or fixture changed since it was measured.
4. Score the runs. Give subjective graders the A/B outputs without saying which
   is the candidate.

## 5. Decide

Apply the decision rules in [metrics](references/metrics.md). Results are
**keep**, **revert**, or **inconclusive**. When the evidence is borderline, add
repetitions up to the agreed cap before deciding. If it is still inconclusive,
revert: an unproven change is not an improvement.

- **Keep**: commit the source change and rebuilt outputs as one commit whose
  message names the candidate ID. The candidate installation becomes the
  baseline.
- **Revert**: restore the source and built files to the last kept commit.

Record the decision, the scores, and any per-model tradeoff before starting
the next candidate.

## 6. Check broader workflows

The focus scenarios can improve while other workflows degrade. Run the broad
regression set against the current baseline and the session's original
baseline:

- after every second kept candidate,
- whenever a kept edit touches a shared file (`SKILL.md`, `docs/runtime.md`,
  `docs/user-decisions.md`, or a file other commands require), and
- before finishing.

A regression there reverts the responsible candidate, or the most recent one
when no single candidate can be identified. Then rerun the check.

## 7. Stop and report

Stop when any of these holds:

- the budget is exhausted,
- the target is met on every selected model,
- three consecutive candidates were reverted or inconclusive,
- no evidence-based hypothesis remains, or
- the user stops the session.

Run the final broad regression check. Report to the user per model:
baseline against final results for each metric, the kept candidates with
their rationale, the reverted candidates and what they showed, unresolved
tradeoffs, and the remaining hypotheses. Keep the run workspace; offer to
remove the disposable repositories, review homes, and copied installations.
Open a pull request only if the user asks for one.
