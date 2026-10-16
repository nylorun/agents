/**
 * R5 step 2: the Tenant's tool policy. The strictest matching rule decides, a call no rule
 * matches runs, and every selector a rule sets must match. Protocol 15: a rule names a tool by
 * its identity (an MCP tool's own name on its server, an HTTP tool's declared name), never by the
 * name a harness gave the model; a stored rule that does refuses every call.
 */
import { describe, expect, it } from "vitest";
import { PutToolPolicyRequestSchema, type ToolRule } from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import {
  decide,
  pinnedApproval,
  policyCallOf,
  readToolPolicy,
  toolCallDecision,
  TOOL_POLICY_SETTING,
  ToolPolicyUnreadable,
  type PolicyCall,
} from "../../src/gates/policy.js";
import type { Session } from "../../src/tenant/context.js";

const refund: PolicyCall = {
  kind: "http",
  tool: "refund",
  agent: "support",
  input: { charge: "ch_1", amount: 3000, customer: { tier: "gold" } },
};
const issue: PolicyCall = {
  kind: "mcp",
  tool: "create.issue",
  server: "github",
  agent: "support",
  input: { title: "Login fails" },
  name: "github__create_issue",
};

describe("the tool policy", () => {
  it("runs a call no rule matches", () => {
    expect(decide([], refund)).toEqual({ effect: "allow" });
    expect(decide([{ effect: "deny", tool: "delete_*" }], refund)).toEqual({ effect: "allow" });
  });

  it("lets the strictest matching rule decide, whatever the order", () => {
    const rules: ToolRule[] = [
      { effect: "allow", tool: "*" },
      { effect: "ask", tool: "refund", reason: "Refunds need a person" },
      { effect: "deny", kind: "http", when: { amount: { gt: 10_000 } }, reason: "Too large" },
    ];
    expect(decide(rules, refund)).toEqual({ effect: "ask", reason: "Refunds need a person" });
    expect(decide(rules, { ...refund, input: { amount: 50_000 } })).toEqual({ effect: "deny", reason: "Too large" });
    expect(decide([...rules].reverse(), refund)).toEqual({ effect: "ask", reason: "Refunds need a person" });
  });

  it("matches tool and server globs, kind and agent", () => {
    expect(decide([{ effect: "ask", tool: "create.*" }], issue).effect).toBe("ask");
    expect(decide([{ effect: "ask", server: "github", tool: "create.issue" }], issue).effect).toBe("ask");
    expect(decide([{ effect: "ask", server: "git*" }], issue).effect).toBe("ask");
    // A server selector never matches an HTTP tool, which has no server.
    expect(decide([{ effect: "ask", server: "*" }], refund).effect).toBe("allow");
    expect(decide([{ effect: "ask", kind: "mcp" }], refund).effect).toBe("allow");
    expect(decide([{ effect: "ask", agent: "sales" }], refund).effect).toBe("allow");
    expect(decide([{ effect: "ask", agent: "supp*" }], refund).effect).toBe("ask");
    // Regex characters in a glob are literal.
    expect(decide([{ effect: "ask", tool: "ref.nd" }], refund).effect).toBe("allow");
  });

  it("tests input fields by dotted path, and a missing field never matches", () => {
    const at = (when: ToolRule["when"]) => decide([{ effect: "deny", when }], refund).effect;
    expect(at({ amount: { gte: 3000 } })).toBe("deny");
    expect(at({ amount: { lt: 3000 } })).toBe("allow");
    expect(at({ "customer.tier": { equals: "gold" } })).toBe("deny");
    expect(at({ "customer.tier": { in: ["silver", "bronze"] } })).toBe("allow");
    expect(at({ charge: { matches: "^ch_" } })).toBe("deny");
    expect(at({ refundReason: { equals: "fraud" } })).toBe("allow");
    // Every condition of a rule must hold.
    expect(at({ amount: { gt: 1000 }, charge: { matches: "^re_" } })).toBe("allow");
  });

  it("asks for a pinned manifest's approval, and a deny rule still wins over it", () => {
    expect(decide([], refund, true)).toMatchObject({ effect: "ask" });
    expect(decide([{ effect: "deny", tool: "refund" }], refund, true)).toMatchObject({ effect: "deny" });
  });

  it("describes a rule that gives no reason", () => {
    expect(decide([{ effect: "deny", tool: "refund", when: { amount: { gt: 1 } } }], refund)).toEqual({
      effect: "deny",
      reason: "The Tenant's tool policy refuses calls of tool 'refund', input amount",
    });
  });

  it("never matches the name the model called a tool by", () => {
    expect(decide([{ effect: "deny", tool: "github_create_issue" }], issue).effect).toBe("allow");
    expect(decide([{ effect: "deny", tool: "github*" }], issue).effect).toBe("allow");
  });

  it("refuses a rule whose tool has __ in it: it names an MCP tool by its model-facing name", () => {
    const put = PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "deny", tool: "github__create_issue" }] });
    expect(put.success).toBe(false);
    expect(JSON.stringify(put.error?.issues)).toContain("Name an MCP tool by `server` and `tool`");
    expect(PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "deny", server: "github", tool: "create_issue" }] }).success).toBe(true);
  });

  it("refuses a rule with an empty condition or a bad regular expression", () => {
    expect(PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "ask", when: { amount: {} } }] }).success).toBe(false);
    expect(
      PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "ask", when: { id: { matches: "(" } } }] }).success,
    ).toBe(false);
    expect(PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "maybe" }] }).success).toBe(false);
  });
});

