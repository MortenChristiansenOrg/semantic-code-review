# Semantic review model

## Semantic stage

A semantic stage is the smallest independently reviewable intent. It may touch
many files and contain several linear commits, but every change serves one
purpose.

Each stage records requirement coverage, rationale, decisions, assumptions,
alternatives, failed attempts, risks, validation, dependencies, branch/base
relationship, immutable head snapshot, and affected files.

Affected files are organized into descriptive change nodes. A node represents
one cause or coherent implementation move, such as renaming an abstraction and
updating its consumers. Each file-to-node link has a predefined classification.
A file owned by multiple causes is partitioned by changed hunks or line ranges.
Every recorded context item links back to the nodes it explains.

## Stage ordering and Git shape

Stages form a semantic dependency DAG but are implemented as a linear local
branch stack:

```text
target <- stage 1 <- stage 2 <- stage 3
```

Each stage has its own cumulative branch based on the branch immediately below
it. The shared default prefix `semantic-review/<review-id>/` groups the
branches in clients such as GitKraken.

This Git shape is hosting-neutral. After local review it can be exposed as
separate stacked changes when a remote supports them, or represented by one
cumulative branch at the final stage head.

## End-to-end workflow

1. The agent initializes at the target branch head.
2. `stage begin` creates and checks out the next stage branch.
3. The agent implements, commits, groups the diff into change nodes, performs
   final validation, and finalizes the branch.
4. The reviewer walks the stack bottom-to-top.
5. Feedback threads are anchored to immutable stage head snapshots.
6. A change is committed directly on the affected branch.
7. `restack` cascades it through every branch above and refreshes snapshots.
8. Approval publishes metadata on a sibling metadata branch.
9. Tooling verifies the local stack and may create a named cumulative branch.
10. Remote publication, review creation, and merge remain outside the flow.

The same restack operation handles edits made manually by a user on any lower
branch.

## Responsibilities

**The skill** plans stages and enforces human gates.

**The CLI** creates deterministic branches, validates branch/base/head and
change-node coverage invariants, restacks descendants, publishes metadata
separately, and prepares hosting-neutral local outputs.

**The review UI** leads with node descriptions, exposes their classified file
or hunk membership, renders linked context and Git diffs, gathers feedback, and
shows stale anchors after branch rewrites.

**The repository host** may consume either the cumulative branch or the branch
stack, but its review and merge model is not part of this protocol.
