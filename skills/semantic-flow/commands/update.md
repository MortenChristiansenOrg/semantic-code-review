# Update command

Use to rebuild semantic-flow from its maintained local source checkout and
replace the installed skill. This command does not touch the target
repository's implementation code or artifacts.

`<semantic-flow>` means `node` followed by the quoted absolute path to
`<installed-skill-root>/scripts/semantic-flow.mjs`. This command is self-contained;
read `../scripts/api/workflow.d.ts` only when options or an unexplained error
require it. Reuse known runtime details; do not run separate discovery or
validation before the helper.

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

The updater also handles a running viewer on the configured review port. After
the build succeeds, it identifies a viewer for this repository or a linked
worktree and this skill installation, requests shutdown through the viewer's
HTTP endpoint, and waits for the process to exit before replacing the installed
files. Older viewers without an installation path are matched by repository and
active implementation. It then restarts that viewer at the same URL without
opening another browser tab. Existing browser drafts remain in the browser.

Do not stop the launcher shell or improvise process termination. A detached
viewer survives its launcher. A failed shutdown stops the update before
installation replacement. A build failure leaves the viewer running; a failed
replacement attempts to restart it from the restored installation and reports
the error. Unrelated viewers are left alone, and no viewer is started when none
was running. Use the same `SEMANTIC_VIEW_PORT` setting as the original launch
when a non-default port is configured.

If the source is dirty, detached, or lacks an upstream, the updater stops
without changing it. Explain the reported state and ask whether to use the
current checkout. Only after explicit approval rerun:

```text
<semantic-flow> update --use-current-source
```

Never use that flag without approval. The updater does not discard source
changes. It reports the previous and installed versions, source branch and
commit, and installed path.
