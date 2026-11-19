export interface FileMemberships {
  memberships?: readonly { nodeId: string }[];
}

/** The node a shared file is opened in, when the stored choice still owns part of the file. */
export function selectedNodeForFile(activeValue: unknown, file: FileMemberships): string | null {
  return typeof activeValue === "string" && file.memberships?.some((m) => m.nodeId === activeValue) ? activeValue : null;
}
