# Vision and scope

## Problem

AI can implement a user story end to end, but the resulting pull request is
often too large and poorly structured for effective human review. A normal diff
shows where code changed, not why it changed or how each change contributes to
the requirement. When questioned later, the AI must reconstruct reasoning that
was available during implementation.

## Vision

Make AI-generated code understandable and trustworthy by presenting it as a
sequence of small, semantic review stages. Each stage tells a coherent story:
the intent, relevant code, rationale, evidence, assumptions, decisions, and
relationship to other stages.

The human reviewer remains the decision-maker. AI helps create, explain, and
revise the work, but does not approve it.

## Goals

- Organize changes by implementation intent rather than repository layout.
- Capture rationale and uncertainty while the AI is doing the work.
- Connect changes to requirements and acceptance criteria.
- Make assumptions, alternatives, and failed attempts visible.
- Let reviewers comment on one stage and request a targeted AI revision.
- Preserve a coherent result when an earlier stage changes and later work must
  be replayed.
- Fit Azure DevOps workflows without requiring heavy client installation.

## Design principles

1. **Review units are semantic.** Files and commits are supporting details.
2. **Context is captured at creation time.** Explanations are not generated
   retrospectively when avoidable.
3. **Evidence beats confidence claims.** Tests, requirement links, and diffs
   matter more than an AI-generated score.
4. **Dependencies are explicit.** Reviewers can see what later work relies on.
5. **Git remains authoritative.** The tool adds structure; it does not replace
   source control.
6. **The protocol is portable.** The AI skill, repository data, and UI should
   not depend on one model or coding agent.

## Initial scope

The first version supports a single developer reviewing an AI-produced change
in a local Git repository:

- An AI skill and scripts create and validate semantic-stage metadata.
- Stages map to a linear chain of cumulative local branches.
- A web UI displays stage narratives and diffs.
- Review comments can be attached to a stage.
- The coding agent can revise a stage and replay dependent stages.
- The complete result can be prepared as one cumulative branch or as a branch
  stack for the team's existing hosting process.

## Non-goals

- Replacing Git, pull requests, or Azure DevOps.
- Building a general-purpose code-generation environment.
- Automatically approving or merging AI-generated code.
- Proving that captured rationale is correct or complete.
- Perfectly recovering intent from arbitrary existing commits.
- Supporting real-time multi-user collaboration in the first version.
- Building a hosted metadata service before the repository protocol is proven.

## Success criteria

The concept is useful if reviewers can understand the shape and intent of a
change faster, identify assumptions before merge, request focused corrections,
and retain a readable history after those corrections.
