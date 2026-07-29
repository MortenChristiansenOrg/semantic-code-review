# Semantic Review Feedback Format

**Status:** Proposal 0.1

Review feedback is mutable workflow state kept separately from the semantic
implementation artifact. It references stable IDs from `.semantic-review` but
does not alter the meaning of requirements or stages.

## Layout

```text
.semantic-review-feedback/
  manifest.json
  batches/
    <batch-id>.json
  items/
    <feedback-id>.json
```

The manifest indexes every batch. Each batch indexes its feedback items.
Readers MUST load through those indexes; unlisted JSON files are invalid.

The format is validated by the schemas in
[`standard/v0.1/feedback-schema`](../standard/v0.1/feedback-schema).

## Batch lifecycle

| Status | Meaning |
| --- | --- |
| `draft` | Comments can be added, edited, or removed |
| `submitted` | The batch is frozen and ready for an agent |
| `addressing` | At least one submitted item has been addressed |
| `resolved` | Every item has an unapproved resolution |
| `approved` | Every resolution has reviewer approval |

Submitting a batch freezes its comment bodies and targets. Corrections become a
new batch so the agent always receives an immutable instruction set.

## Feedback item lifecycle

| Status | Meaning |
| --- | --- |
| `draft` | Reviewer is still composing the comment |
| `submitted` | Comment is waiting for implementation |
| `addressed` | Agent recorded how and where it was resolved |
| `approved` | Reviewer accepted the resolution |

A resolution records its explanation, semantic stage, previous stage commit,
rewritten stage commit, and timestamps. It does not claim that the reviewer has
accepted the result until the item reaches `approved`.

## Targets

Every target stores a human-readable `label`. Semantic targets reference IDs;
code targets additionally reference the stage commit used when the comment was
created.

| Kind | Required anchor |
| --- | --- |
| `requirement` | Requirement ID |
| `criterion` | Requirement ID and criterion ID |
| `stage` | Stage ID and stage commit |
| `context` | Stage ID, stage commit, collection, and item ID |
| `file` | Stage ID, stage commit, and repository path |
| `line` | Stage ID, stage commit, path, side, and positive line number |

`context` supports decisions, assumptions, alternatives, failed attempts,
risks, validation evidence, and open questions.

Line anchors can become stale after history rewriting. Tools SHOULD preserve
the original anchor, show that it differs from the current stage commit, and
display the resolution rather than silently moving the comment.

## Agent processing

An agent processes submitted feedback by semantic stage:

1. Select all submitted items assigned to the earliest affected stage.
2. Implement and validate those changes in one temporary fix commit.
3. Rewrite the target stage with that fix and replay every downstream stage.
4. Refresh semantic artifact commit bindings.
5. Record a resolution for each addressed item.
6. Repeat for the next affected stage.

The reviewer can then approve resolutions individually or all at once. Stack
approval is allowed only when no draft, submitted, addressing, or merely
resolved feedback remains.

## Storage and publication

The active feedback root SHOULD be locally ignored so it cannot enter semantic
stage commits. A product may persist it in a database or publish a snapshot in a
separate metadata commit. The implementation artifact remains valid without
feedback state.
