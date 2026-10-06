# Evaluation harness

Run from the repository root with Node 20+ and Git. The maintained entrypoint is
`node scripts/evaluations/refine.mjs`. It is not included in the distributed skill.
No package installation or remote operation is needed for the built-in fixtures.

## First baseline

1. Run `npm test --prefix scripts`. This includes the build and harness tests.
2. Copy `assets/baseline.json` from this skill to a working config file. Set the
   exact implementer/grader models and effort; make `variants[].skill` an absolute
   path to the built `skills/semantic-flow/`. Relative paths resolve from the config
   file, not the current directory. The sample is already runnable in its original
   location with the model choices used in the first evaluation.
3. Run these commands, substituting the config and a new session directory:

   ```text
   node scripts/evaluations/refine.mjs plan <config.json>
   node scripts/evaluations/refine.mjs prepare <config.json> .refinement/<date>-<focus>
   node scripts/evaluations/refine.mjs run .refinement/<date>-<focus>
   node scripts/evaluations/refine.mjs verify .refinement/<date>-<focus>
   node scripts/evaluations/refine.mjs grade .refinement/<date>-<focus>
   node scripts/evaluations/refine.mjs report .refinement/<date>-<focus>
   ```

Only `run` and `grade` launch models. Invalid model or grader output makes those
commands exit nonzero after saving the attempt; diagnostics distinguish missing,
unexpected and duplicate check IDs. A later invocation may run still-unattempted
planned jobs, but never retries invalid ones or erases their failure status.
`prepare` creates every fixture and freezes copies of the built installations, adapters and rubric. It fails before spending
model budget if a prerequisite or fixture is broken. Inspect `session.json` for
exact versions, source state, installation hashes and the temporary workspace.
Prepared source snapshots never copy an active installation back into the source.

The default plan is eight evaluated runs and four grader contexts: 12 calls total.
An evaluated repetition and a fresh grader context each consume one call. Prompts
are non-interactive; no automatic continuation or retry is hidden in the budget.
The runner works sequentially so tool/resource contention does not vary between
variants. The wall deadline starts at preparation; `grading.reserveMinutes` prevents
launching another evaluated run when grading time is running out. Individual calls
are capped by `budget.runMinutes` and the remaining wall deadline.

Re-running `run`, `verify`, `grade`, or `report` reuses existing records. It does not
retry a failed call or recheck unchanged results. Interrupted/failed calls consume
budget and remain visible. After fixing apparatus problems, prepare a new session
with a separately accounted remaining budget. Do not edit session state to buy calls.
If stopped midway, `verify` and `report` still expose missing/invalid evidence.

## Config contract

The sample shows every required field. `mode` is `baseline` (one variant) or
`compare` (two variants). A comparison requires the full six-scenario broad set and
at least three repetitions per variant/model. A one-model comparison with batch size
3 and instruction grading plans 36 evaluated runs and 7 graders, totaling 43 calls.
Add a second implementer only when the budget and desired claim justify it.

`implementers` and `grader` use the same adapter fields:

- `id`: unique lowercase letters/digits/hyphens; `model` and `effort`: exact strings.
- `command`: executable and argument array, never a shell string. The prompt arrives
  on stdin. Supported substitutions are `{model}`, `{effort}`, `{repo}`, `{case}`,
  `{output}`, and `{schema}` (the generated grader JSON Schema). Do not add an interactive approval flag.
- `versionCommand`: executable/argument array that reports the harness version.
- `preflight`: `codex-sandbox` for the supplied Codex workspace-write profile. Before
  model calls it probes Node subprocess input/EOF, filesystem writes, and (for
  implementers) commits and linked worktrees in a disposable repository. Raw
  outcomes are recorded under `preflight/`. Other adapters may omit it or use
  `none`, which explicitly records that harness capabilities were not checked;
  their scenario adapters must preflight the execution environment themselves.
- `transcript`: `codex-jsonl`, or `text` for a harness whose stdout is its final
  answer. Text adapters retain raw output and mark token/tool telemetry unavailable.
- `isolation`: `sandbox` when the configured harness enforces it, or `prompt` when
  it does not. This is an explicit recorded setting, not a security guarantee made
  by the runner. Verify the harness flags locally. Never silently drop a sandbox
  because a launch fails.

The supplied Codex command uses a fresh ephemeral context, ignores user config,
selects model/effort explicitly, disables interactive approvals, and requests a
workspace sandbox with the case directory writable. The implementer also explicitly
grants writes to `{repo}/.git`: workspace access alone can leave Git metadata
read-only, which prevents commits, branches and worktrees. Before using a different
sandbox profile, probe Git initialization, commits and worktree creation in a
disposable repository without invoking a model. Other harnesses can supply an
argument array without changing the scenario/verifier. The sample also explicitly
sets `sandbox_workspace_write.network_access=true`. In the tested Codex 0.160.1 /
Node 24.20.0 Linux environment, network-restricted sandboxing stalled Node
subprocess stdin even for local Git commands. This setting retains filesystem
restrictions; the task still prohibits remote operations and live services. It is
a declared profile, never a fallback after a failed launch. If network restriction
is required, use a runtime/profile that passes the probe; do not silently weaken it.
The Codex probe uses its local `sandbox --permission-profile` command; unsupported
CLI versions fail during preparation instead of consuming model calls.

