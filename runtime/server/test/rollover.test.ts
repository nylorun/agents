/**
 * Model Calls P2 gate (design §10): a long turn runs in segments that each end at a step
 * boundary, so no advance reaches its deadline, and the turn completes as one turn.
 */
import { afterEach, expect, it } from "vitest";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "rollover-app-token-aaaaaaaaaaaaaa";

/** Writes one file per step for `steps` steps, then answers; each call takes `delayMs`. */
function writer(steps: number, delayMs = 0): ModelProvider & { calls: () => number } {
  let calls = 0;
  const provider = async (effect: Parameters<ModelProvider>[0]) => {
    const step = calls++;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (step >= steps) return { output: [{ type: "text", text: "All written." }] };
    return {
      output: [
        {
          type: "tool-call",
          id: `call-${effect.turnId}-${step}`,
          name: "write",
          args: { path: `f${step}.txt`, content: "x" },
        },
      ],
    };
  };
  return Object.assign(provider, { calls: () => calls });
}

async function settle(session: ReturnType<AgentsClient["session"]>) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const view = await session.inspect();
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("session did not settle");
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function open(model: ModelProvider, rollover: { steps?: number; ms?: number }) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    sandbox: { backend: "virtual" },
    modelProvider: model,
    rollover,
  });
  closers.push(() => runtime.close());
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await client.saveAgent(Agent({ id: "writer", name: "Writer" }).instructions("Write.").build(), {
    implementationVersion: "dev",
  });
  const session = await client.createSession({
    id: "s1",
    agentId: "writer",
    ownerUserId: "ada",
    sandbox: {},
  });
  return { runtime, session };
}

it("runs one turn across several segments and completes it", async () => {
  const model = writer(10);
  const { runtime, session } = await open(model, { steps: 3 });
  await session.input("write ten files", { idempotencyKey: "m1" });
  expect((await settle(session)).status).toBe("completed");
  expect(model.calls()).toBe(11);

  const { items } = await session.history();
  expect(items.filter((item) => item.type === "turn.paused")).toEqual([]);
  expect(items.filter((item) => item.type === "turn.completed")).toHaveLength(1);
  expect(items.filter((item) => item.type === "message.assistant")).toHaveLength(11);

  const stored = await withTestSessionStore(
    { root: runtime.root, tenantId: runtime.tenantId },
    (store) =>
      store.tx(async (t) => ({
        effects: await t.effectsForSession<any>("s1"),
        session: await t.get<any>("sessions", "s1"),
      })),
  );
  const segments = new Set(
    stored.effects.map((effect) => String(effect.request.effectId).split(":")[1]),
  );
  // 11 model calls at 3 steps per segment.
  expect(segments.size).toBe(4);
  expect(stored.session.checkpoint.segment).toBe(3);
  expect(new Set(stored.effects.map((effect) => effect.request.effectId)).size).toBe(
    stored.effects.length,
  );
});

it("rolls over on time as well as on steps", async () => {
  const model = writer(6, 30);
  const { runtime, session } = await open(model, { steps: 1_000, ms: 50 });
  await session.input("write six files", { idempotencyKey: "m1" });
  expect((await settle(session)).status).toBe("completed");
  const segment = await withTestSessionStore(
    { root: runtime.root, tenantId: runtime.tenantId },
    (store) => store.tx(async (t) => (await t.get<any>("sessions", "s1")).checkpoint.segment),
  );
  expect(segment).toBeGreaterThanOrEqual(2);
});

it("cancels a turn between segments and runs nothing after", async () => {
  const model = writer(1_000, 20);
  const { session } = await open(model, { steps: 1 });
  await session.input("keep writing", { idempotencyKey: "m1" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await session.cancel({ idempotencyKey: "c1" });
  expect((await settle(session)).status).toBe("cancelled");
  const after = model.calls();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(model.calls()).toBeLessThanOrEqual(after + 1);
  expect((await session.history()).items.filter((item) => item.type === "turn.cancelled")).toHaveLength(1);
});
