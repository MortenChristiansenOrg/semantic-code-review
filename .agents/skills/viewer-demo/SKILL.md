---
name: viewer-demo
description: Use when the user asks for a demo setup for testing the viewer or related features. Also used for cleanup of a previously created demo.
---

# Viewer demo

Build a throwaway demo tailored to the current request. Prioritize speed and
reuse of existing infrastructure; do not build a reusable demo framework.

Keep generated repositories and data under `.demo/<name>/` (gitignored). Set
`SEMANTIC_FLOW_HOME` to an absolute path inside that workspace for setup and
viewer processes. Record created resources and viewer URLs in `demo.json` so a
later session can clean up. For cleanup, identify demo viewers through
`/api/whoami`, stop them through `POST /api/shutdown`, and remove the workspace.

Reuse:

- `skills/semantic-flow/scripts/`: built CLI and production storage APIs.
  Refresh with `npm run build --prefix scripts` when needed.
- [Repository fixtures](../../../scripts/tests/helpers/repository.mjs): artifact
  and Git setup recipes. Do not import this module directly: it overrides
  `SEMANTIC_FLOW_HOME` and registers automatic cleanup on exit.
- [Workflow tests](../../../scripts/tests/semantic-flow/workflow-helper.test.mjs)
  and [viewer tests](../../../scripts/tests/semantic-view/): working examples of
  viewer startup and seeding review state.
