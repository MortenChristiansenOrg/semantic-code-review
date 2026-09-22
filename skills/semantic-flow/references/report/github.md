# GitHub access and submission

Always target `https://github.com/MortenChristiansenOrg/semantic-code-review`.
Choose one available route and read only its subsection; all routes share the
submission/recovery rules below. Do not switch methods/accounts silently.

## Connector or authenticated API

Use the host's available GitHub tools; discover them through its tool catalog
when needed. Verify the authenticated profile and the account used for issue
creation/comments, repository readability, whether issues are enabled, and any
exposed write restrictions. A connector being installed does not establish its
identity or write capability. A service/bot identity is not the user's personal
account: disclose it and ask for a personal-authentication route if the user
wants to submit as themselves. Never describe an integration account as the user.

Use structured tool arguments for title/body to preserve literal text. Search
both open and closed issues; paginate when results are truncated. Read plausible
matches and relevant comments before choosing a duplicate. Inspect available
issue templates, labels and security policy in the upstream repository, not the
user's project. Only request attachment upload capabilities if needed.

Limit: some connectors expose neither authenticated identity nor issue creation,
or only search a limited index. Describe what could be verified; offer the CLI or
manual browser route instead of inferring account identity or write access.

## GitHub CLI (optional)

These commands use the explicit GitHub.com host/repository, so the current project
remote and an enterprise-host default cannot redirect the report. Run independent
read-only queries together where the host supports it:

```text
gh api --hostname github.com user --jq .login
gh api --hostname github.com repos/MortenChristiansenOrg/semantic-code-review --jq '{has_issues,archived,disabled,visibility}'
```

If authentication fails, suggest connecting a GitHub tool or the interactive
`gh auth login --hostname github.com` flow. The user should complete sign-in through
the authentication UI. For account confusion, `gh auth status --hostname github.com`
can show configured accounts; request an account switch only when needed, then
repeat the `user` query. Environment-provided authentication can override the
stored account; do not print environment variables or use `gh auth token` or
`--show-token` to debug it. A profile returned by the actual request is stronger
evidence than a stored-account selection.

Search examples (replace example terms with sanitized symptoms):

```text
gh issue list --repo github.com/MortenChristiansenOrg/semantic-code-review --state all --search 'viewer first stage expanded' --limit 50 --json number,title,state,url
gh issue view 15 --repo github.com/MortenChristiansenOrg/semantic-code-review --json title,body,state,url,comments
```

Use a small set of meaningful queries rather than downloading every issue body.
If a limit is reached, narrow the search or fetch more before claiming coverage.
Follow the current repository templates (including `.github/ISSUE_TEMPLATE/` and
an applicable default community template), labels and security policy through
the API or browser. Their absence is not a blocker for a normal bug report.

Only after approval, use the exact saved UTF-8 body with `--body-file` or stdin:

```text
gh issue create --repo github.com/MortenChristiansenOrg/semantic-code-review --title '<approved title>' --body-file '<absolute draft path>'
gh issue comment <issue-number> --repo github.com/MortenChristiansenOrg/semantic-code-review --body-file '<absolute draft path>'
```

These are alternatives, not a sequence. Substitute placeholders with arguments
escaped for the actual shell; do not concatenate untrusted report text into shell
code. Preserve backticks, dollar signs and line breaks literally. Never use an
interactive editor for an already approved body or regenerate it while sending.
Apply an existing `bug`/other applicable label only when allowed. A normal
external reporter does not need label-management, project, or push permissions;
if labeling is unavailable, submit without labels and report that limitation.

Limit: successful profile/repository reads do not prove that the credential can
write issues. Check exposed token/app capabilities without revealing credentials;
fine-grained credentials need Issues write permission. Do not test access by
posting. If capability remains uncertain, disclose that before the approved
attempt and handle a permission rejection without elevating access automatically.

## Browser/manual fallback

Use the [upstream issue chooser](https://github.com/MortenChristiansenOrg/semantic-code-review/issues/new/choose)
and provide the sanitized draft separately. Confirm the signed-in account through
the browser profile if browser tools can observe it; otherwise ask the user to
verify the displayed account before they submit manually. Do not claim that
the CLI/connector identity is also the browser identity. The user can sign in
through GitHub normally; never request their password or token.

Search the repository's Issues page with both open and closed results. Do not put
private diagnostics into search queries or prefilled URL parameters. Offer a
copyable draft when neither a connector nor a CLI is available. The user performs
the final submission if the host cannot safely verify the account and submit.
Ask for the resulting link to confirm completion; until then report “draft ready”
rather than claiming an issue exists.

## Submission result and ambiguous failures (all routes)

Keep the approved payload, account, destination and attempt time until the result
is known. On success, verify the returned URL belongs to the intended repository
and inspect the created item when accessible. Retain any useful local reproduction
instructions and report the URL. Do not edit others' issues or manage their state.

On timeout, connection loss, or unclear tool output, **do not immediately retry**.
Inspect recent issues by the submitting author and creation time, comparing the
exact title/body, or the intended issue's recent comments for a comment attempt.
Use direct recent-item listings as well as search: search indexing may lag. For
example, list that author's issues sorted by creation with `gh issue list --state
all --author <login> --search 'sort:created-desc'`, then, if needed, use the REST
issues endpoint with `state=all&creator=<login>&sort=created&direction=desc` and
pagination (exclude entries containing `pull_request`). A title match alone is
not proof. Inspect likely matches' authors, timestamps and payloads.
An empty listing also cannot prove an in-flight create has failed. If its outcome
is still uncertain, stop and verify later rather than retrying.

If the item exists, return its link rather than reposting. If absence is verified
and a transient cause has cleared, allow at most one retry of the unchanged,
approved payload under the same reverified identity. If the result remains
ambiguous, or a rate limit/offline condition prevents verification, stop posting,
retain the draft and explain how to verify manually. Report permission failures,
disabled/archived repositories and rate limits accurately; do not loop or request
broader credentials than the operation needs. A label/attachment failure can
happen after creation: check for an existing item before any alternative send.

Reference when API behavior needs investigation:
[issue creation and permissions](https://docs.github.com/en/rest/issues/issues#create-an-issue),
[CLI issue creation](https://cli.github.com/manual/gh_issue_create),
[CLI issue search](https://cli.github.com/manual/gh_issue_list), and
[CLI authentication status](https://cli.github.com/manual/gh_auth_status).
