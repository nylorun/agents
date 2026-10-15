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
 *
 * A rule's `tool` matches the tool's identity (protocol 15): an MCP tool's own name on its
 * server (`server` names the server), an HTTP tool's declared name, a flow stage's key. The name
 * a harness gave the model never matches. A stored rule whose `tool` has `__` in it (an MCP tool
 * named by its old model-facing `server__tool` name) makes the policy unreadable, so every call
 * is refused until the policy names it by `server` and `tool`: a rule never silently stops
 * matching.
 */
import { ToolPolicySchema, type ToolInputCondition, type ToolPolicy, type ToolRule } from "@nylorun/core/contracts";
import type { AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { mcpToolSettingsIn } from "../mcp/snapshot.js";
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
  /**
   * The tool's identity: an MCP tool's own name on its server, an HTTP tool's declared name, a
   * flow stage's key.
   */
  readonly tool: string;
  /** The MCP server's name. */
  readonly server?: string;
  /** The agent that calls it. */
  readonly agent: string;
  readonly input: unknown;
  /** The name the model called it by, for display only: no rule matches it. */
  readonly name?: string;
}

export type PolicyDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "ask" | "deny"; readonly reason: string };

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

/** A stored policy this Runtime cannot apply: every call is refused, with `message` as why. */
export class ToolPolicyUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPolicyUnreadable";
  }
}

/**
 * The Tenant's policy; an empty one when none was set. Throws when it cannot be read, a
 * `ToolPolicyUnreadable` saying which rule when one names an MCP tool by a model-facing name.
 */
export async function readToolPolicy(t: Pick<Tx, "getSetting">): Promise<ToolPolicy> {
  const raw = await t.getSetting(TOOL_POLICY_SETTING);
  if (raw === undefined) return { rules: [], updatedAt: null };
  const parsed = ToolPolicySchema.safeParse(JSON.parse(raw));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ToolPolicyUnreadable(
    issue?.path.at(-1) === "tool"
      ? `Rule ${Number(issue.path[1]) + 1} of the Tenant's tool policy names a tool by a model-facing name: ${issue.message}. Set the policy again (PUT /v1/tenant/tool-policy)`
      : `The Tenant's tool policy could not be read: ${issue?.message ?? "malformed"}`
  );
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
  } catch (error) {
    return {
      effect: "deny",
      reason:
        error instanceof ToolPolicyUnreadable
          ? `${error.message}, so no tool call runs`
          : "The Tenant's tool policy could not be read, so no tool call runs",
    };
  }
  return decide(rules, policyCallOf(s, request, kind), pinnedApproval(turnManifestOf(s), request));
}

/** `request` as the policy reads it: by its target's identity (protocol 15). */
export function policyCallOf(s: Pick<Session, "agentId">, request: HostEffect, kind: "mcp" | "http"): PolicyCall {
  const target = request.target;
  return {
    kind,
    tool:
      target?.kind === "mcp" || target?.kind === "http"
        ? target.tool
        : (request.key ?? request.effectId),
    ...(target?.kind === "mcp" ? { server: target.server } : {}),
    agent: request.agent?.id ?? s.agentId,
    input: request.input,
    ...(request.toolName === undefined ? {} : { name: request.toolName }),
  };
}

/** Decides `call` by `rules`; `pinnedAsk` adds the ask of a manifest saved before R5 step 2. */
export function decide(rules: readonly ToolRule[], call: PolicyCall, pinnedAsk = false): PolicyDecision {
  let strictest: { effect: "allow" | "ask" | "deny"; reason?: string } | undefined = pinnedAsk
    ? {
        effect: "ask",
        reason: `The agent's manifest asks for approval of '${call.server === undefined ? call.tool : `${call.server} / ${call.tool}`}'`,
      }
    : undefined;
  for (const rule of rules) {
    if (!matches(rule, call)) continue;
    if (strictest && STRICTNESS[rule.effect] <= STRICTNESS[strictest.effect]) continue;
    strictest = { effect: rule.effect, reason: rule.reason ?? describe(rule) };
  }
  if (!strictest || strictest.effect === "allow") return { effect: "allow" };
  return { effect: strictest.effect, reason: strictest.reason! };
}

/**
 * The pinned `approval: "always"` of the call's tool, in a manifest saved before R5 step 2: an
 * MCP tool's settings by its own name, an HTTP tool's declaration by its declared name.
 */
export function pinnedApproval(manifest: AgentManifest, request: HostEffect): boolean {
  const target = request.target;
  if (target?.kind === "mcp")
    return mcpToolSettingsIn(manifest, request.agent?.id, target.server, target.tool).approval === "always";
  if (target?.kind === "http")
    return declaredHttpTool(manifest, request.agent?.id, target.tool)?.approval === "always";
  return false;
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
