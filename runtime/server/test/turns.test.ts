/**
 * The turn index (A2A design §9, Host feature `turns`): each turn's row is written with the
 * events that change it, so it agrees with the session's log through completion, failure,
 * cancellation and a pause for approval; `GET /v1/turns` pages the rows in the order they
 * changed, one session's or the whole feed, scoped to the caller; and the migration's backfill
 * writes the rows the live path writes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/agents";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { sql } from "drizzle-orm";
import type { ModelProvider } from "../src/core/provider.js";
import { database } from "../src/store/postgres/db.js";
import { shippedMigrations } from "../src/store/postgres/migrate.js";
import { deploy, openSession } from "./support/agents.js";
import { testTenantPool, withTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";
import { setToolPolicy } from "./support/tool-policy.js";
import { startToolServer, type ToolServer } from "./support/tool-server.js";

const APP = "turns-app-key-aaaaaaaaaaaaaaaaaaaa";

/** Released holds, by name: a model call whose last user text is `hold:<name>` waits for it. */
const held = new Map<string, () => void>();

/** Answers by the last user text: `fail` fails the call, `hold:<name>` waits, `save` asks for the tool. */
const model: ModelProvider = async (effect, signal) => {
  const prompt = (effect.input as { prompt?: { role?: string; kind?: string; content?: { type: string; text?: string }[] }[] })
    .prompt ?? [];
  const texts = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])));
  const last = texts.at(-1) ?? "";
  if (last === "fail")
    return { kind: "failed", code: "invalid_request", message: "refused", retryable: false };
  const hold = last.match(/^hold:(\w+)$/)?.[1];
  if (hold)
    await new Promise<void>((resolve, reject) => {
      held.set(hold, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  if (last === "save" && !prompt.some((item) => item.kind === "tool-result"))
    return {
      output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "save", args: { note: "hi" } }],
    };
  return { output: [{ type: "text", text: `answered ${last}` }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let service: ToolServer;
let app: Record<string, string>;
const as = (subject: string) => ({ ...app, "Nylorun-Subject": subject, "Nylorun-Scopes": "sessions:own" });

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  app = { ...runtime.headers(), "content-type": "application/json" };
  service = await startToolServer({ save: () => ({ saved: true }) });
  await deploy(runtime.url, app, Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build(), {
    runtime: { kind: "none" } as never,
  });
  await deploy(
    runtime.url,
    app,
    Agent({ id: "guarded", name: "Guarded" })
      .instructions("Save.")
      .tools(service.tool("save", { input: z.object({ note: z.string() }) }))
      .build(),
  );
  await setToolPolicy(runtime, [{ effect: "ask", tool: "save", agent: "guarded" }]);
}, 60_000);

afterAll(async () => {
  for (const release of held.values()) release();
  await service?.close();
  await runtime?.close();
});

let n = 0;
async function command(session: string, body: Record<string, unknown>): Promise<any> {
  n++;
  const response = await fetch(`${runtime.url}/v1/sessions/${session}/commands`, {
    method: "POST",
    headers: app,
    body: JSON.stringify({ requestId: `r${n}`, idempotencyKey: `k${n}`, ...body }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
const send = (session: string, content: string) => command(session, { type: "message", content });

async function view(session: string): Promise<any> {
  return (await fetch(`${runtime.url}/v1/sessions/${session}`, { headers: app })).json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const settled = (session: string, statuses = ["completed", "failed", "cancelled", "paused"]) =>
  until(() => view(session), (v) => statuses.includes(v.status) && (v.status === "paused" || v.activeTurnId === null));

async function open(id: string, agent = "bot", owner = "ada") {
  const opened = await openSession(runtime.url, app, id, { agent, ownerUserId: owner });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

async function turns(query: Record<string, string>, headers = app): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}/v1/turns?${new URLSearchParams(query)}`, { headers });
  return { status: response.status, body: await response.json() };
}

/** Every page of the feed after `changedAfter`. */
async function drain(query: Record<string, string>, headers = app, limit = "2") {
  const seen: any[] = [];
  let cursor = query.changedAfter;
  for (;;) {
    const page = await turns({ ...query, limit, ...(cursor ? { changedAfter: cursor } : {}) }, headers);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    seen.push(...page.body.turns);
    cursor = page.body.cursor;
    if (!page.body.hasMore) return { turns: seen, cursor: cursor! };
  }
}

/**
 * The feed reads only below the oldest open transaction of the whole server (other test files'
 * included), so a change shows once those end: reads that expect one wait for it.
 */
async function eventually(query: Record<string, string>, done: (turns: any[]) => boolean, headers = app) {
  return until(() => turns(query, headers), (page) => page.status === 200 && done(page.body.turns));
}

/** How many rows the index holds (of `owner`'s sessions). */
async function committed(owner?: string): Promise<number> {
  const db = database(testTenantPool(runtime.tenantId));
  const [row] = await db.execute<{ n: number }>(
    owner === undefined
      ? sql`SELECT count(*)::int AS n FROM nylorun.turns`
      : sql`SELECT count(*)::int AS n FROM nylorun.turns WHERE owner_user_id = ${owner}`,
  );
  return row!.n;
}

/** Every page of the whole feed, once it shows every committed row. */
async function drainAll(headers = app, owner?: string, limit = "2") {
  const count = await committed(owner);
  return until(() => drain({}, headers, limit), (page) => page.turns.length === count);
}

/** What the log says of each turn: what the index must say. */
async function fromLog(session: string) {
  const page = (await (await fetch(`${runtime.url}/v1/sessions/${session}/items?limit=500`, { headers: app })).json()) as {
    items: { type: string; turnId: string | null; time: string; payload: any }[];
  };
  const status: Record<string, string> = {
    "command.message": "running",
    "command.approve": "running",
    "command.respond": "running",
    "turn.paused": "paused",
    "turn.completed": "completed",
    "turn.failed": "failed",
    "turn.cancelled": "cancelled",
  };
  const byTurn = new Map<string, any>();
  for (const event of page.items) {
    if (!event.turnId || !status[event.type]) continue;
    const entry = byTurn.get(event.turnId);
    if (entry?.status !== undefined && event.type === "command.message") continue;
    const ended = ["completed", "failed", "cancelled"].includes(status[event.type]!);
    const totals = event.payload?.totals;
    byTurn.set(event.turnId, {
      turnId: event.turnId,
      sessionId: session,
      status: status[event.type],
      startedAt: entry?.startedAt ?? event.time,
      endedAt: ended ? event.time : null,
      changedAt: event.time,
      totals: ended && totals ? { steps: totals.steps, tokens: totals.tokens, costUsd: totals.costUsd } : null,
    });
  }
  return [...byTurn.values()];
}

describe("the turn index", () => {
  it("is a Host feature", async () => {
    expect(HOST_PROTOCOL.features).toContain("turns");
    const health = await (await fetch(`${runtime.url}/health`)).json();
    expect(JSON.stringify(health)).toContain('"turns"');
  });

  it("agrees with the log through completion, failure and cancellation", async () => {
    await open("t-life");
    await send("t-life", "hello");
    expect((await settled("t-life")).status).toBe("completed");
    await send("t-life", "fail");
    expect((await settled("t-life")).status).toBe("failed");
    const holding = await send("t-life", "hold:life");
    await until(async () => held.has("life"), (v) => v);
    const running = await eventually({ sessionId: "t-life" }, (rows) => rows.at(-1)?.turnId === holding.turnId);
    expect(running.body.turns.at(-1)).toMatchObject({ turnId: holding.turnId, status: "running", endedAt: null, totals: null });
    await command("t-life", { type: "cancel" });
    expect((await settled("t-life")).status).toBe("cancelled");

    const indexed = await eventually({ sessionId: "t-life" }, (rows) => rows.at(-1)?.status === "cancelled");
    expect(indexed.status).toBe(200);
    const log = await fromLog("t-life");
    expect(log.map((turn) => turn.status)).toEqual(["completed", "failed", "cancelled"]);
    expect(indexed.body.turns).toEqual(
      log.map((turn) => ({ ...turn, agentId: "bot", a2a: null })),
    );
    // The end facts' totals (the in-process provider meters nothing).
    expect(indexed.body.turns[0].totals).toEqual({ steps: 0, tokens: 0, costUsd: 0 });
  });

  it("follows a turn that pauses for approval, and goes on when it is approved", async () => {
    await open("t-pause", "guarded");
    const sent = await send("t-pause", "save");
    const paused = await settled("t-pause");
    expect(paused.status).toBe("paused");
    const before = await eventually({ sessionId: "t-pause" }, (rows) => rows.length === 1);
    expect(before.body.turns).toEqual([expect.objectContaining({ turnId: sent.turnId, status: "paused", endedAt: null })]);
    const page = (await (await fetch(`${runtime.url}/v1/sessions/t-pause/items?limit=100`, { headers: app })).json()) as {
      items: { type: string; payload: any }[];
    };
    const interactionId = page.items.find((event) => event.type === "turn.paused")!.payload.interactions[0].interaction.id;
    await command("t-pause", { type: "approve", interactionId, approved: true });
    expect((await settled("t-pause", ["completed", "failed"])).status).toBe("completed");
    // It reappears after the cursor read while it was paused, now completed.
    const after = await eventually({ sessionId: "t-pause", changedAfter: before.body.cursor }, (rows) => rows[0]?.status === "completed");
    expect(after.body.turns).toEqual([expect.objectContaining({ turnId: sent.turnId, status: "completed" })]);
    expect((await turns({ sessionId: "t-pause" })).body.turns).toEqual(
      (await fromLog("t-pause")).map((turn) => ({ ...turn, agentId: "guarded", a2a: null })),
    );
  });
});

describe("the turn index's transactions", () => {
  it("keeps nothing of a transaction that rolls back, and stamps each change with its own", async () => {
    await open("t-tx");
    const message = { type: "message", requestId: "x", idempotencyKey: "x", content: "x" } as const;
    await withTestSessionStore(runtime, async (store) => {
      await expect(
        store.tx(async (t) => {
          await t.event("t-tx", "turn-rolled-back", "command.message", message);
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await store.tx((t) => t.turn("t-tx", "turn-rolled-back"))).toBeUndefined();
      // Two changes in two transactions: the row moves to the later one.
      await store.tx((t) => t.event("t-tx", "turn-direct", "command.message", message));
      const started = await store.tx((t) => t.turn("t-tx", "turn-direct"));
      expect(started).toMatchObject({ status: "running", firstSeq: started!.lastSeq, endedAt: null });
      await store.tx((t) =>
        t.event("t-tx", "turn-direct", "turn.cancelled", {
          reason: "test",
          totals: { steps: 2, tokens: 30, costUsd: 0.5 },
        }),
      );
      const ended = await store.tx((t) => t.turn("t-tx", "turn-direct"));
      expect(ended).toMatchObject({
        status: "cancelled",
        firstSeq: started!.firstSeq,
        lastSeq: started!.lastSeq + 1,
        totals: { steps: 2, tokens: 30, costUsd: 0.5 },
      });
      expect(BigInt(ended!.txid)).toBeGreaterThan(BigInt(started!.txid));
      expect(ended!.endedAt).toBe(ended!.changedAt);

      // A paused turn keeps what its first open interaction asks for, as profile v2 names it.
      const paused = (kind: string, metadata?: object) => ({
        interactions: [
          { invocationId: "done", status: "completed", interaction: { id: "old", kind: "approval" } },
          { invocationId: "i", status: "interaction", interaction: { id: "x", kind, ...(metadata ? { metadata } : {}) } },
        ],
      });
      const waiting = async (turnId: string, payload: object) => {
        await store.tx((t) => t.event("t-tx", turnId, "command.message", { ...message, idempotencyKey: turnId }));
        await store.tx((t) => t.event("t-tx", turnId, "turn.paused", payload as never));
        return (await store.tx((t) => t.turn("t-tx", turnId)))!;
      };
      expect(await waiting("turn-ask", paused("response"))).toMatchObject({ status: "paused", waitingFor: "question" });
      expect(await waiting("turn-approve", paused("approval"))).toMatchObject({ waitingFor: "approval" });
      expect(await waiting("turn-connect", paused("response", { kind: "connection" }))).toMatchObject({
        waitingFor: "connection",
      });
      await store.tx((t) =>
        t.event("t-tx", "turn-ask", "command.respond", {
          type: "respond",
          requestId: "a",
          idempotencyKey: "a",
          interactionId: "x",
          value: "yes",
        }),
      );
      expect(await store.tx((t) => t.turn("t-tx", "turn-ask"))).toMatchObject({ status: "running", waitingFor: null });

      // A turn that took queued messages is found by each of their ids.
      await store.tx(async (t) => {
        await t.event("t-tx", "turn-queued", "command.message", { ...message, idempotencyKey: "q1", queuedMessageId: "qm-1" });
        await t.event("t-tx", "turn-queued", "command.message", { ...message, idempotencyKey: "q2", queuedMessageId: "qm-2" });
      });
      for (const id of ["qm-1", "qm-2"])
        expect((await store.tx((t) => t.turnOfQueuedMessage("t-tx", id)))?.turnId).toBe("turn-queued");
      expect(await store.tx((t) => t.turnOfQueuedMessage("t-tx", "qm-none"))).toBeUndefined();
    });
  });
});

describe("the change feed under concurrent transactions", () => {
  it("holds back a change while an earlier transaction is still open, so none lands behind the cursor", async () => {
    await open("t-c1");
    await open("t-c2");
    const { cursor } = await drainAll();
    const message = { type: "message", requestId: "c", idempotencyKey: "c", content: "c" } as const;
    await withTestSessionStore(runtime, async (store) => {
      let release!: () => void;
      let written!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const wrote = new Promise<void>((resolve) => (written = resolve));
      const earlier = store.tx(async (t) => {
        await t.event("t-c1", "turn-earlier", "command.message", message);
        written();
        await gate;
      });
      await wrote;
      await store.tx((t) => t.event("t-c2", "turn-later", "command.message", message));
      // The later transaction committed first; the feed waits for the earlier one.
      expect((await drain({ changedAfter: cursor })).turns).toEqual([]);
      release();
      await earlier;
      const both = await until(
        () => drain({ changedAfter: cursor }),
        (page) => page.turns.length === 2,
      );
      expect(both.turns.map((turn) => turn.turnId)).toEqual(["turn-earlier", "turn-later"]);
    });
  });
});

describe("GET /v1/turns", () => {
  it("pages the changes in order, a turn again when it changes, and echoes the cursor when none did", async () => {
    const all = await drainAll();
    expect(all.turns.length).toBeGreaterThanOrEqual(4);
    // Each page follows the last; no turn twice in one read of rows that did not change.
    expect(new Set(all.turns.map((turn) => `${turn.sessionId}/${turn.turnId}`)).size).toBe(all.turns.length);
    const quiet = await turns({ changedAfter: all.cursor });
    expect(quiet.body).toEqual({ turns: [], cursor: all.cursor, hasMore: false });

    await open("t-feed");
    const first = await send("t-feed", "one");
    await settled("t-feed");
    const next = await until(() => drain({ changedAfter: all.cursor }), (page) => page.turns.length === 1);
    expect(next.turns).toEqual([expect.objectContaining({ sessionId: "t-feed", turnId: first.turnId, status: "completed" })]);
    // Two turns of one session, oldest first, each once.
    const second = await send("t-feed", "two");
    await settled("t-feed");
    expect((await eventually({ sessionId: "t-feed" }, (rows) => rows.length === 2)).body.turns.map((turn: any) => turn.turnId)).toEqual([
      first.turnId,
      second.turnId,
    ]);
    const later = await until(() => drain({ changedAfter: next.cursor }), (page) => page.turns.length === 1);
    expect(later.turns.map((turn) => turn.turnId)).toEqual([second.turnId]);
  });

  it("starts with a cursor even when nothing changed, and refuses a cursor of another query", async () => {
    const empty = await turns({ sessionId: "t-none-yet" });
    expect(empty.status).toBe(404);
    await open("t-empty");
    const first = await turns({ sessionId: "t-empty" });
    expect(first.body).toEqual({ turns: [], cursor: expect.any(String), hasMore: false });
    const mismatch = await turns({ changedAfter: first.body.cursor });
    expect(mismatch).toMatchObject({ status: 400, body: { code: "cursor_mismatch" } });
    expect((await turns({ changedAfter: "not a cursor" })).status).toBe(400);
    expect((await turns({ limit: "0" })).status).toBe(400);
  });

  it("shows a subject only its own sessions' turns, and an application key the Tenant's", async () => {
    await open("t-bob", "bot", "bob");
    const bobs = await send("t-bob", "mine");
    await settled("t-bob");
    const ada = await drainAll(as("ada"), "ada", "100");
    expect(ada.turns.length).toBeGreaterThan(0);
    expect(ada.turns.every((turn) => turn.sessionId !== "t-bob")).toBe(true);
    const bob = await drainAll(as("bob"), "bob", "100");
    expect(bob.turns.map((turn) => turn.turnId)).toEqual([bobs.turnId]);
    const tenant = await drainAll(app, undefined, "100");
    expect(tenant.turns.map((turn) => turn.turnId)).toContain(bobs.turnId);
    expect(tenant.turns.length).toBe(ada.turns.length + bob.turns.length);
    // Another subject's session is the 404 of a missing one.
    expect((await turns({ sessionId: "t-bob" }, as("ada"))).status).toBe(404);
    expect((await eventually({ sessionId: "t-bob" }, (rows) => rows.length === 1, as("bob"))).body.turns).toHaveLength(1);
  });
});

describe("the backfill migration", () => {
  it("writes the rows the live index wrote", async () => {
    const db = database(testTenantPool(runtime.tenantId));
    const columns = sql.raw(
      `session_id, turn_id, agent_id, owner_user_id, a2a_context_id, status, started_at, ended_at, changed_at, totals::jsonb AS totals, waiting_for, queued_message_ids, first_seq, last_seq`,
    );
    const read = () => db.execute(sql`SELECT ${columns} FROM nylorun.turns ORDER BY session_id, turn_id`);
    const live = await read();
    expect(live.length).toBeGreaterThanOrEqual(7);
    const backfill = shippedMigrations().find((migration) => migration.tag === "0041_turn_index_backfill")!;
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM nylorun.turns`);
      for (const statement of backfill.statements) if (statement.trim()) await tx.execute(sql.raw(statement));
    });
    expect(await read()).toEqual(live);
  });
});