The grader command uses `--output-schema {schema}`. Each packet gets a generated
schema containing only its allowed transcript-check IDs and all required evidence
fields. Other harnesses should enforce this schema through their equivalent option;
the post-run validator still checks coverage and calibration independently.
The current helper implements Codex JSONL usage semantics only; other adapters must not fabricate telemetry.

The environment supplies private `SEMANTIC_FLOW_HOME`, TMPDIR/TMP/TEMP, npm caches,
XDG cache/config/data paths, pnpm and Yarn cache paths, and Git configuration.
HOME and CODEX_HOME remain intact for harness authentication. Custom frameworks
must pin any additional cache/profile paths in their fixture setup. API access by
the harness is expected; agents cannot push, fetch, deploy or use live application
services. The runner stops process groups on timeout/interruption and reaps its
background servers in that process group after completion (Windows uses taskkill's
process-tree option). Custom adapters must separately manage services that detach
from that group or run in an external browser host.

## Custom project scenarios

Use a committed, self-contained `.mjs` adapter instead of one-off runner edits.
A scenario entry adds `adapter` and optional `options`; paths resolve from the
config. The adapter is copied and content-hashed before running. It must export:

```js
export const checkIds = ['application-acceptance', 'artifact-publication'];
export const transcriptChecks = ['acceptance-exercised'];
export const transcriptCriteria = {
  'acceptance-exercised': 'Pass when the agent exercises the complete specified acceptance path; define applicable checks and any justified inapplicability here.',
};
export async function preflight({ options, source, workspace }) {
  // Check required runtime, dependency and browser capabilities before model calls.
  // Return serializable, verified versions/hashes (including a fixed source commit).
  return { /* capability fingerprint */ };
}
export async function prepare({ root, skill, env, options, capabilities }) {
  // Create one fresh Git repository within root, without remotes or old review state.
  // Export only the pinned source commit; preserve the user's original checkout.
  // Copy required dependencies without live installs or secrets.
  return { repo: /* absolute path within root */, request: /* exact task */,
    agentSetup: /* available tooling and how to invoke it, no answers */,
    before: /* snapshots needed by your verifier */ };
}
export async function verify({ fixture, root, skill, env, options, capabilities }) {
  // Read-only acceptance against the final cumulative commit, not an arbitrary HEAD.
  // Return each declared check exactly once. A task failure is passed:false;
  // throw only for evaluator infrastructure failures.
  return { checks: [/* {id, passed, evidence} */], evidence: {} };
}
```

The adapter must use Node built-ins or absolute, preflight-verified tool paths, not
relative imports that break when it is copied. Pin acceptance scripts and dependency
versions/hashes in the capability fingerprint. Keep the contract stable for all
repetitions/variants. The helper enforces declared check IDs but cannot infer whether
an arbitrary custom verifier is semantically correct: regression-test it with both a
known-good and deliberately broken implementation before paid runs.
Every transcript check also requires a nonempty `transcriptCriteria` rule describing
pass/fail conditions and applicability. Graders receive those rules with the packet;
evaluated agents do not. Avoid acceptance predicates that demand filler to produce
an otherwise inapplicable metric.

For UI tasks, make interactive acceptance a named check. Preflight an automation
capability supported by the current environment, provide its exact invocation to
the agent, isolate its profile/cache, and use local service mocks. Run the same
held-out interactions across implementations: input, navigation, reload, in-flight
success/failure, and specified edge cases. Unit tests or fetched SSR HTML cannot
substitute for an interactive check. If browser automation cannot be provided, reduce
the declared task scope before starting or mark the scenario unsupported; do not
launch an evaluation that can never satisfy its checks. Follow the current harness's
browser-tool preference; a closed preview is not proof of unavailability.

Do not give agents check scripts, expected outputs, grader conclusions, or reference
solutions. Prompt-only isolation does not make hidden checks inaccessible to a
malicious agent; this is an instruction evaluation, not an adversarial benchmark.

## Grading and records

`grade` reads frozen metrics and [grader.md](grader.md), constructs opaque A/B packets,
normalizes installation/fixture paths, and validates returned JSON, calibration,
coverage and score ranges. Each packet contains full evidence, including the
transcript, fixed checks, artifact and diff. It never tells graders which label is
the candidate. The operator-only mapping is retained in `blind-map.json`.

To exclude an attempted run after diagnosing apparatus trouble, use
`invalidate <session-directory> <run-id> <evidence-based-reason>`. This adds a
separate immutable annotation and regenerates the report; it never rewrites raw
attempts, checks or grades. Excluded runs cannot count as successes even when
acceptance passed. This reporting-only operation also works after runner changes;
it does not permit resuming a session with changed evaluation code. Preserve the
original report alongside a corrected rendering when reporting an older session.

If a packet exceeds a model's context limit, its grading is invalid. Decrease batch
size in the next planned session; do not truncate evidence or count it as a task
failure. Missing grader output leaves success unscored. `report` produces every
planned result row, including not-run/invalid cases, plus all measured metric tables
and links to evidence. Review the concrete findings; there is no automatic keep vote.

Keep the run directory and temporary workspace until the user is done inspecting
them. Cleanup is an explicit operator action: check the workspace ownership marker
against session.json and remove only that session's workspace. Never run a global
`/tmp` cleanup or remove the original project, source skill, or user-level review home.
