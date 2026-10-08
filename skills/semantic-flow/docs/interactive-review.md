# Interactive review

`/semantic-flow review -i` opens the viewer and keeps you listening for feedback
until the review ends. The reviewer never runs another command between rounds;
feedback sent while you work is queued for your next round.

`<semantic-flow>` and `<review-feedback>` mean `node` followed by the quoted
`scripts/semantic-flow.mjs` and `scripts/review-feedback.mjs` paths under the
installed skill root.

## Start

1. Launch the viewer exactly as `../commands/review.md` describes. A healthy
   viewer for the same review is reused.
2. Read `../commands/feedback.md` completely once. Every round follows its
   “Ask in the viewer”, “Address feedback”, “Restack conflicts”, and “Reply”
   sections. Do not reread guidance that is already in context.
3. Start listening:

   ```text
   <semantic-flow> feedback --json --wait [--project <repository-or-worktree-path>] [--implementation-id <id>] [--timeout <seconds>]
   ```

   This first call starts a session, replacing any earlier listener for this
   review. Every result includes `session`; pass `--session <session>` to every
   later wait.

## Wait

If the harness can run a command in the background and resume you when it
finishes, run each wait that way with `--timeout 3600`, so the conversation
stays free. Otherwise run it in the foreground with a timeout below the
harness's command limit; the default 540 seconds suits common limits.

Each result has one of these shapes:

| Result | Action |
| --- | --- |
| `stages` is not empty | Process the round, then wait again. |
| `responses` is not empty | Apply the reviewer's answers to the work they unblock, then wait again. |
| `timedOut: true` | Wait again immediately. |
| `stopped: true` | End the loop with one short line in the chat. `reason` is `stopped` (the reviewer pressed Stop), `completed` (the review was marked complete), `idle` (two hours without feedback), or `superseded` (another listener started). |

A round's result has the same fields as the `feedback --json` preflight in
`../commands/feedback.md`, with the threads already claimed. Never end the loop
on your own and never ask whether to continue. Waiting again with a session
first validates the stack and feedback; fix any failure it reports before
continuing.

## Rounds

Process each round as `../commands/feedback.md` describes, including parallel
subagents for questions and for independent stage changes. Reuse stage
worktrees created in earlier rounds. After the change replies are posted, wait
again with the session instead of rerunning the preflight.

Before long steps, you may show what the round is doing:

```text
<review-feedback> agent progress --body "Changing the cancellation and refund stages"
```

When a round needs an answer from `agent ask`, wait with the session as usual.
The round keeps its threads while the question is open, and the answer returns
in `responses`. New feedback waits until the round completes.

All interaction with the reviewer happens in the viewer. In the chat, write one
short line per round, such as “Answered 3 threads; listening”, and report only
failures that make the viewer or its review data unusable.
