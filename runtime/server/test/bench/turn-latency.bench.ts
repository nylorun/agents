/**
 * Turn latency of the in-process harness and of a harness over a loopback WebSocket (F6.1 H1,
 * F6.2). Not part of `npm test`:
 *
 *   (cd runtime && npx vitest bench --run test/bench)
 *
 * Each scenario runs `BENCH_TURNS` (default 200) turns on a Tenant with the in-process
 * harness (`memory`) and one with a harness service over WebSocket (`ws`), interleaved,
 * timing the advances themselves (the
 * execution is never started; the bench calls the Tenant's worker): (a) one model call;
 * (b) ten steps alternating model calls and sandbox `bash`; (c) an HTTP tool answered by a
 * local service; (d) a warm resume over a 300-entry transcript. Then the
 * Harness API's traffic per turn of (c) in JSON mode, and the heap after 500 sessions.
 * Prints p50/p95 per scenario; (b) and (c) should stay within 10%.
 */
import { afterAll, describe, test } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import type { Frame } from "@nylorun/core/harness-api";
import type { ModelProvider } from "../../src/core/provider.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { setTranscriptShadow } from "../../src/tenant/history.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import { startTestTenant, type StartTestTenantOptions } from "../support/tenant.js";
import { startToolServer, type ToolServer } from "../support/tool-server.js";

const TURNS = Number(process.env.BENCH_TURNS ?? 200);
const APP = "bench-app-token-aaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

setTranscriptShadow(false);

const plain = Agent({ id: "plain", name: "Plain" }).build();
const sandboxed = Agent({ id: "sandboxed", name: "Sandboxed" }).instructions("Use the sandbox.").build();
const httpTools = (service: ToolServer) =>
  Agent({ id: "http", name: "HTTP" })
    .tools(
      service.tool("save", {
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
      }),
    )
    .build();

/** Answers after `steps` tool calls of `call`, counting the turn's tool results. */
function stepping(steps: number, call: (step: number) => { name: string; args: unknown }): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string; turnId?: string }[] }).prompt ?? [];
    let step = 0;
    for (let i = prompt.length - 1; i >= 0 && prompt[i]!.kind !== "input"; i -= 1)
      if (prompt[i]!.kind === "tool-result") step += 1;
    if (step >= steps) return { output: [{ type: "text", text: "done" }] };
    const next = call(step);
    return { output: [{ type: "tool-call", id: `call-${effect.effectId}`, name: next.name, args: next.args }] };
  };
}

const models: Record<string, ModelProvider> = {
  plain: async () => ({ output: [{ type: "text", text: "done" }] }),
  sandboxed: stepping(5, (step) => ({ name: "bash", args: { command: `echo ${step}` } })),
  http: stepping(1, () => ({ name: "save", args: { note: "hi" } })),
};

type Bench = Awaited<ReturnType<typeof open>>;

