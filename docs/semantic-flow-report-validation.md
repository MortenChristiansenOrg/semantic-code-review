# Validating the report command

`skills/semantic-flow/commands/report.md` is instruction-only behavior distributed
with the main skill. Reporting has no executable dependency or issue-submission
helper. Validate decisions with realistic scenarios, not assertions that particular
words appear in Markdown.

## Packaging and integration checks

The release archive test installs the complete built main skill into a fresh
folder without a source checkout, checks the report command and template, and
resolves every local reference reachable from the command inside that installation.
The normal build preserves these maintained reporting resources. The same archive
and installation replacement mechanism deliver implementation and reporting together.

Use the host's skill validator when available. Exercise `/semantic-flow report`,
`$semantic-flow report`, natural-language bug reporting, and `/semantic-flow help report`.
Help must explain the command without diagnosis, authentication, or publication;
implementation review feedback must still route to `feedback`. Ordinary implementation
commands must retain their authorized recovery behavior and avoid loading reporting
references. Reporting must remain usable with a broken CLI or no Node.js.
Never point a publication simulation at live write tools.

## Simulated behavioral checks

Before consolidation (#16), an independent evaluator received the standalone skill, realistic requests, and the raw
facts below, without the implementation author's intended responses. It performed
simulated workflow decisions and produced drafts/responses in a temporary
directory; it did not authenticate, query live GitHub, or mutate repositories.
These checks demonstrate instruction behavior in the evaluation, not guaranteed
behavior across all models/connectors or a live end-to-end publication test.

| Scenario supplied to evaluator | Observed response or stopping point |
| --- | --- |
| First review opens the first stage; connector identifies `alice` but is read-only; search returns matching #15; installed version is `0.1.0` with no source checkout | Linked the matching report, explained the default, and did not create a duplicate or claim a verified fix/current installation. No repair resources were needed. |
| Offline restack failure; invocation, error and provenance unknown; active implementation must remain untouched | Preserved an explicitly incomplete, unsubmitted draft and asked for recoverable sanitized error output. Did not rerun restack, require login, or invent reproduction steps. |
| Maintainer approves exact title/body as `alice`; actual CLI profile is `bob`; failing installation is a customized user-level copy | Stopped before submission, retained the exact approved payload, and requested the intended account or approval for the changed identity. Did not substitute the maintainer checkout's provenance. |
| Approved create times out; search is empty but the direct recent-issue listing contains matching author/title/body/time and upstream URL | Identified the original successful submission, verified the intended destination, and did not retry. |
| Blocking defect; no source checkout/fork; original evidence includes private data and a token; no repair authorization | Offered an optional separate local checkout and whole-skill rebuild, kept a hosted fork optional, withheld sensitive evidence, and stopped for repair scope agreement. |
| `review --publish` is rejected; the installed API documents `publish` only on `validate` | Explained the supported invocation and asked whether an instruction supplied the invalid command, leaving room for a documentation defect without inventing a CLI bug or executing mutations. |
| Verified installed commit A and upstream B both report `0.1.0`; B includes a breaking storage change; user declines updating an active customized installation | Retained A as affected provenance, recorded the declined update and untested potential fix, and continued gathering report evidence without replacing the installation. |
| Complete sanitized report and public research are available; no authenticated account or CLI; host offers a connector sign-in UI | Kept the draft, requested the available connection flow, and deferred exact-account/payload confirmation until identity verification. Offered manual browser submission if connecting is declined. |

The evaluator found one concrete navigation defect: abbreviated workflow source
paths in the optional local-fix table could be read relative to the repository
root. Those paths were expanded to `skills/semantic-flow/commands/` and
`skills/semantic-flow/docs/`; the evaluator confirmed both corrected paths exist.

## Access-method limits to retain

- Public reads do not prove authenticated issue-write capability. Do not create
  probe issues; disclose unverifiable permissions and handle submission errors.
- A connector may expose a bot, omit the account identity, lack posting tools, or
  search an incomplete index. Manual browser submission remains supported.
- CLI, connector, and browser identities may differ. Approval binds to the exact
  payload and publishing identity, and account changes require reconciliation.
- A browser-only host may be unable to inspect local versions or create a local
  draft file. Preserve a copyable draft and mark unavailable evidence honestly.
- Search can lag creation; even an empty recent-item listing cannot prove that
  an in-flight write failed. Ambiguous requests must not trigger blind retries.
- A version label or containing repository commit is insufficient build provenance.
  Updates and temporary repairs remain optional and separately authorized.

Repeat relevant scenarios after changing submission, identity, diagnostic, or
update guidance. For a live publication check, use an explicitly authorized test
repository/account and payload; the ordinary upstream issue tracker is not a test
sink.

## Consolidation review (#70)

After consolidation, an independent evaluator read the main skill and relevant
command/reference files as data, with no live tools or repository mutations. It
simulated these routes and decisions:

- Offline restack crash with active work and no Node.js: preserve evidence and a
  sanitized incomplete draft; read `VERSION` when available; no recovery mutations.
- Approved payload for `alice`, actual publishing identity `bob`: stop posting
  until the intended identity is restored or exact content/account is reapproved.
- Timed-out create with an exact recent API match despite empty search: inspect
  and return the existing item; do not retry.
- Authorized separate source fix without installation replacement: use bundled
  source guidance, reproduce/build/test, and stop with the local fix; no install,
  push, or publication.
- `help report`: explain the workflow without diagnosis, authentication, or writes.
- Implementation reviewer comments: route to `feedback`.
- Ordinary implementation restack conflict: retain authorized guarded recovery
  without loading reporting instructions.

No missing resources or substantive contradictions were found. The evaluator
noted that verified absence after an ambiguous submission is necessarily dependent
on the tool's evidence; the existing rule stops when the outcome remains uncertain.
These simulations do not establish live host or publication behavior.
