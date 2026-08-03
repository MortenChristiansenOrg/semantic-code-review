# Semantic flow scripts

This TypeScript project is the source for the production tools bundled with the
`semantic-flow` skill.

```powershell
npm ci --prefix .\scripts
npm test --prefix .\scripts
```

`npm run build --prefix .\scripts` compiles self-contained Node.js bundles into
`skills\semantic-flow\scripts`, compiler-emits `API.d.ts` from the documented
TypeScript API source, and copies the versioned schemas required at runtime.

Edit `src\api.ts` and `src\command-api.ts` together when the CLI surface
changes. The build rejects command or parameter drift and missing source JSDoc.
Do not edit generated files under `skills\semantic-flow\scripts` or generated
schema copies under `skills\semantic-flow\references`.
