/**
 * The R5 step 2 exit: tool policy. An approval can wait a day and still run the exact input it
 * was shown, whichever harness sent the call: nothing holds a process while it waits, so it
 * survives a restart. A deny rule refuses a matching call before it reaches the tool. A session
 * pinned to a manifest that set `approval` keeps it, and a definition that sets `approval` is
 * refused. The gates run over HTTP, as in the local stack.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import { hashManifest } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { openTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "r5-policy-token-aaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** A refund service that records each request it gets. */
async function refundService() {
  const requests: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString() || "null"));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refunded: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/refunds`, requests: () => [...requests] };
}

/** Calls `refund` once with `args`, then answers with the tool result it read. */
function refunder(args: Record<string, unknown>, seen: unknown[]): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const result = prompt.find((item) => item.kind === "tool-result");
    if (result) {
      seen.push(result);
      return { output: [{ type: "text", text: "done" }] };
    }
    return { output: [{ type: "tool-call", id: "call-1", name: "refund", args }] };
  };
}

const refundAgent = (url: string) =>
  Agent({ id: "bot", name: "Bot" })
    .tools(http({ name: "refund", input: z.object({ charge: z.string(), amount: z.number() }), url }))
    .build();

async function boot(model: ModelProvider, options: { hostRoot?: string; tenantId?: string } = {}) {
  const runtime = await startTestTenant({ applicationKey: APP, modelProvider: model, retainRoot: true, ...options });
  open.push(() => runtime.close());
  return runtime;
}

async function put(runtime: Started, path: string, body: unknown, management = false) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "PUT",
    headers: management ? { ...runtime.managementHeaders(), "content-type": "application/json" } : headers,
    body: JSON.stringify(body),
  });
  return response;
}

async function setPolicy(runtime: Started, rules: unknown[]) {
  const response = await put(runtime, "/v1/tenant/tool-policy", { rules }, true);
  expect(response.status, await response.clone().text()).toBe(200);
}

async function start(runtime: Started, manifest: unknown) {
  expect((await put(runtime, "/v1/agents/bot", { requestId: "put-1", manifest, implementationVersion: "dev" })).ok).toBe(true);
  expect((await put(runtime, "/v1/sessions/s1", { requestId: "session-s1", agentId: "bot", ownerUserId: "u" })).ok).toBe(true);
}

const command = (runtime: Started, body: Record<string, unknown>) =>
  fetch(`${runtime.url}/v1/sessions/s1/commands`, { method: "POST", headers, body: JSON.stringify(body) });

const say = async (runtime: Started) =>
  expect((await command(runtime, { type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" })).ok).toBe(true);

async function settled(runtime: Started): Promise<{ status: string; waits?: unknown }> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const view = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string };
    if (["completed", "failed", "cancelled", "paused", "uncertain"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The turn did not settle");
}

async function items(runtime: Started) {
  const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
    items: { type: string; payload: Record<string, any> }[];
  };
  return body.items;
}

describe("the R5 step 2 exit", { timeout: 60_000 }, () => {
  it("refuses a call a deny rule matches before it reaches the tool; the model sees why", async () => {
    const service = await refundService();
    const seen: unknown[] = [];
    const runtime = await boot(refunder({ charge: "ch_1", amount: 50_000 }, seen));
    await setPolicy(runtime, [
      { effect: "deny", tool: "refund", when: { amount: { gt: 10_000 } }, reason: "Refunds over 10000 are refused" },
    ]);
    await start(runtime, refundAgent(service.url).manifest);
    await say(runtime);
    expect((await settled(runtime)).status).toBe("completed");
    expect(service.requests()).toEqual([]);
    expect(JSON.stringify(seen)).toContain("tool.denied");
    const completed = (await items(runtime)).filter((item) => item.type === "tool.completed");
    expect(completed.map((item) => item.payload)).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 0,
        error: expect.objectContaining({ code: "tool.denied", message: "Refunds over 10000 are refused" }),
        // What the policy did (R7.1); never sent, so no gate times.
        policy: { decision: "deny", reason: "Refunds over 10000 are refused" },
      }),
    ]);
    expect(completed[0]!.payload).not.toHaveProperty("gate");
  });

  it("holds a call an ask rule matches; approved after a restart, it runs once with the input shown", async () => {
    const service = await refundService();
    const seen: unknown[] = [];
    const first = await boot(refunder({ charge: "ch_2", amount: 3000 }, seen));
    await setPolicy(first, [{ effect: "ask", tool: "refund", reason: "Refunds need a person" }]);
    await start(first, refundAgent(service.url).manifest);
    await say(first);
    const paused = await settled(first);
    expect(paused.status).toBe("paused");
    const pause = (await items(first)).find((item) => item.type === "turn.paused")!;
    const [interaction] = pause.payload.interactions as {
      callId: string;
      toolName: string;
      interaction: { id: string; kind: string; reason: string; input: unknown };
    }[];
    expect(interaction).toMatchObject({
      callId: "call-1",
      toolName: "refund",
      interaction: { kind: "approval", reason: "Refunds need a person", input: { charge: "ch_2", amount: 3000 } },
    });
    expect(service.requests()).toEqual([]);
    const calls = (await (await fetch(`${first.url}/v1/sessions/s1/calls/tool`, { headers })).json()) as {
      calls: { status: string; effectId: string }[];
    };
    expect(calls.calls).toEqual([expect.objectContaining({ status: "held", effectId: interaction!.interaction.id })]);

    // Nothing holds a process while it waits: the Runtime restarts, and the approval still works.
    await first.close();
    const again = await boot(refunder({ charge: "ch_2", amount: 3000 }, seen), {
      hostRoot: first.root,
      tenantId: first.tenantId,
    });
    const approved = await command(again, {
      type: "approve",
      requestId: "a1",
      idempotencyKey: "a1",
      interactionId: interaction!.interaction.id,
      approved: true,
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await settled(again)).status).toBe("completed");
    expect(service.requests()).toEqual([{ charge: "ch_2", amount: 3000 }]);
    const completed = (await items(again)).filter((item) => item.type === "tool.completed");
    expect(completed.map((item) => item.payload)).toEqual([
      expect.objectContaining({ status: "completed", attempts: 1, output: { refunded: true } }),
    ]);
  });

  it("fails a call a person denies to the model as tool.denied, unsent", async () => {
    const service = await refundService();
    const seen: unknown[] = [];
    const runtime = await boot(refunder({ charge: "ch_3", amount: 3000 }, seen));
    await setPolicy(runtime, [{ effect: "ask", kind: "http" }]);
    await start(runtime, refundAgent(service.url).manifest);
    await say(runtime);
    expect((await settled(runtime)).status).toBe("paused");
    const pause = (await items(runtime)).find((item) => item.type === "turn.paused")!;
    const id = (pause.payload.interactions as { interaction: { id: string } }[])[0]!.interaction.id;
    const denied = await command(runtime, { type: "approve", requestId: "a1", idempotencyKey: "a1", interactionId: id, approved: false });
    expect(denied.ok).toBe(true);
    expect((await settled(runtime)).status).toBe("completed");
    expect(service.requests()).toEqual([]);
    expect(JSON.stringify(seen)).toContain("tool.denied");
    // Held, then denied by a person (R7.1): the policy asked, and nobody approved.
    const completed = (await items(runtime)).find((item) => item.type === "tool.completed")!;
    expect(completed.payload.policy).toEqual({ decision: "ask", reason: expect.any(String) });
  });

  it("keeps the approval of a session pinned to a manifest that set it, through the Tool Gate", async () => {
    const service = await refundService();
    const runtime = await boot(refunder({ charge: "ch_4", amount: 10 }, []));
    await start(runtime, refundAgent(service.url).manifest);
    // As saved before R5 step 2: the pinned HTTP tool asks for approval.
    const store = await openTestSessionStore(runtime);
    try {
      await store.tx(async (t) => {
        const session = await t.get<Record<string, any>>("sessions", "s1");
        const manifest = structuredClone(session!.manifest);
        for (const capability of manifest.capabilities)
          for (const tool of capability.tools ?? []) if (tool.name === "refund") tool.approval = "always";
        await t.put("sessions", "s1", { ...session, manifest, manifestHash: hashManifest(manifest) });
      });
    } finally {
      await store.close();
    }
    await say(runtime);
    const view = await settled(runtime);
    expect(view.status, JSON.stringify(view)).toBe("paused");
    const pause = (await items(runtime)).find((item) => item.type === "turn.paused")!;
    expect(pause.payload.interactions[0].interaction.reason).toContain("manifest asks for approval");
    expect(service.requests()).toEqual([]);
  });

  it("holds a flow's HTTP stage as it holds an agent's HTTP tool call", async () => {
    const service = await refundService();
    const runtime = await boot(refunder({ charge: "unused", amount: 0 }, []));
    await setPolicy(runtime, [{ effect: "ask", kind: "http", tool: "refund" }]);
    const flow = Agent({ id: "bot" })
      .pipe(http({ name: "refund", input: z.object({ charge: z.string(), amount: z.number() }), url: service.url }))
      .build();
    expect((await put(runtime, "/v1/agents/bot", { requestId: "put-1", manifest: flow.manifest, implementationVersion: "dev" })).ok).toBe(true);
    expect((await put(runtime, "/v1/sessions/s1", { requestId: "session-s1", agentId: "bot", ownerUserId: "u" })).ok).toBe(true);
    expect(
      (await command(runtime, { type: "message", requestId: "m1", idempotencyKey: "m1", data: { charge: "ch_6", amount: 5 } })).ok,
    ).toBe(true);
    const view = await settled(runtime);
    expect(view.status, JSON.stringify(view)).toBe("paused");
    expect(service.requests()).toEqual([]);
    const pause = (await items(runtime)).find((item) => item.type === "turn.paused")!;
    const id = (pause.payload.interactions as { interaction: { id: string } }[])[0]!.interaction.id;
    expect((await command(runtime, { type: "approve", requestId: "a1", idempotencyKey: "a1", interactionId: id, approved: true })).ok).toBe(true);
    expect((await settled(runtime)).status).toBe("completed");
    expect(service.requests()).toEqual([{ charge: "ch_6", amount: 5 }]);
  });

  it("refuses a definition that sets approval, and reads and replaces the policy", async () => {
    const service = await refundService();
    const runtime = await boot(refunder({ charge: "ch_5", amount: 1 }, []));
    const manifest = structuredClone(refundAgent(service.url).manifest) as any;
    manifest.capabilities[0].tools[0].approval = "always";
    const refused = await put(runtime, "/v1/agents/bot", { requestId: "put-1", manifest, implementationVersion: "dev" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("approval was removed from the manifest");

    const empty = await fetch(`${runtime.url}/v1/tenant/tool-policy`, { headers: runtime.managementHeaders() });
    expect(await empty.json()).toEqual({ rules: [], updatedAt: null });
    await setPolicy(runtime, [{ effect: "ask", server: "billing*" }]);
    const set = (await (
      await fetch(`${runtime.url}/v1/tenant/tool-policy`, { headers: runtime.managementHeaders() })
    ).json()) as { rules: unknown[]; updatedAt: string };
    expect(set.rules).toEqual([{ effect: "ask", server: "billing*" }]);
    expect(typeof set.updatedAt).toBe("string");
    expect((await put(runtime, "/v1/tenant/tool-policy", { rules: [{ effect: "maybe" }] }, true)).status).toBe(400);
    // The Runtime API's key is not the Management API's.
    expect((await put(runtime, "/v1/tenant/tool-policy", { rules: [] })).status).toBe(403);
  });
});
