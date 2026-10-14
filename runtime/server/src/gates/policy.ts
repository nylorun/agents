/**
 * Tool policy (R5 step 2). Every MCP and HTTP tool call of every harness is decided as core
 * journals it (`harness-api/record.ts`), which each harness must do before it sends a call:
 * `deny` fails it to the model as `tool.denied`, unsent; `ask` holds the row until a person
 * approves it on the session; `allow` runs it. The Tool Gate sends only a call the journal holds
 * running (`journal.ts`), so a held or refused call cannot run, whichever harness asks.
 *
 * The rules are the Tenant's (`PUT /v1/tenant/tool-policy`, the `tool-policy` setting). A rule
 * matches a call when every selector it sets matches; the strictest matching rule decides
 * (`deny`, then `ask`, then `allow`), and a call no rule matches runs. A session pinned to a
 * manifest saved before R5 step 2 keeps its `approval: "always"` as an ask: no session loses
 * the approval it was opened with. A policy that cannot be read refuses every call.
 */
import { ToolPolicySchema, type ToolInputCondition, type ToolPolicy, type ToolRule } from "@nylorun/core/contracts";
import type { AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { mcpToolOf, mcpToolSettingsIn, type McpSnapshot } from "../mcp/snapshot.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import { turnManifestOf } from "../tenant/session.js";
import { declaredHttpTool } from "./http-tool.js";

/** The `tenant_settings` key the policy is kept under. */
export const TOOL_POLICY_SETTING = "tool-policy";

/** A call as the policy reads it. */
export interface PolicyCall {
  readonly kind: "mcp" | "http";
  /** The name the model calls the tool by; a flow stage's key. */
  readonly tool: string;
  /** The MCP server's name. */
  readonly server?: string;
  /** The agent that calls it. */
  readonly agent: string;
  readonly input: unknown;
}

export type PolicyDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "ask" | "deny"; readonly reason: string };

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

/** The Tenant's policy; an empty one when none was set. Throws when it cannot be read. */
export async function readToolPolicy(t: Pick<Tx, "getSetting">): Promise<ToolPolicy> {
  const raw = await t.getSetting(TOOL_POLICY_SETTING);
  if (raw === undefined) return { rules: [], updatedAt: null };
  return ToolPolicySchema.parse(JSON.parse(raw));
}

/**
 * The decision for `request`, a session's MCP or HTTP tool call: the Tenant's rules and the
 * pinned manifest's `approval`. A policy that cannot be read refuses the call.
 */
export async function toolCallDecision(
  t: Pick<Tx, "getSetting">,
  s: Session,
  request: HostEffect,
  kind: "mcp" | "http",
): Promise<PolicyDecision> {
  let rules: readonly ToolRule[];
  try {
    rules = (await readToolPolicy(t)).rules;
  } catch {
    return { effect: "deny", reason: "The Tenant's tool policy could not be read, so no tool call runs" };
  }
  const mcp = mcpToolOf(s.mcpSnapshot, request);
  return decide(
    rules,
    {
      kind,
      tool: request.toolName ?? request.key ?? request.effectId,
      ...(mcp ? { server: mcp.serverName } : {}),
      agent: request.agent?.id ?? s.agentId,
      input: request.input,
    },
    pinnedApproval(turnManifestOf(s), s.mcpSnapshot, request),
  );
}

/** Decides `call` by `rules`; `pinnedAsk` adds the ask of a manifest saved before R5 step 2. */
export function decide(rules: readonly ToolRule[], call: PolicyCall, pinnedAsk = false): PolicyDecision {
  let strictest: { effect: "allow" | "ask" | "deny"; reason?: string } | undefined = pinnedAsk
    ? { effect: "ask", reason: `The agent's manifest asks for approval of '${call.tool}'` }
    : undefined;
  for (const rule of rules) {
    if (!matches(rule, call)) continue;
    if (strictest && STRICTNESS[rule.effect] <= STRICTNESS[strictest.effect]) continue;
    strictest = { effect: rule.effect, reason: rule.reason ?? describe(rule) };
  }
  if (!strictest || strictest.effect === "allow") return { effect: "allow" };
  return { effect: strictest.effect, reason: strictest.reason! };
}

/** The pinned `approval: "always"` of the call's tool, in a manifest saved before R5 step 2. */
export function pinnedApproval(
  manifest: AgentManifest,
  snapshot: McpSnapshot | undefined,
  request: HostEffect,
): boolean {
  const mcp = mcpToolOf(snapshot, request);
  if (mcp) return mcpToolSettingsIn(manifest, mcp).approval === "always";
  return declaredHttpTool(manifest, request.agent?.id, request.toolName)?.approval === "always";
}

function matches(rule: ToolRule, call: PolicyCall): boolean {
  if (rule.kind !== undefined && rule.kind !== call.kind) return false;
  if (rule.tool !== undefined && !glob(rule.tool).test(call.tool)) return false;
  if (rule.server !== undefined && (call.server === undefined || !glob(rule.server).test(call.server))) return false;
  if (rule.agent !== undefined && !glob(rule.agent).test(call.agent)) return false;
  for (const [path, condition] of Object.entries(rule.when ?? {}))
    if (!holds(condition, fieldOf(call.input, path))) return false;
  return true;
}

/** A pattern where `*` is any run of characters, matched whole. */
function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** The value at a dotted `path` of `input`, or undefined. */
function fieldOf(input: unknown, path: string): unknown {
  let value = input;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function holds(condition: ToolInputCondition, value: unknown): boolean {
  if (value === undefined) return false;
  if (condition.equals !== undefined && canonical(value) !== canonical(condition.equals)) return false;
  if (condition.in !== undefined && !condition.in.some((item) => canonical(item) === canonical(value))) return false;
  const number = typeof value === "number" ? value : undefined;
  if (condition.gt !== undefined && !(number !== undefined && number > condition.gt)) return false;
  if (condition.gte !== undefined && !(number !== undefined && number >= condition.gte)) return false;
  if (condition.lt !== undefined && !(number !== undefined && number < condition.lt)) return false;
  if (condition.lte !== undefined && !(number !== undefined && number <= condition.lte)) return false;
  if (condition.matches !== undefined && !(typeof value === "string" && new RegExp(condition.matches).test(value)))
    return false;
  return true;
}

/** What a rule with no `reason` says. */
function describe(rule: ToolRule): string {
  const what = [
    rule.tool === undefined ? undefined : `tool '${rule.tool}'`,
    rule.server === undefined ? undefined : `server '${rule.server}'`,
    rule.kind === undefined ? undefined : `${rule.kind} tools`,
    rule.agent === undefined ? undefined : `agent '${rule.agent}'`,
    rule.when === undefined ? undefined : `input ${Object.keys(rule.when).join(", ")}`,
  ].filter((part) => part !== undefined);
  const verb = rule.effect === "deny" ? "refuses" : "asks a person about";
  return `The Tenant's tool policy ${verb} ${what.length === 0 ? "every tool call" : `calls of ${what.join(", ")}`}`;
}
