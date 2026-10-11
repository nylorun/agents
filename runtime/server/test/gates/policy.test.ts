/**
 * R5 step 2: the Tenant's tool policy. The strictest matching rule decides, a call no rule
 * matches runs, and every selector a rule sets must match.
 */
import { describe, expect, it } from "vitest";
import { PutToolPolicyRequestSchema, type ToolRule } from "@nylorun/core/contracts";
import { decide, type PolicyCall } from "../../src/gates/policy.js";

const refund: PolicyCall = {
  kind: "http",
  tool: "refund",
  agent: "support",
  input: { charge: "ch_1", amount: 3000, customer: { tier: "gold" } },
};
const issue: PolicyCall = {
  kind: "mcp",
  tool: "github__create_issue",
  server: "github",
  agent: "support",
  input: { title: "Login fails" },
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
    expect(decide([{ effect: "ask", tool: "github__*" }], issue).effect).toBe("ask");
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

  it("refuses a rule with an empty condition or a bad regular expression", () => {
    expect(PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "ask", when: { amount: {} } }] }).success).toBe(false);
    expect(
      PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "ask", when: { id: { matches: "(" } } }] }).success,
    ).toBe(false);
    expect(PutToolPolicyRequestSchema.safeParse({ rules: [{ effect: "maybe" }] }).success).toBe(false);
  });
});
