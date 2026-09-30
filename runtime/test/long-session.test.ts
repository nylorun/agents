/**
 * Model Calls P1 gate (design §8, §9): a session whose history outgrows a 16k window keeps
 * going, and what it stores grows with the window, not with the square of its length.
 */
import { expect, it } from "vitest";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { ModelCall } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "long-session-app-token-aaaaaaaaa";
const WINDOW = 16_384;
const TURNS = 10;
const STEPS = 30;

/**
 * A model with a 16k window: a prompt estimated above it fails with context_overflow. It
 * reports its window, so the engine compacts before that happens. Each turn makes 30
 * sandbox writes, then answers.
 */
function model(stats: { overflows: number; compactions: number; largest: number }): ModelProvider {
  const steps = new Map<string, number>();
  return async (effect) => {
    const call = effect.input as ModelCall;
    const tokens = Math.ceil(JSON.stringify(call.prompt).length / 4);
    stats.largest = Math.max(stats.largest, tokens);
    if ((effect.context as { compaction?: unknown }).compaction) {
      stats.compactions++;
      return { output: [{ type: "text", text: "## Goal\nWrite the files.\n## Progress\nMany written." }] };
    }
    if (tokens > WINDOW) {
      stats.overflows++;
      throw new Error(`This model's maximum context length is ${WINDOW} tokens, requested ${tokens}.`);
    }
    const step = steps.get(effect.turnId) ?? 0;
    steps.set(effect.turnId, step + 1);
    const evidence = { extras: { contextWindow: WINDOW, maxOutputTokens: 1_024 } };
    const usage = { totalTokens: tokens + 150 };
    if (step >= STEPS) return { output: [{ type: "text", text: "Done." }], usage, evidence };
    return {
      output: [
        { type: "text", text: `Writing file ${step}. ${"n".repeat(400)}` },
        {
          type: "tool-call",
          id: `call-${effect.turnId}-${step}`,
          name: "write",
          args: { path: `f${step}.txt`, content: "c".repeat(800) },
        },
      ],
      usage,
      evidence,
    };
  };
}

async function settle(session: ReturnType<AgentsClient["session"]>) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const view = await session.inspect();
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("session did not settle");
}

it(
  "runs 10 turns of 30 tool steps on a 16k window with bounded storage",
  async () => {
    const stats = { overflows: 0, compactions: 0, largest: 0 };
    const runtime = await startTestTenant({
      applicationKey: APP,
      vaultKek: null,
      sandbox: { backend: "virtual" },
      modelProvider: model(stats),
    });
    try {
      const client = createClient({
        url: runtime.url,
        key: runtime.applicationKey,
        tenant: runtime.tenantId,
      });
      await client.saveAgent(Agent({ id: "writer", name: "Writer" }).instructions("Write files.").build(), {
        implementationVersion: "dev",
      });
      const session = await client.createSession({
        id: "long",
        agentId: "writer",
        ownerUserId: "ada",
        sandbox: {},
      });
      for (let turn = 0; turn < TURNS; turn++) {
        await session.input(`Write batch ${turn}.`, { idempotencyKey: `m${turn}` });
        expect((await settle(session)).status).toBe("completed");
      }
      const { items } = await session.history();
      const compacted = items.filter((item) => item.type === "context.compacted");
      expect(compacted.length).toBeGreaterThan(0);
      expect(stats.compactions).toBe(compacted.length);
      // Proactive compaction kept every call inside the window.
      expect(stats.overflows).toBe(0);
      expect(stats.largest).toBeLessThanOrEqual(WINDOW);

      const stored = await withTestSessionStore(
        { root: runtime.root, tenantId: runtime.tenantId },
        (store) =>
          store.tx(async (t) => ({
            effects: await t.effectsForSession<any>("long"),
            session: await t.get<any>("sessions", "long"),
          })),
      );
      const models = stored.effects.filter((effect) => effect.request.kind === "model");
      expect(models.length).toBeGreaterThan(TURNS * STEPS);
      expect(models.every((effect) => effect.slimmed === true)).toBe(true);
      const perStep =
        models.reduce((sum, effect) => sum + JSON.stringify(effect).length, 0) / models.length;
      expect(perStep).toBeLessThanOrEqual(1_024);
      expect(JSON.stringify(stored.session).length).toBeLessThanOrEqual(3 * WINDOW * 4);
      expect(stored.session.state.transcript[0].kind).toBe("compaction");
    } finally {
      await runtime.close();
    }
  },
  180_000,
);
