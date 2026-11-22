# Windows runtime details

Read this file only when `node -p "process.platform"` reports `win32`. Command
files define workflow behavior; this file defines only Windows invocation,
path, and temporary-file details.

## Preflight and CLI invocations

Use PowerShell. Resolve the installed skill directory, construct paths with
`Join-Path`, and define:

```powershell
$skillRoot = (Resolve-Path 'C:\absolute\path\to\semantic-flow').Path
$semanticFlow = Join-Path $skillRoot 'scripts\semantic-flow.mjs'

node --version
git --version
Test-Path -LiteralPath $semanticFlow -PathType Leaf
git rev-parse --show-toplevel
git status --short --branch
```

Verify that Node.js is version 22 or later. In the shared procedure,
substitute:

```text
<semantic-flow> => node $semanticFlow
```

For example:

```powershell
node $semanticFlow inspect --json
node $semanticFlow implementation validate
node $semanticFlow feedback next --json
node $semanticFlow review
```

Use `Join-Path` or quoted absolute paths for Windows filesystem paths. Use
forward slashes—not backslashes—for repository paths stored in artifacts or
supplied through options such as `--path`, because those paths use Git's
cross-platform representation.

## JSON input

PowerShell 7 can pipe a here-string to commands accepting `--input -`:

```powershell
@'
{
  "id": "implement-behavior",
  "title": "Implement behavior",
  "summary": "Add the requested behavior.",
  "rationale": "Keep the behavior independently reviewable.",
  "specificationRef": ["story#works"]
}
'@ | node $semanticFlow implementation stage begin --input -
```

For Windows PowerShell 5.1, or whenever JSON contains non-ASCII text, prefer a
temporary UTF-8 file. This also supports commands that require a JSON
filename. With the JSON document already held in `$json`:

```powershell
$platformInput = [System.IO.Path]::GetTempFileName()
try {
  Set-Content -LiteralPath $platformInput -Value $json -Encoding utf8
  node $semanticFlow implementation stage organize --file $platformInput
}
finally {
  Remove-Item -LiteralPath $platformInput -Force
}
```

Windows PowerShell 5.1 writes a byte-order mark with `-Encoding utf8`; the CLI
accepts one in JSON given as a file or on standard input. Artifact and feedback
documents may not contain one. Do not place transient command input inside the
target repository.
