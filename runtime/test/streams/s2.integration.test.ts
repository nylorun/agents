import { afterAll, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createS2Streams } from "../../src/adapters/streams/s2.js";
import { tenantBasinName } from "../../src/streams/basin.js";
import {
  CONTROL_STREAM,
  WORK_AVAILABLE,
  WORK_STREAM,
  sessionStream,
} from "../../src/streams/types.js";
import { streamsContract } from "../contracts/streams.contract.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

describe.skipIf(!STACK_ENABLED)("s2-lite", () => {
  const create = () =>
    createS2Streams({ endpoint: stackEndpoints().s2.endpoint, basinPrefix: "contract-" });

  streamsContract("s2-lite", async () => ({ streams: create() }));

  describe("S2 adapter", () => {
    const streams = create();
    const tenants: string[] = [];
    const tenant = async () => {
      const tenantId = newTenantId();
      tenants.push(tenantId);
      await streams.ensureTenant(tenantId);
      return tenantId;
    };

    afterAll(async () => {
      for (const tenantId of tenants) await streams.deleteTenant(tenantId).catch(() => {});
      await streams.close();
    });

    it("lets exactly one of many racing conditional appends win each sequence", async () => {
      const tenantId = await tenant();
      const stream = sessionStream("race");
      for (let seq = 0; seq < 5; seq += 1) {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, n) =>
            streams.append(tenantId, stream, [{ seq, n }], { matchSeq: seq }),
          ),
        );
        expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
        for (const r of results)
          if (r.status === "seq_mismatch") expect(r.tail).toBe(seq + 1);
      }
      const records = [];
      for await (const record of streams.read<{ seq: number }>(tenantId, stream, 0, {
        follow: false,
      }))
        records.push(record);
      expect(records.map((r) => [r.seq, r.body.seq])).toEqual(
        [0, 1, 2, 3, 4].map((n) => [n, n]),
      );
    });

    it("reads history across several pages", async () => {
      const tenantId = await tenant();
      const stream = sessionStream("long");
      for (let n = 0; n < 5; n += 1)
        await streams.append(
          tenantId,
          stream,
          Array.from({ length: 500 }, (_, i) => n * 500 + i),
        );
      const seqs: number[] = [];
      for await (const record of streams.read<number>(tenantId, stream, 250, { follow: false })) {
        expect(record.body).toBe(record.seq);
        seqs.push(record.seq);
      }
      expect(seqs).toEqual(Array.from({ length: 2250 }, (_, i) => i + 250));
    });

    it("resumes a live read from a sequence past the tail", async () => {
      const tenantId = await tenant();
      await streams.append(tenantId, WORK_STREAM, [0, 1]);
      const controller = new AbortController();
      const reading = (async () => {
        for await (const record of streams.read<number>(tenantId, WORK_STREAM, 3, {
          signal: controller.signal,
        }))
          return record;
      })();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await streams.append(tenantId, WORK_STREAM, [2]);
      await streams.append(tenantId, WORK_STREAM, [3]);
      const record = await reading;
      controller.abort();
      expect(record).toMatchObject({ seq: 3, body: 3 });
    });

    it("ends live reads when the Tenant's basin is deleted, and on close", async () => {
      const tenantId = await tenant();
      await streams.append(tenantId, WORK_STREAM, [0]);
      const seen: number[] = [];
      const reading = (async () => {
        for await (const record of streams.read<number>(tenantId, WORK_STREAM, 0))
          seen.push(record.seq);
      })();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await streams.deleteTenant(tenantId);
      await reading;
      expect(seen).toEqual([0]);

      const other = create();
      const otherTenant = await tenant();
      const pending = (async () => {
        const out: number[] = [];
        for await (const record of other.read<number>(otherTenant, WORK_STREAM, 0))
          out.push(record.seq);
        return out;
      })();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await other.close();
      expect(await pending).toEqual([]);
      await expect(other.append(otherTenant, WORK_STREAM, [1])).rejects.toThrow("closed");
    });

    it("keeps session streams forever and trims signal streams by age", async () => {
      const tenantId = await tenant();
      await streams.append(tenantId, sessionStream("kept"), [1]);
      await streams.append(tenantId, WORK_STREAM, [WORK_AVAILABLE]);
      await streams.append(tenantId, CONTROL_STREAM, [{ type: "session.cancel", sessionId: "s" }]);
      // Stream configs as s2-lite reports them (REST: GET /v1/streams/{stream}).
      const config = async (stream: string) => {
        const response = await fetch(
          `${stackEndpoints().s2.endpoint}/v1/streams/${encodeURIComponent(stream)}`,
          { headers: { "s2-basin": tenantBasinName(tenantId, "contract-") } },
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { retention_policy: unknown }).retention_policy;
      };
      expect(await config(sessionStream("kept"))).toEqual({ infinite: {} });
      expect(await config(WORK_STREAM)).toEqual({ age: 86_400 });
      expect(await config(CONTROL_STREAM)).toEqual({ age: 86_400 });
    });
  });
});
