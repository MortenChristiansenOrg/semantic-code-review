# User decisions and internal mechanics

Apply these rules to every command, including implementation, continuation,
feedback, sync, reconcile, prepare, archive, update, and recovery. They govern
how to handle command-specific ask/stop conditions; they do not waive preflight
checks, guarded writes, preservation of unrelated work, or authorization limits.

A clear request carries permission for the prescribed reversible steps needed
to complete it. Run the documented procedure without a separate approval for
restacking, stage-ref updates, temporary recovery branches, compare-and-swap,
artifact repair, or CLI syntax. Use only supported procedures and their guards.
An exception explicitly prescribed by a recovery guide is already authorized
within that procedure; it is not a new permission request.

Before asking, inspect available requirements, feedback, code, and current state.
Resolve routine mechanics yourself. Ask only for a real product or code-intent
ambiguity, conflicting requirements, unclear stage ownership that changes the
implementation, an external side effect not already authorized, or a safety
condition you cannot resolve with the documented procedures. Existing user
instructions and approvals remain sufficient; do not ask for them again.

Translate the condition into its concrete effect before prompting. Explain
which behavior or work is affected and offer choices the user can evaluate.
For example, ask whether a cancelled order should still receive a confirmation
email, rather than which side of a replay conflict to keep. If stage ownership
matters, describe which behavior must work independently, rather than asking
which stage ID should own a hunk. If the choice is only internal representation,
make it yourself.

A failed guarded write or a concurrently moved branch stops that write. Inspect
the new state read-only and preserve all work and recovery snapshots. Do not
force an update, substitute a newer expected revision merely to retry, or infer
permission to overwrite new work. Resume only if a documented safe recovery
applies and intent remains clear. Otherwise report what changed, what work could
be lost or misapplied, and the concrete blocker. Ask only if a user decision can
resolve it, such as whether newly discovered edits belong in the reviewed change.
Never ask whether to retry compare-and-swap or approve a recovery command.

Routine progress describes outcomes: “I’m applying the review correction and
checking that later changes still work.” When blocked, lead with the affected
work and its preservation. Paths, revisions, recovery branch names, and raw
errors may follow as diagnostics for reproducibility, but must not be the
premise of the user's decision. If no user decision can fix a tooling failure,
report the blocker and the preserved work without an opaque permission question.