describe("a call as the policy reads it (protocol 15)", () => {
  // Protocol 16: the session runs on the Agent `users/ada/support`, made from the manifest `support`.
  const session = { agentId: "users/ada/support", manifest: { id: "support" } } as Session;
  const effect = (fields: Partial<HostEffect>): HostEffect =>
    ({ kind: "tool", effectId: "e1", sessionId: "s", turnId: "t", input: {}, context: {}, ...fields }) as HostEffect;

  it("keys an MCP call on its server and the server's own tool name, an HTTP call on its declared name", () => {
    expect(
      policyCallOf(session, effect({ toolName: "github__create_issue", target: { kind: "mcp", server: "github", tool: "create.issue" } }), "mcp"),
    ).toEqual({ kind: "mcp", tool: "create.issue", server: "github", agent: "support", input: {}, name: "github__create_issue" });
    expect(policyCallOf(session, effect({ toolName: "pay", target: { kind: "http", tool: "refund" } }), "http")).toMatchObject({
      tool: "refund",
      name: "pay",
    });
    expect(policyCallOf(session, effect({ key: "stage" }), "http")).toMatchObject({ tool: "stage" });
  });

  it("names the calling agent by its manifest, never by the Agent the session runs on (protocol 16)", () => {
    const http = effect({ target: { kind: "http", tool: "lookup_order" } });
    expect(policyCallOf(session, http, "http").agent).toBe("support");
    expect(decide([{ effect: "ask", tool: "lookup_order", agent: "support" }], policyCallOf(session, http, "http")).effect).toBe("ask");
    expect(decide([{ effect: "ask", agent: "users/*" }], policyCallOf(session, http, "http")).effect).toBe("allow");
    // An agent used as a tool is named by its own id.
    const delegated = effect({ target: { kind: "http", tool: "lookup_order" }, agent: { id: "billing", path: "billing" } });
    expect(policyCallOf(session, delegated, "http").agent).toBe("billing");
  });

  it("finds a pinned approval by the tool's identity", () => {
    // A manifest saved before R5 step 2, as a pinned session keeps it.
    const manifest = {
      manifestSchemaVersion: 7,
      id: "support",
      mcpServers: {
        github: {
          name: "github",
          type: "streamable-http",
          url: "https://mcp.example.invalid",
          tools: { "create.issue": { approval: "always" } },
        },
      },
    } as never;
    const mcp = effect({ toolName: "github__create_issue", target: { kind: "mcp", server: "github", tool: "create.issue" } });
    expect(pinnedApproval(manifest, mcp)).toBe(true);
    expect(pinnedApproval(manifest, effect({ target: { kind: "mcp", server: "github", tool: "other" } }))).toBe(false);
  });

  it("refuses every call while a stored rule names a tool by a model-facing name", async () => {
    const stored = JSON.stringify({ rules: [{ effect: "allow", tool: "github__create_issue" }], updatedAt: "2026-10-01T00:00:00Z" });
    const t = { getSetting: async (key: string) => (key === TOOL_POLICY_SETTING ? stored : undefined) };
    await expect(readToolPolicy(t)).rejects.toBeInstanceOf(ToolPolicyUnreadable);
    const decision = await toolCallDecision(
      t,
      { agentId: "support", manifest: Agent({ id: "support" }).build().manifest } as Session,
      effect({ toolName: "x", target: { kind: "http", tool: "x" } }),
      "http",
    );
    expect(decision).toEqual({ effect: "deny", reason: expect.stringContaining("Rule 1 of the Tenant's tool policy names a tool by a model-facing name") });
  });
});
