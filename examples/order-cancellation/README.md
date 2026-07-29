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
requirement links, dependencies, decisions, assumptions, a failed attempt,
risks, validation evidence, and an open question.

The repeated-digit commit IDs are placeholders. The files pass schema,
reference, and dependency validation, but Git integrity validation requires the
artifact to be attached to a repository containing the referenced commit stack.
