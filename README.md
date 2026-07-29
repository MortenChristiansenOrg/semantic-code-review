# Semantic Code Review

Semantic Code Review is a proposed tool for reviewing AI-generated changes by
intent rather than by file. It turns a large implementation into an ordered set
of logical stages, each with its code changes, rationale, requirements,
assumptions, decisions, and dependencies.

The aim is to help a human reviewer understand and refine AI-generated work
without asking the AI to reconstruct its reasoning after implementation.

## Design documents

- [Vision and scope](docs/vision-and-scope.md)
- [Semantic review model](docs/semantic-review-model.md)
- [Artifact format standard](docs/artifact-format.md)
- [Architecture and roadmap](docs/architecture-and-roadmap.md)

The proposed standard includes
[machine-readable JSON Schemas](standard/v0.1/schema) and a
[complete example artifact set](examples/order-cancellation/README.md).

The [semantic story implementation skill](.github/skills/semantic-story-implementation/SKILL.md)
guides coding agents through creating and validating these artifacts while they
implement a user story.

The original conversation is retained in
[Initial design discussion.md](Initial%20design%20discussion.md).
