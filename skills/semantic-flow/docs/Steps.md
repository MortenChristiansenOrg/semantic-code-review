# Semantic Flow Steps

Read `../scripts/API.d.ts` before invoking the bundled CLI. The examples below
show command selection only; the generated API signature defines every
required and optional parameter.

When a new body of work is started which fits the requirements for this skill, start the flow which includes these steps which are elaborated below:

1) Initialize work and plan stages
2) Implement each stage
  A) Begin the next stage
  B) Implement the stage while capturing context
  C) Validate the stage
  D) Commit and finalize the stage
  E) Continue with 2.A if stages remain, otherwise continue with 3
3) Validate the complete stage stack and open review
4) Reviewer approves or submits feedback
5) Address submitted feedback
6) Reviewer re-reviews the changes
  A) Continue with 5 if more feedback is submitted
  B) Continue with 7 when the implementation is approved
7) Publish artifacts and prepare the pull request
8) Land the change
9) Archive flow artifacts


## Initialize work and plan stages

### Trigger

This step should be triggered automatically when the user gives the instruction to implement a new feature, user story or other similar fully contained task.

### Behavior

Capture the requirements, acceptance criteria and starting revision for the work. Analyze the required implementation and organize it into an ordered sequence of stages. Each stage must have a well-defined intent, build on the previous stages and leave the implementation in a functional state which meets all relevant quality gates.

Group changes by their purpose rather than by technical similarity. Prefer vertical slices that deliver a meaningful part of the required behavior. Avoid splitting one conceptual change across several stages when it can be reviewed more clearly as one stage.

The initial plan is provisional. Discoveries made during implementation may require future stages to be added, removed, reordered or reshaped. Update the plan when this happens rather than continuing with a plan which no longer represents the work. Keep future stages in the agent's task plan. Register only the next stage in the artifact, immediately before implementing it, because the CLI permits one active working stage.

### Commands

```
# Initialize the review and its first requirement
node <skill-root>/scripts/semantic-review.mjs init <options>
```

## Implement each stage

### Trigger

This step should be triggered after the work has been initialized and whenever the previous stage has been finalized while more functionality remains to be implemented.

### Behavior

Begin one stage before making its code changes. Only one stage may be active at a time.

Implement the coherent intent described by the stage. Capture relevant decisions, assumptions, alternatives, failed attempts, risks and open questions when they occur. Record validation evidence after running each relevant test or quality check. Do not reconstruct this context after the implementation has been completed.

When the stage is functional and all relevant quality gates pass, commit only the implementation belonging to that stage and finalize the stage against that commit. If implementation discoveries change the remaining work, update the future stage plan before beginning the next stage.

Repeat this step until all required functionality has been implemented.

### Commands

```
# Begin the next planned stage
node <skill-root>/scripts/semantic-review.mjs stage begin <options>

# Capture relevant context as it is discovered
node <skill-root>/scripts/semantic-review.mjs stage record <options>

# Record the result of a relevant quality check
node <skill-root>/scripts/semantic-review.mjs stage validation <options>

# Bind the completed stage to its implementation commit
node <skill-root>/scripts/semantic-review.mjs stage finish --id <stage-id> --commit HEAD
```

## Validate the complete stage stack and open review

### Trigger

This step should be triggered when every required stage has been finalized and the implementation is believed to be complete.

### Behavior

Validate the complete flow rather than relying only on the validation of its individual stages. Confirm that the requirements and acceptance criteria are covered, the stages form a valid ordered commit stack, recorded file inventories are current and no unfinished stage or invalid reference remains.

Resolve validation failures before opening the review. Once the complete stack is valid, launch the review tool so the reviewer can inspect the implementation stage by stage together with its captured context and validation evidence.

### Commands

```
# Validate the complete implementation and semantic artifacts
node <skill-root>/scripts/semantic-review.mjs validate --publish

# Launch the repository's configured review experience after validation
```

## Reviewer approves or submits feedback

### Trigger

This step should be triggered after the review tool has been launched for a valid, completed stage stack.

### Behavior

The reviewer examines the implementation one stage at a time. They may inspect the intent, code changes, captured context and validation evidence for each stage.

The reviewer either approves the implementation without changes or submits a completed batch of actionable feedback. Draft feedback is still being authored and must not be processed until the reviewer submits it. Approval continues the flow with publication. Submitted feedback continues the flow with feedback processing.

