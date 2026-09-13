# Releases and updates

Semantic Code Review distributes the built Semantic Flow skill through
[GitHub releases](https://github.com/MortenChristiansenOrg/semantic-code-review/releases).
The release version covers the skill, its bundled CLI, schemas, and viewer.
`scripts/package.json` is authoritative; the lockfile and built `VERSION` agree
with it. `RELEASE.json` in the archive records the version, source commit, runtime
requirement, and every packaged file's SHA-256 digest.

## Version and compatibility policy

Every `0.x` release may break compatibility, including a patch release. Our
default is one minor increment per release (`0.2.0`, `0.3.0`, …); patch releases
are reserved for explicitly requested corrections and carry the same experimental
policy. Moving to `1.0.0` requires an explicit maintainer decision.

From `1.0.0`, use [semantic versioning](https://semver.org/): incompatible public
changes increment the major version, compatible additions/deprecations increment
the minor version, and compatible fixes increment the patch version. The highest
required increment wins. The public contract includes documented skill workflows,
CLI/API arguments and outputs, stored data formats, and runtime requirements.
Internal changes alone do not imply a breaking release.

Release versions and data-format versions are separate. During `0.x`, the
implementation and feedback formats remain `0.1` and may change in place; there
is no migration or backward-compatibility guarantee. JSON schema validation
rejects unsupported formats and invalid fields. Finish or archive active work
before incompatible changes, or retain its matching skill version. At the 1.0
transition, freeze and document supported data contracts. Subsequent incompatible
format changes require distinct format identifiers, an explicit support/upgrade
policy, and a major product release. Routine releases do not create new formats.

Normal `0.x` releases are published releases, not GitHub prereleases. The updater
chooses the highest numeric `vMAJOR.MINOR.PATCH` among non-draft, non-prerelease
releases, regardless of publication date. A broken latest release is reported;
the updater does not silently fall back to an older release. Preview tags are
excluded. The publisher marks a release latest only if no higher published
version exists, so a late maintenance release cannot move users backward.

## Installing and updating

Install Node.js 20 or newer and Git. No source checkout, npm dependencies, or
build toolchain is needed to use the packaged skill. Windows, macOS, and Linux
use the same archive. The separate reporting skill is not bundled.

Download `semantic-flow-X.Y.Z.zip` and `semantic-flow-X.Y.Z.zip.sha256` from the
same release. Use the uploaded asset, rather than GitHub's source-code archive.
On Linux, verify with `sha256sum -c semantic-flow-X.Y.Z.zip.sha256`; on macOS use
`shasum -a 256 -c semantic-flow-X.Y.Z.zip.sha256`. On Windows, compare
`(Get-FileHash .\semantic-flow-X.Y.Z.zip -Algorithm SHA256).Hash` with the digest
in the checksum file. Then extract using your platform's ZIP tool and place the
complete `semantic-flow` folder in the skills directory used by your harness.

For an existing source-based installation, first stop its matching viewer through
`POST http://127.0.0.1:29180/api/shutdown` with `Content-Type: application/json`
and body `{}` (use its configured port). Wait for it to exit. Keep the old skill
folder as a backup, replace the entire folder, then run the new skill's `version`
and `review` commands. Restore the backup if installation fails. Old updater
instructions can alternatively use an explicitly authorized local build of this
release once, followed by normal release updates. Do not replace this repository's
source skill with a release archive.

After installation, ask for `/semantic-flow update`. It displays release notes,
including skipped versions, verifies the download and all file digests, and then
replaces the installed directory. A matching viewer is stopped only after
validation and restarted at the same URL. Current browser drafts stay in place.
Repository code, artifact files, and feedback files are untouched.

For a chosen version, run `node /path/to/semantic-flow/scripts/semantic-flow.mjs update --version X.Y.Z`.
Downgrading additionally requires `--allow-downgrade`; this restores tooling, not
data that a later version changed. Equal release versions are a no-op; an
equal-version source build is replaced with the official release. Locally newer
installations are never implicitly downgraded. Use `GH_TOKEN` or `GITHUB_TOKEN` if
GitHub access requires authentication or a higher API rate limit. Credentials are
sent only to GitHub's API.

The updater validates before replacement and restores the old directory if the
replacement fails. A failure to restart the newly installed viewer is reported
separately; run `review` after resolving the reported port/runtime problem.
Downloads and extraction failures leave the old installation and viewer running.

Contributors may explicitly use `update --source /path/to/semantic-code-review`.
This preserves source validation, fast-forward pulls, local builds, and the
approved `--use-current-source` override. It is never an automatic fallback.

## Maintainer workflow: “bump the version”

Work in a branch and follow the normal PR workflow. A request for a release
authorizes its preparation; carry out publication when the maintainer's request
includes it. A request for a PR ends at the reviewed PR unless publication was
also requested. Do not use the Semantic Flow skill on this repository.

1. Fetch tags and inspect published releases. Identify the last published version
   and the intended release commit. Read the diff, tests, and relevant PRs/issues
   since that release; commit prefixes alone cannot classify compatibility.
   For the first packaged release, the source baseline is
   `08aade5457db696039ddd435406cf0c98b2aa31f` (the last `0.1.0` source snapshot).
   The `0.2.0` notes introduce the bundled product and summarize changes from that
   baseline, rather than pretending an earlier GitHub release exists.
2. Explain the highest-impact change classification. Run `npm run release --prefix scripts -- next breaking`
   (or `feature`, `fix`, `none`) to preview, then `npm run release --prefix scripts -- bump breaking`
   to update metadata. `none` stops instead of inventing an empty release.
   Use `--stable` only for an explicitly requested 1.0 transition. For an explicit
   experimental patch correction, edit package/lockfile versions together and
   rebuild; document why the default minor increment was overridden. Never move
   an existing release tag.
3. Write `releases/X.Y.Z.md` using `releases/TEMPLATE.md`. Write a fresh summary
   of user-visible changes in simple language. Group related changes, explain
   technical terms, and omit internal churn and empty optional sections. Keep
   Overview, Breaking changes (write “None” when appropriate), and Updating.
   Make specific breaking changes and upgrade actions prominent; include the
   experimental note during `0.x`. Generated GitHub notes are research input,
   not the finished changelog. The publisher removes only the leading version/date
   heading (and following blank space) from the reviewed file because GitHub
   already displays the version as the release title. All note sections remain
   intact, and publication verifies this exact rendered body.
4. Run `npm ci --prefix scripts`, `npm test --prefix scripts`, install Chromium
   with `npm exec --prefix scripts -- playwright install chromium`, and run
   `npm run test:browser --prefix scripts`. Commit the version, notes, and built
   skill with the implementation. Do not include unrelated uncommitted work.
5. From that clean commit, run `npm run release --prefix scripts -- package`.
   This writes `dist/semantic-flow-X.Y.Z.zip` and its checksum, checks metadata,
   extracts the actual archive, and runs the bundled commands without a source
   checkout. Repeating it on the same commit produces the same bytes. CI runs
   this rehearsal on all three supported operating systems.
6. After the PR lands and publication is authorized, check out the intended
   release commit and create/push its matching annotated tag, for example
   `git tag -a v0.2.0 -m "Release 0.2.0"` and `git push origin v0.2.0`.
   The Release workflow runs the full validation matrix, rebuilds from the exact
   tag, and publishes through `npm run release --prefix scripts -- publish`.
   GitHub Actions needs `contents: write` for publication; local publication
   additionally needs an authenticated `gh` CLI with repository write access.
7. Verify the workflow, release URL, notes, downloadable archive, installed version,
   and latest-release selection. Report the version choice and validation outcome.

Publication creates a draft, uploads the archive/checksum, downloads and compares
them with the tested files, verifies the reviewed notes, then publishes. Retry a
failed workflow on the same tag: draft assets can be replaced, while published
releases are refused. If a published release needs a fix, make a new version.
If publication succeeded but a final check failed, inspect the existing release
instead of recreating it. Never delete a published release or move its tag as a
recovery step. Concurrent release jobs are serialized.

## Experimental compatibility audit (0.2.0, issue #7)

The audit covered artifact/feedback parsers, CLI contracts, and browser storage.
Specification source kinds are now extensible strings; references remain
required, supplied URLs remain URI-validated, and `kind: url` still requires a URL.
No artifact or CLI migration layers were found. Removed browser conversions for
the old `specificationOpen` boolean and `active` file, old boolean/fingerprint
approval handling, and cleanup of obsolete node approval entries. Invalid UI
preferences reset rather than being converted; current persisted state is kept.

Retained file-rename approval handling and revision staleness checks because they
describe changes to reviewed projects. Retained viewer process identity/shutdown
safeguards because they protect live processes during updates. The `migration`
change classification describes work in reviewed projects and is unrelated to
compatibility code. No replacement migration layer or new schema version was added.
