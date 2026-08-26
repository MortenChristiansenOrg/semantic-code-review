# Semantic Code Review

This project includes a standardized schema describing changes to a code base as a result of implementing a user story or similar
piece of work. It offers a CLI for creating artifacts following the schema as well as an AI skill describing a stacked-PR based workflow
using the CLI.

The content of this project is cross platform and not tailored to any specific LLM or harness but may contain reference implementations and tooling for
specific platforms, harnesses, etc.

## Workflow

Do not use the semantic-flow skill on this repo, it is a skill that other projects will install and use.

## Schema stability

Version 0.1 is experimental. Breaking schema and CLI changes may be made in
place without migration or backward compatibility. Do not create a new schema
version solely to preserve v0.1 behavior until versioning is declared active.

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
  diffs, linked context, and feedback threads.

### Implementation model

- **Implementation**: The complete set of file changes made by the LLM using Semantic
  Flow to implement the requested work. This encompasses updates as response to
  review feedback. [Previously "review"]
- **Review**: The process of a human reviewing the current implementation, providing
  feedback, and the LLM responding and making corrections.
- **Stage**: A semantically independent part of the implementation that can be
  understood and validated in isolation. Each stage builds on the previous stage.
- **Node**: A coherent set of file changes within a stage representing a single
  logical change.
- **Classification**: The predefined category attached to each file-to-node
  membership (such as behavior, refactor and test).
- **Insight**: A recorded piece of reasoning attached to a stage and
  linked to the nodes it explains. Its kinds are decision, assumption,
  alternative, failed attempt, risk, and question. [Previously "context item"]
- **Validation evidence**: A recorded observation that a check was run for a
  stage (automated, manual, or analysis), with its status and link to nodes.
  Preferred over: validation item.
- **Requirements**: The full set of specifications - i.e. the work to be done.
- **Specification**: The identification, description and scope for the
  work including one or more acceptance criteria. [Previously "requirement"]
- **Acceptance criterion**: A single testable condition of a specification.

### Artifacts and storage

- **Implementation artifact**: The `.semantic-review/` JSON data describing an implementation: its
  manifest, requirements, and stages.
- **Manifest**: The single entry-point document (`manifest.json`) that indexes
  the requirements and stages and records review-level fields.
- **Stage branch**: The persistent cumulative branch that holds one stage's
  implementation, based on the branch immediately below it.
- **Stage stack**: The linear chain of stage branches from the target branch
  upward.
- **Target branch**: The repository branch the review is built on top of and
  eventually lands on.
- **Base revision / head revision**: Immutable commit snapshots recorded for a
  stage's diff range; they make mutable branches and feedback anchors
  verifiable.
- **Restacking**: Replaying every branch above a changed stage onto the newly
  computed lower head, as one transaction, and refreshing the recorded
  snapshots.
- **Metadata branch**: The sibling branch (`<branch-prefix>/metadata`) that
  carries published review metadata, kept out of implementation diffs.
- **Publication**: Publishing the artifact to the metadata branch after
  approval.
- **Preparation**: Producing hosting-neutral local outputs after review: the
  stage stack (`prepare-stack`) or a single cumulative branch
  (`prepare-branch`).
- **Cumulative branch*: A single named branch at the final stage head,
  representing the whole reviewed change for a conventional remote review.
- **Archive**: Storing a landed implementation's artifact under
  `.semantic-review-history/<implementation-id>/` for provenance after stage branches
  may be deleted.
- **Artifact worktree**: The linked worktree that contains the active
  artifact.
- **Anchor**: An immutable stage head snapshot a feedback item is attached to;
  it is **stale** when the stage's current head has since changed.
- **Working branch**: The currently checked out stage branch.
- **Operational branch**: The branch from which the LLM operates. Unless changed
  after starting the work, this will be a different branch than the working branch.
  The skill resolves the working branch as needed when issuing workflow commands.

### Feedback

- **Feedback artifact**: The mutable local review workflow state under
  `.semantic-review-feedback/`, independent from the artifact and never
  committed on stage branches.
- **Thread**: A single review conversation opened by the user and continued by
  the assistant, anchored to a target and stage head.
- **Comment**: One entry in a thread's ordered timeline, authored by the user
  or the assistant.
- **Approval**: A recorded human sign-off on the whole change, a stage, a
  change node, or a file. This is for personal reference by the reviewer
  and holds no technical significance. Also seen as: review-progress approval.