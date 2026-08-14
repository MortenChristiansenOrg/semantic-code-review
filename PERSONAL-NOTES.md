# Personal notest

DISCLAIMER: This document is not for LLM use, so ignore its content.

This tool should probably support both stacked PRs and commit based stages. The skill should ask the user for their preference when they first use it. The user should be able to change preferences by calling the skill with a "configure" argument.

We should have the scripts defined in Typescript and the convert them to js as needed, for maintainability (or is there a way to execute the TS directly?).

We might need to have a way to prepare the skill for consumption, so it does not contain anything it does not need.

How do we evaulate the skill in a good and repeatable way? Should there be a reference repository (separate from this one) that has a small application we can expand upon and which has the skill installed.

The skill should self update from the remote source. This is one of the aspects that should be "compiled" into the final skill as consumed by other projects. Maybe we should update the AGENTS.md to not use the skill in this project?

If we want to look at stacked PRs, is there a good way to structure the branch names, so they group nicely in GitKraken?

How do we structure the skill according to progressive enhancement?

An essential part of the skill description is to avoid unclear step descriptions or descriptions where you don't know how to do it. Also avoid details which the LLM do not need to understand because they are handled by a script.

Scripts should handle expected errors and format them as messages to the LLM rather than failing with a response code or exception.

Maybe there is a code file describing the signature for the CLI calls, including doc strings which we could reference from the skill description. It should not have implementation details and should have just enough info for the agent to know how to use it.

Should the skill just stop before the PR? What about cleanup?

Is anything gitignored and if so, how does that work when checking out a different branch?

There are some things specific to azure devops in the vison and document format. I should consider a review making this completely neutral with regards to the tooling you use.

Should we specify that versions 0.X of the schema should all be treated as major revisions?

Is the format for review feedback detailed enough so that you can provide all the feedback you need to?

How does manual adjustments fit into this system? Sometimes you just want to edit a file yourself, but that does not really work with the single-commit approach. You could enter it as verbatim edit instructions in feedback, but you really want to do this in the IDE where you can see that it works. Is this an argument for stacked PRs?

Is there a useful way to save info about the choices made for posterity? If the artifacts are included in git, the final artifact will be committed along with the changes, which is fine. However, I'm not sure whether there is a good way to for the LLM to access this data later if it wants to know a decision. There chould be a script/tool for helping with this ("get choices related to file") but it would be fragile and potentially very slow, I would think. One problem is that we might need to track file renaming and things like that. Maybe this is something to look at after having used the skill for a while, so we can see what the artifacts end up containing. It would be a good idea to get the artifacts into git, though, so we start capturing historical data as soon as possible.