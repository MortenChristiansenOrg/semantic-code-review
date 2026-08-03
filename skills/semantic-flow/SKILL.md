---
name: semantic-flow
description: Use when implementing a substantial feature or user story that should be reviewed as ordered, intent-based stages. Invoke before implementation starts and keep using it through planning, coding, validation, feedback revisions, and publication. Do not use for small fixes, investigations, review-only tasks, or routine refactors.
---

# Semantic Flow

Produce a trustworthy semantic review artifact while implementing the work.
The artifact must describe what actually happened, not a reconstruction created
after the code is finished.

Read `docs/Steps.md` and `scripts/API.d.ts` before changing application code or
invoking the CLI. `docs/Steps.md` defines the operating procedure.
`scripts/API.d.ts` is the authoritative command signature.

## Non-negotiable rules

- Run all commands from the target Git repository root.
- Use the bundled CLI for every artifact and feedback mutation. Never hand-edit
  `.semantic-review/` or `.semantic-review-feedback/`.
- Resume an existing active review instead of initializing another one.
- Start new work only in a clean, isolated worktree on the intended work
  branch and base revision. Never stash, discard, or absorb unrelated user
  changes to satisfy the workflow.
- Keep future stages in the agent's task plan. Register only the stage about to
  be implemented because only one working stage may exist.
- Begin a stage before editing its implementation. Keep its code, tests, and
  documentation limited to one coherent intent.
- Commit only that stage's implementation, then finalize it against the commit.
  Semantic metadata must not be included in a stage commit.
- Record review-relevant conclusions when they arise. Do not invent decisions,
  alternatives, failed attempts, risks, or validation after the fact, and do
  not record private chain-of-thought.
- Record validation only after it ran, with the exact command and observed
  result. Preserve relevant failures and skipped checks.
- Treat review, approval, publication, push, merge, and archive as explicit
  human gates. Never approve on the reviewer's behalf or publish/land/archive
  without the required user instruction.

## Artifact quality

A strong stage lets a reviewer answer:

1. What requirement or acceptance criterion does this satisfy?
2. What coherent behavior changed?
3. Why is this stage boundary and implementation approach appropriate?
4. What evidence supports it, and what deserves reviewer attention?

Prefer vertical, behavior-oriented stages over file-, layer-, or activity-based
stages. Keep tests with the behavior they validate. Split work only when each
stage is independently understandable and leaves the repository in a valid
state. Do not create artificial stages or a catch-all cleanup stage merely to
make the artifact look detailed.

Rationale must explain the approach or boundary rather than repeat the summary.
Requirement references must identify criteria genuinely addressed by the
stage. Dependencies must list only direct prerequisites.

## Bundled CLI

The production CLI is self-contained in `scripts/` and requires Node.js 20 or
later:

```text
node <skill-root>/scripts/semantic-review.mjs <command>
node <skill-root>/scripts/review-feedback.mjs <command>
```

Do not inspect the generated `.mjs` bundles to discover usage. Read their
implementation only as a last resort when the API signature, skill guidance,
and an observed command error cannot explain a tool defect or undocumented
behavior.
