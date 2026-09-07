# Versions and updates

Identify the affected installation before comparing versions. The reporting skill
and a nearby source checkout are not evidence of what the user actually ran.
Use installation metadata, an update receipt, a known source revision/channel,
and the affected installed files. Preserve evidence of customization and the
original error before any update.

If a local runtime is available, the affected skill's read-only version helper is:

```text
node "<affected-skill-root>/scripts/semantic-flow.mjs" version --json
```

Use its absolute path. If it cannot run, read `VERSION` and relevant installed
instructions instead; a missing/older version command is not a reporting blocker.
Do not run implementation discovery or validation just to obtain a version.

The current experimental format uses `0.1.0` for different source commits. The
version helper reports `sourceCommit` only when its directory is in a Git
checkout; a repository-level copied installation may therefore report the user's
project commit, not an upstream skill revision. Verify the repository and the
skill's relationship to that commit before treating it as provenance. A source
checkout's HEAD also does not prove an installed copy was built from it.

Compare with the distribution channel the user installed (release/tag/branch),
using the official upstream release/source or that channel's maintained metadata.
For a source-channel install with no pin, discover upstream's current default
branch rather than assuming a branch name. If only version strings match, the
comparison remains inconclusive. Different hashes prove a difference, not which
copy is newer. Relevant file comparisons or known commit ancestry can establish
a specific fix is missing; matching one file cannot establish the whole install
is current. Avoid full bundle reads into the conversation when local hashes suffice.

When exact provenance cannot be established, record the installed version, source
channel if known, local-modification status (including unknown), relevant file
fingerprints/comparison, comparison date and uncertainty. Do not require cloning,
installing tooling, or authenticating merely to prepare that report.

If evidence suggests a relevant update, explain the fix and link its source.
Keep the original diagnostics, and check whether active implementation/review
state or local customizations could be affected. Experimental updates may break
schemas or storage in place. Do not promise safe continuation from version-number
equality, silently update a dirty installation, or make updating a condition of
reporting. The user may decline or defer and still submit a useful report.

If the user authorizes updating, follow the affected installation's supported
update/reinstall route, including its source and destination checks. Preserve local
customizations and relevant review state before replacement; explain any unresolved
compatibility risk. For copied installs without a source checkout, use the same
trusted distribution/installer instead of assuming a sibling developer checkout.
Never bypass an updater rejection with a force option just to finish a report.
Reproduce safely afterward when possible and record both original and updated
provenance and outcomes. A fix that is verified after update may resolve the
request without a new issue; an untested upgrade does not establish resolution.
