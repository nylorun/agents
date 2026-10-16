/**
 * The access acceptance's A1 and A2 on a test Tenant (protocol 16): each subject of the
 * application key opens a session on its own Agent (`users/<role>/desk`, owner-guarded, made from
 * the agent manifest `desk`, which the app saved), follows its events, and its turn pauses for
 * the Tenant's tool policy, whose rule names the calling agent by its manifest (`agent: "desk"`),
 * never by the Agent the session runs on.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createClient } from "@nylorun/agents";
import type { ModelCall } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { startToolServer, type ToolServer } from "../support/tool-server.js";
import { setToolPolicy } from "../support/tool-policy.js";
import { APP, startSubjectTenant, type SubjectTenant } from "./subjects.js";

/** Calls `lookup_order` on a turn's first step, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as ModelCall;
  if (input.prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "shipped" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "lookup_order", args: { orderId: "o1" } }] };
};

let tenant: SubjectTenant;
let service: ToolServer;
beforeAll(async () => {
  tenant = await startSubjectTenant({ modelProvider: model });
  service = await startToolServer({ lookup_order: () => ({ status: "shipped" }) });
});
afterAll(async () => {
  await service?.close();
  await tenant?.close();
});

it("pauses a subject's turn on its own Agent for a rule naming the manifest, and streams its events", async () => {
  const app = createClient({ url: tenant.runtime.url, key: APP });
  const desk = Agent({ id: "desk", name: "Desk" })
    .tools(service.tool("lookup_order", { input: z.object({ orderId: z.string() }), output: z.object({ status: z.string() }) }))
    .build();
  await app.agentManifests.save({ agent: desk });
  await setToolPolicy(tenant.runtime, [{ effect: "ask", tool: "lookup_order", agent: "desk" }]);
  const name = "app:admin";
  const client = app.as(name, { scopes: ["agent-manifests:write", "sessions:own", "agents:write"] });
  await app.agents.put("users/admin/desk", { manifest: "desk", owner: name });
  const session = await client.createSession({ id: "sess-admin", agent: "users/admin/desk", ownerUserId: name });

  const streams = new AbortController();
  const seen: { type: string; sessionId: string }[] = [];
  const reading = (async () => {
    try {
      for await (const event of session.observe({ signal: streams.signal })) seen.push(event as never);
    } catch (error) {
      if (!streams.signal.aborted) throw error;
    }
  })();
  try {
    await session.input("Where is my order?", { idempotencyKey: "m1" });
    let view = await session.inspect();
    for (let i = 0; i < 400 && !["paused", "completed", "failed"].includes(view.status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await session.inspect();
    }
    expect(view.status, "the rule `agent: desk` holds the call of the Agent users/admin/desk").toBe("paused");
    expect(service.calls).toHaveLength(0);
    const interaction = (view.waits as { interaction?: { kind: string; id: string } }[]).find(
      (wait) => wait.interaction?.kind === "approval",
    )!.interaction!;
    await session.approve(interaction.id, true, { idempotencyKey: "approve-1" });
    for (let i = 0; i < 400 && !seen.some((event) => event.type === "turn.completed"); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await session.inspect()).status).toBe("completed");
    expect(service.calls.map((call) => call.name)).toEqual(["lookup_order"]);
    expect(seen.map((event) => event.type)).toContain("turn.completed");
    expect(new Set(seen.map((event) => event.sessionId))).toEqual(new Set(["sess-admin"]));
  } finally {
    streams.abort();
    await reading;
  }
});
