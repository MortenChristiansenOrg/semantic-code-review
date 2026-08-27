# Linux runtime details

Read this file only when `node -p "process.platform"` reports `linux`. This
includes WSL and Linux containers. Command files define workflow behavior; this
file defines only Linux invocation, path, and temporary-file details.

## Preflight and CLI invocations

Use a Bash-compatible shell for these examples. Resolve the installed skill
directory to an absolute path, quote every filesystem path, and define:

```bash
skill_root="/absolute/path/to/semantic-flow"
semantic_implementation="$skill_root/scripts/semantic-implementation.mjs"
review_feedback="$skill_root/scripts/review-feedback.mjs"
semantic_view="$skill_root/scripts/semantic-view.mjs"
semantic_flow="$skill_root/scripts/semantic-flow.mjs"

node --version
git --version
test -f "$semantic_implementation"
test -f "$review_feedback"
test -f "$semantic_view"
test -f "$semantic_flow"
git rev-parse --show-toplevel
git status --short --branch
```

Verify that Node.js is version 20 or later. In the shared procedure,
substitute:

```text
<semantic-flow>    => node "$semantic_flow"
<semantic-implementation>  => node "$semantic_implementation"
<review-feedback>  => node "$review_feedback"
<semantic-view>    => node "$semantic_view"
```

For example:

```bash
node "$semantic_flow" inspect --json
node "$semantic_implementation" validate
node "$review_feedback" next --json
node "$semantic_view" review
```

Use forward slashes for Linux filesystem paths. Also use forward slashes for
repository paths stored in artifacts or supplied through options such as
`--path`.

## JSON input

Prefer stdin for commands accepting `--input -`:

```bash
node "$semantic_implementation" stage begin --input - <<'JSON'
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
node "$semantic_implementation" stage organize --file "$platform_input"
rm -f -- "$platform_input"
```

Do not place transient command input inside the target repository.
