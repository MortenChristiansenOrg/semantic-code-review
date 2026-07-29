# Semantic Review Artifact Format

**Status:** Proposal 0.1

This document defines the first version of the repository artifact used to
describe an AI-assisted implementation. The format is optimized for three
clients:

- A coding agent writing one bounded document at a time.
- A validator detecting structural, reference, and Git inconsistencies.
- A review tool loading the artifact without scanning or inferring its shape.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Design choices

1. The artifact is a directory, not a single document.
2. The manifest is the only entry point and explicitly indexes every child.
3. Requirements and semantic stages are stored one per file.
4. References use stable IDs; paths are derived from those IDs.
5. Every document has a strict JSON Schema. Unknown standard fields are errors.
6. Cross-file and Git invariants are checked separately from JSON Schema.
7. A stage commit is the source of truth for its diff. The artifact stores only
   a verifiable file inventory and review context.

This split keeps common edits local. Adding a stage normally creates one stage
file and appends one ID to the manifest. Updating a stage does not rewrite a
large shared document.

## Artifact layout

An artifact root MUST be named `.semantic-review` and have this layout:

```text
.semantic-review/
  manifest.json
  requirements/
    <requirement-id>.json
  stages/
    <stage-id>.json
```

The manifest lists all requirement and stage IDs. Readers MUST NOT discover the
artifact graph by globbing the directories. Unlisted JSON files are invalid;
validators MAY enumerate the two child directories only to detect them.

The format does not define where the artifact is committed. Artifact files
MUST NOT be part of a commit referenced by a stage because a stage file contains
that commit's hash. An implementation MAY keep the artifact uncommitted, commit
it after the stage stack, or store it on a separate ref.

## Common encoding rules

- Files MUST contain UTF-8 JSON without a byte-order mark.
- JSON comments, trailing commas, `NaN`, and duplicate object keys are invalid.
- Writers SHOULD use two-space indentation and a final newline.
- IDs MUST match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` and be at most 80
  characters.
- IDs are case-sensitive.
- Repository paths MUST use `/`, be relative to the repository root, and MUST
  NOT contain `.` or `..` segments.
- Git revisions MUST be full, lowercase, 40-character SHA-1 object IDs in
  version 0.1.
- Human-readable strings MUST contain at least one non-whitespace character.
- Arrays whose order has meaning retain that order. Other arrays SHOULD use a
  stable, logical order to reduce noisy diffs.
- Empty arrays are explicit and required where the schema requires them. This
  distinguishes "none" from "writer omitted the field."

Every document MUST contain a `$schema` URI. Version 0.1 uses the schemas in
[`standard/v0.1/schema`](../standard/v0.1/schema).

## Reference and path resolution

References never contain paths.

| Reference | Resolved path |
| --- | --- |
| Requirement ID `cancel-order` | `requirements/cancel-order.json` |
| Stage ID `persist-cancellation` | `stages/persist-cancellation.json` |
| Criterion `cancel-order#reject-shipped` | Criterion `reject-shipped` in requirement `cancel-order` |

A loader starts at `manifest.json`, resolves each listed ID using this table,
and rejects files whose internal `id` does not match the filename.

## Manifest document

Path: `.semantic-review/manifest.json`

The manifest identifies the review, pins its base, and defines the complete
narrative order.

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | Yes | Version 0.1 manifest schema URI |
| `formatVersion` | Yes | Exact value `0.1` |
| `reviewId` | Yes | Stable artifact identity |
| `title` | Yes | Short review title |
| `summary` | Yes | Scope and intended outcome |
| `baseRevision` | Yes | Commit immediately before the first stage |
| `targetBranch` | Yes | Branch the stack is intended to merge into |
| `requirements` | Yes | Unique requirement IDs |
| `stages` | Yes | Unique stage IDs in narrative and commit order |
| `extensions` | No | Namespaced non-standard data |

`requirements` MUST contain at least one ID. `stages` MAY be empty while work is
being planned and MUST contain at least one ID before publication. The order of
`requirements` is presentational. The order of `stages` is normative.

## Requirement document

Path: `.semantic-review/requirements/<requirement-id>.json`

