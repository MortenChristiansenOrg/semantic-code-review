# Semantic review model

## Primary artifact: the semantic stage

A semantic stage is the smallest independently reviewable unit of an
implementation. It may touch several files, but all changes serve one intent.

Each stage records:

| Field | Purpose |
| --- | --- |
| Identity and title | Stable reference and concise intent |
| Summary | What the stage changes |
| Requirements | User story or acceptance criteria addressed |
| Rationale | Why this approach was chosen |
| Decisions | Requirement-driven, assumed, or engineering choices |
| Alternatives | Notable options considered and why they were rejected |
| Failed attempts | Useful exploration that should not be repeated |
| Dependencies | Earlier stages required by this stage |
| Changes | Associated commit and affected paths |
| Validation | Tests or checks supporting the stage |
| Open concerns | Known uncertainty or reviewer attention points |

The repository artifact is a versioned set of JSON documents rooted at
`.semantic-review/`. A manifest indexes separate requirement and stage files,
which reference each other by stable IDs. See the
[artifact format standard](artifact-format.md). JSON is an interchange
protocol, not the long-term user interface.

## Stage ordering

Stages form a directed acyclic graph. Their displayed order provides the review
narrative, while dependency edges determine which later stages may need replay
after a revision.

For the first version, each stage maps to one commit in a linear stack. This
keeps the relationship between metadata, diff, and Git history understandable.
The model may later allow multiple commits per stage or parallel branches.

## End-to-end workflow

1. The coding agent reads the requirement and proposes a stage plan.
2. During implementation, it records decisions, assumptions, alternatives, and
   validation with the stage that caused them.
3. Scripts validate the manifest and its links to the commit stack.
4. The reviewer walks through stages in narrative order, viewing metadata and
   diffs together.
5. The reviewer accepts a stage or leaves comments against the stage or its
   code.
6. The agent updates the affected stage only, then rebases or replays dependent
   stages.
7. The tool highlights downstream stages whose code or rationale changed.
8. Once accepted, the final stack is delivered through the normal pull-request
   workflow.

## Review experience

The default view should answer four questions quickly:

1. What requirement does this stage satisfy?
2. What changed?
3. Why was it implemented this way?
4. What should I be cautious about?

Useful secondary views include an architecture-impact summary, a dependency
graph, cross-cutting changes, and a narrated replay of the implementation.

## Protocol responsibilities

**The AI skill** defines how stages are planned, recorded, committed, revised,
and replayed.

**Validation scripts** enforce schema validity, unique stage identities,
dependency integrity, valid commit references, and required metadata.

**The review UI** renders the protocol, gathers human feedback, and invokes
local Git or AI operations through an explicit bridge.

The protocol should record facts and provenance where possible. Subjective
confidence indicators may be shown later, but must not substitute for evidence.
