# Update command

Install the latest published release of Semantic Flow, or with `-p` the latest
release including prereleases. This command replaces the
installed skill without changing repository code, implementation artifacts, or
feedback files. Updates can run from any directory, including outside Git.

`<semantic-flow>` means `node` followed by the quoted absolute path to
`<installed-skill-root>/scripts/semantic-flow.mjs`. Run:

```text
<semantic-flow> update
```

## Prereleases

`/semantic-flow update -p` and `/semantic-flow update --prerelease` mean the
same thing. For either, run:

```text
<semantic-flow> update --prerelease
```

It installs the highest version among normal releases and prereleases
(`X.Y.Z-rc.N`). Pass `--prerelease` only when the user asked for a prerelease,
never on your own, and tell the user that a prerelease is less tested than a
normal release. The choice holds for this run only; nothing is stored.

Plain `update` stays on normal releases. On a prerelease installation it moves
only to a normal release of the same version or newer. While the installed
prerelease is newer than every normal release, it changes nothing and says so;
report that `/semantic-flow update -p` gets later prereleases. An installed
version that reports no `--prerelease` option, or rejects a prerelease version,
predates prereleases: point the user to the one-time manual installation in the
release documentation instead of improvising a workaround.

The helper downloads the built GitHub release, displays its notes and any skipped
release notes, verifies checksums, archive paths, required files, version, and
runtime requirements, and replaces the whole installation. It needs no local
source checkout or build dependencies. Use `GH_TOKEN` or `GITHUB_TOKEN` when
GitHub requires authentication or reports an API rate limit. Never print tokens.

Surface breaking changes and upgrade steps from the notes. All `0.x` releases
are experimental and may break compatibility. Updating the skill does not
migrate existing artifacts. A newer local version is not silently downgraded.

When invoked inside Git, the helper identifies a matching viewer for the current
repository or a linked worktree, requests shutdown, and waits for the process to exit before replacing
files. It then restarts the viewer at the same URL without opening another browser tab.
Browser drafts remain in the browser. Unrelated viewers are left alone.
Outside Git, viewer discovery and shutdown are skipped.
Do not stop the launcher shell or improvise process termination. Use the same
`SEMANTIC_VIEW_PORT` setting as the original launch when a custom port is configured.

Download or validation failures leave the old installation and viewer running.
A replacement failure restores the old installation and attempts to restart its
viewer. If the new viewer cannot restart, the helper reports that the skill was
installed and explains how to reopen it. Report the previous/installed versions,
source commit, installation path, and release-notes link.

For an explicitly requested version or recovery:

```text
<semantic-flow> update --version X.Y.Z
<semantic-flow> update --version X.Y.Z --allow-downgrade
```

An explicit version may be a prerelease (`--version 0.15.0-rc.2`) and needs no
`--prerelease`. Use `--allow-downgrade` only when the user intends to restore
older tooling, including going from a normal release back to one of its
prereleases; downgrading cannot undo changes to data formats.

## Contributor source updates

Only when the user wants a local source build, run:

```text
<semantic-flow> update --source /path/to/semantic-code-review
```

The invocation directory need not be a Git repository. The helper validates the
explicit source, pulls a clean branch with an upstream using `--ff-only`, installs missing dependencies, builds, verifies, and replaces
the skill. It does not run the source test suite. A dirty, detached, or source
branch without an upstream stops the update. Under `../docs/user-decisions.md`,
explain that this would install the checkout's current contents (including any
uncommitted changes), rather than verified latest upstream contents. Ask whether
that is the intended source only if not already authorized; then add
`--use-current-source`. Do not present the flag itself as the user's choice.
Existing authorization to use that checkout is sufficient. Source updates never
discard changes, cannot be combined with `--prerelease`, and are never a fallback
for failed release downloads.

When invoked from the source repository, follow its `AGENTS.md` destination rules.
Never replace this repository's source skill with a release installation.
