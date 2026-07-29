# Architecture and roadmap

## Proposed architecture

```text
Coding agent + semantic-review skill
                |
                v
Git commits + versioned JSON artifact set
                |
                v
        Review PWA in browser
                |
                v
 Optional localhost companion
       | Git | AI | Azure DevOps
```

### AI skill and scripts

The skill is the protocol entry point for coding agents. It guides semantic
decomposition, metadata capture, commit construction, targeted revisions, and
downstream replay. Small scripts validate and inspect the manifest so correctness
does not depend on prompt compliance alone.

### Repository artifacts

Git stores the code and stage commits. A versioned JSON artifact set stores the
review structure and references commits rather than duplicating diffs. A small
manifest indexes separate requirement and stage documents for incremental
writing and efficient loading. Keeping the first implementation
repository-backed makes it inspectable, portable, and easy to prototype.

### Review PWA

The primary interface is an installable web application. It reads the manifest,
renders stage narratives and diffs, tracks review state, and presents dependency
and impact information. Existing diff-rendering libraries should be reused; the
product's novel work is semantic structure and revision flow.

### Local companion

A small localhost process is introduced only where browser APIs are
insufficient. It exposes narrow, authenticated operations for:

- Reading repository and Git state.
- Creating comments or revision requests.
- Invoking an approved coding agent.
- Rebasing or replaying a commit stack.
- Publishing or linking work in Azure DevOps.

The PWA should remain useful in read-only mode without the companion. The bridge
must not expose a general shell endpoint.

## Technology direction

| Area | Initial choice | Reason |
| --- | --- | --- |
| UI | PWA | Low installation cost and broad internal access |
| Diff rendering | Existing web library | Avoid rebuilding commodity behavior |
| Local integration | Minimal localhost service | Safe access to Git and AI tools |
| Metadata | Indexed, multi-file JSON in repository | Strict, portable, incremental |
| Change structure | Linear stacked commits | Simple review and replay semantics |
| Hosted backend | None for MVP | Prove the protocol before adding operations |

The implementation language and UI framework remain open until a prototype
compares ecosystem fit, diff-library quality, and local-bridge packaging.

## Boundaries and risks

- Browser file APIs vary, so write operations should not depend on them alone.
- Rebasing downstream stages can create conflicts requiring human resolution.
- Metadata can drift from commits; validation must make drift visible.
- Captured rationale is an AI-authored claim, not an audit-grade proof.
- Repository metadata may contain sensitive requirements or reasoning and must
  follow the repository's access controls.
- Azure DevOps integration should follow the semantic model, not shape it
  prematurely.

## Delivery sequence

### 1. Protocol prototype

Exercise the proposed artifact format, create the AI skill, generate a staged
implementation, and validate metadata against a local commit stack.

### 2. Read-only review

Build the PWA view for stage navigation, rationale, requirements, dependencies,
and diffs. Test whether the format materially improves review comprehension.

### 3. Revision loop

Add stage comments, local-agent invocation, targeted commit updates, downstream
replay, conflict handling, and changed-stage indicators.

### 4. Team integration

Add Azure DevOps linking or publishing, shared review-state decisions, and only
then evaluate a database-backed implementation graph.

## Future exploration

If the core review workflow proves valuable, explore promoting selected lessons
from reviewer feedback into a shared knowledge store. The immediate revision
would still correct the current stage, while an explicit, human-controlled step
could preserve the underlying guidance for future implementations and help
avoid repeating the same mistake. How guidance is generalized, approved,
scoped, retrieved, and retired should be designed only after there is evidence
that the primary semantic review workflow is useful.

## Open decisions

- Whether the proposed v0.1 artifact format needs changes after prototyping.
- Long-term schema publication and migration policy.
- Whether stage metadata belongs in implementation commits or a separate
  metadata commit.
- How review comments persist before a hosted service exists.
- How to detect and present semantic drift after replay.
- Which Git stack operations can be safely automated.
- Which Azure DevOps integration point gives value without duplicating pull
  requests.
- What measurements demonstrate faster or higher-quality review.
