# Architecture and roadmap

## Architecture

```text
Coding agent + semantic-flow CLI
                |
                v
Linear stage branches + JSON artifact
                |
                v
        Local review PWA
                |
                v
 Hosting-neutral local preparation
```

### Skill and CLI

The skill plans semantic stages. The CLI creates deterministic stage branches,
captures branch/base/head provenance, validates linear history, cascades
restacks, manages feedback snapshots, publishes metadata separately, and
prepares final local branch refs.

### Git and artifacts

Git stores cumulative stage branches. `.semantic-review/` stores intent and
immutable snapshots without duplicating diffs. The default branch family is:

```text
semantic-review/<review-id>/
  01-<stage>
  02-<stage>
  metadata
```

The slash hierarchy groups branches in Git clients such as GitKraken.

### Review PWA

The localhost PWA loads indexed artifacts, renders stage-only diffs, tracks
feedback against immutable heads, and exposes explicit approval actions. It
does not expose a general shell endpoint.

### Preparation boundary

The workflow ends with a locally reviewed codebase. It supports two outputs:

1. The validated stage branch stack, preserving every semantic review unit.
2. A named cumulative branch pointing at the final stage head.

No remote is contacted. Pushing branches, creating reviews, choosing whether a
host should treat them as one change or a stack, and merging are external.

## Technology choices

| Area | Choice |
| --- | --- |
| Change structure | Linear branch-per-stage stack |
| Branch naming | Deterministic slash-prefixed family |
| Metadata | Indexed strict JSON |
| Review UI | Local PWA |
| Preparation | Local stack manifest or cumulative branch |
| Restacking | Transactional local replay |

## Risks

- Restacking can conflict and requires human resolution.
- Branch refs can move outside the tool; snapshot validation must expose drift.
- Remotes differ in stacked-change support and base semantics.
- Rewritten published branches may require lease-protected force pushes.
- Non-linear or parallel stacks are outside the initial protocol.

## Delivery sequence

1. Branch-backed protocol and transactional restacking.
2. Read-only semantic review and stage diffs.
3. Feedback anchored to stage head snapshots.
4. Local cumulative-branch and stack preparation.
5. Optional host adapters that remain outside the core protocol.

## Open decisions

- Whether cumulative preparation should optionally squash history.
- How to surface restack conflicts in the PWA.
- Whether metadata branches should be included in generic push manifests.
- How host-specific adapters consume the neutral stack description.
- How archived artifacts record the eventual landing outcome.
