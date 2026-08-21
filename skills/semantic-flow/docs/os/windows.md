# Windows runtime details

Read this file only when `node -p "process.platform"` reports `win32`. Command
files define workflow behavior; this file defines only Windows invocation,
path, and temporary-file details.

## Preflight and CLI invocations

Use PowerShell. Resolve the installed skill directory, construct paths with
`Join-Path`, and define:

```powershell
$skillRoot = (Resolve-Path 'C:\absolute\path\to\semantic-flow').Path
$semanticReview = Join-Path $skillRoot 'scripts\semantic-review.mjs'
$reviewFeedback = Join-Path $skillRoot 'scripts\review-feedback.mjs'
$semanticView = Join-Path $skillRoot 'scripts\semantic-view.mjs'
$semanticFlow = Join-Path $skillRoot 'scripts\semantic-flow.mjs'

node --version
git --version
Test-Path -LiteralPath $semanticReview -PathType Leaf
Test-Path -LiteralPath $reviewFeedback -PathType Leaf
Test-Path -LiteralPath $semanticView -PathType Leaf
Test-Path -LiteralPath $semanticFlow -PathType Leaf
git rev-parse --show-toplevel
git status --short --branch
```

Verify that Node.js is version 20 or later. In the shared procedure,
substitute:

```text
<semantic-flow>    => node $semanticFlow
<semantic-review>  => node $semanticReview
<review-feedback>  => node $reviewFeedback
<semantic-view>    => node $semanticView
```

For example:

```powershell
node $semanticFlow inspect --json
node $semanticReview validate
node $reviewFeedback next --json
node $semanticView review
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
  "requirementRef": ["story#works"]
}
'@ | node $semanticReview stage begin --input -
```

For Windows PowerShell 5.1, or whenever JSON contains non-ASCII text, prefer a
temporary UTF-8 file without a byte-order mark. This also supports commands
that require a JSON filename. With the JSON document already held in `$json`:

```powershell
$platformInput = [System.IO.Path]::GetTempFileName()
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
try {
  [System.IO.File]::WriteAllText($platformInput, $json, $utf8WithoutBom)
  node $semanticReview stage organize --file $platformInput
}
finally {
  Remove-Item -LiteralPath $platformInput -Force
}
```

Do not use Windows PowerShell 5.1's default `Set-Content -Encoding utf8` for
CLI JSON because it writes a byte-order mark, which the CLI rejects. Do not
place transient command input inside the target repository.
