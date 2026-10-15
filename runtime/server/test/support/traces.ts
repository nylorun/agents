/**
 * Trace export in tests (R7.2): an OTLP/HTTP receiver in the test process, and the trace
 * projector on a test Tenant's database, on a slot of the test's own. A slot belongs to the
 * Postgres server, not to a database, so each test names its own and drops it after.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPgoutputSource } from "../../src/adapters/replication/pgoutput.js";
import { createPostgresTurnMessages } from "../../src/store/postgres/record.js";
import type { SessionStore } from "../../src/store/types.js";
import { traceKey } from "../../src/traces/key.js";
import type { OtlpSpan, TraceContent } from "../../src/traces/map.js";
import { createOtlpPoster } from "../../src/traces/otlp.js";
import { createTraceProjector, type TraceProjector } from "../../src/traces/projector.js";
import { openTestSessionStore, testTenantPool, testTenantUrl } from "./store.js";

export interface OtlpReceiver {
  readonly url: string;
  /** Every span posted, in the order posted. */
  readonly spans: OtlpSpan[];
  /** Each post's body, as sent. */
  readonly bodies: string[];
  close(): Promise<void>;
}

/** A collector's `/v1/traces` that keeps what it is sent and answers 200. */
export async function otlpReceiver(): Promise<OtlpReceiver> {
  const spans: OtlpSpan[] = [];
  const bodies: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    if (req.method !== "POST" || req.url !== "/v1/traces") return void res.writeHead(404).end();
    bodies.push(body);
    for (const resource of JSON.parse(body).resourceSpans)
      for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    spans,
    bodies,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A slot name of this test's own. */
export function testSlot(): string {
  return `nylorun_trace_test_${randomBytes(4).toString("hex")}`;
}

/** Creates `slot` now, so it holds every row committed from here on. */
export async function createSlot(tenantId: string, slot: string): Promise<void> {
  await testTenantPool(tenantId)`SELECT pg_create_logical_replication_slot(${slot}, 'pgoutput')`;
}

/** Drops `slot` once nothing reads it. */
export async function dropSlot(tenantId: string, slot: string): Promise<void> {
  await testTenantPool(tenantId)`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
    WHERE slot_name = ${slot} AND NOT active`.catch(() => undefined);
}

/** The slot's confirmed position, or null. */
export async function confirmedOf(tenantId: string, slot: string): Promise<string | null> {
  const [row] = await testTenantPool(tenantId)<{ lsn: string | null }[]>`
    SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = ${slot}`;
  return row?.lsn ?? null;
}

/** Whether `a` is at or past `b` (Postgres LSNs). */
export async function lsnAtLeast(tenantId: string, a: string, b: string): Promise<boolean> {
  const [row] = await testTenantPool(tenantId)<{ ok: boolean }[]>`SELECT ${a}::pg_lsn >= ${b}::pg_lsn AS ok`;
  return row!.ok;
}

export async function currentLsn(tenantId: string): Promise<string> {
  const [row] = await testTenantPool(tenantId)<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  return row!.lsn;
}

/** The trace projector of test Tenant `tenantId`, on `slot`, posting to `url`. */
export async function startTestProjector(input: {
  tenantId: string;
  root: string;
  slot: string;
  url: string;
  content?: TraceContent;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  backoffMs?: number;
}): Promise<{ projector: TraceProjector; close(): Promise<void> }> {
  const store: SessionStore = await openTestSessionStore({ root: input.root, tenantId: input.tenantId });
  const log = input.log ?? (() => {});
  const projector = createTraceProjector({
    contentBytes: async () => 8 * 1024,
    source: createPgoutputSource({
      connectionString: testTenantUrl(input.tenantId),
      tenantId: input.tenantId,
      slot: input.slot,
      retryMs: 200,
      log,
    }),
    post: createOtlpPoster({
      url: input.url,
      resource: { serviceName: "nylorun-test" },
      backoffMs: input.backoffMs ?? 20,
      timeoutMs: 2000,
      log,
    }),
    key: () => traceKey(store),
    turnMessage: createPostgresTurnMessages(testTenantPool(input.tenantId)),
    content: input.content ?? new Set(),
    maxDelayMs: 50,
    log,
  });
  projector.start();
  return {
    projector,
    async close() {
      await projector.stop();
      await store.close();
    },
  };
}

/** Waits until `check` holds, or fails naming `what`. */
export async function until(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
