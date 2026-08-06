# Semantic Code Review

Semantic Code Review is a proposed tool for reviewing AI-generated changes by
intent rather than by file. It turns a large implementation into a local
branch stack: one cumulative branch per logical stage, with its code
changes, rationale, requirements, assumptions, decisions, and dependencies.

The aim is to help a human reviewer understand and refine AI-generated work
without asking the AI to reconstruct its reasoning after implementation.

## Design documents

- [User manual](docs/user-manual.md)
- [Vision and scope](docs/vision-and-scope.md)
- [Semantic review model](docs/semantic-review-model.md)
- [Artifact format standard](docs/artifact-format.md)
- [Feedback format proposal](docs/feedback-format.md)
- [Architecture and roadmap](docs/architecture-and-roadmap.md)

The proposed standard includes
[machine-readable JSON Schemas](standard/v0.1/schema) and a
[complete example artifact set](examples/order-cancellation/README.md).

The [semantic flow skill](skills/semantic-flow/SKILL.md) is kept as
distribution source outside `.github/skills`, so this repository does not load
its own output while being developed. Its production CLI and generated API
signature are compiled from the maintainable
[TypeScript scripts project](scripts/package.json).

The [semantic flow repair skill](skills/semantic-flow-repair/SKILL.md) is
distributed alongside it. It guides an agent that encounters a defect in
another repository to reproduce the problem there and repair the maintained
sources in this repository.

The [local review tool proof of concept](poc/README.md) loads the active
artifact, renders its semantic stages, invokes the validator, and shows
Git-backed branch-to-base diffs and feedback snapshots.

The original conversation is retained in
[Initial design discussion.md](Initial%20design%20discussion.md).
