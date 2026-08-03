---
name: semantic-flow
description: When implementing a full feature or user story, use this skill continually during the implementation to generate a semantic documentation artifact. This artifact will be used be the developer to review the final implementation.
---

# Purpose

The semantic development flow is an approach to produce structured metadata about the implementation of a bigger set of functionality such as a user story or feature. The goal is to split the work into a sequence of individual implementation stages, each with a coherent and self-contained scope and semantic meaning. Once the implementation is completed, the user will be able to review each stage individually rather than as one big change set.

Scope: The semantic flow is intended to be used for the implementation of a full feature or user story. It is not intended to be used for small changes or bug fixes.

See docs/Steps.md for a description of the steps in the semantic flow.

## Bundled CLI

Use the production CLI bundled in `scripts/` for every artifact or feedback
mutation. Run them from the target Git repository root.

Before invoking a command, read `scripts/API.d.ts`. It is the authoritative,
generated signature for every command, parameter, flag, default, and
conditional option.

Do not inspect `scripts/semantic-review.mjs` or
`scripts/review-feedback.mjs` to discover usage. The bundles are generated
implementation details. Read their implementation only as a last resort when
the API signature, skill guidance, and observed command error cannot resolve a
tool defect or undocumented behavior.

```text
node <skill-root>/scripts/semantic-review.mjs <command>
node <skill-root>/scripts/review-feedback.mjs <command>
```

The bundles require Node.js 20 or later and include their runtime dependencies.