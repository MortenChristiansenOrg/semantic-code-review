# Scenarios

A scenario is a reproducible task given to an agent in a fresh context. Reuse
existing fixtures and documented evaluations; add cards here when a focus has
no coverage.

## Running a scenario

1. Create the fixture in a fresh temporary directory, outside this checkout. Use
   a fresh `SEMANTIC_FLOW_HOME` for each run.
2. Start an independent agent with the selected model in non-interactive mode,
   for example `claude -p` or `codex exec`. Check the installed harness's
   `--help` for the model, permission, and machine-readable transcript flags.
   Give it only the card's request, the copied skill path, the fixture path,
   the review home, and the isolation limits: no remote operations and no writes
   outside the fixture and review home.
3. Never give the agent the expected outcome, the pass checks, or earlier
   conclusions.
4. If the agent asks a question, answer only with the card's scripted reply. If
   no reply is scripted, the evaluated agent records the exact question and
   stops dependent work. The question is scored, never forwarded to a real
   user.
5. Keep the transcript, then check the repository, artifact, and feedback
   state against the card.

## Card format

```markdown
### <scenario-id>

- Focus: <commands and aspects covered>
- Fixture: <setup command or steps>
- Request: <exact user message>
- Scripted replies: <question pattern → reply, or none>
- Pass checks: <observable conditions, all required>
- Violation checks: <additions to the default list>
- Expected questions: <decisions the agent should raise, or none>
```

## Catalog

| ID | Focus | Source |
| --- | --- | --- |
| `feedback-compatible` | feedback, conflict recovery, prompts | [Feedback recovery evaluation](../../../../skills/semantic-flow/docs/feedback-recovery-evaluation.md) (compatible fixture from `scripts/evaluations/feedback-recovery.mjs`) |
| `feedback-conflicting-intent` | feedback, user questions | Same evaluation, ambiguous fixture |
| `feedback-concurrent-move` | sync safety guards | Same evaluation, safety control (needs a harness that can pause tools) |
| `cli-recovery-category` | implement, CLI recovery | [CLI recovery evaluation](../../../../skills/semantic-flow/docs/cli-recovery-evaluation.md): unsupported decision category |
| `cli-recovery-kind-argument` | implement, CLI recovery | Same evaluation: unsupported insight kind and missing argument |
| `cli-recovery-boundary` | user questions | Same evaluation: conflicting criteria or unrelated user edits |
| `report-scenarios` | report | [Report validation](../../../../docs/semantic-flow-report-validation.md) simulated checks |
| `implement-small` | implement, staging, artifact quality | Card below |
| `status-help` | status, help, routing | Card below |

For fixture building blocks, see `createRepository`, `initializeImplementation`,
`beginStage`, `finalizeStage`, and `repository.feedback` in
`scripts/tests/helpers/repository.mjs`, as used by the feedback evaluation
script. Importing the helper points `SEMANTIC_FLOW_HOME` at a temporary home
that is deleted on exit. Override it after the import, as that script does, and
pass `{ after() {} }` to `createRepository` so the repositories outlive the
script.
`examples/order-cancellation/` is a complete artifact for read-only scenarios.

### implement-small

- Focus: implement, stage organization, insight capture, efficiency
- Fixture: a new Git repository with `main` and a small module, for example a
  `prices.js` that exports `total(items)` and has a test.
- Request: `/semantic-flow implement Add a percentage discount parameter to total() that rejects values outside 0–100, with tests.`
- Scripted replies: none
- Pass checks: the stage stack and publication validate; the final head passes
  the module's tests; every changed file belongs to a change node; at least one
  insight or validation-evidence entry is linked to nodes.
- Violation checks: defaults
- Expected questions: none

### status-help

- Focus: status, help, routing, instruction bytes
- Fixture: the result of `implement-small`, or a feedback fixture.
- Request: `/semantic-flow status`, then in a fresh run `/semantic-flow help feedback`
- Scripted replies: none
- Pass checks: status reports the stages and their state without mutating refs,
  the artifact, or feedback; help explains feedback without running it.
- Violation checks: any mutation; reading command files unrelated to the request
- Expected questions: none

## Broad regression set

Run this set as described in the skill's broader workflows step:
`feedback-compatible`, `feedback-conflicting-intent`, `cli-recovery-category`,
`implement-small`, and `status-help`. Add the focus scenarios of earlier
sessions when they cover workflows touched by kept edits.

Periodic checks during a session may screen with one repetition per model. A
screening run that differs from the original baseline is extended to the full
repetition count before deciding. A matching screening run only defers the
decision: it never establishes that there is no regression. The final check
before finishing runs the full repetition count for both variants and applies
the variability rules in [metrics](metrics.md).
