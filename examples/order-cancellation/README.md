# Order cancellation example

This fictional change shows a complete version 0.1 artifact:

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
semantic-flow/customer-order-cancellation/01-add-cancellation-policy
semantic-flow/customer-order-cancellation/02-persist-cancellation
semantic-flow/customer-order-cancellation/03-expose-cancellation-endpoint
```

Each branch is one semantic stage head based on the branch below it. Git
integrity validation requires a repository containing the referenced branches
and revisions.
