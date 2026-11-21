# Semantic Implementation Artifact Format

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
6. A finalized stage is one commit. Commits made while the stage is worked on
   or corrected are folded into it. Merge commits are invalid.
7. Immutable base/head snapshots make mutable branches and feedback anchors
   verifiable.
8. The active artifact stores only what Git cannot tell. Branch names, base
   revisions and file inventories follow from the stage order and the head
   revisions; published and archived artifacts store them in full.

## Layout

```text
.semantic-review/
  manifest.json
  requirements/<specification-id>.json
  stages/<stage-id>.json
  evidence/<stage-id>/<sha256>.<extension>
```

Readers load only IDs indexed by the manifest. Unlisted JSON files are invalid.
The active artifact MUST NOT be committed on a stage branch because that would
pollute its implementation diff and make branch/head bindings self-referential.
The reference tooling keeps it outside every worktree (see
[Active storage](#active-storage)). A writer MAY publish it on a separate
metadata branch.

## Common rules

- UTF-8 JSON, two-space indentation, final newline.
- IDs match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and MUST NOT equal the
  case-insensitive Windows device names `con`, `prn`, `aux`, `nul`, `com1`
  through `com9`, or `lpt1` through `lpt9`.
- Repository paths use `/` and are relative to the repository root.
- Revisions are full lowercase 40-character SHA-1 IDs in version 0.1.
- Branch names must pass `git check-ref-format --branch` and MUST NOT contain a
  path component equal to one of those Windows device names.
- Arrays with defined order preserve it.
- Every document names its `$schema`.

## Manifest

Fields (required unless marked optional):

| Field | Meaning |
| --- | --- |
| `formatVersion` | Exact value `0.1` |
| `skillVersion` | Optional version of the Semantic Flow skill that initialized the implementation, read from its installed `VERSION` file. The Viewer displays “Unknown” when absent; later tooling updates do not rewrite this provenance. |
| `implementationId` | Stable implementation identity |
| `title`, `summary` | Complete work description |
| `baseRevision` | Target branch head captured before stage 1 |
| `targetBranch` | Repository branch below stage 1 |
| `branchPrefix` | Shared folder-like prefix for all stage branches |
| `requirements` | Indexed specification IDs |
| `stages` | Stage IDs in bottom-to-top branch order |

The default prefix is `semantic-flow/<implementation-id>`. Stage branches are
named:

```text
<branch-prefix>/stages/<stage-id>
```

The name carries no position, so a stage can be inserted, split, reordered or
removed without renaming the branches above it; stage order comes only from the
manifest. The `stages/` level keeps a stage whose ID is `metadata` apart from
the `<branch-prefix>/metadata` publication branch, and groups related branches
in clients such as GitKraken.

`baseRevision` MUST equal `targetBranch` when initialized. If trunk advances,
restacking updates `baseRevision` and every affected stage snapshot.

## Specification

A specification records `id`, `title`, `summary`, source provenance, and at least
one acceptance criterion. Criterion references use
`<specification-id>#<criterion-id>`.

`source.kind` is any non-empty origin identifier, such as `local`, `url`,
`jira`, or an internal tracker name. `source.reference` is required and non-empty.
An optional `source.url` must be a valid URI; `kind: url` requires it. Provider
names do not require schema or API changes. For example:

```json
{ "kind": "internal-tracker", "reference": "TEAM-42", "url": "https://work.example.com/TEAM-42" }
```

## Stage

A stage records its intent, dependencies, specification references, rationale,
insights, validation evidence, and `change`.

`dependsOn` contains only direct semantic prerequisites. Manifest order is both a topological order and the linear branch order.

### Optional insight code targets

Every insight kind, and validation evidence, may include `codeTarget`. It supplements
`nodeRefs`; untargeted items remain valid. The target stores `path`, immutable
commit `revision`, `blobId`, inclusive one-based `startLine` / `endLine`, and
`contextStartLine` / `context` (an array of original lines including up to three
surrounding lines on each side). The context must contain the entire span and,
when the original commit is available, must match that snapshot. Only regular
text files are supported. The target may refer to an unchanged file in the stage
head as well as a changed file.

The original anchor is immutable until explicitly retargeted or removed. Viewer
resolution compares it with the stage's recorded head, not the working tree.
Line shifts away from the span and Git-detected file renames map automatically.
Moved blocks map only when the diff preserves the span and its immediate boundaries.
Edits touching the span or its immediate boundaries, deleted blocks, ambiguous repeated code, and
unavailable original revisions are marked **Needs review**. Automatic mapping
indicates unchanged target text, not a fresh review of the reasoning or its
surrounding behavior. Saved original context remains readable after publication,
archiving, or pruning old commits. Mapping does not mutate the artifact.

After reviewing changed code and updating the insight if necessary, use
`stage target` to capture a new anchor or `--remove` to drop only the link. A
normal insight replacement preserves an existing anchor unless a new target
is supplied. Format `0.1` remains unchanged.

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

`branch` MUST equal `<branch-prefix>/stages/<stage-id>`.
The local branch ref MUST point to `headRevision` during an active implementation.
`headRevision` MUST be the one commit of the range `baseRevision..headRevision`.
Tooling folds the commits made while a stage is worked on or corrected into
that commit when it records the stage head. The reference tooling generates its
message from the stage title and summary and adds a `Co-authored-by` trailer
for every other author of the folded commits. A restack rebuilds the message
of every stage it covers from the current title and summary and keeps the
commit's trailers, so a title or summary changed on a finalized stage reaches
its commit at the next restack.

`files` is derived from:

```text
git --no-replace-objects -c core.attributesFile=/dev/null -c diff.default.binary=auto \
  diff-tree -r -z --name-status --ignore-submodules=none --find-renames=50% -l1000 \
  <baseRevision> <headRevision> --
```

run with `GIT_ATTR_SOURCE` set to the empty tree and `GIT_ATTR_NOSYSTEM=1`, so
that the inventory does not depend on Git configuration, replacement refs or
attributes (Git reads `/dev/null` as the null device on every platform). `1000` is the rename limit of this format (Git's default since
2.33). Git before 2.41 ignores `GIT_ATTR_SOURCE` and still reads the worktree's
`.gitattributes`, and every Git version reads `$GIT_DIR/info/attributes`.

Supported kinds are `added`, `modified`, `deleted`, and `renamed`.

## Active form

The active artifact of the reference tooling stores a compact form that is
private to the CLI. It differs from the full form in three places:

- The manifest's `stages` lists `{ "id": "<stage-id>", "headRevision": "<sha>" }`
  entries in bottom-to-top order instead of IDs. An entry also has a
  `baseRevision` while the stage does not build on the recorded head below it:
  after a lower stage's corrected head was recorded and before restacking
  moves the stage onto it. Validation with Git reports that state and names
  the restack that ends it.
- Stage documents omit `change`.
- Working stage documents omit `branch`.

One loader turns the active form into the full form for every reader: it names
each branch, takes each base from the stage below or from the manifest, and
derives each file inventory from Git. Commands validate the result against the
full schemas; the viewer narrows each field itself, so it can still show an
artifact that validation rejects. Storing a derived field in the active form is an error.
`semantic-flow implementation export` shows the full form.

## Active storage

The reference tooling stores the active artifact in the repository's Git
object store, not in a worktree:

- The private ref `refs/semantic-review/active/<implementation-id>` points at
  a snapshot commit whose tree is the whole artifact in its active form. Files
  are stored byte for byte, whatever the line-ending and attribute settings.
- Every change writes a new snapshot commit and moves the ref only if it still
  points at the snapshot the command read, so a concurrent writer fails
  instead of overwriting. The ref keeps a reflog.
- A snapshot's parents are not earlier snapshots but the superseded stage
  heads: every head a snapshot recorded for a stage and a later one replaced.
  Each snapshot carries them forward, so commits that feedback anchors may
  still refer to survive garbage collection.
- A command that also moves stage branches, such as `stage begin`, `stage
  discard` or `restack`, moves them and the artifact's ref in one transaction.
- Every worktree of the repository sees the same artifacts, and cleaning a
  worktree cannot remove them. Active implementations are found by listing
  `refs/semantic-review/active/`. With several, a command acts on the one whose
  stage or metadata branch is checked out in its worktree, or else the one last
  initialized or begun there.
- Archiving removes the active ref in the same transaction that creates the
  archive ref (see [Publication and archive](#publication-and-archive)). An
  archived implementation's ID cannot be used again.

An earlier tooling version kept the active artifact in a worktree's
`.semantic-review/` folder. Such a folder is reported, not read: an
implementation cannot be continued across that change.

## Working stage

Tooling may store one working stage under `.work/stages/` of the active artifact.
In its full form it includes the deterministic `branch` but no canonical
`change`. `stage begin` creates and checks out that branch at the current stack
tip. Finalization records the branch head and removes the working document.

## Restacking

Branches are mutable; recorded revisions are snapshots. When stage `k` changes:

1. Read the current head of stage `k` and fold its commits into one.
2. Replay each branch above it onto the newly computed lower head, bottom-up,
   folding any branch that was edited too.
3. Move no ref while any replay conflicts. The reference tooling cherry-picks
   each stage commit in a scratch worktree and, on a conflict, records the
   restack as pending in the active artifact (`.work/restack.json`) and keeps
   the worktree's Git conflict state until `restack --continue` or `--abort`.
   A stage whose changes the target already contains stays in the stack as
   an empty commit marked with the trailer `Semantic-Flow-Empty: <commit>`,
   naming the stage commit it replaced, which the artifact keeps reachable;
   its `files` is empty and its nodes keep describing the change. A later
   restack replays the named commit, so the stage's changes return if the
   target no longer contains them. A stage whose conflict was resolved to no
   change is marked `Semantic-Flow-Empty: resolved` and is not replayed again.
   A correction to an empty stage replaces its commit, and with it the marker:
   the named commit is no longer replayed, and the tooling warns when that
   happens.
4. Move affected branch refs as one transaction.
5. Record each affected `headRevision` (and the manifest's `baseRevision` when
   the target advanced); the other `change` fields follow from them.

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

1. Parse indexed JSON, derive the full form, and validate schemas.
2. Validate IDs, references, and dependencies.
3. Resolve every base/head revision and stage branch.
4. Verify the branch ref equals `headRevision`.
5. Verify linear ancestry, no merges, unique heads, node coverage of the
   derived inventories, and exclusion of semantic metadata from stage diffs.

The active form stores no branch names, bases or inventories, so validation
does not compare stored copies with Git.

Publication validation also requires at least one finalized stage and no
working stage. Stage specification references define the criteria included in
the review. Other criteria in the indexed requirements do not block
publication or preparation.

## Evidence

Each stage has a required `evidence` array of captures that show its behavior
working. An entry has an `id`, a `kind` (`screenshot`, `recording`, `terminal`,
`http`, `log`, `output-file`, `measurement`, or `report`), a `summary`, the
`capturedAt` time, `nodeRefs`, and at least one of `attachments` or `inline`. It may add `specificationRefs` for
the criteria it supports (each must be addressed by the stage), `reproduction`,
and `codeTarget`.

An attachment has an artifact-relative `path`, a `mediaType`, a `sha256`, and an
optional `caption` and `role` (`before` or `after`). Files live at
`evidence/<stage-id>/<sha256>.<extension>`. They are part of the active metadata,
so they stay out of stage diffs, and publication and archiving carry them with
the rest of the artifact.

Full validation requires each attachment to be a regular file with the recorded
hash and an allowed media type, at most 25 MiB, with at most 100 MiB per stage,
and rejects files in `evidence/` that no entry references. A behavior stage with
no evidence and no `noEvidenceReason` is a warning, not an error.

## Publication and archive

The recommended publication branch is:

```text
<branch-prefix>/metadata
```

It contains one metadata-only commit parented by the final stage head, with the
artifact in its full form and without working stages. Keeping it separate
prevents implementation metadata from appearing in implementation diffs.

Once the work is finished, normally after it landed, the artifact may be
archived under the private ref:

```text
refs/semantic-review/archive/<implementation-id>
```

It points at an archive commit whose only parent is the metadata commit that
publishes the artifact, and whose tree adds one file, `.semantic-review/landing.json`.
Archiving adds nothing to the target branch. The archive keeps the published
artifact in its full form and, through the metadata commit, the final head of
every stage, so it preserves branch and revision provenance even if stage
branches are later deleted. Stage heads that earlier snapshots superseded are
not kept.

The landing record (`landing.schema.json`) names the target branch and the
final stage head and has one of three outcomes:

| `outcome` | Meaning |
| --- | --- |
| `ancestry` | `targetRevision`, a head of the target branch, contains the final stage head. |
| `supplied` | The reviewer named `landedCommits`: a commit, such as a squash merge, or a Git range `<base>..<head>`, such as a rebase merge. |
| `unknown` | Neither. |

Matching the implementation's changes against target commits also succeeds when
the target made the same edits independently, so tooling MAY use it only to
suggest `landedCommits` to the reviewer. Landing may be recorded after
archiving: the archive ref then moves to a new archive commit on the same
metadata commit.

An archive is shared as the annotated tag:

```text
refs/tags/semantic-review-archive/<implementation-id>
```

The tag MUST NOT be moved once it was pushed; the reference tooling never moves
it, so landing is recorded before sharing. Pushing it sends the artifact, its
evidence and the stage commits, but nothing reaches the target branch.

Its short name, `semantic-review-archive/<implementation-id>`, differs from the
short name of every ref under `refs/semantic-review/`. Stage, metadata and
cumulative branches MUST NOT start with `semantic-review/`,
`semantic-review-archive/` or `refs/`; the reference tooling refuses such a
branch prefix or cumulative branch name, and refuses to share an archive while
a branch or ref of an older artifact has the tag's short name.

## Deliberate exclusions

- Remote hosting and review APIs.
- Non-linear or parallel stage graphs.
- Automatic conflict resolution.
- Embedded diffs. Captured evidence is stored as separate files under
  `evidence/`, never inside the JSON documents, apart from small inline text.
- Automatic creation, push, or merge without an explicit user request.
