# Artifact viewer usability mockups

Fifteen no-build HTML prototypes built from the artifacts in
`/home/morten/code/chat-app/.semantic-review`.

Run from the repository root:

```bash
python3 -m http.server 4180 --directory mockups/artifact-viewer
```

Then open <http://127.0.0.1:4180>.

Directions 1–10 deliberately remove source-control metadata and file diffs. The
shared review data emphasizes requirements, implementation intent, linked
decisions/assumptions/risks/lessons, and human-readable validation evidence.
Approvals and personal notes are stored locally in the browser, independently
for each concept. Every direction includes a shared review-coverage panel, and
all disclosures and moving reading surfaces include reduced-motion-aware
transitions.

Directions 11–15 extend Quiet Checklist with single-column, project-grouped
file inventories, compact filenames, integrated Git excerpts, and file-level
approvals and notes. Each implementation surface reserves enough desktop space
for at least 160 monospace characters and 30 visible diff rows.
