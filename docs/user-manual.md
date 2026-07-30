# Semantic Review user manual

This manual is for a reviewer using the local proof-of-concept application to
understand, comment on, and approve an AI-assisted implementation.

## Start the application

You need Node.js 20 or later and a repository containing an active
`.semantic-review` artifact.

From the repository root, run:

```powershell
npm ci --prefix .\.github\skills\semantic-story-implementation
npm start --prefix .\poc
```

Open <http://127.0.0.1:4173>. Keep the terminal process running while you use
the application.

The header shows whether the artifact is valid and how many stages are
finalized or still working. Use **Reload** after the implementation or review
state changes.

## Understand the review

Start with **Requirements**. These describe the intended outcome and its
acceptance criteria.

The **Stage stack** presents the implementation in its intended review order.
Select a stage to see:

- Its purpose and summary.
- The requirements it addresses.
- Why the approach was chosen.
- Decisions, assumptions, alternatives, failed attempts, risks, validation
  evidence, and open questions recorded during implementation.
- Its changed files and Git commit.

A **Working** stage is not committed and may still change. A **Finalized** stage
has a commit and an exact patch. Select **Load unified diff** to inspect that
patch.

The current format uses one linear Git commit stack. Each stage is one commit
on top of the previous stage.

## Add feedback

Select **Review queue** in the header.

1. Select **Start review** if no feedback workspace exists.
2. Enter a title and select **Create batch**.
3. Select that draft batch.
4. Use **Comment** beside a requirement, criterion, reasoning item, or changed
   file. After loading a diff, use **+** beside a line to comment on that line.
5. Enter what should change and why, then select **Add comment**.

One batch can contain comments from several stages. Draft comments can be
edited or deleted. An empty draft batch can also be deleted.

When the batch is complete, select **Submit feedback**. Submission freezes its
comments and anchors so the implementation agent receives a stable instruction
set.

## Review the response

The agent applies submitted feedback one semantic stage at a time. If an early
stage changes, later stage commits are replayed so the final history still
matches the stage narrative.

Each addressed comment receives an **Agent resolution** containing:

- A summary of how the feedback was handled.
- The stage that changed.
- The stage commit before and after rewriting.

An original file or line anchor may be marked as rewritten. This preserves
where the comment was made; it does not mean the resolution is invalid.

Select **Approve resolution** for one response, or **Approve all resolutions**
for every addressed response in the batch.

| Batch status | Meaning |
| --- | --- |
| `draft` | Comments can still be edited |
| `submitted` | Waiting for implementation |
| `addressing` | Some comments have been handled |
| `resolved` | Every comment has a response awaiting approval |
| `approved` | Every response is approved |

## Approve the complete change

The whole-stack approval control appears at the bottom of the **Review queue**
when either:

- No feedback batches exist, or
- Every feedback batch is approved.

Confirm the proposed branch name and select **Approve changes**. This validates
the semantic review, publishes its metadata, and creates a stable PR-ready
branch containing the implementation and review artifact.

If the control is missing, finish, approve, or delete every incomplete feedback
batch first.

The current POC does not persist a separate whole-stack approval badge in the
UI. The created Git branch is the durable approval result.

## Current limitations

- The application runs only on localhost and reviews the repository from which
  it was started.
- Feedback state is local and Git-ignored; it is not included in the published
  review artifact.
- Version 0.1 keeps all stage commits on one linear branch. Branch-per-stage
  stacked diffs are a possible future improvement.
- The tool does not open or merge a hosted pull request.

## If the review does not load

Run the validator from the repository root:

```powershell
node .\.github\skills\semantic-story-implementation\scripts\semantic-review.mjs validate
```

Correct the reported artifact or Git mismatch, then select **Reload**.
