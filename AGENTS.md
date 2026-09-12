# Semantic Code Review

This project includes a standardized schema describing changes to a code base as a result of implementing a user story or similar
piece of work. It offers a CLI for creating artifacts following the schema as well as an AI skill describing a stacked-PR based workflow
using the CLI.

The content of this project is cross platform and not tailored to any specific LLM or harness but may contain reference implementations and tooling for
specific platforms, harnesses, etc.

## Workflow

Do not use the semantic-flow skill on this repo, it is a skill that other projects will install and use.

### Releases

When asked to bump the version or create a release, follow [docs/releases.md](docs/releases.md).
Classify actual changes, use the release helper, write notes from the template,
and validate the built archive. Follow the requested PR/publication scope.

### Updating an installed skill from this repository

`/semantic-flow update` installs the latest published release by default. When
working here, first identify the installed copy outside this source directory.
If a user-level installation exists and the destination is not already specified,
ask whether to update it or a repository-level installation (request that target
repository path). If no user-level installation exists, request the target path.
Never use this repository's source skill as the release update destination.
Use this checkout as `--source` only when a source build is explicitly requested.

## Schema stability

Product releases use `0.x` versions and any release may contain breaking changes.
The implementation and feedback formats remain experimental `0.1`, independently
of product versions. Breaking format changes may be made in place without
migration or backward compatibility during `0.x`; do not add a new schema version
merely for a product release. See [docs/releases.md](docs/releases.md) for the
compatibility contract and the explicit transition to semantic versioning at 1.0.

## Project Glossary

### System and process

- **Semantic Code Review**: The overall project: the artifact standard, the
  schemas, the skill, the CLI, and the viewer taken together.
- **Semantic Flow**: The end-to-end workflow the skill prescribes.
- **The skill**: The semantic-flow skill. Implements the semantic flow and provides access
  to a set of commands to the user.
- **The CLI**: The bundled command-line tools that create deterministic
  branches, validate invariants, restack, manage feedback, publish metadata, and
  prepare local outputs.
- **Viewer**: The local web app that renders stages, change nodes,
  diffs, linked insights, and feedback threads.

### Implementation model

- **Implementation**: The complete set of file changes made by the LLM using Semantic
  Flow to implement the requested work as well as any manual changes made. This
  encompasses updates as response to review feedback.
- **Review**: The process of a human reviewing the current implementation, providing
  feedback, and the LLM responding and making corrections.
- **Stage**: A logically distinct and independently reviewable part of the
  implementation that can be understood and validated in isolation. Each stage
  branch builds on the previous stage branch.
- **Change node**: A coherent subset of a stage's diff representing a single
  logical change. It may own complete changed files or selected hunks or line
  ranges when several nodes share a file. Mostly used just as "node" when not
  ambiguous with Node.js.
- **Classification**: The predefined category attached to each file-to-node
  membership (such as behavior, refactor and test).
- **Insight**: A recorded piece of reasoning or other observation attached to a
  stage and linked to the nodes it explains. Its kinds are decision, assumption,
  alternative, failed attempt, risk, and open question.
- **Validation evidence**: A recorded observation that a check was run or considered
  for a stage (automated, manual, or analysis), with its status and link to nodes.
- **Requirements**: The full set of specifications. When there is one specification,
  the requirements and the specification are one and the same.
- **Specification**: The identification, description and scope for the
  work including one or more acceptance criteria.
- **Acceptance criterion**: A single testable condition of a specification.

### Artifacts and storage

- **Implementation artifact**: The `.semantic-review/` JSON data describing an
  implementation: its manifest, requirements, and stages.
- **Manifest**: The single entry-point document (`manifest.json`) that indexes
  the requirements and stages and records implementation-level fields.
- **Stage branch**: The persistent branch whose head represents the cumulative
  implementation through one stage, based on the branch immediately below it.
  The stage's own changes are the diff between its recorded base and head
  revisions.
- **Stage stack**: The linear chain of stage branches from the target branch
  upward.
- **Target branch**: The repository branch the implementation is built on top of and
  eventually lands on.
- **Base revision / head revision**: Immutable commit snapshots recorded for a
  stage's diff range; they make mutable branches and feedback anchors
  verifiable.
- **Restacking**: Recomputing affected stage branches after the target branch
  or a lower stage changes by replaying commits bottom-up onto the new lower
  heads, then moving the affected refs as one transaction and refreshing the
  recorded snapshots.
- **Metadata branch**: The sibling branch (`<branch-prefix>/metadata`) that
  carries published implementation metadata, kept out of implementation diffs.
- **Publication**: Publishing the artifact to the metadata branch.
- **Preparation**: The workflow represented by `/semantic-flow prepare`, which
  prepares hosting-neutral local outputs after review by validating and
  reporting the existing stage stack (`validate-stack`) or creating a single
  cumulative branch (`prepare-branch`).
- **Cumulative branch**: A single named branch at the final stage head,
  representing the whole reviewed change for a conventional remote review.
  Preparation binds the name locally and safely moves the same branch after
  later reviewed changes.
- **Archive**: Storing a landed implementation's artifact under
  `.semantic-review-history/<implementation-id>/` so its provenance remains
  available if stage branches are later deleted. Archiving does not delete
  branches.
- **Artifact worktree**: The repository worktree that contains the active
  artifact and from which artifact and feedback commands operate.
- **Anchor**: A stage head snapshot a feedback thread is attached to. Pending
  non-line anchors may refresh when the exact target still exists; line anchors
  remain immutable. An anchor is **stale** when it no longer matches and cannot
  be refreshed safely.
- **Working branch**: The branch checked out in the repository checkout or
  linked worktree where the LLM is currently making implementation changes.
  When no changes are in progress, it is the branch currently checked out
  there.
- **Operational branch**: The branch checked out in the original repository
  checkout where the LLM session started. It remains the session's operational
  context while the LLM runs commands or edits files in another worktree. It
  may be the same as the working branch.

### Feedback

- **Feedback artifact**: The mutable local review workflow state under
  `~/.semantic-flow/reviews/<review-id>/feedback/`, independent from the artifact and never
  committed on stage branches.
- **Thread**: A single review conversation opened by the user and continued by
  the agent or user, anchored to a target and stage head.
- **Comment**: One entry in a thread's ordered timeline, authored by the user
  or the agent.
- **Approval**: A recorded human sign-off on the whole change, a stage, a
  change node, or a file. This is for personal reference by the reviewer
  and holds no technical significance.
