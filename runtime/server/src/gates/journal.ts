/**
 * The Tool Gate's journal check (R5.6). Under a run token, the gate sends only a call core
 * journaled: its `Idempotency-Key` (the effect id) names an `invoking` tool row of the token's
 * session and turn, for the same tool, with the same input. Anything else is refused before it
 * is sent, so a harness that skips the journal, ours or another (R4), gets nothing run, and
 * every call that runs has its row (`/calls/tool`) and its `tool.completed`.
 *
 * Core's own credential (previews, calls outside a run) is not checked: it names no run.
 */
import type { HostEffect } from "@nylorun/harness/run";
import { mcpToolOf } from "../mcp/snapshot.js";
import type { McpServerRef } from "../mcp/pool.js";
import { canonical } from "../store/canonical.js";
import type { EffectDoc } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import type { RunClaims } from "../tenant/run-token.js";
import { httpToolRefOf, type HttpToolRef } from "./http-tool.js";
import type { TenantVaults } from "./tenant-vaults.js";

/** The call a run asks the gate to send, as the gate's body names it. */
export type GateToolCall =
  | {
      readonly kind: "mcp";
      readonly server: McpServerRef;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly kind: "http"; readonly tool: HttpToolRef; readonly input: unknown };

export interface JournalCheck {
  /** Why the journal does not hold `call` under `key` for the run `claims` names; else undefined. */
  refusal(
    tenantId: string | undefined,
    claims: RunClaims,
    key: string,
    call: GateToolCall,
  ): Promise<string | undefined>;
}

export function journalCheck(vaults: TenantVaults): JournalCheck {
  return {
    async refusal(tenantId, claims, key, call) {
      const store = (await vaults.open(tenantId)).store;
      return store.tx(async (t) => {
        const row = await t.get<EffectDoc>("effects", key);
        if (!row) return `No journaled call has the effect id '${key}'`;
        const request = row.request as HostEffect;
        if (
          request.kind !== "tool" ||
          request.sessionId !== claims.sessionId ||
          request.turnId !== claims.turnId
        )
          return `Effect '${key}' is not a tool call of this run's turn`;
        if (row.status !== "invoking") return `Effect '${key}' is not running: it is ${row.status}`;
        if (call.kind === "http") {
          const { sessionId: _journaled, ...expected } = httpToolRefOf(request);
          const { sessionId: _named, ...named } = call.tool;
          if (canonical(expected) !== canonical(named)) return `Effect '${key}' calls another tool`;
          if (canonical(request.input ?? null) !== canonical(call.input ?? null))
            return `Effect '${key}' was journaled with other input`;
          return undefined;
        }
        const session = await t.get<Session>("sessions", request.sessionId);
        const tool = mcpToolOf(session?.mcpSnapshot, request);
        if (
          !tool ||
          tool.capabilityId !== call.server.capabilityId ||
          tool.serverName !== call.server.serverName ||
          (tool.agentId ?? null) !== (call.server.agentId ?? null) ||
          tool.serverToolName !== call.name
        )
          return `Effect '${key}' calls another tool`;
        if (canonical(argumentsOf(request.input)) !== canonical(call.arguments))
          return `Effect '${key}' was journaled with other input`;
        return undefined;
      });
    },
  };
}

/** A tool call's input as `tools/call` arguments (`callMcpTool`): an object, else none. */
function argumentsOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}
