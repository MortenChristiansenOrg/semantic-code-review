# Implicit usage

Use this route when the user invokes semantic flow without an explicit command
or mentions semantic flow in a natural-language request.

## Route by intent

- An implementation request such as "implement the current user story using
  semantic flow" routes to `implement.md`.
- A request to resume interrupted implementation routes to `continue.md`.
- A request to inspect or open the completed implementation routes to `review.md`.
- A request to address open reviewer comments routes to `feedback.md`.
- A request to distribute current manual edits into their responsible stages
  routes to `reconcile.md`.
- A request matching another indexed command routes to that command file.
- A bare `/semantic-flow` invocation routes to `help.md`.

Natural-language usage remains a first-class interface. Never require the user
to rewrite a clear implementation request as `/semantic-flow implement`.

If the intent is genuinely ambiguous and different routes would mutate
different state, ask the user to choose one route. Do not infer an unknown
slash command.
