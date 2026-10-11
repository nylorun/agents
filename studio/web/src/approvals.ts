/**
 * The approvals a paused session waits on (R5 step 2): the approval interactions of its last
 * `turn.paused`, unless a later event answered or ended the turn. A tool call the Tool Gate held
 * names its tool, why, and its input; `approve` on the session answers it by its id.
 */

/** One approval a person can give or refuse. */
export interface PendingApproval {
  readonly id: string;
  readonly toolName?: string;
  readonly prompt?: string;
  readonly reason?: string;
  readonly server?: string;
  readonly input?: unknown;
}

interface EventLike {
  readonly type: string;
  readonly payload?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The open approvals of `events`, oldest first; empty when the last turn did not pause on one. */
export function pendingApprovals(events: readonly EventLike[]): PendingApproval[] {
  const answered = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "command.approve" && typeof payload.interactionId === "string")
      answered.add(payload.interactionId);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) return [];
    if (event.type !== "turn.paused") continue;
    const interactions = Array.isArray(payload.interactions) ? payload.interactions : [];
    return interactions.flatMap((entry): PendingApproval[] => {
      if (!isRecord(entry) || !isRecord(entry.interaction)) return [];
      const { interaction } = entry;
      if (interaction.kind !== "approval" || typeof interaction.id !== "string") return [];
      if (answered.has(interaction.id)) return [];
      const toolName =
        typeof entry.toolName === "string" ? entry.toolName : typeof interaction.toolName === "string" ? interaction.toolName : undefined;
      return [
        {
          id: interaction.id,
          ...(toolName === undefined ? {} : { toolName }),
          ...(typeof interaction.prompt === "string" ? { prompt: interaction.prompt } : {}),
          ...(typeof interaction.reason === "string" ? { reason: interaction.reason } : {}),
          ...(typeof interaction.server === "string" ? { server: interaction.server } : {}),
          ...("input" in interaction ? { input: interaction.input } : {}),
        },
      ];
    });
  }
  return [];
}