### Commands

```
# Submit the current feedback batch for implementation
node <skill-root>/scripts/review-feedback.mjs batch submit --id <batch-id>

# If no changes are required, continue to stack approval and publication
```

## Address submitted feedback

### Trigger

This step should be triggered when the reviewer submits a feedback batch.

### Behavior

Analyze each feedback item and associate it with the stage whose intent or implementation must change. Address feedback one affected stage at a time, including any necessary tests and updated semantic context.

Commit the fix and fold it into the affected stage rather than leaving an unrelated fix commit at the end of the stack. Rebuild any downstream stages on top of the rewritten stage so the ordered semantic history remains intact. Record how each feedback item was resolved and revalidate the complete stack after all submitted feedback has been addressed.

Do not mark feedback as resolved unless the requested change has been implemented or the recorded resolution clearly explains why no code change was appropriate.

### Commands

```
# Load submitted feedback grouped by affected stage
node <skill-root>/scripts/review-feedback.mjs next --json

# Fold a committed fix into the affected stage and rebuild later stages
node <skill-root>/scripts/semantic-review.mjs rewrite-stage --stage <stage-id> --fix HEAD

# Record the resolution of an individual feedback item
node <skill-root>/scripts/review-feedback.mjs comment resolve <options>

# Validate the rewritten stack before returning it to the reviewer
node <skill-root>/scripts/semantic-review.mjs validate --publish
```

## Reviewer re-reviews the changes

### Trigger

This step should be triggered after all submitted feedback has been addressed and the rewritten stage stack passes complete validation.

### Behavior

Return the resolved feedback and updated stages to the reviewer. The reviewer verifies that each resolution addresses the original concern and that the resulting implementation remains coherent.

If the reviewer submits additional feedback, return to the feedback processing step. If the reviewer approves all resolutions and the complete implementation, continue with publication. Approval applies to the resulting implementation, not merely to the text of the feedback resolutions.

### Commands

```
# Submit additional feedback when further changes are required
node <skill-root>/scripts/review-feedback.mjs batch submit --id <batch-id>

# Approve one resolution or every addressed resolution in a batch
node <skill-root>/scripts/review-feedback.mjs comment approve --id <feedback-id>
node <skill-root>/scripts/review-feedback.mjs batch approve-all --id <batch-id>
```

## Publish artifacts and prepare the pull request

### Trigger

This step should be triggered after the reviewer explicitly approves the complete implementation and no unresolved or draft feedback remains.

### Behavior

Run publication-level validation and approve the complete stack. Stack approval
publishes the semantic artifacts as a metadata-only commit and creates a
pull-request-ready branch containing the approved implementation and metadata.
Do not modify the approved stage stack while preparing the branch.

### Commands

```
# Validate feedback, publish metadata, and create the PR-ready branch
node <skill-root>/scripts/review-feedback.mjs approve-stack --branch <branch-name>
```

## Land the change

### Trigger

This step should be triggered after the pull-request-ready branch has been prepared successfully.

### Behavior

Push the prepared branch, create or update the pull request and complete the repository's normal integration gates. The pull request must contain the same approved implementation and semantic artifacts which were reviewed.

Merge the pull request only after all required checks and approvals pass. If integration review requires implementation changes, return to the feedback processing step and repeat review and publication for the updated stage stack. Do not archive the flow while its pull request remains unmerged.

### Commands

```
// Publish the prepared branch and open the pull request
git push --set-upstream origin review/work-xyz
gh pr create { base: 'main', head: 'review/work-xyz', ... }

// Merge after all repository gates pass
gh pr merge
```

## Archive flow artifacts

### Trigger

This step should be triggered only after the approved pull request has been merged into the target branch and the local target branch contains the merged change.

### Behavior

Move the completed flow artifacts from the active workspace into the review history. Preserve the published metadata so the intent, stage structure, review feedback and approval remain available for future inspection.

Archival must produce a clean, persistent repository state and make the workspace ready for another semantic flow. Refuse to archive unpublished artifacts, an unmerged implementation or a flow which still contains unresolved feedback.

### Commands

```
# Archive the merged and published semantic flow
node <skill-root>/scripts/semantic-review.mjs archive
```
