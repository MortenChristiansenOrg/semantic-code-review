# Linux and macOS runtime details

Read this file only when `node -p "process.platform"` reports `linux` or
`darwin` (macOS). Linux includes WSL and Linux containers. Command files define
workflow behavior; this file defines only invocation, path, and temporary-file
details for these systems.

## Preflight and CLI invocations

Use a Bash-compatible shell for these examples. Resolve the installed skill
directory to an absolute path, quote every filesystem path, and define:

```bash
skill_root="/absolute/path/to/semantic-flow"
semantic_flow="$skill_root/scripts/semantic-flow.mjs"

node --version
git --version
test -f "$semantic_flow"
git rev-parse --show-toplevel
git status --short --branch
```

Verify that Node.js is version 22 or later. In the shared procedure,
substitute:

```text
<semantic-flow> => node "$semantic_flow"
```

For example:

```bash
node "$semantic_flow" inspect --json
node "$semantic_flow" implementation validate
node "$semantic_flow" feedback next --json
node "$semantic_flow" review
```

Use forward slashes for filesystem paths. Also use forward slashes for
repository paths stored in artifacts or supplied through options such as
`--path`.

## JSON input

Prefer stdin for commands accepting `--input -`:

```bash
node "$semantic_flow" implementation stage begin --input - <<'JSON'
{
  "id": "implement-behavior",
  "title": "Implement behavior",
  "summary": "Add the requested behavior.",
  "rationale": "Keep the behavior independently reviewable.",
  "specificationRef": ["story#works"]
}
JSON
```

When a command requires a JSON filename, create it outside the repository with
`mktemp`, write UTF-8 JSON using the available file-editing tool, pass the
quoted path, and remove that exact temporary file afterward:

```bash
platform_input="$(mktemp)"
node "$semantic_flow" implementation stage organize --file "$platform_input"
rm -f -- "$platform_input"
```

Do not place transient command input inside the target repository.
