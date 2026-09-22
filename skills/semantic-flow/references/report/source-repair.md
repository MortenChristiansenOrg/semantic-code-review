# Maintained source repair

Read only for an authorized source fix, after [Temporary local fixes](local-fix.md).
Keep the affected project, installation, and maintained checkout distinct.

## Edit the maintained source

Choose files by responsibility:

| Concern | Maintained source |
| --- | --- |
| Command routing | `skills/semantic-flow/SKILL.md` |
| Command workflows | `skills/semantic-flow/commands/` |
| Shared runtime and quality rules | `skills/semantic-flow/docs/runtime.md`, `skills/semantic-flow/docs/artifact-quality.md` |
| Semantic implementation CLI | `scripts/src/semantic-implementation.ts` |
| Review feedback CLI | `scripts/src/review-feedback.ts` |
| Runtime command and option definitions | `scripts/src/command-api.ts` |
| Published TypeScript command contract and JSDoc | `scripts/src/api/*.ts` (indexed by `scripts/src/api.ts`) |
| Contract validation or skill packaging | `scripts/src/api-contract-check.ts`, `scripts/src/build-skill.ts` |
| Artifact schemas | `standard/v0.1/schema/` |
| Feedback schemas | `standard/v0.1/feedback-schema/` |
| Working-stage schema | `scripts/schemas/work-stage.schema.json` |
| CLI regression coverage | `scripts/tests/` |
| User-facing concepts and formats | `docs/` |

When the CLI surface changes, edit `scripts/src/command-api.ts` and
`scripts/src/api/*.ts` (indexed by `scripts/src/api.ts`) together. Keep source JSDoc accurate because the generated
API declaration is user-facing guidance.

Do not directly edit generated files:

- `skills/semantic-flow/VERSION`
- `skills/semantic-flow/scripts/*.mjs`
- `skills/semantic-flow/scripts/API.d.ts`
- `skills/semantic-flow/references/schema/`
- `skills/semantic-flow/references/feedback-schema/`
- `skills/semantic-flow/references/work-stage.schema.json`

The build replaces those files from their maintained sources. Inspect generated
bundles only as a last-resort diagnostic after the skill guidance, generated
API declaration, source, and observed error fail to explain the behavior.

Make the smallest complete source change. Add or update a regression test that
recreates the target-repository failure for executable or schema defects.
Update skill guidance or repository documentation when behavior or the
supported workflow changes.
