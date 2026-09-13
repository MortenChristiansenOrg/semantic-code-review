---
name: semantic-flow
description: Use when explicitly requested to implement a substantial feature or user story with semantic flow, reconstruct an existing implementation, or review, revise, sync, validate, prepare, archive, inspect, or update a semantic-flow implementation. Supports explicit commands and natural-language requests.
---

# Semantic Flow

Route the request through this index. Read the selected command file completely
before acting, along with every shared file it requires. Reuse guidance already
present in the current context while the installed skill is unchanged.

The CLI, artifact plumbing, branch choreography, and recovery commands are
internal implementation details. A request authorizes the routine reversible
mechanics needed to complete it. Handle those mechanics autonomously, including
prescribed conflict recovery; do not ask users to approve CLI invocations,
restacking, temporary branches, guarded stage-ref updates, or artifact repair.
This applies to every command below, including continuation and error paths.

Before any user-facing question or blocker report, apply
[the communication rules](docs/user-decisions.md). Ask about desired behavior,
scope, or an unresolved safety condition in plain language. Preserve all safety
guards and existing authorization limits; stopping a write does not automatically
require a user question.

Some harnesses use `$semantic-flow` instead of `/semantic-flow` for skill
commands. Treat them as equivalent. All examples use `/semantic-flow`.

| Invocation | Alias | Command file |
| --- | --- | --- |
| Natural-language semantic-flow request | | `commands/implicit.md` |
| `/semantic-flow implement` | | `commands/implement.md` |
| `/semantic-flow review` | `rv` | `commands/review.md` |
| `/semantic-flow feedback` | `fb` | `commands/feedback.md` |
| `/semantic-flow reconcile` | `rc` | `commands/reconcile.md` |
| `/semantic-flow simulate` | `sim` | `commands/simulate.md` |
| `/semantic-flow status` | | `commands/status.md` |
| `/semantic-flow continue` | | `commands/continue.md` |
| `/semantic-flow sync` | | `commands/sync.md` |
| `/semantic-flow validate` | | `commands/validate.md` |
| `/semantic-flow prepare` | | `commands/prepare.md` |
| `/semantic-flow archive` | | `commands/archive.md` |
| `/semantic-flow version` | | `commands/version.md` |
| `/semantic-flow update` | `up` | `commands/update.md` |
| `/semantic-flow help` or `/semantic-flow help <command>` | | `commands/help.md` |

Treat the first word after `/semantic-flow` as the command. With no explicit
command, use `commands/implicit.md`. Unknown commands route to
`commands/help.md`; do not guess.
