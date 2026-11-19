export type ApprovalState = "none" | "approved" | "stale";

/** Combines file approvals: any unapproved file wins, then any stale one. */
export function aggregateApprovalState(states: readonly ApprovalState[]): ApprovalState {
  if (!states.length || states.some((st) => st === "none")) return "none";
  return states.every((st) => st === "approved") ? "approved" : "stale";
}
