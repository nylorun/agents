/**
 * Session Store contract (architecture §12.2). Every `SessionStore`
 * implementation runs this suite; Postgres runs it in `store.test.ts`:
 *
 *   storeContract("postgres", async (options) => {
 *     const database = await isolatedTestDatabase();
 *     return { store: createPostgresSessionStore({ ...options, sql: database.sql }), dispose: () => database.drop() };
 *   });
 */
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor, encodeCursor } from "../../src/record/index.js";
import {
  OwnershipLostError,
  isOwnershipLost,
  ownedTx,
} from "../../src/store/ownership.js";
import {
  DOC_TABLES,
  type Commit,
  type ModelUsageWrite,
  type SessionStore,
  type SessionStoreOptions,
  type VaultCredentialRow,
} from "../../src/store/types.js";
import type { RecordRow } from "../../src/streams/relay/types.js";

export interface StoreHarness {
  store: SessionStore;
  /** Removes everything the store created (database, files). Called after `store.close()`. */
  dispose?(): Promise<void>;
}

/** Opens a fresh, empty store for `options.tenantId`. */
export type StoreFactory = (options: SessionStoreOptions) => Promise<StoreHarness>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function session(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    agentId: "agent-a",
    ownerUserId: "user-1",
    status: "idle",
    activeTurnId: null,
    ...fields,
  };
}

function effect(
  id: string,
  sessionId: string,
  turnId: string,
  status: string,
  kind = "model",
) {
  return {
    request: {
      effectId: id,
      sessionId,
      turnId,
      agentId: "agent-a",
      manifestHash: "m",
      kind,
      input: {},
      context: {},
    },
    status,
  };
}

function credential(
  id: string,
  vaultId: string,
  createdAt: string,
  fields: Partial<VaultCredentialRow> = {},
): VaultCredentialRow {
  return {
    id,
    vaultId,
    name: id,
    type: "bearer",
    bindingJson: JSON.stringify({ url: "https://api.example.com" }),
    expiresAt: null,
    createdAt,
    rotatedAt: null,
    kekId: "kek-1",
    nonce: new Uint8Array([1, 2, 3]),
    ciphertext: new Uint8Array([4, 5, 6, 7]),
    wrappedDek: new Uint8Array([8, 9]),
    ...fields,
  };
}

/** Every row of the store's record, in (session, seq) order. */
async function recorded(store: SessionStore): Promise<RecordRow[]> {
  const record = store.record();
  const rows: RecordRow[] = [];
  for (const head of await record.heads(undefined, 1000))
    rows.push(...(await record.readRange(head.tenantId, head.sessionId, 0, head.head)));
  return rows;
}

