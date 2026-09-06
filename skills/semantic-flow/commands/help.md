# Help command

This command explains the installed skill. It is read-only.

## `/semantic-flow help`

Read the installed `SKILL.md` index and enumerate the commands it currently
contains. Generate a concise one-line explanation for each command by reading
its installed command file. Do not rely on a hard-coded command list outside
the index.

Include natural-language usage and one example:

```text
Implement the current user story using semantic flow
```

For bugs in the skill, CLI, or viewer, mention the separate `semantic-flow-report`
skill when relevant. It guides diagnosis and bug reporting to the upstream
repository; it is not the `feedback` command for an implementation review.
If installed, invoke `/semantic-flow-report <problem>` (or the host's `$` form).
Otherwise point to the installation instructions in the
[upstream README](https://github.com/MortenChristiansenOrg/semantic-code-review#report-a-semantic-flow-problem).
It does not require a developer checkout or the repair skill. Do not load its
instructions or start reporting merely to answer a help request.

## `/semantic-flow help <command>`

1. Resolve `<command>` through the installed `SKILL.md` index.
2. Read that command file completely.
3. Read every shared document the command explicitly requires.
4. When CLI behavior matters, inspect the installed `scripts/API.d.ts`.
5. Explain the command based on those installed files, covering:
   - What it is for.
   - Preconditions and discovery behavior.
   - The work it performs in order.
   - Files, branches, artifacts, or feedback it may mutate.
   - Validation and human gates.
   - Its output and stopping point.

Write the explanation for the current installed version. Do not return a
prewritten description from this file or rely on memory. If the command is not
indexed, show the available commands discovered from `SKILL.md`.

Help must not invoke workflow CLIs, switch branches, edit files, or update the
skill.
