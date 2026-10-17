/**
 * The `memory` tool's calls (track T5, D72): a `runtime` effect, operation `memory`, which core
 * serves in the transaction that journals the call, as it does `schedule_wake`. So a replayed turn
 * applies a write once and sees the same `view`, and a BYO harness gets the same answers by sending
 * the same target. The input is Anthropic's memory tool's: `command` and its parameters.
 *
 * Core checks every call, whichever harness sent it (our engine runs the same `checkMemoryCall`
 * before it sends one): a call missing a command's parameter, or with a parameter of the wrong
 * type, fails with Anthropic-style text (`Error: create requires file_text.`) and changes nothing. Writes need `access: "read_write"` in the version the session runs and the
 * root agent: a sub-agent's call (one that names its `agent`) may only view (`memory.forbidden`).
 */
import { checkMemoryCall, type AgentMemorySettings, type MemoryCommandName } from "@nylorun/core/contracts";
import type { Tx } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { applyMemoryCommand, viewMemory, type MemoryCommand } from "./service.js";

type Outcome =
  | { kind: "completed"; output: string }
  | { kind: "failed"; code: string; message: string };

/** `harness.memory` of the agent manifest version session `s` runs, when it sets one. */
export async function memorySettingsOf(t: Tx, s: Pick<Session, "definition">): Promise<AgentMemorySettings | undefined> {
  if (!s.definition) return undefined;
  const version = await t.agentManifest(s.definition.name, s.definition.version);
  const harness = version?.body.harness as { kind?: string; memory?: AgentMemorySettings } | undefined;
  return harness?.kind === "workflow" ? undefined : harness?.memory;
}

function commandOf(command: Exclude<MemoryCommandName, "view">, args: Record<string, unknown>): MemoryCommand {
  switch (command) {
    case "create":
      return { command, path: args.path as string, fileText: args.file_text as string };
    case "str_replace":
      return {
        command,
        path: args.path as string,
        oldStr: args.old_str as string,
        ...(typeof args.new_str === "string" ? { newStr: args.new_str } : {}),
      };
    case "insert":
      return { command, path: args.path as string, insertLine: Number(args.insert_line), insertText: args.insert_text as string };
    case "delete":
      return { command, path: args.path as string };
    case "rename":
      return { command, oldPath: args.old_path as string, newPath: args.new_path as string };
  }
}

/**
 * Serves one `memory` call of session `s`'s active turn in `t`: a view, or a write recorded as a
 * version attributed to the turn (`agent:<manifest>@<version>`, the session, turn and the trigger
 * run that started it), with `memory.updated` in the session and `agent.memory_updated` on the
 * Agent's stream when something changed.
 */
export async function serveMemoryTool(
  t: Tx,
  s: Session,
  request: { effectId: string; input?: unknown; agent?: unknown },
): Promise<Outcome> {
  const settings = await memorySettingsOf(t, s);
  if (!settings) return { kind: "failed", code: "tool.unavailable", message: "This session's agent has no memory (harness.memory)." };
  const parsed = checkMemoryCall(request.input);
  if ("error" in parsed) return { kind: "failed", code: "tool.invalid-input", message: parsed.error };
  const { command, args } = parsed;
  if (command === "view") {
    const range = Array.isArray(args.view_range) ? ([Number(args.view_range[0]), Number(args.view_range[1])] as const) : undefined;
    const viewed = await viewMemory(t, s.agentId, args.path as string, range);
    return viewed.ok ? { kind: "completed", output: viewed.text } : { kind: "failed", code: viewed.code, message: viewed.text };
  }
  if ((settings.access ?? "read_write") === "read_only" || request.agent !== undefined)
    return {
      kind: "failed",
      code: "memory.forbidden",
      message:
        request.agent !== undefined
          ? "Error: memory is read-only for a sub-agent; only the main agent writes it."
          : "Error: this agent's memory is read-only (harness.memory.access); view it, but don't change it.",
    };
  const turnId = s.activeTurnId!;
  const result = await applyMemoryCommand(
    t,
    s.agentId,
    commandOf(command, args),
    {
      actor: `agent:${s.definition!.name}@${s.definition!.version}`,
      sessionId: s.id,
      turnId,
      ...(s.turnCause ? { triggerRunId: s.turnCause.runId } : {}),
    },
    await readRuntimeLimits(t),
  );
  if (!result.ok) return { kind: "failed", code: result.code, message: result.text };
  if (result.changes.length > 0) {
    const changes = result.changes.map((change) => ({ ...change }));
    await t.event(s.id, turnId, "memory.updated", { effectId: request.effectId, changes });
    await t.agentEvent(s.agentId, "agent.memory_updated", { effectId: request.effectId, changes, sessionId: s.id, turnId });
  }
  return { kind: "completed", output: result.text };
}
