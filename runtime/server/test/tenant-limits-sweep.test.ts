/**
 * The last limits B15 made Tenant settings (B15c): their defaults equal the values they replace,
 * and a lowered limit takes effect in each area: a message's parts, a page, labels, a manifest's
 * description, setup command and secret slots, a secret write, the tool policy, the budgets, and
 * an Agent's events.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNTIME_LIMIT_CEILINGS, RUNTIME_LIMIT_DEFAULTS, type RuntimeLimits } from "@nylorun/core/contracts";
import { budgetIssues, labelIssues, secretRequestIssues, toolPolicyIssues } from "../src/tenant/limits.js";
import { boot, openSession, plain, server, type Started } from "./host/execution-support.js";
import { deploy, manifestOf, writeManifest } from "./support/agents.js";

let runtime: Started;
beforeAll(async () => {
  runtime = await boot({ sandbox: { backend: "virtual" } });
  // Agent manifest `bot` (and Agent `bot`), which the Agents here are made from.
  await deploy(runtime.url, server, plain);
});
afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = server) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}
const management = () => runtime.managementHeaders();
const setLimits = async (limits: Partial<RuntimeLimits>) =>
  expect((await call("PUT", "/v1/tenant/limits", { limits }, management())).status).toBe(200);
async function lowered(limits: Partial<RuntimeLimits>, body: () => Promise<void>) {
  await setLimits(limits);
  try {
    await body();
  } finally {
    await setLimits({});
  }
}

describe("the B15c limits", () => {
  it("default to the values they replace, each within its ceiling", () => {
    expect(RUNTIME_LIMIT_DEFAULTS).toMatchObject({
      messageParts: 32,
      pageItems: 200,
      exportPageItems: 1_000,
      environmentEventItems: 1_000,
      artifactLabels: 32,
      labelKeyChars: 63,
      labelValueChars: 256,
      setupCommandChars: 4_096,
      setupReasonChars: 500,
      setupCommandExcerptChars: 80,
      manifestDescriptionChars: 1_024,
      secretDescriptionChars: 500,
      secretValueChars: 8_192,
      secretHosts: 32,
      toolRules: 200,
      toolRuleFieldChars: 200,
      toolRuleTextChars: 500,
      modelBudgets: 100,
      flowConcurrency: 8,
      flowMapItems: 1_000,
      flowLoopIterations: 100,
    });
    // Linux's longest argument (MAX_ARG_STRLEN, 128 KiB with its NUL) at 3 UTF-8 bytes a character.
    expect(RUNTIME_LIMIT_CEILINGS.setupCommandChars.value).toBe(43_690);
  });

  it("hold a message to messageParts", async () => {
    await openSession(runtime, "parts");
    const send = (id: string, count: number) =>
      call("POST", "/v1/sessions/parts/commands", {
        type: "message",
        requestId: id,
        idempotencyKey: id,
        parts: Array.from({ length: count }, (_, index) => ({ type: "text", text: `part ${index}` })),
      });
    await lowered({ messageParts: 2 }, async () => {
      const refused = await send("m1", 3);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("at most 2 parts (the Runtime limit messageParts)");
    });
    // The default takes 33 no longer only by the schema: the limit says 32.
    expect((await send("m2", RUNTIME_LIMIT_DEFAULTS.messageParts + 1)).status).toBe(400);
  });

  it("hold a page to pageItems: a larger limit gets that many, a page with none the lower of its default and the limit", async () => {
    for (const id of ["p1", "p2", "p3"])
      expect((await call("PUT", `/v1/agents/${id}`, { requestId: id, manifest: "bot" })).status).toBe(200);
    await lowered({ pageItems: 2 }, async () => {
      const page = await call("GET", "/v1/agents?limit=50");
      expect(page.status).toBe(200);
      expect(page.body.agents).toHaveLength(2);
      expect(page.body.nextCursor).toEqual(expect.any(String));
    });
    expect((await call("GET", "/v1/agents?limit=250")).status).toBe(200);
  });

  it("hold an artifact's labels to artifactLabels, labelKeyChars and labelValueChars", async () => {
    const upload = (query: string) =>
      fetch(`${runtime.url}/v1/artifacts?name=a.txt&${query}`, {
        method: "POST",
        headers: { authorization: server.authorization, "content-type": "text/plain" },
        body: "hello",
      });
    await lowered({ artifactLabels: 1, labelKeyChars: 3, labelValueChars: 4 }, async () => {
      const many = await upload("label=a=1&label=b=2");
      expect(many.status).toBe(400);
      expect(((await many.json()) as { message: string }).message).toContain("artifactLabels allows at most 1");
      const long = await upload("label=long=1");
      expect(((await long.json()) as { message: string }).message).toContain("labelKeyChars allows at most 3");
      const value = await upload("label=k=12345");
      expect(((await value.json()) as { message: string }).message).toContain("labelValueChars allows at most 4");
      expect((await upload("label=k=1234")).status).toBe(201);
    });
  });

  it("hold an Agent's label keys and values to labelKeyChars and labelValueChars", async () => {
    await lowered({ labelKeyChars: 2, labelValueChars: 2 }, async () => {
      const refused = await call("PUT", "/v1/agents/labels", { requestId: "l1", manifest: "bot", labels: { abc: "1", a: "123" } });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("labelKeyChars allows at most 2");
      expect(refused.body.message).toContain("labelValueChars allows at most 2");
    });
    // Past the old schema's 63 characters, now within the limit when the Tenant raises it.
    await lowered({ labelKeyChars: 100 }, async () => {
      expect(
        (await call("PUT", "/v1/agents/labels", { requestId: "l2", manifest: "bot", labels: { ["k".repeat(80)]: "v" } })).status,
      ).toBe(200);
    });
  });

  it("hold a saved manifest to setupCommandChars, the description limits and secretHosts", async () => {
    await lowered({ setupCommandChars: 4, manifestDescriptionChars: 5, secretDescriptionChars: 3, secretHosts: 1 }, async () => {
      const saved = await writeManifest(runtime.url, server, {
        ...manifestOf(plain, {
          name: "shaped",
          runtime: {
            kind: "pod",
            setup: [{ command: "make all" }],
            secrets: {
              GITHUB_TOKEN: {
                type: "environment_secret",
                allowedHosts: ["api.github.com", "github.com"],
                description: "the bot",
              },
            },
          },
        }),
        description: "too long",
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(400);
      const message = JSON.stringify(saved.body);
      expect(message).toContain("setupCommandChars allows at most 4");
      expect(message).toContain("manifestDescriptionChars allows at most 5");
      expect(message).toContain("secretDescriptionChars allows at most 3");
      expect(message).toContain("secretHosts allows at most 1");
    });
  });

  it("hold a secret's value to secretValueChars when it is written", async () => {
    expect((await call("PUT", "/v1/agents/vaulted", { requestId: "v1", manifest: "bot" })).status).toBe(200);
    await lowered({ secretValueChars: 4 }, async () => {
      const refused = await call("PUT", "/v1/agents/vaulted/secrets/MODE", { type: "environment_variable", value: "12345" });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("secretValueChars allows at most 4");
      expect((await call("PUT", "/v1/agents/vaulted/secrets/MODE", { type: "environment_variable", value: "1234" })).status).toBe(200);
    });
  });

  it("hold the tool policy to toolRules and its texts, and the budgets to modelBudgets", async () => {
    await lowered({ toolRules: 1, toolRuleFieldChars: 3, modelBudgets: 1 }, async () => {
      const policy = await call(
        "PUT",
        "/v1/tenant/tool-policy",
        { rules: [{ effect: "deny", tool: "delete" }, { effect: "allow" }] },
        management(),
      );
      expect(policy.status).toBe(400);
      expect(policy.body.message).toContain("toolRules allows at most 1");
      expect(policy.body.message).toContain("rules[0].tool has 6 characters; the Runtime limit toolRuleFieldChars");
      const budgets = await call(
        "PUT",
        "/v1/tenant/budgets",
        { budgets: [{ scope: "turn", limitTokens: 5 }, { scope: "tenant", period: "day", limitTokens: 50 }] },
        management(),
      );
      expect(budgets.status).toBe(400);
      expect(budgets.body.message).toContain("modelBudgets allows at most 1");
    });
  });

  it("hold one read of an Agent's events to environmentEventItems; from reads on", async () => {
    // Agent bot's stream: created, and an attachment for each session on it.
    await openSession(runtime, "evented-a", false);
    const all = (await call("GET", "/v1/agents/bot/events")).body.events as { seq: number }[];
    expect(all.length).toBeGreaterThan(0);
    await lowered({ environmentEventItems: 1 }, async () => {
      const first = (await call("GET", "/v1/agents/bot/events")).body.events as { seq: number }[];
      expect(first).toHaveLength(1);
      if (all.length > 1) {
        const next = (await call("GET", `/v1/agents/bot/events?from=${first[0]!.seq + 1}`)).body.events;
        expect(next).toHaveLength(1);
      }
    });
  });
});

describe("the B15c checks", () => {
  const limits = { ...RUNTIME_LIMIT_DEFAULTS, environmentSecretSlots: 1, secretValueChars: 3, secretHosts: 1 };
  it("name each limit a request passes", () => {
    expect(secretRequestIssues({ type: "environment_secret", value: "abcd", allowedHosts: ["a.b", "c.d"] }, limits)).toHaveLength(2);
    // A bearer's value has no Runtime limit of its own.
    expect(secretRequestIssues({ type: "bearer", value: "abcd" }, limits)).toEqual([]);
    expect(budgetIssues([1, 2], { ...limits, modelBudgets: 1 })).toHaveLength(1);
    expect(
      toolPolicyIssues(
        [{ effect: "ask", reason: "x".repeat(6), when: { "a.b.c": { matches: "y".repeat(6) } } }],
        { ...limits, toolRuleTextChars: 5, toolRuleFieldChars: 4 },
      ),
    ).toEqual([
      expect.stringContaining("rules[0].reason has 6 characters"),
      expect.stringContaining("rules[0].when path"),
      expect.stringContaining("matches has 6 characters"),
    ]);
    expect(labelIssues({ abc: "x" }, { ...limits, artifactLabels: 0, labelKeyChars: 2 }, "artifactLabels")).toHaveLength(2);
  });
});
