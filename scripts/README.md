# Semantic flow scripts

This TypeScript project is the source for the production tools bundled with the
`semantic-flow` skill.

```text
npm ci --prefix ./scripts
npm test --prefix ./scripts
```

The full suite runs test files in parallel. During focused work, use the
smallest matching suite:

```text
npm run test:flow --prefix ./scripts
npm run test:implementation --prefix ./scripts
npm run test:feedback --prefix ./scripts
npm run test:view --prefix ./scripts
```

Each focused suite still type-checks and rebuilds the bundled skill before
running its tests.

`npm run build --prefix ./scripts` compiles self-contained Node.js bundles into
`skills/semantic-flow/scripts`, compiler-emits an `API.d.ts` index, focused `api/*.d.ts` modules, and `API.full.d.ts` from the documented
TypeScript API source, and copies the versioned schemas required at runtime.

Edit `src/api/*.ts` and `src/command-api.ts` together when the CLI surface
changes. The build rejects command or parameter drift and missing source JSDoc.
Do not edit generated files under `skills/semantic-flow/scripts` or generated
schema copies under `skills/semantic-flow/references`.
