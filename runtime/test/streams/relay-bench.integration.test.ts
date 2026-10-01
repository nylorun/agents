/**
 * The stream relay's latency gate (Durable Streams §16.1, §20): commit to S2 acknowledgement,
 * p99 under 200 ms, on the test stack's Postgres (logical replication) and s2-lite, with 50
 * sessions committing one event per transaction. Opt in with `NYLORUN_BENCH=1` (it takes a
 * few seconds and its numbers depend on the machine); prints the percentiles.
 *
 *   NYLORUN_TEST_STACK=1 NYLORUN_BENCH=1 npx vitest run -c vitest.integration.config.ts test/streams/relay-bench
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { createPgoutputSource } from "../../src/adapters/replication/pgoutput.js";
import { createS2Streams } from "../../src/adapters/streams/s2.js";
import { createPostgresClient } from "../../src/store/postgres/connect.js";
import { migrateStreamsSchema } from "../../src/store/postgres/migrations/shared/index.js";
import { createStreamRelay } from "../../src/streams/relay/core.js";
import type { AppendOptions, AppendResult, DurableStreams } from "../../src/streams/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { recordOf, writeRecord } from "../support/record.js";

const BENCH = STACK_ENABLED && process.env.NYLORUN_BENCH === "1";
const P99_LIMIT_MS = 200;

describe.skipIf(!BENCH)("stream relay latency", () => {
  const url = stackEndpoints().postgres.url;
  const sql = createPostgresClient(url, { max: 60 });
  const slot = `nylorun_bench_${randomBytes(4).toString("hex")}`;
  afterAll(async () => {
    await sql`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
              WHERE slot_name = ${slot} AND NOT active`.catch(() => undefined);
    await sql.end();
  });

  it(`commit to S2 is under ${P99_LIMIT_MS} ms at p99 with 50 sessions`, { timeout: 120_000 }, async () => {
    await migrateStreamsSchema(sql);
    const tenantId = `tn_bench_${randomBytes(4).toString("hex")}`;
    const s2 = createS2Streams({
      endpoint: stackEndpoints().s2.endpoint,
      basinPrefix: `bench${randomBytes(3).toString("hex")}-`,
    });
    await s2.ensureTenant(tenantId);
    const committedAt = new Map<string, number>();
    const lags: number[] = [];
    // Times each appended record from its commit to S2's acknowledgement.
    const timed: DurableStreams = Object.assign(Object.create(s2) as DurableStreams, {
      async append(basin: string, stream: string, records: readonly unknown[], options?: AppendOptions) {
        const result: AppendResult = await s2.append(basin, stream, records, options);
        const now = performance.now();
        if (result.status === "ok")
          for (const record of records as { key: string }[]) {
            const at = committedAt.get(record.key);
            if (at !== undefined) lags.push(now - at);
          }
        return result;
      },
    });
    const relay = createStreamRelay({
      source: createPgoutputSource({ connectionString: url, slot, retryMs: 200 }),
      record: recordOf(sql, tenantId),
      streams: timed,
    });
    relay.start();
    try {
      while (!relay.status().active) await new Promise((resolve) => setTimeout(resolve, 20));
      const sessions = Array.from({ length: 50 }, (_, i) => `s${i}`);
      const perSession = 40;
      await Promise.all(
        sessions.map(async (sessionId) => {
          for (let i = 0; i < perSession; i += 1) {
            const key = `${sessionId}:${i}`;
            await writeRecord(sql, tenantId, sessionId, 1, () => ({ key, text: "x".repeat(300) }));
            committedAt.set(key, performance.now());
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }),
      );
      const deadline = Date.now() + 60_000;
      while (lags.length < sessions.length * perSession && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      lags.sort((a, b) => a - b);
      const pct = (p: number) => lags[Math.min(lags.length - 1, Math.floor((p / 100) * lags.length))]!;
      const report = { events: lags.length, p50: pct(50), p95: pct(95), p99: pct(99), max: lags.at(-1) };
      process.stderr.write(
        `stream relay commit→S2 ms: ${JSON.stringify(report, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}\n`,
      );
      expect(lags.length).toBe(sessions.length * perSession);
      expect(report.p99).toBeLessThan(P99_LIMIT_MS);
    } finally {
      await relay.stop();
      await s2.deleteTenant(tenantId).catch(() => undefined);
      await s2.close();
    }
  });
});
