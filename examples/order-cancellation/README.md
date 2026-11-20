# Order cancellation example

This fictional change shows a complete version 0.1 artifact in the full form
that publication and archives store:

```text
.semantic-review/
  manifest.json
  requirements/
    cancel-order.json
  stages/
    add-cancellation-policy.json
    persist-cancellation.json
    expose-cancellation-endpoint.json
```

The example covers a domain rule, persistence, and an API endpoint. It includes
specification links, dependencies, decisions, assumptions, a failed attempt,
risks, validation evidence, and an open question.

The repeated-digit revisions are placeholders. The default branch family is:

```text
semantic-flow/customer-order-cancellation/stages/add-cancellation-policy
semantic-flow/customer-order-cancellation/stages/persist-cancellation
semantic-flow/customer-order-cancellation/stages/expose-cancellation-endpoint
```

Each branch is one semantic stage head based on the branch below it. In this
form, every stage records its branch, base and file inventory. The active
artifact of a worktree stores only each stage's head revision and derives the
rest from Git, so it requires a repository containing the referenced
revisions.
