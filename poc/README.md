# Semantic Review Tool POC

Requires Node.js 20 or later.

Run from the repository root:

```powershell
npm ci --prefix .\.github\skills\semantic-story-implementation
npm start --prefix .\poc
```

Open <http://127.0.0.1:4173>. The server reads the repository's
`.semantic-review` artifact on every request, so finalized and working-stage
changes appear without restarting it.

The workspace provides:

- Manifest-indexed requirements and semantic stages.
- Working and finalized stage state.
- Rationale, decisions, assumptions, alternatives, failures, risks, evidence,
  and open questions.
- Authoritative artifact validation through the semantic review CLI.
- Lazy Git-backed unified diffs for finalized stages.
- Cross-stage feedback batches with requirement, context, file, and line
  anchors.
- Submitted comment state, agent resolution tickets, individual or bulk
  approval, and PR-branch approval.

Run tests with:

```powershell
npm test --prefix .\poc
```
