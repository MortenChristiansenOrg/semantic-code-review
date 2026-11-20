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

`npm run build --prefix ./scripts` compiles the self-contained Node.js
executable `semantic-flow.mjs` into `skills/semantic-flow/scripts`, compiler-emits an `API.d.ts` index, focused `api/*.d.ts` modules, and `API.full.d.ts` from the documented
TypeScript API source, and copies the versioned schemas required at runtime.

Edit `src/api/*.ts` and `src/command-api.ts` together when the CLI surface
changes. The build rejects command or parameter drift and missing source JSDoc.
Do not edit generated files under `skills/semantic-flow/scripts` or generated
schema copies under `skills/semantic-flow/references`.

### Viewer browser regressions

Run `npm ci`, then `npx playwright install chromium` (or
`npx playwright install --with-deps chromium` on a fresh Linux CI machine), and
`npm run test:browser` from `scripts/`. `viewer.spec.mjs` serves the production
viewer with intercepted fixture responses and covers layout at empty/short/overflowing
sizes, saved stage choices, feedback refresh, keyboard submission, node context,
and accessible tooltips. `real-viewer.spec.mjs` starts real viewers with the CLI
on fixture repositories and covers launch links, the page's content security
policy, the fresh-link notice, and switching between viewers on different ports.

The artifact command suite also scripts recovery from an unsupported decision
category: the rejected write preserves application work, a supported retry keeps
the observed rationale, and the stage finishes. This verifies the recovery path;
it is not an evaluation of a particular model's compliance with the skill.

### Releases

See [the release workflow](../docs/releases.md). `npm run release -- next breaking`
previews the next version; `bump breaking` applies it. After checks and a commit,
`npm run release -- package` builds and smoke-tests the distribution archive.
Release assets contain dependency license texts collected during the build.
The repository has no project license file; packaging does not introduce new
license terms. If a project `LICENSE` is added, it is included automatically.
