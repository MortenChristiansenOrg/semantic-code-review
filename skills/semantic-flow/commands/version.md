# Version command

Use to report the installed semantic-flow version. This command is read-only.

`<semantic-flow>` means `node` followed by the quoted absolute path to
`<installed-skill-root>/scripts/semantic-flow.mjs`. This command is self-contained;
read `../scripts/api/workflow.d.ts` only when options or an unexplained error
require it. Reuse known runtime details; do not run separate discovery or
validation before the helper. Run:

```text
<semantic-flow> version
```

The helper reports the installed skill version, artifact and feedback format
versions, skill root, and a source commit only when the installed skill is in a
Git checkout. It reports a missing `VERSION` as unversioned.
