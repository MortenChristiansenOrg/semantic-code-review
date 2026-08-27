# Semantic Code Review

Do you repeatedly find yourself wading through huge AI-generated pull requests, full of changes which you struggle to
reason about, where the decision process is opaque and you are left to reconstruct the decision process on your own?
Do you find that traditional PR review UIs provide little to no help structuring the changes in ways that are easy
to process and that they don't have any mechanisms for structuring your thoughts along the way? If so, the Semantic
Code Review tool might be something for you.

The tool contains a number of components, but at its core it is a skill which you add to your project and tell your LLM
to use when implementing end-to-end work, such as user stories, features, etc. This workflow is called Semantic Flow
and when invoked causes the AI to capture various insights about the implementation process during the implementation
itself, at the time when it actually has the knowledge of what it is doing and why. In addition, the flow prescribes a
specific way of structuring the work in layered branches, with each branch containing an isolated stage in the
implementation.

Generating these artifacts and maintaining this specific branch structure serves one specific purpose - to provide as
much semantic meaning and insight as possible to the human reviewer, once the work is done. While the artifacts follow
a standard that allow you to build your own tooling to process them, the skill comes with a built-in review tool that
has all you need to review the code and provide feedback to the LLM for further revisions.

## Getting Started

You need three things:

- A project in a local Git repository.
- An AI coding agent whose harness supports skills.
- Node.js, which runs the bundled command-line tool and the local review viewer.

To get started, install the Semantic Flow skill into your project and then work
through a typical cycle:

1. **Ask for the work.** Tell your agent to implement a feature or user story
   using semantic flow. It confirms the requirements, its goal, and the criteria
   that define "done".
2. **Let it build in stages.** Instead of one large diff, the agent splits the
   work into a sequence of small, self-contained stages. As it works, it
   records the intent, decisions, assumptions, alternatives it rejected, and the
   checks it ran — while it still has that knowledge fresh.
3. **Review the result.** Open the review viewer and walk the stages one at a
   time. Each stage tells you what it does and why, groups its changes by
   purpose, links them back to a specification, and shows the evidence behind
   them.
4. **Give feedback.** Leave notes or questions on any stage, piece of reasoning,
   or line of code. The agent answers questions and makes targeted corrections,
   then updates the affected stages so the history stays clean.
5. **Approve and hand off.** When you're satisfied, approve the work. The result
   is ready for your normal Git workflow — as a stack of branches or a single
   branch — so you can push, open a pull request, and merge however you already
   do.

Throughout, you stay the decision-maker. The agent creates, explains, and
revises the work, but never approves or merges it for you.

## Features of the Review Tool

The review tool is a small web app that runs locally against your repository. It
is built to make an AI-generated change fast to understand:

- **Stage-by-stage narrative.** Read the change as an ordered story rather than
  a flat diff, starting from the intent of each stage.
- **Changes grouped by purpose.** Related edits are grouped by what they
  accomplish, not by where they happen to live in the file tree.
- **Recorded insights.** See the decisions, assumptions, alternatives, failed
  attempts, and open questions attached to the exact changes they explain.
- **Specification links and evidence.** Trace each stage back to the specification
  it satisfies and the checks that were run to validate it.
- **Feedback threads.** Start a conversation on a stage, a piece of reasoning, or
  a specific line, and get an answer or a targeted revision back.
- **Explicit approvals.** Approve the whole change, a single stage, or an
  individual file, and see when a previously approved file changes again.

## Skill Command Reference

You can drive the workflow with natural language ("implement the current user
story using semantic flow") or with explicit commands:

| Command | What it does |
| --- | --- |
| `implement` | Start a new piece of work and build it out in reviewable stages. |
| `continue` | Resume an implementation that was interrupted. |
| `review` | Launch the local review viewer for the current work. |
| `feedback` | Have the agent address the feedback you submitted in the viewer. |
| `status` | Show a read-only summary of where the work stands. |
| `validate` | Check the work for consistency and flag anything that needs attention. |
| `prepare` | After review, prepare a validated branch stack or cumulative branch for handoff. |
| `archive` | Store the captured reasoning once the change has landed. |
| `version` | Report the installed skill version. |
| `update` | Update the installed skill from its source. |
| `help` | Explain the available commands, or one command in detail. |

## Contained in this Repository

The Semantic Code Review package is made up of a few components:

- **A standard** that describes how to represent two aspects of a piece of work
  as portable JSON artifacts:
  - The knowledge and insights the implementation is based upon.
  - The feedback and discussion that happen while the work is reviewed.
- **JSON schemas** for validating those artifacts.
- **An AI skill** you install in your codebase, which unlocks the Semantic Flow
  process of implementing work in a way that produces the artifacts.
- **A local viewer** for reading the captured stages, exploring the diffs, and
  holding review conversations.
- **A command-line tool** that creates and maintains the artifacts and the
  underlying branch structure.

## A Standard for Semantic Implementation and Feedback

At the heart of the project is a simple idea: the most valuable time to explain
a change is while it is being made, not weeks later when someone asks about it.
The standard defines a structured, human- and machine-readable way to capture
that explanation alongside the code, so the reasoning behind a change is never
lost.

It covers two things. The first is the implementation itself, described as an
ordered set of stages - each with its intent, rationale, decisions, assumptions,
links to the requirements, and the evidence that it works. The second is the
review: the threads, questions, and revisions exchanged while a human evaluates
the work.

The standard is deliberately neutral. It does not depend on a particular AI
model, coding agent, or code-hosting service, and it treats Git as the source of
truth rather than replacing it. Because the artifacts follow a published,
versioned schema, you are free to build your own tooling around them - the
viewer and command-line tool in this repository are simply one reference
implementation.

> **Schema stability:** Version 0.1 is experimental and may receive breaking
> changes in place. It does not provide backward-compatibility guarantees yet.
