---
name: semantic-flow
description: Use when explicitly requested to implement a substantial feature or user story with semantic flow, or to review, revise, validate, prepare, archive, inspect, or update a semantic-flow review. Supports explicit commands and natural-language requests.
---

# Semantic Flow

Route the request through this index. Read the selected command file completely
before acting, along with every shared file it requires.

Some harnesses use `$semantic-flow` instead of `/semantic-flow` for skill
commands. Treat them as equivalent. All examples use `/semantic-flow`.

| Invocation | Command file |
| --- | --- |
| Natural-language semantic-flow request | `commands/implicit.md` |
| `/semantic-flow implement` | `commands/implement.md` |
| `/semantic-flow review` | `commands/review.md` |
| `/semantic-flow feedback` | `commands/feedback.md` |
| `/semantic-flow status` | `commands/status.md` |
| `/semantic-flow continue` | `commands/continue.md` |
| `/semantic-flow validate` | `commands/validate.md` |
| `/semantic-flow prepare` | `commands/prepare.md` |
| `/semantic-flow archive` | `commands/archive.md` |
| `/semantic-flow version` | `commands/version.md` |
| `/semantic-flow update` | `commands/update.md` |
| `/semantic-flow help` or `/semantic-flow help <command>` | `commands/help.md` |

Treat the first word after `/semantic-flow` as the command. With no explicit
command, use `commands/implicit.md`. Unknown commands route to
`commands/help.md`; do not guess.
