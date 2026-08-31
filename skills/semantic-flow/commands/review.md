# Review command

Use to open the local semantic review viewer. This command is read-only with
respect to implementation artifacts and implementation branches.

`<semantic-flow>` means `node <installed-skill-root>/scripts/semantic-flow.mjs`.
Quote the script path. Launch:

```text
<semantic-flow> review [--project <repository-or-worktree-path>] [--implementation-id <id>]
```

The helper resolves linked worktrees without requiring `targetBranch` to match
the invoking branch, then starts the bundled viewer. It reports the local URL
only after the server is listening, so do not run a separate inspect,
validation, or HTTP probe. Keep the process running.

The viewer renders stages, change nodes, project-grouped files, linked insights,
full-context diffs, and feedback threads. A user can add and edit draft notes
before sending. Sent notes become open threads; agent follow-ups appear in
the same thread after the feedback workflow runs. It reads
`.semantic-review` once at launch. Restart it to show later artifact changes.

Feedback and browser-local review state may be created through the viewer, but
the launch command itself must not mutate the artifact, switch branches,
approve work, or prepare outputs. Run feedback CLI commands from the resolved
artifact worktree root.
