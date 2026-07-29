# Semantic Review Tool POC

Requires Node.js 20 or later.

Run from the repository root:

```powershell
npm start --prefix .\poc
```

Open <http://127.0.0.1:4173>. The server reads the repository's
`.semantic-review` artifact on every request, so finalized and working-stage
changes appear without restarting it.

Run tests with:

```powershell
npm test --prefix .\poc
```
