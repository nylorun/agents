/**
 * The session of an AG-UI thread: one per subject, agent and thread, so one subject can never
 * name another's session. The same on every path (an app server's handler or a browser), so a
 * thread continues whichever way it is reached.
 */
import { createHash } from "node:crypto";

export function sessionIdFor(subject: string, agentId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${subject}\u0000${agentId}\u0000${threadId}`)
    .digest("hex")
    .slice(0, 32);
}
