/**
 * The trace projector on Postgres logical replication (R7.2): turns run by a test Tenant reach
 * an OTLP receiver in this process as one trace per turn; a slot reset to an earlier position
 * posts byte-identical spans; a receiver that is down for the whole run costs only its spans,
 * and the slot is acknowledged anyway.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import type { ModelProvider } from "../../src/core/provider.js";
import type { OtlpSpan } from "../../src/traces/map.js";
import { STACK_ENABLED } from "../stack/endpoints.js";
import { testTenantPool } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";
import {
  confirmedOf,
  createSlot,
  currentLsn,
  dropSlot,
  lsnAtLeast,
  otlpReceiver,
  startTestProjector,
  testSlot,
  until,
} from "../support/traces.js";

const APP = "r7-projector-token-aaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close().catch(() => undefined);
});

const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (prompt.some((item) => item.kind === "tool-result")) return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "hook", args: { n: 1 } }] };
};

async function boot() {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  cleanups.push(() => runtime.close());
  const manifest = Agent({ id: "bot", name: "Bot" })
    .tools(http({ name: "hook", input: z.object({ n: z.number() }), url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }))
    .build().manifest;
  for (const [path, body] of [
    ["/v1/agents/bot", { requestId: "a", manifest, implementationVersion: "dev" }],
    ["/v1/sessions/s1", { requestId: "s", agentId: "bot", ownerUserId: "u" }],
  ] as const) {
    const response = await fetch(`${runtime.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(response.ok, await response.clone().text()).toBe(true);
  }
  let n = 0;
  /** Runs one turn to its end; its id. */
  const turn = async (): Promise<string> => {
    n += 1;
    const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: `m${n}`, idempotencyKey: `m${n}`, content: "go" }),
    });
    expect(sent.ok, await sent.clone().text()).toBe(true);
    const { turnId } = (await sent.json()) as { turnId: string };
    await until("the turn to complete", async () => {
      const { status } = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string };
      return status === "completed";
    });
    return turnId;
  };
  const route = async (turnId: string): Promise<OtlpSpan[]> => {
    const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/turns/${turnId}/trace`, { headers })).json()) as any;
    return body.resourceSpans[0].scopeSpans[0].spans;
  };
  return { runtime, turn, route };
}

describe.skipIf(!STACK_ENABLED)("trace projector on logical replication", { timeout: 120_000 }, () => {
  it("exports one trace per turn, the spans the trace route answers", async () => {
    const { runtime, turn, route } = await boot();
    const receiver = await otlpReceiver();
    cleanups.push(() => receiver.close());
    const slot = testSlot();
    cleanups.push(() => dropSlot(runtime.tenantId, slot));
    const started = await startTestProjector({ tenantId: runtime.tenantId, root: runtime.root, slot, url: receiver.url });
    cleanups.push(() => started.close());
    await until("the projector to read its slot", () => started.projector.status().active);
    const turns = [await turn(), await turn()];
    await until("both turns' root spans", () => receiver.spans.filter((span) => span.name === "invoke_agent bot").length === 2);
    await started.projector.idle();
    const traces = new Map<string, OtlpSpan[]>();
    for (const span of receiver.spans) traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
    expect(traces.size).toBe(2);
    // The first turn calls the tool; the second answers from what it already has.
    const names = [["chat", "execute_tool hook", "chat", "invoke_agent bot"], ["chat", "invoke_agent bot"]];
    for (const [at, turnId] of turns.entries()) {
      const answered = await route(turnId);
      const posted = traces.get(answered[0]!.traceId)!;
      expect(posted.filter((span) => !span.parentSpanId)).toHaveLength(1);
      expect(posted.map((span) => span.name)).toEqual(names[at]);
      expect(JSON.stringify(posted)).toBe(JSON.stringify(answered));
    }
  });

  it("posts byte-identical spans again from a slot reset to before the turn", async () => {
    const { runtime, turn } = await boot();
    const slot = testSlot();
    const copy = `${slot}_copy`;
    cleanups.push(() => dropSlot(runtime.tenantId, slot), () => dropSlot(runtime.tenantId, copy));
    await createSlot(runtime.tenantId, slot);
    // The copy keeps the slot's position: reading it later replays what the first read.
    await testTenantPool(runtime.tenantId)`SELECT pg_copy_logical_replication_slot(${slot}, ${copy})`;
    await turn();
    const exports: OtlpSpan[][] = [];
    for (const name of [slot, copy]) {
      const receiver = await otlpReceiver();
      cleanups.push(() => receiver.close());
      const started = await startTestProjector({ tenantId: runtime.tenantId, root: runtime.root, slot: name, url: receiver.url });
      await until("the turn's root span", () => receiver.spans.some((span) => span.name === "invoke_agent bot"));
      await started.projector.idle();
      await started.close();
      exports.push(receiver.spans);
    }
    expect(exports[0]!.length).toBeGreaterThan(0);
    expect(JSON.stringify(exports[1])).toBe(JSON.stringify(exports[0]));
  });

  it("acknowledges the slot while the collector is down, and logs the dropped spans", async () => {
    const { runtime, turn } = await boot();
    const slot = testSlot();
    cleanups.push(() => dropSlot(runtime.tenantId, slot));
    const logged: { message: string; fields?: Record<string, unknown> }[] = [];
    const started = await startTestProjector({
      tenantId: runtime.tenantId,
      root: runtime.root,
      slot,
      url: "http://127.0.0.1:1/v1/traces",
      log: (message, fields) => logged.push({ message, ...(fields ? { fields } : {}) }),
    });
    cleanups.push(() => started.close());
    await until("the projector to read its slot", () => started.projector.status().active);
    const before = await currentLsn(runtime.tenantId);
    await turn();
    // The turn's rows reach the projector over several transactions, and so several posts: each
    // dropped post is logged with its spans, the turn's four in all.
    const dropped = () =>
      logged
        .filter((entry) => entry.message === "trace_export_dropped")
        .reduce((sum, entry) => sum + Number(entry.fields?.spans ?? 0), 0);
    await until("the turn's spans to be dropped and logged", () => dropped() >= 4);
    // Every row of the turn is acknowledged: Postgres keeps no WAL for the dead collector.
    await until("the slot to move past the turn", async () => {
      const confirmed = await confirmedOf(runtime.tenantId, slot);
      return confirmed !== null && (await lsnAtLeast(runtime.tenantId, confirmed, before)) && started.projector.status().pendingTxs === 0;
    });
  });
});
