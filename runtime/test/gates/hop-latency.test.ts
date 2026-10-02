/**
 * What the Model Gate's hop costs (blueprint §15 target: p50 ≤ 15 ms, p99 ≤ 60 ms added).
 * Times 50 calls to a local OpenAI-compatible stub through the in-process gate and through
 * the HTTP gate (the gates service on 127.0.0.1), and prints the difference. Measures; does
 * not gate. Opt in:
 *
 *   NYLORUN_BENCH=1 npx vitest run test/gates/hop-latency.test.ts   # in runtime/
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { httpModelGate } from "../../src/gates/http-client.js";
import { inProcessModelGate } from "../../src/gates/in-process.js";
import type { ModelGate, ModelGateRequest } from "../../src/gates/model-gate.js";
import { startGates, type GatesServer } from "../../src/host/gates.js";
import { createTestSessionStore } from "../support/store.js";

const CALLS = 50;
const WARMUP = 5;
const quiet = { info() {}, warn() {}, error() {} };

describe.skipIf(!process.env.NYLORUN_BENCH)("Model Gate hop latency", () => {
  let provider: Server | undefined;
  let gates: GatesServer | undefined;

  afterAll(async () => {
    await gates?.close();
    if (provider) await new Promise((resolve) => provider!.close(resolve));
  });

  it(`adds little to ${CALLS} calls`, async () => {
    provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (body: unknown) => res.write(`data: ${JSON.stringify(body)}\n\n`);
        chunk({ id: "b", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
        chunk({ id: "b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const host = {
      readHostModel: async () => ({
        provider: "custom",
        model: "bench",
        baseUrl,
        authType: "api_key" as const,
        credential: { type: "api_key" as const, key: "bench-key" },
      }),
      writeHostCredential: async () => {},
    };
    const token = "ab".repeat(32);
    const store = await createTestSessionStore();
    gates = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: {
        open: async () => ({
          store,
          root: "/nonexistent-bench-home",
          ...host,
        }),
      },
      drainMs: 0,
    });
    const request: ModelGateRequest = {
      tenantId: newTenantId(),
      sessionId: "s",
      turnId: "t",
      agentId: "bot",
      effectId: "t:0:model:1",
      invocationId: "1",
      call: {
        executionId: "e",
        tools: [],
        prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    };
    const time = async (gate: ModelGate) => {
      const samples: number[] = [];
      for (let i = 0; i < WARMUP + CALLS; i += 1) {
        const started = performance.now();
        const outcome = await gate.call(request, new AbortController().signal);
        expect(outcome).toMatchObject({ output: [{ type: "text", text: "ok" }] });
        if (i >= WARMUP) samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
      return { p50: at(0.5), p99: at(0.99) };
    };
    const local = await time(inProcessModelGate(host));
    const remote = await time(httpModelGate({ url: gates.url, token }));
    const added = { p50: remote.p50 - local.p50, p99: remote.p99 - local.p99 };
    console.log(
      `Model Gate hop over ${CALLS} calls: in-process p50 ${local.p50.toFixed(1)} ms, p99 ${local.p99.toFixed(1)} ms; ` +
        `HTTP p50 ${remote.p50.toFixed(1)} ms, p99 ${remote.p99.toFixed(1)} ms; ` +
        `added p50 ${added.p50.toFixed(1)} ms, p99 ${added.p99.toFixed(1)} ms`,
    );
  });
});
