# Transcript: AI-Assisted Semantic Code Review Tool Discussion

**User:** I've been thinking about a solution to a technical problem
that I would like to discuss with you and get some feedback on.

**Assistant:** Sure thing. Hit me.

**User:** It's a tool for programming. I've been using AI to implement
user stories end to end, which produces a lot of code, and it's
difficult to review.

**Assistant:** It can definitely become tedious.

**User:** I'm thinking about a tool that splits the resulting work into
semantic stages rather than one large pull request. Each stage would
represent a logical piece of work, with explanations of why changes were
made, links back to requirements or acceptance criteria, and notes where
the LLM had to make assumptions.

**Assistant:** So the diff would be organized by intent rather than
files, with explanations for each logical unit.

**User:** Exactly. Then I could review each stage individually, leave
comments, and ask the AI to address only those comments. If implemented
as stacked commits, the AI would update the affected stage and replay
later stages as needed.

**Assistant:** That makes sense. Treat each layer as a small narrative
containing both code and rationale.

**User:** We use Azure DevOps, so we'd probably need to build our own
tooling. I wondered whether existing diff libraries or stack-diff
tooling could be reused.

**Assistant:** Existing diff viewers can certainly be reused. The novel
part is the semantic decomposition and review experience rather than the
rendering of diffs.

**User:** CodeRabbit has recently added semantic review features. Maybe
that's inspiration.

**Assistant:** Their semantic grouping validates the direction, but your
idea goes further by allowing reviewers to iteratively modify semantic
layers and have the AI replay downstream work.

**User:** What artifact should capture all this metadata? JSON in the
repository?

**Assistant:** A database-backed implementation graph would be ideal
eventually, but for an MVP a JSON file in the repository is a pragmatic
choice.

**User:** I was thinking about implementing this as an AI skill with
scripts that generate and validate the JSON and define how commits and
branches should be created.

**Assistant:** I like that. The skill becomes a protocol between the
coding agent and the review tool. Over time, the storage mechanism can
change while the protocol stays stable.

**User:** One problem today is that when I ask an LLM why it made a
change, it has to reconstruct the reasoning afterwards. I'd rather
capture the reasoning during implementation.

**Assistant:** That's one of the strongest aspects of your proposal.
Capture rationale while the model still knows why decisions are being
made, rather than reconstructing them later.

**User:** So we'd need logical chunks containing code, reasoning,
dependencies, and decisions.

**Assistant:** Exactly. Those become the primary review units.

**User:** Any other ideas for helping reviewers understand AI-generated
code?

**Assistant:** Some ideas: - Architecture change summaries. - Decision
classification (requirement vs assumption vs best practice). -
Alternative approaches considered. - A narrated "review replay." -
Confidence indicators. - Cross-cutting impact summaries.

**User:** I especially like capturing discarded alternatives and failed
attempts.

**Assistant:** Those failed explorations often contain valuable
engineering context.

**User:** What about the technology stack? I've built Electron apps, but
I'd like colleagues to use this without installing much software.

**Assistant:** A PWA is probably the best fit. Use the File System
Access API where possible and optionally provide a tiny localhost bridge
for Git and AI integration.

**User:** Could you write high-level design documentation covering
functionality, architecture, technology choices, and any open questions?

**Assistant:** Yes. I proposed documenting: - Vision and problem
statement. - Core concepts. - Workflow. - AI collaboration protocol. -
Data model. - UX. - Architecture. - Open questions and roadmap.

**User:** Sounds good.

**Assistant:** I also suggested including design principles and a
complete walkthrough.

**User:** Go ahead.

**Assistant:** Agreed. I'd prepare a lightweight but complete design
document set.

**User:** Anything else?

**Assistant:** I think we've captured the important ideas. The core
problem is helping humans build trust in AI-generated code through
semantic review rather than file-by-file review.

**User:** Thanks for the talk.

**Assistant:** You're welcome. Good luck with the prototype.

------------------------------------------------------------------------

## Key themes

-   Review code by intent instead of by file.
-   Capture rationale while code is generated.
-   Represent work as semantic stages with dependencies.
-   Keep human reviewers in control.
-   Support iterative AI-assisted review and replay.
-   Start with a repository-backed JSON protocol before introducing
    backend infrastructure.
-   Build an accessible web-based UI with an optional local companion
    process.
