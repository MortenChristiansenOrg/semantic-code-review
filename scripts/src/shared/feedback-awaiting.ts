/** Reply watermarks. An agent comment answers the conversation through the user
 * comment named by `respondsTo`; replies without one answer every earlier comment.
 * User comments after the latest watermark still await the agent. */
interface WatermarkedComment { id: string; author: string; respondsTo?: string }

export function answeredThrough(comments: WatermarkedComment[]): number {
  let through = -1;
  comments.forEach((comment, index) => {
    if (comment.author !== "agent") return;
    const answered = comment.respondsTo ? comments.findIndex((item) => item.id === comment.respondsTo) : index - 1;
    if (answered > through) through = answered;
  });
  return through;
}

export function awaitsAgentReply(thread: { status?: string; comments?: WatermarkedComment[] }): boolean {
  if (thread?.status !== "open") return false;
  const comments = thread.comments || [];
  const through = answeredThrough(comments);
  return comments.some((comment, index) => index > through && comment.author === "user");
}

export function latestUserCommentId(thread: { comments?: WatermarkedComment[] }): string | undefined {
  return [...(thread.comments || [])].reverse().find((comment) => comment.author === "user")?.id;
}
