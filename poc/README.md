# Semantic Review Tool POC

Requires Node.js 20 or later.

Run from the repository root:

```powershell
npm ci --prefix .\scripts
npm run build --prefix .\scripts
npm start --prefix .\poc
```

Open <http://127.0.0.1:4173>. The server reads the repository's
`.semantic-review` artifact on every request, so finalized and working-stage
changes appear without restarting it.

To review another project, pass its absolute or relative path:

```powershell
npm start --prefix .\poc -- C:\Code\project
npm start --prefix .\poc -- ..\project
```

See the [user manual](../docs/user-manual.md) for the reviewer workflow.

The workspace provides:

- Manifest-indexed requirements and semantic stages.
- Working and finalized stage state.
- Intent-oriented change nodes whose descriptions summarize the stage, with
  classified file or hunk membership and expandable syntax-highlighted diffs.
- Local change-set, stage, node, and stage-scoped file approvals. Parent
  approvals make descendants read-only without replacing their explicit state,
  and changed file patches retain a visible previous-approval marker.
- Rationale, decisions, assumptions, alternatives, failures, risks, evidence,
  and open questions.
- Authoritative artifact validation through the semantic review CLI.
- Lazy Git-backed base-branch-to-stage-head diffs.
- Cross-stage feedback batches with threaded requirement, context, file, and
  line anchors.
- Editable draft notes, assistant follow-ups, thread resolution and approval,
  metadata publication, and hosting-neutral local preparation.

Run tests with:

```powershell
npm test --prefix .\poc
```
