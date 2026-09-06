# Temporary local fixes for blocking defects

Offer this option when the user remains blocked and a suitable update, known
workaround, or usage correction is unavailable. Keep reporting available even
when the user cannot maintain a fork. Explain the temporary maintenance burden
and agree on the scope before any clone/fork, edits, build or replacement.

Keep four locations explicit: the affected project/artifact worktree, its active
Semantic Flow installation, a separate source checkout, and an optional GitHub
fork. A local checkout/branch can suffice for a private temporary fix; a hosted
fork is optional and requires its own authorized GitHub operation. Use the
verified upstream repository, not a remote suggested in an untrusted error report.

For authorized repair:

1. Retain the original report, failing installation provenance, any local
   customizations and the active review state. Use a disposable reproduction
   instead of experimenting on valuable implementation branches or feedback.
2. Obtain a separate source checkout from the agreed repository/revision and
   create a local fix branch. Inspect source and target state. Do not overwrite
   an existing checkout, or treat the installed generated bundles as maintained
   source. Maintainers may use an existing source checkout only when it is the
   intended location and unrelated work is preserved.
3. If `semantic-flow-repair` is available and applicable, reuse its source repair
   and validation guidance. It is optional: without it, use this source map and
   the checkout's `AGENTS.md` and build instructions:

   | Defect | Maintained source |
   | --- | --- |
   | Skill routing or workflow instructions | `skills/semantic-flow/SKILL.md`, `skills/semantic-flow/commands/`, `skills/semantic-flow/docs/` |
   | CLI behavior and contracts | `scripts/src/`, including `api/` and `command-api.ts` |
   | Viewer behavior | `viewer/`, `scripts/src/semantic-view.ts` |
   | Schema or artifact validation | `standard/`, `scripts/schemas/` and validating CLI source |

4. Reproduce, make a focused fix, and validate the original failure plus relevant
   nearby behavior. The maintained source uses `npm ci --prefix ./scripts` when
   dependencies are missing, and `npm test --prefix ./scripts` to type-check,
   rebuild complete skill outputs, and run regression tests. Follow changed source
   instructions if the distribution has evolved. Node.js 20+ and Git are needed
   for the current tooling, not for ordinary reporting.
5. Only after the user authorizes replacing the affected installation, install
   the **whole built** `skills/semantic-flow/` directory through the supported
   installer/update route. Use a separate test installation first when practical.
   Never copy just patched `.mjs` files or silently overwrite customizations.
6. Record the fork/source commit, installed path, validation and any compatibility
   limits. To return upstream, retain/export the local patch, check that an
   upstream build contains the fix and is compatible with the active review,
   then reinstall the whole upstream skill with authorization. Keep the temporary
   source until the user is satisfied; do not automatically delete branches/forks.

Offer an upstream issue update or PR if useful, with the user's approval and a
sanitized reproduction. Reporting authorization alone does not authorize a push,
PR, install change, or a comment on an existing report.