A requirement records the source intent independently from the implementation.

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | Yes | Version 0.1 requirement schema URI |
| `id` | Yes | ID matching the filename and manifest entry |
| `title` | Yes | Short requirement title |
| `summary` | Yes | Requirement in implementation-relevant terms |
| `source` | Yes | Origin kind, reference, and optional URL |
| `acceptanceCriteria` | Yes | Non-empty list of locally unique criteria |
| `extensions` | No | Namespaced non-standard data |

`source.kind` is one of `azure-devops`, `github`, `url`, or `local`.
`source.reference` is the human-recognizable source identifier, such as
`AB#4821`. A source URL SHOULD be included when one is available.

Each acceptance criterion has an `id` and `text`. Its globally resolvable
reference is `<requirement-id>#<criterion-id>`.

## Stage document

Path: `.semantic-review/stages/<stage-id>.json`

A stage describes one committed, independently reviewable implementation unit.

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | Yes | Version 0.1 stage schema URI |
| `id` | Yes | ID matching the filename and manifest entry |
| `title` | Yes | Intent-focused title |
| `summary` | Yes | What the stage changes |
| `dependsOn` | Yes | Direct prerequisite stage IDs |
| `requirementRefs` | Yes | Acceptance criteria addressed |
| `change` | Yes | Commit hash and exact changed-file inventory |
| `rationale` | Yes | Why this implementation was chosen |
| `decisions` | Yes | Requirement-driven or engineering decisions |
| `assumptions` | Yes | Claims that may require confirmation |
| `alternatives` | Yes | Considered but rejected approaches |
| `failedAttempts` | Yes | Tried approaches and lessons |
| `risks` | Yes | Known risk and optional mitigation |
| `validation` | Yes | Automated, manual, or analytical evidence |
| `openQuestions` | Yes | Unresolved questions for reviewers |
| `extensions` | No | Namespaced non-standard data |

All narrative item IDs are local to their stage and MUST be unique within their
array. They make comments and later updates addressable without embedding array
positions.

### Dependencies

`dependsOn` contains only direct dependencies. A stage MUST NOT list itself,
list a later stage, or redundantly list a transitive dependency.

The manifest stage order MUST be a topological order. In version 0.1 it is also
the commit order: the first stage commit's first parent is `baseRevision`, and
each later stage commit's first parent is the previous stage commit.

### Requirement references

Every stage MUST reference at least one acceptance criterion. Each
`requirementRefs` value uses `<requirement-id>#<criterion-id>`. Both parts must
resolve through the manifest.

### Change inventory

`change.commit` identifies the stage commit. `change.files` lists its complete
file-level diff:

| `kind` | Required fields |
| --- | --- |
| `added` | `path` |
| `modified` | `path` |
| `deleted` | `path` |
| `renamed` | `path`, `previousPath` |

`path` is the new path for a rename. Files MUST appear once and SHOULD be sorted
by `path`. The inventory deliberately omits hunks and line numbers because Git
already owns that data.

### Context collections

- A `decision` has an ID, category (`requirement` or `engineering`), summary,
  and rationale.
- An `assumption` has an ID, statement, and consequence if wrong.
- An `alternative` has an ID, approach, and reason it was rejected.
- A `failedAttempt` has an ID, approach, outcome, and reusable lesson.
- A `risk` has an ID, summary, and optional mitigation.
- An `openQuestion` has an ID and question.

Writers MUST use an empty array when no item exists. They MUST NOT invent an
alternative or failed attempt merely to avoid an empty array.

### Validation evidence

Each validation item has an ID, type, status, and summary.

- `type` is `automated`, `manual`, or `analysis`.
- `status` is `passed`, `failed`, or `not-run`.
- Automated validation MUST include the exact `command`.
- Manual and analytical validation MAY include a command when useful.
- A failed or unrun check MUST remain in the artifact if it is relevant to
  review.

The format records concise evidence, not full logs. Large or sensitive output
belongs in the existing build system and MAY be linked through an extension.

## Extensions

All standard objects reject unknown properties. Experimental data MUST be
placed in the top-level `extensions` object.

Extension keys MUST be namespaced and match a dotted or hyphenated identifier
such as `com.example.performance`. Consumers that do not recognize an extension
MUST preserve it when rewriting a document and otherwise ignore it.

