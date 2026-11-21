# Review command

Opens the local review viewer and keeps you listening for the reviewer's
feedback until the review ends. The reviewer works only in the viewer and never
runs another command between rounds; feedback sent while you work waits for
your next round. A review of someone else's branch (`--branch`) follows
`review-branch.md` instead, and nothing listens there.

Launching the viewer changes nothing: it does not mutate the artifact, switch
branches, approve work, or prepare outputs. Rounds change the implementation as
`feedback.md` describes.

`<semantic-flow>` means `node` followed by the quoted `scripts/semantic-flow.mjs`
path under the installed skill root.

## Open the viewer

```text
<semantic-flow> review [--project <repository-or-worktree-path>] [--implementation-id <id>]
```

Pass only these options. A leftover `-i` or `--interactive` in the request
means plain `review`; it is not a CLI option.

The command resolves linked worktrees, starts the viewer as a detached
background process or reuses a healthy one for the same review, reports the
local URL once the server is listening, and exits. Do not run a separate
inspect, validation, HTTP probe, or shell backgrounding command. If it fails,
for example because the implementation was archived, report the error in one
line and stop without waiting.

If you are already listening to this same review in this conversation, the
reviewer only wants the viewer back: run the command, then continue your loop
with the same session. Never start a second wait without `--session` beside it.
A request for another implementation or project starts its own listening once
your current loop has ended; say so in one line instead of switching.

## Listen

```text
<semantic-flow> feedback --json --wait [--project <repository-or-worktree-path>] [--implementation-id <id>] [--timeout <seconds>]
```

The first wait starts a session, replacing any earlier listener for this review.
Every result includes `session`; pass `--session <session>` to every later wait.
Every wait repeats the `--project` and `--implementation-id` values you launched
the viewer with.

If the harness can run a command in the background and resume you when it
finishes, run each wait that way with `--timeout 3600`, so the conversation
stays free. Otherwise run it in the foreground with a timeout below the
harness's command limit; the default 540 seconds suits common limits.

| Result | Action |
| --- | --- |
| `stages` is not empty | Process the round, then wait again. |
| `responses` is not empty | Apply the reviewer's answers to the work they unblock, then wait again. |
| `timedOut: true` | Wait again immediately. |
| `stopped: true` | End the loop with one short line in the chat. `reason` is `stopped` (the reviewer pressed Stop agent), `completed` (the review is marked complete), `idle` (two hours without feedback), or `superseded` (another agent started listening). |

When the first wait already returns `completed`, it started no session. Say that
the review is marked complete, so nothing listens, and that **Reopen review** in Saved reviews
followed by `/semantic-flow review` resumes listening.

Never end the loop on your own and never ask whether to continue. Waiting again
with a session after a round first validates the stack and feedback; fix any
failure it reports before continuing. Stop and two hours without feedback take
effect only after the current round.

## Rounds

When a result first has `stages` or `responses`, read `feedback.md` completely
once. A round's result has the same fields as its `feedback --json` preflight,
with the threads already claimed, so do not run that preflight. Process each
round by its “Ask in the viewer”, “Address feedback”, “Restack conflicts”, and
“Reply” sections, including parallel subagents for questions and for
independent stage changes. Reuse stage worktrees created in earlier rounds.

Start the next wait only after `reply` or `reply-batch` has finished, never as
a parallel tool call beside it, even when the harness encourages parallel
calls. A wait that finds the round still unanswered returns its threads to the
queue after a few seconds and reports them on stderr. If a reply reports that
the round was replaced, another agent took over the review: end with one short
line and change nothing more.

Before long steps, you may show what the round is doing:

```text
<semantic-flow> feedback agent progress --input -
{"body":"Changing the cancellation and refund stages"}
```

When a round needs an answer from `agent ask`, wait with the session as usual.
The round keeps its threads while the question is open, and the answer returns
in `responses`. New feedback waits until the round completes.

All interaction with the reviewer happens in the viewer. In the chat, write one
short line per round, such as “Answered 3 threads; listening”, and report only
failures that make the viewer or its review data unusable.
