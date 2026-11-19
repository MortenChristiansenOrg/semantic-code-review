/** Reply watermarks. An agent comment answers the conversation through the user
 * comment named by `respondsTo`; replies without one answer every earlier comment.
 * User comments after the latest watermark still await the agent. */
import type { Comment, Thread } from "./documents.js";

export function answeredThrough(comments: readonly Comment[]): number {
  let through = -1;
  comments.forEach((comment, index) => {
    if (comment.author !== "agent") return;
    const answered = comment.respondsTo ? comments.findIndex((item) => item.id === comment.respondsTo) : index - 1;
    if (answered > through) through = answered;
  });
  return through;
}

export function awaitsAgentReply(thread: Thread): boolean {
  if (thread.status !== "open") return false;
  const through = answeredThrough(thread.comments);
  return thread.comments.some((comment, index) => index > through && comment.author === "user");
}

export function latestUserCommentId(thread: Thread): string | undefined {
  return thread.comments.findLast((comment) => comment.author === "user")?.id;
}