async function open(harness: "memory" | "ws", extra: Partial<StartTestTenantOptions> = {}) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    harness,
    sandbox: { backend: "virtual" },
    sweepIntervalMs: 600_000,
    modelProvider: (effect, signal) => models[effect.agentId]!(effect, signal),
    // Never started: the bench runs every advance itself.
    execution: { execution: new MemoryExecution(), workers: new TenantWorkers() },
    ...extra,
  });
  const worker = (runtime.handle as TenantRuntime).worker;
  const service = await startToolServer({ save: () => ({ saved: true }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<any>;
  };
  for (const agent of [plain, sandboxed, httpTools(service)])
    await call("PUT", `/v1/agents/${agent.manifest.id}`, {
      requestId: agent.manifest.id,
      manifest: agent.manifest,
      implementationVersion: "dev",
    });
  let n = 0;
  return {
    runtime,
    async session(agentId: string) {
      const id = `s${++n}`;
      await call("PUT", `/v1/sessions/${id}`, {
        requestId: id,
        agentId,
        ownerUserId: "u",
        ...(agentId === "sandboxed" ? { sandbox: {} } : {}),
      });
      return id;
    },
    async message(id: string) {
      n += 1;
      await call("POST", `/v1/sessions/${id}/commands`, {
        type: "message",
        requestId: `m${n}`,
        idempotencyKey: `m${n}`,
        content: "go",
      });
    },
    async advance(id: string) {
      const result = await worker.advance(id, new AbortController().signal);
      if (result.status !== "done") throw new Error(`advance of ${id}: ${JSON.stringify(result)}`);
    },
    async status(id: string) {
      return (await call("GET", `/v1/sessions/${id}`)).status as string;
    },
    async close() {
      await service.close();
      await runtime.close();
    },
  };
}

/** One measured turn of a scenario, in ms. */
type Turn = (bench: Bench, state: Map<Bench, string>) => Promise<number>;

const time = async (fn: () => Promise<void>) => {
  const started = performance.now();
  await fn();
  return performance.now() - started;
};

const scenarios: Record<string, Turn> = {
  "(a) one model call": async (b) => {
    const id = await b.session("plain");
    await b.message(id);
    return time(() => b.advance(id));
  },
  "(b) 10 steps: model and sandbox bash": async (b) => {
    const id = await b.session("sandboxed");
    await b.message(id);
    const ms = await time(() => b.advance(id));
    if ((await b.status(id)) !== "completed") throw new Error("(b) did not complete");
    return ms;
  },
  "(c) HTTP tool answered by a local service": async (b) => {
    const id = await b.session("http");
    await b.message(id);
    const ms = await time(() => b.advance(id));
    if ((await b.status(id)) !== "completed") throw new Error("(c) did not complete");
    return ms;
  },
  "(d) warm resume, 300-entry transcript": async (b, state) => {
    let id = state.get(b);
    if (!id) {
      id = await b.session("plain");
      state.set(b, id);
      for (let i = 0; i < 150; i += 1) {
        await b.message(id);
        await b.advance(id);
      }
    }
    await b.message(id);
    return time(() => b.advance(id!));
  },
};

const results: string[] = [];
const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const delta = (on: number, off: number) => `${on >= off ? "+" : ""}${(((on - off) / off) * 100).toFixed(1)}%`;

afterAll(() => {
  console.log(["", "Turn latency (ms), in-process harness (off) vs WebSocket harness (on):", ...results].join("\n"));
});

describe("turn latency", () => {
  test(
    "interleaved off/on",
    async () => {
      const off = await open("memory");
      const on = await open("ws");
      try {
        results.push("| scenario | off p50 | on p50 | Δp50 | off p95 | on p95 | Δp95 |", "|---|---|---|---|---|---|---|");
        for (const [name, turn] of Object.entries(scenarios)) {
          const state = new Map<Bench, string>();
          const samples = { off: [] as number[], on: [] as number[] };
          for (let i = 0; i < TURNS + 10; i += 1) {
            // Alternate which mode goes first; the first 10 turns warm up.
            const order = i % 2 === 0 ? (["off", "on"] as const) : (["on", "off"] as const);
            for (const mode of order) {
              const ms = await turn(mode === "off" ? off : on, state);
              if (i >= 10) samples[mode].push(ms);
            }
          }
          const [p50off, p50on, p95off, p95on] = [
            percentile(samples.off, 50),
            percentile(samples.on, 50),
            percentile(samples.off, 95),
            percentile(samples.on, 95),
          ];
          results.push(
            `| ${name} | ${p50off.toFixed(1)} | ${p50on.toFixed(1)} | ${delta(p50on, p50off)} | ${p95off.toFixed(1)} | ${p95on.toFixed(1)} | ${delta(p95on, p95off)} |`,
          );
        }
      } finally {
        await off.close();
        await on.close();
      }
    },
    3_600_000,
  );

  test(
    "Harness API traffic per turn of (c), JSON mode",
    async () => {
      const counts = { intents: 0, requests: 0, toCore: 0, toHarness: 0, reads: 0 };
      const tap = (frame: Frame, from: "harness" | "core", bytes?: number) => {
        if (from === "harness") counts.toCore += bytes ?? 0;
        else counts.toHarness += bytes ?? 0;
        if (frame.t === "req") {
          counts.requests += 1;
          if (frame.m === "effect.intent") counts.intents += 1;
          if (frame.m === "transcript.read") counts.reads += 1;
        }
      };
      const b = await open("memory", { harness: "json", harnessTap: tap });
      const turns = 20;
      try {
        for (let i = 0; i < turns; i += 1) await scenarios["(c) HTTP tool answered by a local service"]!(b, new Map());
      } finally {
        await b.close();
      }
      results.push(
        "",
        `(c) in JSON mode, per turn: ${(counts.intents / turns).toFixed(1)} intents, ${(counts.requests / turns).toFixed(1)} requests, ` +
          `${(counts.toCore / turns / 1024).toFixed(1)} KiB to core, ${(counts.toHarness / turns / 1024).toFixed(1)} KiB to the harness, ` +
          `${(counts.reads / turns).toFixed(2)} transcript reads`,
      );
    },
    3_600_000,
  );

  test(
    "heap after 500 sessions",
    async () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      for (const harness of ["memory", "ws"] as const) {
        gc?.();
        const before = process.memoryUsage();
        const b = await open(harness);
        try {
          for (let i = 0; i < 500; i += 1) await scenarios["(a) one model call"]!(b, new Map());
          gc?.();
          const after = process.memoryUsage();
          results.push(
            `${harness}: 500 sessions, heap +${((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1)} MiB, ` +
              `rss ${(after.rss / 2 ** 20).toFixed(0)} MiB${gc ? "" : " (no --expose-gc)"}`,
          );
        } finally {
          await b.close();
        }
      }
    },
    3_600_000,
  );
});
