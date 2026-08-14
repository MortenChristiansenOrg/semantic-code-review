# Semantic Review Artifact Format

**Status:** Proposal 0.1

This format describes an AI-assisted implementation as a linear stack of
semantic stage branches. The key words **MUST**, **MUST NOT**, **SHOULD**, and
**MAY** are normative.

## Design

1. `.semantic-review/manifest.json` is the only entry point.
2. Requirements and stages are separate, strictly validated documents.
3. Stable IDs connect narrative data; Git branches and revisions identify code.
4. Each stage is one cumulative local branch and one review unit.
5. The first stage branch is based on `targetBranch`; every later stage branch
   is based on the branch immediately below it.
6. A stage may contain multiple linear commits. Merge commits are invalid.
7. Immutable base/head snapshots make mutable branches and feedback anchors
   verifiable.

## Layout

```text
.semantic-review/
  manifest.json
  requirements/<requirement-id>.json
  stages/<stage-id>.json
```

Readers load only IDs indexed by the manifest. Unlisted JSON files are invalid.
Active metadata SHOULD be ignored locally. It MUST NOT be committed on a stage
branch because that would pollute its implementation diff and make branch/head bindings
self-referential. A writer MAY publish it on a separate metadata branch.

## Common rules

- UTF-8 JSON, two-space indentation, final newline.
- IDs match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Repository paths use `/` and are relative to the repository root.
- Revisions are full lowercase 40-character SHA-1 IDs in version 0.1.
- Branch names must pass `git check-ref-format --branch`.
- Arrays with defined order preserve it.
- Every document names its `$schema`.

## Manifest

Required fields:

| Field | Meaning |
| --- | --- |
| `formatVersion` | Exact value `0.1` |
| `reviewId` | Stable review identity |
| `title`, `summary` | Complete work description |
| `baseRevision` | Target branch head captured before stage 1 |
| `targetBranch` | Repository branch below stage 1 |
| `branchPrefix` | Shared folder-like prefix for all stage branches |
| `requirements` | Indexed requirement IDs |
| `stages` | Stage IDs in bottom-to-top branch order |

The default prefix is `semantic-review/<review-id>`. Writers SHOULD use:

```text
<branch-prefix>/<two-digit-position>-<stage-id>
```

This deterministic convention groups related branches in clients such as
GitKraken.

`baseRevision` MUST equal `targetBranch` when initialized. If trunk advances,
restacking updates `baseRevision` and every affected stage snapshot.

## Requirement

A requirement records `id`, `title`, `summary`, source provenance, and at least
one acceptance criterion. Criterion references use
`<requirement-id>#<criterion-id>`.

## Stage

A stage records its intent, dependencies, requirement references, rationale,
context, validation, and `change`.

`dependsOn` contains only direct semantic prerequisites. Manifest order is both a topological order and the linear branch order.

### Change

| Field | Meaning |
| --- | --- |
| `branch` | Persistent stage/head branch |
| `baseBranch` | Branch immediately below this stage |
| `baseRevision` | Immutable base snapshot used for the recorded diff |
| `headRevision` | Immutable stage branch snapshot |
| `files` | Complete file inventory for `baseRevision..headRevision` |

For stage 1:

```text
baseBranch = manifest.targetBranch
baseRevision = manifest.baseRevision
```

For stage `n > 1`:

```text
baseBranch = previousStage.change.branch
baseRevision = previousStage.change.headRevision
```

`branch` MUST equal the deterministic branch name for its manifest position.
The local branch ref MUST point to `headRevision` during an active review.
`headRevision` MUST descend linearly from `baseRevision` and the range MUST
contain at least one commit and no merge commit.

`files` is derived from:

```text
git diff --name-status --find-renames=50% <baseRevision> <headRevision>
```

Supported kinds are `added`, `modified`, `deleted`, and `renamed`.

## Working stage

Tooling may store one working stage under `.semantic-review/.work/stages/`.
It includes the deterministic `branch` but no canonical `change`. `stage begin`
creates and checks out that branch at the current stack tip. Finalization
derives `change` from Git and removes the working document.

## Restacking

Branches are mutable; recorded revisions are snapshots. When stage `k` changes:

1. Read the current head of stage `k`.
2. Replay each branch above it onto the newly computed lower head, bottom-up.
3. Abort without moving refs if any patch conflicts.
4. Move affected branch refs as one transaction.
5. Refresh each affected `baseBranch`, `baseRevision`, `headRevision`, and
   `files`.

The operation MUST refuse to overwrite an affected branch that changed after
it was read. Tools SHOULD use compare-and-swap ref updates and
`--force-with-lease` when pushing rewritten branches.

This procedure supports both agent changes and commits made manually by a user
on a specific lower stage branch.

## Local preparation

The canonical output is a locally validated branch chain:

```text
targetBranch <- stage 1 <- stage 2 <- stage 3
```

Tooling SHOULD expose the ordered branch/base/head data without encoding any
hosting API or review identifier. It SHOULD also be able to create a named
cumulative branch at the final stage head.

A remote may consume the branches as one normal change or as separate stacked
changes when supported. Push, hosted review creation, and merge semantics are
outside this format.

## Validation

Validation layers:

1. Parse indexed JSON and validate schemas.
2. Validate IDs, references, dependencies, and deterministic branch names.
3. Resolve every base/head revision and stage branch.
4. Verify the branch ref equals `headRevision`.
5. Verify each base branch/revision relationship.
6. Verify linear ancestry, no merges, unique branches/heads, exact file
   inventories, and exclusion of semantic metadata from stage diffs.

Publication validation also requires at least one finalized stage and no
working stage.

## Publication and archive

The recommended publication branch is:

```text
<branch-prefix>/metadata
```

It contains one metadata-only commit parented by the final stage head. Keeping
it separate prevents review metadata from appearing in implementation diffs.

After the result is landed, the artifact may be archived under:

```text
.semantic-review-history/<review-id>/.semantic-review/
```

Archived artifacts preserve branch and revision provenance even if stage
branches are later deleted.

## Deliberate exclusions

- Remote hosting and review APIs.
- Non-linear or parallel stage graphs.
- Automatic conflict resolution.
- Embedded diffs, logs, or binary evidence.
- Automatic creation, push, or merge without an explicit user request.
