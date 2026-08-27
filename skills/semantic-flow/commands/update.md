# Update command

Use to rebuild semantic-flow from its maintained local source checkout and
replace the installed skill. This command does not touch the target
repository's implementation code or artifacts.

Read `../docs/runtime.md`, `../scripts/API.d.ts`, and the selected
operating-system guide.

## Run the updater

Run:

```text
<semantic-flow> update
```

The updater resolves the installed skill from its own location and looks for
`semantic-code-review` beside the target repository. If the source lives
elsewhere, rerun with `--source <repository-path>`. It validates the source
layout and never searches arbitrary drives or clones a remote.

For a clean source branch with an upstream, it pulls with `--ff-only`, installs
missing dependencies, builds the skill without running the test suite, verifies
the built skill, and replaces the installation as one directory. It checks the
installed version and key file hashes afterward. When the source skill is the
active installation, the successful build is the update.

If the source is dirty, detached, or lacks an upstream, the updater stops
without changing it. Explain the reported state and ask whether to use the
current checkout. Only after explicit approval rerun:

```text
<semantic-flow> update --use-current-source
```

Never use that flag without approval. The updater does not discard source
changes. It reports the previous and installed versions, source branch and
commit, and installed path.