export function storeContract(name: string, factory: StoreFactory): void {
  describe(`SessionStore contract: ${name}`, () => {
    const open: StoreHarness[] = [];
    let tenantId = "";
    let errors: unknown[] = [];

    async function fresh(
      extra: Pick<SessionStoreOptions, "now"> = {},
    ): Promise<SessionStore> {
      tenantId = newTenantId();
      errors = [];
      const harness = await factory({
        tenantId,
        onError: (error) => errors.push(error),
        ...extra,
      });
      open.push(harness);
      return harness.store;
    }

    afterEach(async () => {
      for (const harness of open.splice(0)) {
        await harness.store.close();
        await harness.dispose?.();
      }
    });

    describe("documents", () => {
      it("puts, gets and deletes a document in every table", async () => {
        const store = await fresh();
        for (const table of DOC_TABLES)
          await store.tx(async (t) => {
            await t.put(table, "doc-1", { id: "doc-1", table, n: 1 });
          });
        for (const table of DOC_TABLES) {
          const doc = await store.tx((t) => t.get(table, "doc-1"));
          expect(doc).toMatchObject({ id: "doc-1", table, n: 1 });
        }
        await store.tx(async (t) => {
          for (const table of DOC_TABLES) await t.delete(table, "doc-1");
        });
        for (const table of DOC_TABLES)
          expect(await store.tx((t) => t.get(table, "doc-1"))).toBeUndefined();
      });

      it("replaces a document on put and returns copies", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("definitions", "d", { manifest: { id: "a" }, v: 1 });
          await t.put("definitions", "d", { manifest: { id: "a" }, v: 2 });
        });
        const first = await store.tx((t) => t.get("definitions", "d"));
        first.v = 99;
        expect(await store.tx((t) => t.get("definitions", "d"))).toEqual({
          manifest: { id: "a" },
          v: 2,
        });
      });

      it("round-trips every string, including U+0000 and unpaired surrogates, in bodies and events", async () => {
        const store = await fresh();
        // Tool output can hold any UTF-16 string. `\\u0000` is a literal backslash, not NUL.
        const odd = [
          "a\u0000b",
          "\u0000",
          "\\u0000",
          "\\\u0000",
          "\ud800",
          "x\udc00y",
          "😀",
          "\u0001\u001f\u007f",
          "\\",
          "￿",
        ];
        const body = { odd, nested: { "k\u0000ey": odd.join("|") } };
        await store.tx(async (t) => {
          await t.put(
            "sessions",
            "s1",
            session("s1", { state: body }),
          );
          await t.put("effects", "e1", {
            ...effect("e1", "s1", "t1", "succeeded"),
            output: body,
          });
          await t.put("links", "l1", { workflowSessionId: "w\u0000", body });
          for (const table of DOC_TABLES)
            if (!["sessions", "effects", "links"].includes(table))
              await t.put(table, "d1", body);
          await t.event("s1", "t1", "turn.completed", { tag: "tool.output", output: body });
        });
        const read = await store.tx(async (t) => ({
          session: await t.get("sessions", "s1"),
          effects: await t.effectsForSession("s1", { statuses: ["succeeded"] }),
          sessions: await t.listSessions({ agentId: "agent-a" }),
          docs: await Promise.all(
            DOC_TABLES.filter(
              (table) => !["sessions", "effects", "links"].includes(table),
            ).map((table) => t.get(table, "d1")),
          ),
        }));
        const rows = await recorded(store);
        expect(read.session.state).toEqual(body);
        expect(read.sessions.map((s) => s.id)).toEqual(["s1"]);
        expect(read.effects.map((e: any) => e.output)).toEqual([body]);
        for (const doc of read.docs) expect(doc).toEqual(body);
        expect(rows.map((row) => (row.body as LiveEvent).payload)).toEqual([
          { tag: "tool.output", output: body },
        ]);
      });

      it("reads a session with store-managed ownership and ignores ownership on put", async () => {
        const store = await fresh();
        await store.tx((t) =>
          t.put("sessions", "s1", {
            ...session("s1"),
            owner: "forged",
            epoch: 42,
            ownerExpiresAt: "2999-01-01T00:00:00.000Z",
          }),
        );
        const read = await store.tx((t) => t.get("sessions", "s1"));
        expect(read).toMatchObject({
          ...session("s1"),
          owner: null,
          epoch: 0,
          ownerExpiresAt: null,
        });
      });
    });

    describe("transactions", () => {
      it("returns the callback's value and makes writes visible after commit", async () => {
        const store = await fresh();
        const value = await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          return "ok";
        });
        expect(value).toBe("ok");
        expect(await store.tx((t) => t.get("sessions", "s1"))).toBeDefined();
      });

      it("rolls back writes, events and afterCommit on throw", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const commits: Commit[] = [];
        store.onCommit((commit) => commits.push(commit));
        let ran = false;
        const failure = new Error("boom");
        await expect(
          store.tx(async (t) => {
            await t.put("sessions", "s1", session("s1", { status: "running" }));
            await t.put("commands", "c1", { id: "c1" });
            await t.event("s1", "t1", "turn.completed", { tag: "turn.started", output: {} });
            t.afterCommit(() => {
              ran = true;
            });
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(ran).toBe(false);
        expect(commits).toEqual([]);
        await store.tx(async (t) => {
          expect((await t.get("sessions", "s1")).status).toBe("idle");
          expect(await t.get("commands", "c1")).toBeUndefined();
          // The rolled-back sequence is reused: no gap.
          const event = await t.event("s1", null, "turn.completed", { tag: "after.rollback", output: {} });
          expect(decodeCursor("s1", event.cursor)).toBe(0);
        });
        expect((await recorded(store)).map((row) => row.seq)).toEqual([0]);
      });

      it("delivers events to commit listeners, then runs afterCommit in order", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const log: string[] = [];
        const commits: Commit[] = [];
        store.onCommit((commit) => {
          commits.push(commit);
          log.push("listener");
        });
        await store.tx(async (t) => {
          await t.event("s1", "t1", "turn.completed", { tag: "a", output: { n: 1 } });
          await t.event("s1", "t1", "turn.completed", { tag: "b", output: { n: 2 } });
          t.afterCommit(() => {
            log.push("first");
          });
          t.afterCommit(async () => {
            await sleep(5);
            log.push("second");
          });
          log.push("body");
        });
        expect(log).toEqual(["body", "listener", "first", "second"]);
        expect(commits).toHaveLength(1);
        expect(commits[0]!.events.map((e) => (e.payload as { tag: string }).tag)).toEqual(["a", "b"]);
      });

      it("does not call listeners for a commit without events", async () => {
        const store = await fresh();
        let calls = 0;
        store.onCommit(() => calls++);
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        expect(calls).toBe(0);
      });

      it("stops calling a listener after unsubscribe", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        let calls = 0;
        const off = store.onCommit(() => calls++);
        await store.tx(async (t) => void (await t.event("s1", null, "turn.completed", { tag: "x", output: {} })));
        off();
        await store.tx(async (t) => void (await t.event("s1", null, "turn.completed", { tag: "y", output: {} })));
        expect(calls).toBe(1);
      });

      it("lets afterCommit read committed state and open a new transaction", async () => {
        const store = await fresh();
        let seen: unknown;
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1", { status: "runnable" }));
          t.afterCommit(async () => {
            seen = await store.tx((t2) => t2.get("sessions", "s1"));
          });
        });
        expect(seen).toMatchObject({ status: "runnable" });
      });

      it("reports afterCommit and listener failures without rejecting the committed tx", async () => {
        const store = await fresh();
        store.onCommit(() => {
          throw new Error("listener");
        });
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const result = await store.tx(async (t) => {
          await t.put("commands", "c1", { id: "c1" });
          await t.event("s1", null, "turn.completed", { tag: "x", output: {} });
          t.afterCommit(() => {
            throw new Error("wake");
          });
          return 7;
        });
        expect(result).toBe(7);
        expect(await store.tx((t) => t.get("commands", "c1"))).toBeDefined();
        expect(errors.map((e) => (e as Error).message).sort()).toEqual([
          "listener",
          "wake",
        ]);
      });

      it("rejects a nested transaction", async () => {
        const store = await fresh();
        await expect(
          store.tx(async () => store.tx(async () => 1)),
        ).rejects.toThrow();
      });

      it("rejects use of a Tx after its transaction ended", async () => {
        const store = await fresh();
        let leaked: any;
        await store.tx(async (t) => {
          leaked = t;
        });
        await expect(
          (async () => leaked.get("sessions", "s1"))(),
        ).rejects.toThrow();
      });
    });

    describe("events", () => {
      it("allocates a per-session sequence from 0 with the cursor encoding", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          await t.put("sessions", "s2", session("s2"));
        });
        const events = await store.tx(async (t) => [
          await t.event("s1", "t1", "turn.completed", { tag: "turn.started", output: { a: 1 } }),
          await t.event("s1", "t1", "turn.completed", { tag: "model.completed", output: { b: [1, 2] } }),
          await t.event("s2", null, "turn.completed", { tag: "session.created", output: null }),
        ]);
        expect(events.map((e) => [e.sessionId, decodeCursor(e.sessionId, e.cursor)])).toEqual([
          ["s1", 0],
          ["s1", 1],
          ["s2", 0],
        ]);
        expect(events[1]).toMatchObject({
          sessionId: "s1",
          tenantId,
          turnId: "t1",
          type: "turn.completed",
          payload: { tag: "model.completed", output: { b: [1, 2] } },
          cursor: Buffer.from("s1:1").toString("base64url"),
        });
        expect(events[1]!.cursor).toBe(encodeCursor("s1", 1));
        expect(typeof events[1]!.eventId).toBe("string");
        expect(Number.isNaN(Date.parse(events[1]!.time))).toBe(false);
        expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
      });

      it("rejects an event for a missing session", async () => {
        const store = await fresh();
        await expect(
          store.tx((t) => t.event("missing", null, "turn.completed", { tag: "x", output: {} })),
        ).rejects.toThrow();
      });

      it("writes events to the record in the Tenant's basin generation", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          await t.put("sessions", "s2", session("s2"));
        });
        const commits: Commit[] = [];
        store.onCommit((commit) => commits.push(commit));
        const written = await store.tx(async (t) => [
          await t.event("s2", null, "turn.completed", { tag: "x", output: 1 }),
          await t.event("s1", null, "turn.completed", { tag: "y", output: 2 }),
          await t.event("s1", null, "turn.completed", { tag: "z", output: 3 }),
        ]);
        const rows = await recorded(store);
        expect(rows.map((r) => [r.sessionId, r.seq, r.generation])).toEqual([
          ["s1", 0, 0],
          ["s1", 1, 0],
          ["s2", 0, 0],
        ]);
        expect(rows[0]!.body).toEqual(written[1]);
        expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);
        expect(commits[0]!.generations).toEqual([0, 0, 0]);
        expect(await store.record().generation(tenantId)).toBe(0);
        expect(await store.record().readRange(tenantId, "s1", 1, 5)).toEqual([rows[1]]);
        expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 0, retired: [] });
      });

      it("keeps a deleted session's record, so a re-created id continues its log", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          await t.put("sessions", "s2", session("s2"));
        });
        await store.tx(async (t) => {
          await t.event("s1", null, "turn.completed", { tag: "x", output: 1 });
          await t.event("s1", null, "turn.completed", { tag: "y", output: 2 });
          await t.event("s2", null, "turn.completed", { tag: "z", output: 3 });
        });
        await store.tx((t) => t.delete("sessions", "s1"));
        await expect(
          store.tx((t) => t.event("s1", null, "turn.completed", { output: 0 })),
        ).rejects.toThrow();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const again = await store.tx((t) => t.event("s1", null, "turn.completed", { tag: "again", output: {} }));
        expect(again.cursor).toBe(encodeCursor("s1", 2));
        expect((await recorded(store)).map((r) => [r.sessionId, r.seq])).toEqual([
          ["s1", 0],
          ["s1", 1],
          ["s1", 2],
          ["s2", 0],
        ]);
      });

      it("moves to a new basin generation on a sessions reset, so ids start again at 0", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        await store.tx((t) => t.event("s1", null, "turn.completed", { output: 1 }));
        await store.tx((t) => t.reset("sessions"));
        expect(await recorded(store)).toEqual([]);
        expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 1, retired: [0] });
        expect(await store.record().generation(tenantId)).toBe(1);
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const event = await store.tx((t) => t.event("s1", null, "turn.completed", { output: 2 }));
        expect(event.seq).toBe(0);
        expect((await recorded(store)).map((r) => [r.sessionId, r.seq, r.generation])).toEqual([
          ["s1", 0, 1],
        ]);
        await store.tx((t) => t.reset("sandboxes"));
        expect((await store.tx((t) => t.basinGenerations())).current).toBe(1);
        await store.tx((t) => t.forgetRetiredGeneration(0));
        expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 1, retired: [] });
      });

      it("has no sequence gaps under 20 concurrent transactions", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          await t.put("sessions", "s2", session("s2"));
        });
        const failures = new Set([3, 11, 17]);
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) =>
            store.tx(async (t) => {
              if (i % 2 === 0) await t.lockSession("s1");
              const a = await t.event("s1", null, "turn.completed", { tag: "concurrent", output: { i } });
              await sleep(i % 3);
              const b = await t.event("s1", null, "turn.completed", { tag: "concurrent", output: { i, second: true } });
              await t.event("s2", null, "turn.completed", { tag: "other", output: { i } });
              if (failures.has(i)) throw new Error(`fail ${i}`);
              return [a, b];
            }),
          ),
        );
        const committed = results.flatMap((r) =>
          r.status === "fulfilled" ? r.value : [],
        );
        expect(committed).toHaveLength(34);
        const seqs = committed
          .map((e) => decodeCursor("s1", e.cursor))
          .sort((a, b) => a - b);
        expect(seqs).toEqual(Array.from({ length: 34 }, (_, i) => i));
        const rows = await recorded(store);
        expect(rows.filter((r) => r.sessionId === "s1").map((r) => r.seq)).toEqual(
          Array.from({ length: 34 }, (_, i) => i),
        );
        expect(rows.filter((r) => r.sessionId === "s2").map((r) => r.seq)).toEqual(
          Array.from({ length: 17 }, (_, i) => i),
        );
        // A committed transaction's two events are adjacent.
        for (let i = 0; i < committed.length; i += 2)
          expect(decodeCursor("s1", committed[i + 1]!.cursor)).toBe(
            decodeCursor("s1", committed[i]!.cursor) + 1,
          );
      });
    });

    describe("lockSession", () => {
      it("returns the session or undefined", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        await store.tx(async (t) => {
          expect(await t.lockSession("s1")).toMatchObject({ id: "s1", epoch: 0 });
          expect(await t.lockSession("s1")).toMatchObject({ id: "s1" });
          expect(await t.lockSession("missing")).toBeUndefined();
        });
      });

      it("serializes read-modify-write across concurrent transactions", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1", { counter: 0 })));
        await Promise.all(
          Array.from({ length: 20 }, () =>
            store.tx(async (t) => {
              const s = await t.lockSession<any>("s1");
              await sleep(1);
              await t.put("sessions", "s1", { ...s, counter: s.counter + 1 });
            }),
          ),
        );
        expect((await store.tx((t) => t.get("sessions", "s1"))).counter).toBe(20);
      });
    });

    describe("ownership", () => {
      const t0 = new Date("2030-01-01T00:00:00.000Z");
      const at = (ms: number) => new Date(t0.getTime() + ms);

      it("takes, refuses while live, and takes over after expiry", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const first = await store.tx((t) =>
          t.takeOwnership("s1", { owner: "w1", now: t0, leaseMs: 1000 }),
        );
        expect(first).toEqual({
          status: "owned",
          epoch: 1,
          takeover: false,
          previous: { owner: null, epoch: 0, ownerExpiresAt: null },
        });
        expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
          owner: "w1",
          epoch: 1,
          ownerExpiresAt: at(1000).toISOString(),
        });
        expect(
          await store.tx((t) =>
            t.takeOwnership("s1", { owner: "w2", now: at(999), leaseMs: 1000 }),
          ),
        ).toEqual({ status: "busy", owner: "w1", ownerExpiresAt: at(1000).toISOString() });
        expect(
          await store.tx((t) =>
            t.takeOwnership("s1", { owner: "w1", now: at(500), leaseMs: 1000 }),
          ),
        ).toMatchObject({ status: "busy" });
        const second = await store.tx((t) =>
          t.takeOwnership("s1", { owner: "w2", now: at(1000), leaseMs: 1000 }),
        );
        expect(second).toEqual({
          status: "owned",
          epoch: 2,
          takeover: true,
          previous: { owner: "w1", epoch: 1, ownerExpiresAt: at(1000).toISOString() },
        });
        expect(
          await store.tx((t) =>
            t.takeOwnership("missing", { owner: "w1", now: t0, leaseMs: 1 }),
          ),
        ).toEqual({ status: "missing" });
      });

      it("renews and releases only for the current owner and epoch", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        await store.tx((t) => t.takeOwnership("s1", { owner: "w1", now: t0, leaseMs: 1000 }));
        expect(await store.tx((t) => t.renewOwnership("s1", "w1", 0, at(5000)))).toBe(false);
        expect(await store.tx((t) => t.renewOwnership("s1", "w2", 1, at(5000)))).toBe(false);
        expect(await store.tx((t) => t.renewOwnership("s1", "w1", 1, at(5000)))).toBe(true);
        expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
          ownerExpiresAt: at(5000).toISOString(),
        });
        expect(await store.tx((t) => t.releaseOwnership("s1", "w2", 1))).toBe(false);
        expect(await store.tx((t) => t.releaseOwnership("s1", "w1", 1))).toBe(true);
        expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
          owner: null,
          epoch: 1,
          ownerExpiresAt: null,
        });
        const next = await store.tx((t) =>
          t.takeOwnership("s1", { owner: "w2", now: at(1), leaseMs: 1000 }),
        );
        expect(next).toMatchObject({ status: "owned", epoch: 2, takeover: false });
      });

      it("keeps ownership across document puts", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        await store.tx((t) => t.takeOwnership("s1", { owner: "w1", now: t0, leaseMs: 1000 }));
        await store.tx(async (t) => {
          const s = await t.get("sessions", "s1");
          await t.put("sessions", "s1", { ...s, status: "running", owner: null, epoch: 0 });
        });
        expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
          status: "running",
          owner: "w1",
          epoch: 1,
        });
      });

      it("aborts an epoch-checked transaction with ownership.lost and no write", async () => {
        const store = await fresh();
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        await store.tx((t) => t.takeOwnership("s1", { owner: "w1", now: t0, leaseMs: 10 }));
        await store.tx((t) => t.takeOwnership("s1", { owner: "w2", now: at(10), leaseMs: 10 }));
        const stale = ownedTx(store, "s1", 1, async (t) => {
          await t.put("commands", "late", { id: "late" });
        });
        await expect(stale).rejects.toBeInstanceOf(OwnershipLostError);
        await stale.catch((error) => {
          expect(isOwnershipLost(error)).toBe(true);
          expect(error.code).toBe("ownership.lost");
        });
        expect(await store.tx((t) => t.get("commands", "late"))).toBeUndefined();
        const current = await ownedTx(store, "s1", 2, async (t, s) => {
          await t.put("commands", "ok", { id: "ok" });
          return s.owner;
        });
        expect(current).toBe("w2");
        await expect(
          store.tx((t) => t.assertEpoch("missing", 0)),
        ).rejects.toSatisfy(isOwnershipLost);
      });
    });

    describe("queries", () => {
      async function seed(store: SessionStore) {
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1", { status: "running" }));
          await t.put("sessions", "s2", session("s2", { status: "runnable", agentId: "agent-b" }));
          await t.put("sessions", "s3", session("s3", { status: "paused", activeTurnId: "t3", ownerUserId: "user-2" }));
          await t.put("sessions", "s4", session("s4", { status: "completed" }));
          await t.put("sessions", "wf", session("wf", { status: "waiting", agentId: "flow" }));
          await t.put("sessions", "wf-a", session("wf-a", { status: "paused" }));
          await t.put("sessions", "wf-b", session("wf-b", { status: "running" }));

          await t.put("effects", "e1", effect("e1", "s1", "t1", "invoking"));
          await t.put("effects", "e2", effect("e2", "s1", "t1", "completed"));
          await t.put("effects", "e3", effect("e3", "s1", "t2", "invoking"));
          await t.put("effects", "e4", effect("e4", "s2", "t1", "uncertain"));
          await t.put("effects", "e5", effect("e5", "wf", "wt", "pending", "agent"));
          await t.put("effects", "e6", effect("e6", "wf", "wt", "queued", "tool"));
          await t.put("effects", "e7", effect("e7", "wf", "old", "queued", "tool"));

          await t.put("links", "wf-a", { workflowSessionId: "wf", path: "a", effectId: "e5", turnId: "wt" });
          await t.put("links", "wf-b", { workflowSessionId: "wf", path: "b/c", effectId: "e8", turnId: "wt" });
          await t.put("links", "ghost", { workflowSessionId: "wf", path: "g", effectId: "e9", turnId: "wt" });
          await t.put("links", "other", { workflowSessionId: "wf-2", path: "x", effectId: "e0", turnId: "wt" });

          await t.put("definitions", "agent-a", { manifest: { id: "agent-a" } });
          await t.put("definitions", "agent-b", { manifest: { id: "agent-b" } });
          await t.put("sandboxes", "sb1", { key: "sb1", state: "running" });
        });
      }
      const ids = (rows: { id?: string; request?: { effectId: string } }[]) =>
        rows.map((r) => r.id ?? r.request!.effectId);

      it("finds sessions by status, agent and orphaned lease", async () => {
        const store = await fresh();
        await seed(store);
        const now = new Date("2030-01-01T00:00:00.000Z");
        await store.tx((t) => t.takeOwnership("wf-b", { owner: "w", now, leaseMs: 60_000 }));
        await store.tx((t) => t.takeOwnership("s1", { owner: "w", now, leaseMs: 1000 }));
        await store.tx(async (t) => {
          expect(ids(await t.sessionsWithStatus(["running", "runnable"]))).toEqual(["s1", "s2", "wf-b"]);
          expect(ids(await t.sessionsWithStatus(["paused"]))).toEqual(["s3", "wf-a"]);
          expect((await t.sessionsWithStatus(["running"]))[0]).toMatchObject({ owner: "w", epoch: 1 });
          expect(ids(await t.listSessions())).toEqual(["s1", "s2", "s3", "s4", "wf", "wf-a", "wf-b"]);
          expect(ids(await t.listSessions({ agentId: "agent-b" }))).toEqual(["s2"]);
          expect(ids(await t.listSessions({ ownerUserId: "user-2" }))).toEqual(["s3"]);
          expect(ids(await t.listSessions({ ownerUserId: "user-1", agentId: "agent-b" }))).toEqual(["s2"]);
          expect(ids(await t.listSessions({ ownerUserId: "user-2", agentId: "agent-b" }))).toEqual([]);
          // s2 has no owner; s1's lease ends at +1s; wf-b's at +60s.
          expect(ids(await t.orphanedSessions(new Date(now.getTime() + 500), 10))).toEqual(["s2"]);
          expect(ids(await t.orphanedSessions(new Date(now.getTime() + 1000), 10))).toEqual(["s2", "s1"]);
          expect(ids(await t.orphanedSessions(new Date(now.getTime() + 1000), 1))).toEqual(["s2"]);
        });
      });

      it("finds effects by session, turn, status and kind", async () => {
        const store = await fresh();
        await seed(store);
        await store.tx(async (t) => {
          expect(ids(await t.invokingEffects("s1"))).toEqual(["e1", "e3"]);
          expect(ids(await t.effectsForSession("s1"))).toEqual(["e1", "e2", "e3"]);
          expect(ids(await t.effectsForSession("s1", { turnId: "t1" }))).toEqual(["e1", "e2"]);
          expect(ids(await t.effectsForSession("wf", { statuses: ["queued"] }))).toEqual(["e6", "e7"]);
          expect(ids(await t.effectsForTurn("wf", "wt"))).toEqual(["e5", "e6"]);
          expect(ids(await t.effectsForTurn("wf", "wt", ["queued"]))).toEqual(["e6"]);
          expect(ids(await t.effectsWithStatus(["invoking"]))).toEqual(["e1", "e3"]);
          expect(ids(await t.effectsWithStatus(["pending"], { kinds: ["agent"] }))).toEqual(["e5"]);
          expect(ids(await t.effectsWithStatus(["pending", "queued"], { kinds: ["model"] }))).toEqual([]);
        });
      });

      it("joins links of a workflow session to existing agent sessions", async () => {
        const store = await fresh();
        await seed(store);
        const linked = await store.tx((t) => t.linkedSessions("wf"));
        expect(linked.map((l) => [l.agentSessionId, l.link.path, l.session.status])).toEqual([
          ["wf-a", "a", "paused"],
          ["wf-b", "b/c", "running"],
        ]);
        expect(linked[0]!.link).toEqual({ workflowSessionId: "wf", path: "a", effectId: "e5", turnId: "wt" });
        expect(linked[0]!.session).toMatchObject({ id: "wf-a", owner: null, epoch: 0 });
        expect(await store.tx((t) => t.linkedSessions("nope"))).toEqual([]);
      });

      it("lists definitions and sandboxes and counts", async () => {
        const store = await fresh();
        expect(await store.tx((t) => t.counts())).toEqual({
          sessions: 0,
          runningSessions: 0,
          uncertainEffects: 0,
          sandboxes: 0,
          definitions: 0,
        });
        await seed(store);
        await store.tx(async (t) => {
          expect((await t.listDefinitions()).map((d) => d.manifest.id)).toEqual(["agent-a", "agent-b"]);
          expect(await t.listSandboxes()).toEqual([{ key: "sb1", state: "running" }]);
          expect(await t.counts()).toEqual({
            sessions: 7,
            runningSessions: 3,
            uncertainEffects: 1,
            sandboxes: 1,
            definitions: 2,
          });
        });
      });

      it("sees its own uncommitted writes", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1", { status: "runnable" }));
          expect(ids(await t.sessionsWithStatus(["runnable"]))).toEqual(["s1"]);
        });
      });
    });

    describe("model usage", () => {
      const usage = (id: string, patch: Partial<ModelUsageWrite> = {}) => ({
        id,
        effectKey: `turn-1:0:model:${id}`,
        sessionId: "s1",
        turnId: "turn-1",
        agentId: "bot",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.25,
        createdAt: "2030-01-01T00:00:00.000Z",
        ...patch,
      });

      it("records rows, flagging a second row for the same effect", async () => {
        const store = await fresh();
        const first = await store.tx((t) => t.recordModelUsage(usage("u1")));
        expect(first).toEqual({
          ...usage("u1"), duplicate: false, tokensReported: null, costKnown: null, txid: expect.any(String),
        });
        const again = await store.tx((t) =>
          t.recordModelUsage({ ...usage("u2"), effectKey: usage("u1").effectKey }),
        );
        expect(again.duplicate).toBe(true);
        expect(await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).toEqual({
          calls: 2,
          tokens: 30,
          costUsd: 0.5,
        });
      });

      it("totals by scope and since", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.recordModelUsage(usage("u1"));
          await t.recordModelUsage(usage("u2", { turnId: "turn-2", createdAt: "2030-01-02T00:00:00.000Z" }));
          await t.recordModelUsage(
            usage("u3", { agentId: "other", turnId: "turn-3", totalTokens: 100, costUsd: 1 }),
          );
        });
        await store.tx(async (t) => {
          expect(await t.modelUsageTotals({ scope: "tenant" })).toEqual({ calls: 3, tokens: 130, costUsd: 1.5 });
          expect(await t.modelUsageTotals({ scope: "agent", id: "bot" })).toEqual({ calls: 2, tokens: 30, costUsd: 0.5 });
          expect(await t.modelUsageTotals({ scope: "turn", id: "turn-3" })).toEqual({ calls: 1, tokens: 100, costUsd: 1 });
          expect(await t.modelUsageTotals({ scope: "agent", id: "nobody" })).toEqual({ calls: 0, tokens: 0, costUsd: 0 });
          expect(
            await t.modelUsageTotals({ scope: "agent", id: "bot", since: "2030-01-02T00:00:00.000Z" }),
          ).toEqual({ calls: 1, tokens: 15, costUsd: 0.25 });
        });
      });

      it("keeps the ledger through a sessions reset and clears it on a full reset", async () => {
        const store = await fresh();
        await store.tx((t) => t.recordModelUsage(usage("u1")));
        await store.tx((t) => t.reset("sessions"));
        expect((await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).calls).toBe(1);
        await store.tx((t) => t.reset("all"));
        expect((await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).calls).toBe(0);
      });

      it("replaces the budgets as a set, ordered, and clears them on a full reset only", async () => {
        const store = await fresh();
        const at = "2030-01-01T00:00:00.000Z";
        const budgets = [
          { scope: "turn" as const, scopeId: "*", period: null, limitUsd: null, limitTokens: 500, updatedAt: at },
          { scope: "agent" as const, scopeId: "bot", period: "day" as const, limitUsd: 2.5, limitTokens: null, updatedAt: at },
          { scope: "tenant" as const, scopeId: "*", period: "month" as const, limitUsd: 100, limitTokens: 5_000_000_000, updatedAt: at },
        ];
        await store.tx((t) => t.putModelBudgets(budgets));
        expect(await store.tx((t) => t.listModelBudgets())).toEqual([budgets[1], budgets[2], budgets[0]]);
        await store.tx((t) => t.putModelBudgets([budgets[0]!]));
        expect(await store.tx((t) => t.listModelBudgets())).toEqual([budgets[0]]);
        await expect(store.tx((t) => t.putModelBudgets([budgets[1]!, budgets[1]!]))).rejects.toThrow();
        expect(await store.tx((t) => t.listModelBudgets())).toEqual([budgets[0]]);
        await store.tx((t) => t.reset("sessions"));
        expect(await store.tx((t) => t.listModelBudgets())).toHaveLength(1);
        await store.tx((t) => t.reset("all"));
        expect(await store.tx((t) => t.listModelBudgets())).toEqual([]);
      });

      it("rolls a row back with its transaction", async () => {
        const store = await fresh();
        await expect(
          store.tx(async (t) => {
            await t.recordModelUsage(usage("u1"));
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        expect((await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).calls).toBe(0);
      });
    });

    describe("principals", () => {
      it("stores principals with unique ids and token hashes", async () => {
        const store = await fresh();
        const app = { id: "pr_app", role: "application", tokenHash: "ha", idempotencyKey: "k", createdAt: "2030-01-01T00:00:00.000Z" };
        const other = { id: "studio", role: "studio", tokenHash: "hs", idempotencyKey: null, createdAt: "2030-01-01T00:00:00.000Z" };
        await store.tx(async (t) => {
          await t.insertPrincipal(app);
          await t.insertPrincipal(other);
        });
        await store.tx(async (t) => {
          expect(await t.principalByTokenHash("ha")).toEqual(app);
          expect(await t.principalById("studio")).toEqual(other);
          expect(await t.principalByTokenHash("nope")).toBeUndefined();
        });
        await expect(store.tx((t) => t.insertPrincipal({ ...app, tokenHash: "new" }))).rejects.toThrow();
        await expect(store.tx((t) => t.insertPrincipal({ ...app, id: "pr_2" }))).rejects.toThrow();
      });

      it("lists, puts (creates or rotates) and deletes principals by id", async () => {
        const store = await fresh();
        const created = await store.tx((t) => t.putPrincipal("backend", "h1", "2030-01-01T00:00:00.000Z"));
        expect(created).toEqual({
          id: "backend",
          role: "application",
          tokenHash: "h1",
          idempotencyKey: null,
          createdAt: "2030-01-01T00:00:00.000Z",
        });
        await store.tx((t) =>
          t.insertPrincipal({ id: "app", role: "application", tokenHash: "h0", idempotencyKey: "k", createdAt: "2029-01-01T00:00:00.000Z" }),
        );
        // Rotating keeps the id and replaces the hash: the old one no longer finds it.
        const rotated = await store.tx((t) => t.putPrincipal("backend", "h2", "2030-02-01T00:00:00.000Z"));
        expect(rotated).toMatchObject({ id: "backend", tokenHash: "h2", createdAt: "2030-02-01T00:00:00.000Z" });
        await store.tx(async (t) => {
          expect(await t.principalByTokenHash("h1")).toBeUndefined();
          expect((await t.principalByTokenHash("h2"))?.id).toBe("backend");
          expect((await t.listPrincipals()).map((row) => row.id)).toEqual(["app", "backend"]);
        });
        // Another principal's hash is refused.
        await expect(store.tx((t) => t.putPrincipal("other", "h0", "2030-01-01T00:00:00.000Z"))).rejects.toThrow();
        expect(await store.tx((t) => t.deletePrincipal("backend"))).toBe(true);
        expect(await store.tx((t) => t.deletePrincipal("backend"))).toBe(false);
        await store.tx(async (t) => {
          expect(await t.principalByTokenHash("h2")).toBeUndefined();
          expect((await t.listPrincipals()).map((row) => row.id)).toEqual(["app"]);
        });
      });
    });

    describe("vault", () => {
      it("stores vaults, one host vault, and lists user vaults by owner and installation vaults", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.insertVault({ id: "v2", name: "B", ownerUserId: "u1", metadataJson: null, createdAt: "2030-01-02T00:00:00.000Z", scope: "user" });
          await t.insertVault({ id: "v1", name: "A", ownerUserId: "u1", metadataJson: '{"a":1}', createdAt: "2030-01-01T00:00:00.000Z", scope: "user" });
          await t.insertVault({ id: "v3", name: "C", ownerUserId: "u2", metadataJson: null, createdAt: "2030-01-01T00:00:00.000Z", scope: "user" });
          await t.insertVault({ id: "host", name: "Host", ownerUserId: "u1", metadataJson: null, createdAt: "2030-01-01T00:00:00.000Z", scope: "host" });
          await t.insertVault({ id: "i2", name: "I2", ownerUserId: "installation", metadataJson: null, createdAt: "2030-01-02T00:00:00.000Z", scope: "installation" });
          await t.insertVault({ id: "i1", name: "I1", ownerUserId: "installation", metadataJson: null, createdAt: "2030-01-02T00:00:00.000Z", scope: "installation" });
        });
        await expect(
          store.tx((t) => t.insertVault({ id: "host2", name: "H", ownerUserId: "host", metadataJson: null, createdAt: "x", scope: "host" })),
        ).rejects.toThrow();
        await expect(
          store.tx((t) => t.insertVault({ id: "v1", name: "dup", ownerUserId: "u1", metadataJson: null, createdAt: "x", scope: "user" })),
        ).rejects.toThrow();
        await store.tx((t) => t.updateVaultMetadata("host", '{"activeProvider":"x"}'));
        await store.tx(async (t) => {
          expect((await t.vaultsByOwner("u1")).map((v) => v.id)).toEqual(["v1", "v2"]);
          expect((await t.vaultsByOwner("installation")).map((v) => v.id)).toEqual([]);
          expect((await t.installationVaults()).map((v) => v.id)).toEqual(["i1", "i2"]);
          expect(await t.getVault("v1")).toEqual({ id: "v1", name: "A", ownerUserId: "u1", metadataJson: '{"a":1}', createdAt: "2030-01-01T00:00:00.000Z", scope: "user" });
          expect((await t.getVault("host"))!.metadataJson).toBe('{"activeProvider":"x"}');
          expect(await t.getVault("nope")).toBeUndefined();
        });
      });

      it("stores credentials with ciphertext columns, patches and deletes them", async () => {
        const store = await fresh();
        await store.tx(async (t) => {
          await t.insertVault({ id: "v1", name: "A", ownerUserId: "u1", metadataJson: null, createdAt: "2030-01-01T00:00:00.000Z", scope: "user" });
          await t.insertVault({ id: "v2", name: "B", ownerUserId: "u1", metadataJson: null, createdAt: "2030-01-01T00:00:00.000Z", scope: "user" });
          await t.insertCredential(credential("c2", "v1", "2030-01-02T00:00:00.000Z"));
          await t.insertCredential(credential("c1", "v1", "2030-01-02T00:00:00.000Z", { type: "model" }));
          await t.insertCredential(credential("c3", "v2", "2030-01-01T00:00:00.000Z"));
        });
        await expect(store.tx((t) => t.insertCredential(credential("c4", "missing", "x")))).rejects.toThrow();
        await expect(store.tx((t) => t.insertCredential(credential("c1", "v1", "x")))).rejects.toThrow();
        await store.tx(async (t) => {
          const row = await t.getCredential("c2");
          expect(row).toMatchObject({ id: "c2", vaultId: "v1", kekId: "kek-1", expiresAt: null, rotatedAt: null });
          expect([...row!.nonce]).toEqual([1, 2, 3]);
          expect([...row!.ciphertext]).toEqual([4, 5, 6, 7]);
          expect([...row!.wrappedDek]).toEqual([8, 9]);
          expect((await t.credentialsForVault("v1")).map((c) => c.id)).toEqual(["c1", "c2"]);
          expect((await t.credentialsForVault("v1", { type: "model" })).map((c) => c.id)).toEqual(["c1"]);
          expect(await t.countCredentials()).toBe(3);
        });
        expect(
          await store.tx((t) =>
            t.updateCredential("v1", "c2", {
              kekId: "kek-2",
              nonce: new Uint8Array([9]),
              ciphertext: new Uint8Array([9, 9]),
              wrappedDek: new Uint8Array([9, 9, 9]),
              expiresAt: "2031-01-01T00:00:00.000Z",
              rotatedAt: "2030-06-01T00:00:00.000Z",
            }),
          ),
        ).toBe(true);
        expect(await store.tx((t) => t.updateCredential("v2", "c2", { name: "x" }))).toBe(false);
        const updated = await store.tx((t) => t.getCredential("c2"));
        expect(updated).toMatchObject({ kekId: "kek-2", name: "c2", expiresAt: "2031-01-01T00:00:00.000Z", rotatedAt: "2030-06-01T00:00:00.000Z" });
        expect([...updated!.ciphertext]).toEqual([9, 9]);
        expect(await store.tx((t) => t.deleteCredential("v2", "c2"))).toBe(false);
        expect(await store.tx((t) => t.deleteCredential("v1", "c2"))).toBe(true);
        await store.tx((t) => t.deleteVault("v1"));
        await store.tx(async (t) => {
          expect(await t.getCredential("c1")).toBeUndefined();
          expect(await t.getVault("v1")).toBeUndefined();
          expect(await t.countCredentials()).toBe(1);
        });
      });

      it("keeps a pending OAuth connect until it is taken once, expired, or its vault goes (F9 C2)", async () => {
        const store = await fresh();
        const pending = (stateHash: string, vaultId: string, expiresAt: string) => ({
          stateHash, vaultId, server: "remote", url: "https://mcp.example.com/mcp",
          tokenEndpoint: "https://auth.example.com/token", clientId: "client-1",
          tokenEndpointAuth: "none" as const, resource: null, kekId: "kek-1",
          clientSecret: null, codeVerifier: new Uint8Array([1, 2, 3]),
          redirectUri: "http://localhost:4000/v1/oauth/callback", expiresAt,
          createdAt: "2030-01-01T00:00:00.000Z",
        });
        await store.tx(async (t) => {
          await t.insertVault({ id: "i1", name: "mcp", ownerUserId: "installation", metadataJson: null, createdAt: "2030-01-01T00:00:00.000Z", scope: "installation" });
          await t.insertOAuthPending(pending("s1", "i1", "2030-01-01T00:10:00.000Z"));
          await t.insertOAuthPending({ ...pending("s2", "i1", "2030-01-01T00:05:00.000Z"), clientSecret: new Uint8Array([7]) });
          await t.insertOAuthPending(pending("s3", "i1", "2030-01-01T00:20:00.000Z"));
        });
        await expect(store.tx((t) => t.insertOAuthPending(pending("s1", "i1", "x")))).rejects.toThrow();
        await expect(store.tx((t) => t.insertOAuthPending(pending("s9", "missing", "x")))).rejects.toThrow();
        const taken = await store.tx((t) => t.takeOAuthPending("s1"));
        expect(taken).toMatchObject({ stateHash: "s1", vaultId: "i1", clientSecret: null, resource: null });
        expect([...taken!.codeVerifier]).toEqual([1, 2, 3]);
        expect(await store.tx((t) => t.takeOAuthPending("s1"))).toBeUndefined();
        expect(await store.tx((t) => t.deleteExpiredOAuthPending("2030-01-01T00:06:00.000Z"))).toBe(1);
        expect(await store.tx((t) => t.takeOAuthPending("s2"))).toBeUndefined();
        await store.tx((t) => t.deleteVault("i1"));
        expect(await store.tx((t) => t.takeOAuthPending("s3"))).toBeUndefined();
      });

      it("appends audit rows and keeps idempotency rows unique", async () => {
        const store = await fresh();
        const row = (id: string, vaultId: string | null) => ({
          id, at: "2030-01-01T00:00:00.000Z", actor: "application", action: "create",
          vaultId, credentialId: null, sessionId: null, target: null, outcome: "created",
        });
        await store.tx(async (t) => {
          await t.insertVaultAudit(row("a1", "v1"));
          await t.insertVaultAudit(row("a2", "v2"));
          await t.insertVaultAudit(row("a3", "v1"));
          await t.insertVaultIdempotency({ id: "k", bodyHash: "h", response: '{"id":"v1"}' });
        });
        await store.tx(async (t) => {
          expect((await t.vaultAudit()).map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
          expect((await t.vaultAudit({ vaultId: "v1" })).map((r) => r.id)).toEqual(["a1", "a3"]);
          expect((await t.vaultAudit({ limit: 1 })).map((r) => r.id)).toEqual(["a1"]);
          expect(await t.vaultAudit({ vaultId: "v2" })).toEqual([row("a2", "v2")]);
          expect(await t.getVaultIdempotency("k")).toEqual({ id: "k", bodyHash: "h", response: '{"id":"v1"}' });
          expect(await t.getVaultIdempotency("nope")).toBeUndefined();
        });
        await expect(
          store.tx((t) => t.insertVaultIdempotency({ id: "k", bodyHash: "h2", response: "{}" })),
        ).rejects.toThrow();
      });
    });

    describe("settings and reset", () => {
      it("gets and puts Tenant settings", async () => {
        const store = await fresh();
        expect(await store.tx((t) => t.getSetting("sandbox.backend"))).toBeUndefined();
        await store.tx((t) => t.putSetting("sandbox.backend", "virtual"));
        await store.tx((t) => t.putSetting("sandbox.backend", "auto"));
        expect(await store.tx((t) => t.getSetting("sandbox.backend"))).toBe("auto");
      });

      async function populate(store: SessionStore) {
        await store.tx(async (t) => {
          await t.put("sessions", "s1", session("s1"));
          await t.put("commands", "c1", { id: "c1" });
          await t.put("effects", "e1", effect("e1", "s1", "t1", "pending"));
          await t.put("links", "l1", { workflowSessionId: "s1", path: "p", effectId: "e1", turnId: "t1" });
          await t.event("s1", null, "turn.completed", { tag: "x", output: {} });
          await t.put("sandboxes", "sb1", { key: "sb1" });
          await t.put("definitions", "agent-a", { manifest: { id: "agent-a" } });
          await t.insertPrincipal({ id: "pr_1", role: "application", tokenHash: "hp", idempotencyKey: null, createdAt: "x" });
          await t.insertVault({ id: "host", name: "Host", ownerUserId: "host", metadataJson: null, createdAt: "x", scope: "host" });
          await t.insertVault({ id: "v1", name: "A", ownerUserId: "u", metadataJson: null, createdAt: "x", scope: "user" });
          await t.insertCredential(credential("hc", "host", "x", { type: "model" }));
          await t.insertCredential(credential("uc", "v1", "x"));
          await t.putSetting("k", "v");
        });
      }

      it("resets sessions", async () => {
        const store = await fresh();
        await populate(store);
        await store.tx((t) => t.reset("sessions"));
        await store.tx(async (t) => {
          const cleared = { sessions: "s1", commands: "c1", effects: "e1", links: "l1" } as const;
          for (const [table, id] of Object.entries(cleared))
            expect(await t.get(table as keyof typeof cleared, id)).toBeUndefined();
          expect(await t.listSandboxes()).toHaveLength(1);
          expect(await t.listDefinitions()).toHaveLength(1);
        });
      });

      it("resets sandboxes", async () => {
        const store = await fresh();
        await populate(store);
        await store.tx((t) => t.reset("sandboxes"));
        await store.tx(async (t) => {
          expect(await t.listSandboxes()).toEqual([]);
          expect(await t.get("sessions", "s1")).toBeDefined();
        });
      });

      it("resets all but keeps the host vault, principals and settings", async () => {
        const store = await fresh();
        await populate(store);
        await store.tx((t) => t.reset("all"));
        await store.tx(async (t) => {
          expect(await t.counts()).toEqual({ sessions: 0, runningSessions: 0, uncertainEffects: 0, sandboxes: 0, definitions: 0 });
          expect(await t.getVault("v1")).toBeUndefined();
          expect(await t.getCredential("uc")).toBeUndefined();
          expect(await t.getVault("host")).toBeDefined();
          expect(await t.getCredential("hc")).toBeDefined();
          expect(await t.principalById("pr_1")).toBeDefined();
          expect(await t.getSetting("k")).toBe("v");
        });
        // A session recreated after reset starts a new sequence.
        await store.tx((t) => t.put("sessions", "s1", session("s1")));
        const event = await store.tx((t) => t.event("s1", null, "turn.completed", { tag: "x", output: {} }));
        expect(decodeCursor("s1", event.cursor)).toBe(0);
      });
    });

    it("reports health", async () => {
      const store = await fresh();
      const health = await store.health();
      expect(health.ok).toBe(true);
      expect(health.schemaVersion).toBe(health.expectedSchemaVersion);
    });
  });
}
