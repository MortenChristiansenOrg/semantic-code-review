# Validating the reporting skill

`skills/semantic-flow-report/` is an instruction-only distribution. It has no
executable dependency, generated bundle, or issue-submission helper. Its behavior
depends on the host following the instructions and accurately reporting tool
capabilities. Validate decisions with realistic scenarios, not assertions that
particular words appear in Markdown.

## Packaging and integration checks

During implementation of #16:

- The skill-creator frontmatter/naming validator passed against the source and
  a complete copy in an isolated temporary skills directory.
- All five files were copied byte-for-byte, and every local Markdown reference
  resolved inside that standalone directory. No repair skill or source checkout
  was present there.
- The five existing CLI contract/integration tests passed, including command
  routing and portability guidance. The production CLI, schema and viewer code
  were unchanged; their broader behavioral suites were not rerun for this skill.
- The documented CLI profile/repository queries worked against GitHub.com.
  The all-state symptom search found existing issue #15; direct author/recent-issue
  queries also returned the expected upstream reports. No test issue/comment was
  published and no authentication settings were changed.
- In an isolated synthetic Git repository, a copied Semantic Flow installation's
  `version --json` reported the containing project's commit. This confirms why
  the provenance guidance does not equate `sourceCommit` with an upstream build.

For a future packaging check, copy the entire reporting-skill folder to a fresh
host skills directory, resolve its relative references, then invoke it with a
synthetic scenario below. It should work without loading unrelated Semantic Flow
workflow instructions or requiring a source checkout. Use the host's skill
validator if available. Never point a publication simulation at live write tools.

## Simulated behavioral checks

An independent evaluator received the skill, realistic requests, and the raw
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
| Blocking defect; no repair skill/source/fork; original evidence includes private data and a token; no repair authorization | Offered an optional separate local checkout and whole-skill rebuild, kept a hosted fork optional, withheld sensitive evidence, and stopped for repair scope agreement. |
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