An extension MUST NOT change the meaning of a standard field or be required to
interpret the standard artifact.

## Writer procedure

A conforming writer SHOULD:

1. Create requirement files before stages that reference them.
2. Create one stage file after its implementation commit exists.
3. Record rationale, assumptions, and failed attempts from working context
   rather than reconstructing them later.
4. Compute the changed-file inventory from Git instead of generating it from
   memory.
5. Add the new IDs to the manifest only after their files are complete.
6. Run schema, reference, graph, and Git validation after every stage addition.
7. Rewrite commit hashes and file inventories after a rebase or replay.

Writers SHOULD edit only the affected child files and manifest entries. They
MUST preserve unknown extension values.

### In-progress stage capture

Tooling MAY keep schema-validated working documents under
`.semantic-review/.work/` while a stage is being implemented. Standard readers
MUST ignore this directory. Working documents are not part of the canonical
artifact graph and MUST be removed before publication.

The working format is tool-specific because a canonical stage cannot identify
its commit or exact file inventory until that commit exists. A tool SHOULD make
the working document structurally close to a stage and SHOULD validate it after
every update. Finalization MUST derive `change` from Git and copy the captured
context into the canonical stage document without asking the writer to
reconstruct it.

## Validation procedure

Validation has four ordered layers. A validator MUST stop treating later data
as trustworthy after a layer fails, but SHOULD report all independent errors
within the failing layer.

### 1. JSON and schema validation

- Parse all indexed files while rejecting duplicate keys.
- Validate each file against the schema named by `$schema`.
- Reject unsupported `formatVersion` values.

### 2. Artifact integrity

- Resolve every manifest ID to its required path.
- Reject missing, unlisted, or duplicate documents.
- Check each internal ID against its filename and manifest entry.
- Check local narrative IDs for uniqueness.
- Check all requirement and criterion references.

### 3. Dependency integrity

- Reject self-references, missing stages, cycles, and dependencies on later
  stages.
- Reject redundant transitive dependencies.
- Confirm that manifest order is a topological order.

### 4. Git integrity

- Confirm that `baseRevision` and every stage commit exist and are commits.
- Confirm the linear first-parent chain defined above.
- Confirm that every stage commit is unique.
- Compare `change.files` with:

  ```text
  git diff --name-status --find-renames=50% <parent> <stage-commit>
  ```

- Map `A`, `M`, `D`, and `R<score>` to `added`, `modified`, `deleted`, and
  `renamed`. Reject other statuses in version 0.1.
- Reject artifact paths inside a referenced stage commit.

Tools MAY offer a schema-only mode for editors, but MUST label it as incomplete
validation.

Publication validation MUST reject an empty stage list and any remaining
`.semantic-review/.work/` documents.

## Loading and processing

A reader can process an artifact in bounded steps:

1. Read and validate `manifest.json`.
2. Load the listed requirements into an ID map.
3. Stream stages in manifest order.
4. Resolve references through maps, never directory scans.
5. Read Git diffs lazily when a stage is displayed.

This requires one small index file and one read per referenced document. A tool
can cache documents by content hash and invalidate only files changed on disk.

## Versioning

`formatVersion` uses `major.minor`.

- A minor version may add optional fields or enum values.
- A major version may change required fields, reference rules, or semantics.
- Readers MUST reject unsupported major versions.
- Readers SHOULD reject unsupported minor versions unless explicitly operating
  in best-effort mode.
- Writers MUST emit one exact version and MUST NOT mix schema versions in an
  artifact.

The canonical v0.1 schema identifiers use:

```text
https://semantic-code-review.dev/schemas/v0.1/<type>.schema.json
```

These URIs are identifiers. Tools MAY resolve them from a bundled local schema
catalog rather than over the network.

## Deliberate exclusions from version 0.1

- Review comments and approval state, which change independently from the code
  description.
- Embedded source diffs, test logs, generated files, or binary evidence.
- Multiple commits per stage, merge commits, or parallel stage branches.
- References between separate review artifacts.
- Automatic recovery of semantic stages from an arbitrary existing history.

See the
[order cancellation example](../examples/order-cancellation/README.md) for a
complete artifact. Its commit IDs are placeholders because the example is not
coupled to an executable Git repository; all non-Git validation rules apply.
