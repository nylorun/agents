import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import { startToolServer, type ToolServer } from "./support/tool-server.js";

/**
 * An approval-gated HTTP tool (`approval: "always"`) with an output schema pauses for the
 * approval instead of failing as `tool.invalid-output`; approving makes the call and checks
 * its answer against the schema, and denying reports `denied` without calling the service.
 */

const APP = "tool-approval-output-app-token-aaa";

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let client: AgentsClient;
let service: ToolServer;
/** The tool result the model last saw (the tests run one session at a time). */
let lastToolResult: unknown;

beforeAll(async () => {
  service = await startToolServer({
    lookup_order: ({ orderId }) => ({ orderId, status: "shipped" }),
  });
  const agent = Agent({
    id: "orders",
    name: "Orders",
    instructions: "Look up the order, then stop.",
  })
    .tools(
      service.tool("lookup_order", {
        description: "Look up an order.",
        input: z.object({ orderId: z.string() }),
        output: z.object({ orderId: z.string(), status: z.string() }),
        approval: "always",
      })
    )
    .build();
  runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async (effect: {
      input?: { prompt?: { kind?: string }[] };
    }) => {
      const last = effect.input?.prompt?.at(-1);
      if (last?.kind === "tool-result") {
        lastToolResult = last;
        return { output: [{ type: "text" as const, text: "done" }] };
      }
      return {
        output: [
          {
            type: "tool-call" as const,
            id: "call-1",
            name: "lookup_order",
            args: { orderId: "A-1" },
          },
        ],
      };
    },
  });
  client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  await client.saveAgent(agent, { implementationVersion: "v1" });
});

afterAll(async () => {
  await service?.close();
  await runtime?.close();
});

type Session = ReturnType<AgentsClient["session"]>;

async function pausedWait(session: Session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waits = await session.pending();
    if (Array.isArray(waits) && waits.length > 0) return waits[0]!;
    const view = await session.inspect();
    if (["idle", "completed", "failed", "cancelled"].includes(view.status))
      throw new Error(`expected a pause but session settled as ${view.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for the approval");
}

async function settled(session: Session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed"].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

function interactionIdOf(wait: unknown): string {
  const w = wait as { interactionId?: string; interaction?: { id?: string } };
  const id = w.interactionId ?? w.interaction?.id;
  if (!id) throw new Error(`no interaction id in wait: ${JSON.stringify(wait)}`);
  return id;
}

async function toolResults(session: Session) {
  const history = await session.history();
  return history.items
    .filter((item) => item.type === "tool.completed")
    .map((item) => item.payload as { output?: unknown; error?: { code: string } });
}

it("pauses an approval-gated tool with an output schema, then completes it on approve", async () => {
  const session = await client.createSession({
    id: "approve",
    agentId: "orders",
    ownerUserId: "user",
  });
  await session.input("look up A-1", { idempotencyKey: "msg-approve" });
  const wait = await pausedWait(session);
  expect(wait).toMatchObject({
    interaction: { kind: "approval", prompt: "Approve lookup_order?" },
  });
  const before = await session.history();
  expect(before.items.some((item) => item.type === "turn.paused")).toBe(true);
  expect(await toolResults(session)).toEqual([]);

  const runsBefore = service.calls.length;
  await session.approve(interactionIdOf(wait), true, {
    idempotencyKey: "approve-1",
  });
  await settled(session);
  expect(service.calls.length).toBe(runsBefore + 1);
  const results = await toolResults(session);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    toolName: "lookup_order",
    output: { orderId: "A-1", status: "shipped" },
  });
  expect(results[0]!.error).toBeUndefined();
  const after = await session.history();
  expect(after.items.some((item) => item.type === "turn.completed")).toBe(true);
});

it("reports a denied approval to the model as denied, not as an invalid output", async () => {
  const session = await client.createSession({
    id: "deny",
    agentId: "orders",
    ownerUserId: "user",
  });
  await session.input("look up A-1", { idempotencyKey: "msg-deny" });
  const wait = await pausedWait(session);

  const runsBefore = service.calls.length;
  await session.approve(interactionIdOf(wait), false, {
    idempotencyKey: "deny-1",
  });
  await settled(session);
  // The harness settles a rejected approval gate itself; the service is never called.
  expect(service.calls.length).toBe(runsBefore);
  expect(lastToolResult).toMatchObject({
    kind: "tool-result",
    toolName: "lookup_order",
    status: "denied",
  });
  expect(await toolResults(session)).not.toContainEqual(
    expect.objectContaining({ error: expect.anything() })
  );
  const history = await session.history();
  expect(history.items.some((item) => item.type === "turn.completed")).toBe(
    true
  );
});
