---
name: semantic-flow-repair
description: Use when the semantic-flow skill fails, gives incorrect or incomplete instructions, rejects valid work, corrupts or cannot repair its state, or its bundled CLI and documented API disagree. This skill is for repairing semantic-flow in its source repository while working from another target repository. Do not use for ordinary semantic-flow usage errors or for manually repairing a target repository's generated implementation artifacts.
---

# Semantic Flow Repair

Repair `semantic-flow` at its maintained source, then reproduce the fix from
the repository where the defect was observed. Do not patch only the installed
copy: that hides the source defect and will be lost when the skill is updated.

## Establish the two repositories

Keep these locations explicit throughout the repair:

- **Target repository:** the repository where `semantic-flow` failed. Run
  semantic-implementation and feedback commands from this repository root because the
  CLI operates on the current Git repository.
- **Source repository:** the local checkout containing
  `skills/semantic-flow/SKILL.md`, `scripts/package.json`, and
  `standard/v0.1/`. Make the lasting repair here.

Locate the source checkout from a path supplied by the user or an already
configured workspace, though start by checking for a sibling folder called
'semantic-code-review' next to this repository folder. If it cannot be identified
unambiguously, ask for its
path. Do not guess a repository, clone an unverified remote, or treat the
installed skill directory as the source checkout.

Before editing, inspect `git status` in both repositories. Preserve unrelated
changes. Use explicit paths or `git -C <repository>` so commands cannot
silently affect the wrong repository.

## Confirm a skill defect

Capture the smallest reproducible failure before changing source:

1. Record the exact command, arguments, output, Node.js version, relevant Git
   state, and installed `semantic-flow` files or revision.
2. Read the installed `semantic-flow/SKILL.md`, the command file selected by
   its index, every shared document that command requires, and
   `scripts/API.d.ts` and the relevant `scripts/api/*.d.ts` module.
3. Distinguish an invalid invocation, unsupported workflow, damaged target
   artifact, or interrupted write from a defect in the skill.
4. Run read-only diagnostics first. Never hand-edit `.semantic-review/` or
   `.semantic-review-feedback/` to make the reproduction pass.

Use the bundled `repair` command only for the unambiguous interrupted writes it
supports. A missing capability, wrong mutation, misleading instruction,
contract mismatch, or reproducible crash belongs in the source repository.

## Edit the maintained source

Choose files by responsibility:

| Concern | Maintained source |
| --- | --- |
| Command routing | `skills/semantic-flow/SKILL.md` |
| Command workflows | `skills/semantic-flow/commands/` |
| Shared runtime and quality rules | `skills/semantic-flow/docs/runtime.md`, `skills/semantic-flow/docs/artifact-quality.md` |
| Semantic implementation CLI | `scripts/src/semantic-implementation.ts` |
| Review feedback CLI | `scripts/src/review-feedback.ts` |
| Runtime command and option definitions | `scripts/src/command-api.ts` |
| Published TypeScript command contract and JSDoc | `scripts/src/api/*.ts` (indexed by `scripts/src/api.ts`) |
| Contract validation or skill packaging | `scripts/src/api-contract-check.ts`, `scripts/src/build-skill.ts` |
| Artifact schemas | `standard/v0.1/schema/` |
| Feedback schemas | `standard/v0.1/feedback-schema/` |
| Working-stage schema | `scripts/schemas/work-stage.schema.json` |
| CLI regression coverage | `scripts/tests/` |
| User-facing concepts and formats | `docs/` |

When the CLI surface changes, edit `scripts/src/command-api.ts` and
`scripts/src/api/*.ts` (indexed by `scripts/src/api.ts`) together. Keep source JSDoc accurate because the generated
API declaration is user-facing guidance.

Do not directly edit generated files:

- `skills/semantic-flow/VERSION`
- `skills/semantic-flow/scripts/*.mjs`
- `skills/semantic-flow/scripts/API.d.ts`
- `skills/semantic-flow/references/schema/`
- `skills/semantic-flow/references/feedback-schema/`
- `skills/semantic-flow/references/work-stage.schema.json`

The build replaces those files from their maintained sources. Inspect generated
bundles only as a last-resort diagnostic after the skill guidance, generated
API declaration, source, and observed error fail to explain the behavior.

Make the smallest complete source change. Add or update a regression test that
recreates the target-repository failure for executable or schema defects.
Update skill guidance or repository documentation when behavior or the
supported workflow changes.

## Build and validate

From the source repository, run:

```text
npm test --prefix ./scripts
```

This type-checks, rebuilds the distributed skill, validates the command
contract, and runs the CLI tests. Install dependencies with
`npm ci --prefix ./scripts` only when they are unavailable or the lockfile
changed.

Inspect the source-repository diff after the build. Generated outputs must
match their sources, and unrelated generated churn must not be included.

## Verify from the target repository

Run the rebuilt CLI directly from the source checkout while the current
directory remains the target repository root:

```text
node "<source-repository>/skills/semantic-flow/scripts/semantic-flow.mjs" <command>
node "<source-repository>/skills/semantic-flow/scripts/semantic-implementation.mjs" <command>
node "<source-repository>/skills/semantic-flow/scripts/review-feedback.mjs" <command>
```

Repeat the original failing operation and the nearest unaffected workflow.
Confirm both the command result and resulting Git or artifact state. Use a
disposable reproduction or a backup when the command is destructive; do not
experiment on valuable active implementation state.

Do not copy individual generated files into the installed skill. Once the
source repair is verified, update or reinstall the complete `semantic-flow`
skill through the repository's normal distribution mechanism.

Report the root cause, maintained files changed, regression coverage, rebuilt
outputs, and target-repository reproduction result. If the issue cannot be
reproduced safely, stop with the captured evidence rather than making a
speculative repair.
