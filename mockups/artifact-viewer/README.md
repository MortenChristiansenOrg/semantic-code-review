# Artifact viewer usability mockups

Ten no-build HTML prototypes built from the artifacts in
`/home/morten/code/chat-app/.semantic-review`.

Run from the repository root:

```bash
python3 -m http.server 4180 --directory mockups/artifact-viewer
```

Then open <http://127.0.0.1:4180>.

Each direction deliberately removes source-control metadata and file diffs. The
shared review data includes only requirements, implementation intent, linked
decisions/assumptions/risks/lessons, and human-readable validation evidence.
Approvals and personal notes are stored locally in the browser, independently
for each concept. Every direction includes a shared review-coverage panel, and
all disclosures and moving reading surfaces include reduced-motion-aware
transitions.
