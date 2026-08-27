# Artifact quality rules

Read this file for implementation, continuation, and feedback work.

Produce an artifact that records what happened while the work was performed,
not a story reconstructed afterward.

## Stage rules

- Resume an active implementation instead of initializing another one.
- Start new work in a clean, isolated worktree at the target branch head.
- Keep future stages in the agent's task plan. Register only the stage about to
  be implemented because only one working stage may exist.
- Begin a stage before editing its implementation.
- Keep each stage to one coherent behavior, with its tests and directly related
  documentation.
- Let `stage begin` create and check out the deterministic stage branch.
- Treat the numeric branch prefix as the finalized manifest position, not a
  planned position. There must be exactly one implementation branch for each
  ordinal.
- Keep all work that belongs to the active stage on its existing branch. If
  its scope changes, update its mutable metadata with `stage set`; do not
  create another numbered branch for the same stage position.
- Do not use `stage discard` to rename or reorder a stage. It removes working
  metadata but leaves the branch ref, so beginning a replacement can create
  two branches claiming the same ordinal. Stop and ask the user if the
  immutable stage ID or stage order must change.
- Commit only implementation content, then organize and finalize that branch
  head.
- Prefer vertical behavior-oriented stages over file, directory, layer, or
  activity groupings.
- Make every stage independently understandable and valid. Do not create
  artificial stages or a catch-all cleanup stage.
- Correct an omission in the earliest responsible stage and restack later
  branches. Do not append stabilization or acceptance-gap stages for work that
  belongs in an existing boundary, and do not create a new numbered branch for
  it.

## Insights and change organization

- Record useful decisions, assumptions, alternatives, failed attempts, risks,
  validation, and open questions when they arise.
- Exclude routine choices, secrets, raw logs, fabricated history, confidence
  claims, and private chain-of-thought.
- After committing, run `stage organize` over the complete stage diff.
- Every changed file must belong to a descriptive change node.
- Node descriptions, read in order, must explain the work without requiring
  the raw file list.
- Use project-domain language for descriptions and avoid unnecessary technical
  jargon without losing the meaning of the change.
- Use whole-file membership when one node owns a file.
- When several nodes share a file, partition every changed hunk or changed line
  exactly once and use one selector style for that file.
- Classify every membership with the schema-defined classification.
- Link all recorded insights and validation evidence to their relevant nodes.

## Requirements and evidence

A specification represents one independently trackable product or business
obligation. Its acceptance criteria are the testable outcomes that jointly
define when that obligation is satisfied.

- Default to one specification for one requested user story, issue, or other
  source work item, even when it has several acceptance criteria.
- Preserve distinct source obligations as distinct requirements. Use more than
  one specification only when the request combines obligations that can be
  understood and tracked independently, or explicitly combines several source
  work items.
- A specification must remain meaningful if the other requirements are removed
  from the implementation. If it would not, it is probably an acceptance criterion,
  stage, or implementation detail instead.
- Do not create separate requirements for acceptance criteria, edge cases,
  implementation stages, technical layers, components, test categories, or
  dependencies.
- Do not merge unrelated source obligations into one specification merely
  because they are implemented within one implementation.
- When a source boundary is materially ambiguous, ask the user instead of
  inventing or merging requirements.

A stage should let a reviewer answer:

1. Which specification or acceptance criterion does this satisfy?
2. What coherent behavior changed?
3. Why is this boundary and approach appropriate?
4. What evidence supports it, and what needs attention?

Rationale explains the approach or boundary rather than repeating the summary.
Specification references identify criteria actually addressed by the stage.
Dependencies list direct behavioral prerequisites, not chronology or Git
ancestry.

Record validation only after it runs, with the exact command and observed
result. Preserve failures and skipped checks. Before requesting review,
exercise the complete acceptance path rather than relying only on isolated
tests. For user-facing work, use the available runtime or browser workflow at
representative viewport sizes. For reactive interfaces, verify that server
updates and rerenders do not erase unsaved input or report stale success.

Review, approval, metadata publication, preparation, and archive are human
gates. The agent must not approve its own implementation or feedback response.
