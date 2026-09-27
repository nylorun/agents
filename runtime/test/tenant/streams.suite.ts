/**
 * The Tenant's Durable Streams seam end to end (architecture §12.4, §11.1, §11.5, §17): history,
 * session SSE, executor work and cancel, read from streams. Runs on the in-memory streams
 * (`streams.test.ts`) and on s2-lite (`streams.integration.test.ts`).
 *
 * "Another node" is a second Tenant runtime in this process over the same SQLite database
 * and the same streams. Until Wave 2 / X removes the Tenant lock file, the second instance
 * opens after its lock file is removed. Both SQLite connections share one thread, so the
 * tests avoid overlapping writes from the two instances.
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor, encodeCursor } from "../../src/store/cursor.js";
import type { TenantContext } from "../../src/tenant/context.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { drainOutbox } from "../../src/tenant/streams.js";
import type { TenantHandle } from "../../src/tenant/types.js";
import type { ModelProvider } from "../../src/core/provider.js";
import {
  CONTROL_STREAM,
  WORK_STREAM,
  sessionStream,
  type AppendOptions,
  type AppendResult,
  type DurableStreams,
  type ReadOptions,
  type StreamRecord,
} from "../../src/streams/types.js";
import { startTestTenant } from "../support/tenant.js";

export interface StreamsHarness {
  streams: DurableStreams;
  dispose?(): Promise<void>;
}

/** Passes through to `inner`, failing every call while `down`, and counts following reads. */
export class ProbeStreams implements DurableStreams {
  down = false;
  /** Following (`follow` not false) reads opened, by stream. */
  readonly followReads = new Map<string, number>();

  constructor(readonly inner: DurableStreams) {}

  private check(): void {
    if (this.down) throw new Error("S2 unreachable");
  }
  async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions
  ): Promise<AppendResult> {
    this.check();
    return this.inner.append(tenantId, stream, records, options);
  }
  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options: ReadOptions = {}
  ): AsyncIterable<StreamRecord<T>> {
    if (options.follow !== false)
      this.followReads.set(stream, (this.followReads.get(stream) ?? 0) + 1);
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        self.check();
        for await (const record of self.inner.read<T>(
          tenantId,
          stream,
          fromSeq,
          options
        )) {
          self.check();
          yield record;
        }
      },
    };
  }
  async tail(tenantId: string, stream: string): Promise<number> {
    this.check();
    return this.inner.tail(tenantId, stream);
  }
  async ensureTenant(tenantId: string): Promise<void> {
    this.check();
    return this.inner.ensureTenant(tenantId);
  }
  deleteTenant(tenantId: string): Promise<void> {
    return this.inner.deleteTenant(tenantId);
  }
  deleteStream(tenantId: string, stream: string): Promise<void> {
    return this.inner.deleteStream(tenantId, stream);
  }
  /** The harness owns the inner streams. */
  async close(): Promise<void> {}
}

const APP = "server-token-value-aaaaaaaa";
const EXECUTOR = "executor-token-value-bbbbbbbb";

export const contextOf = (handle: TenantHandle): TenantContext =>
  (handle as unknown as { ctx: TenantContext }).ctx;

const seqs = (events: readonly LiveEvent[]) =>
  events.map((e) => decodeCursor(e.sessionId, e.cursor));
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

async function eventually<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface SseClient {
  /** Parsed `data:` frames, in arrival order. */
  readonly frames: unknown[];
  /** True once the server ended the response. */
  readonly ended: boolean;
  /** Resolves once the response headers arrived (the observer has joined). */
  ready(): Promise<void>;
  until(what: string, done: (frames: unknown[]) => boolean): Promise<void>;
  close(): unknown[];
}

function sse(url: string, headers: Record<string, string>): SseClient {
  const abort = new AbortController();
  const frames: unknown[] = [];
  let status: number | undefined;
  let ended = false;
  void (async () => {
    const response = await fetch(url, { headers, signal: abort.signal });
    status = response.status;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      text += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data && !abort.signal.aborted) frames.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => {});
  return {
    frames,
    get ended() {
      return ended;
    },
    async ready() {
      await eventually("the SSE response", () => {
        if (status !== undefined && status !== 200)
          throw new Error(`SSE answered ${status}`);
        return status === 200 || undefined;
      });
    },
    async until(what, done) {
      await eventually(what, () => {
        if (status !== undefined && status !== 200)
          throw new Error(`SSE answered ${status}`);
        return done(frames);
      });
    },
    close() {
      abort.abort();
      return [...frames];
    },
  };
}

type Node = Awaited<ReturnType<typeof startTestTenant>>;

export function tenantStreamsSuite(
  name: string,
  factory: () => Promise<StreamsHarness>
): void {
  describe(`Tenant streams seam: ${name}`, { timeout: 30_000 }, () => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function setup() {
      const harness = await factory();
      const probe = new ProbeStreams(harness.streams);
      const tenantId = newTenantId();
      const nodes: Node[] = [];
      cleanups.push(async () => {
        for (const node of nodes.reverse()) await node.close().catch(() => {});
        await harness.streams.deleteTenant(tenantId).catch(() => {});
        await harness.streams.close();
        await harness.dispose?.();
      });

      /** The first node creates the Tenant; later ones open the same database and streams. */
      async function node(
        options: { modelProvider?: ModelProvider; executors?: boolean } = {}
      ): Promise<Node> {
        const first = nodes[0];
        if (first)
          rmSync(tenantPaths(first.root, tenantId).lock, { force: true });
        const started = await startTestTenant({
          tenantId,
          applicationKey: APP,
          streams: probe,
          ...(first ? { hostRoot: first.root } : {}),
          ...(options.modelProvider
            ? { modelProvider: options.modelProvider }
            : {}),
          ...(options.executors
            ? {
                executors: [
                  {
                    token: EXECUTOR,
                    agentId: "issue",
                    implementationVersion: "dev",
                  },
                ],
              }
            : {}),
        });
        nodes.push(started);
        return started;
      }

      const headers = {
        authorization: `Bearer ${APP}`,
        "content-type": "application/json",
      };

      async function call(url: string, method: string, body?: unknown) {
        const response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return response;
      }

      async function createSession(
        node: Node,
        sessionId = "s1",
        manifest = Agent({ id: "bot", name: "Bot" }).build().manifest
      ) {
        const agentId = (manifest as { id: string }).id;
        expect(
          (
            await call(`${node.url}/v1/agents/${agentId}`, "PUT", {
              requestId: `agent-${agentId}`,
              manifest,
              implementationVersion: "dev",
            })
          ).ok
        ).toBe(true);
        expect(
          (
            await call(`${node.url}/v1/sessions/${sessionId}`, "PUT", {
              requestId: `session-${sessionId}`,
              agentId,
              ownerUserId: "ada",
            })
          ).ok
        ).toBe(true);
      }

      async function command(
        node: Node,
        body: Record<string, unknown>,
        sessionId = "s1"
      ) {
        const response = await call(
          `${node.url}/v1/sessions/${sessionId}/commands`,
          "POST",
          body
        );
        expect(response.status).toBe(200);
        return (await response.json()) as { cursor: string };
      }

      async function history(
        node: Node,
        query: { cursor?: string; agent?: string } = {},
        sessionId = "s1"
      ) {
        const search = new URLSearchParams(query).toString();
        return call(
          `${node.url}/v1/sessions/${sessionId}/items${search ? `?${search}` : ""}`,
          "GET"
        );
      }

      async function items(node: Node, query: { cursor?: string; agent?: string } = {}) {
        const response = await history(node, query);
        expect(response.status).toBe(200);
        return (await response.json()) as {
          items: LiveEvent[];
          cursor: string | null;
        };
      }

      function observe(node: Node, cursor?: string, sessionId = "s1") {
        return sse(`${node.url}/v1/sessions/${sessionId}/events`, {
          authorization: `Bearer ${APP}`,
          ...(cursor ? { "last-event-id": cursor } : {}),
        });
      }

      /** Commits `count` single-event transactions concurrently through `node`'s store. */
      async function commitConcurrently(
        node: Node,
        count: number,
        payload: (i: number) => unknown = (i) => ({ i }),
        sessionId = "s1"
      ): Promise<LiveEvent[]> {
        const ctx = contextOf(node.handle);
        const events = await Promise.all(
          range(0, count).map((i) =>
            ctx.store.tx((t) => t.event(sessionId, null, "test.tick", payload(i)))
          )
        );
        await relayed(node);
        return events;
      }

      /** Waits until `node`'s relay has appended everything it started. */
      async function relayed(node: Node) {
        await contextOf(node.handle).live.wiring!.relay.idle();
      }

      async function tailOf(stream: string) {
        return harness.streams.tail(tenantId, stream);
      }

      async function records(stream: string) {
        const out: unknown[] = [];
        for await (const record of harness.streams.read(tenantId, stream, 0, {
          follow: false,
        }))
          out.push(record.body);
        return out;
      }

      return {
        probe,
        tenantId,
        node,
        createSession,
        command,
        history,
        items,
        observe,
        commitConcurrently,
        relayed,
        tailOf,
        records,
      };
    }

    const onlyEvents = (frames: unknown[]) => frames as LiveEvent[];

    it("resumes SSE from Last-Event-ID with no gap or duplicate under concurrent commits", async () => {
      const t = await setup();
      const a = await t.node();
      await t.createSession(a);
      const base = (await t.items(a)).items.length;

      const first = t.observe(a);
      // Ten batches of ten concurrent commits, spread out so the reconnect lands mid-way.
      const writing = (async () => {
        for (let batch = 0; batch < 10; batch += 1) {
          await t.commitConcurrently(a, 10);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      await first.until("30 events on the first connection", (f) => f.length >= 30);
      const seen = onlyEvents(first.close());
      const last = seen.at(-1)!;
      expect(seen.length).toBeLessThan(base + 100);

      const second = t.observe(a, last.cursor);
      await writing;
      const total = base + 100;
      await second.until("every event on the second connection", (f) =>
        onlyEvents(f).some((e) => decodeCursor("s1", e.cursor) === total - 1)
      );
      const resumed = onlyEvents(second.close());
      expect(seqs(seen)).toEqual(range(0, seen.length));
      expect(seqs(resumed)).toEqual(range(seen.length, total));
      expect((await t.items(a)).items).toEqual([...seen, ...resumed]);
    });

    it("shares one stream read among a session's observers", async () => {
      const t = await setup();
      const a = await t.node();
      await t.createSession(a);
      await t.commitConcurrently(a, 5);
      const total = (await t.items(a)).items.length;
      const stream = sessionStream("s1");

      const one = t.observe(a);
      await one.until("the history", (f) => f.length === total);
      const two = t.observe(a, onlyEvents(one.frames).at(-1)!.cursor);
      await two.ready();
      await t.commitConcurrently(a, 5);
      for (const client of [one, two])
        await client.until("the new events", (f) =>
          onlyEvents(f).some((e) => decodeCursor("s1", e.cursor) === total + 4)
        );
      expect(t.probe.followReads.get(stream)).toBe(1);

      // An observer behind the shared read restarts it; the others skip what they have.
      const three = t.observe(a);
      await three.until("the whole stream", (f) => f.length === total + 5);
      await t.commitConcurrently(a, 1);
      for (const client of [one, two, three])
        await client.until("one more event", (f) =>
          onlyEvents(f).some((e) => decodeCursor("s1", e.cursor) === total + 5)
        );
      expect(t.probe.followReads.get(stream)).toBe(2);
      expect(seqs(onlyEvents(one.close()))).toEqual(range(0, total + 6));
      expect(seqs(onlyEvents(two.close()))).toEqual(range(total, total + 6));
      expect(seqs(onlyEvents(three.close()))).toEqual(range(0, total + 6));
    });

    it("resumes SSE on another node without a gap", async () => {
      const t = await setup();
      const a = await t.node();
      const b = await t.node();
      await t.createSession(a);
      await t.commitConcurrently(a, 10);
      const base = (await t.items(a)).items.length;

      const onA = t.observe(a);
      await onA.until("the history on node A", (f) => f.length === base);
      const seen = onlyEvents(onA.close());

      await t.commitConcurrently(a, 10);
      const onB = t.observe(b, seen.at(-1)!.cursor);
      await t.commitConcurrently(b, 10);
      await t.commitConcurrently(a, 10);
      await onB.until("every event on node B", (f) => f.length === 30);
      expect(seqs(onlyEvents(onB.close()))).toEqual(range(base, base + 30));
      expect(seqs((await t.items(b)).items)).toEqual(range(0, base + 30));
    });

    it("pages history by cursor and filters by agent in the Runtime", async () => {
      const t = await setup();
      const a = await t.node();
      await t.createSession(a);
      const base = (await t.items(a)).items.length;
      const ctx = contextOf(a.handle);
      await ctx.store.tx(async (tx) => {
        for (let i = 0; i < 6; i += 1)
          await tx.event("s1", null, "test.tick", {
            i,
            ...(i % 2 === 0 ? { agent: { path: "helper", delegationId: `d${i}` } } : {}),
          });
      });
      await t.relayed(a);

      const all = await t.items(a);
      expect(seqs(all.items)).toEqual(range(0, base + 6));
      expect(all.cursor).toBe(encodeCursor("s1", base + 5));

      const page = await t.items(a, { cursor: all.items[base + 2]!.cursor });
      expect(page.items).toEqual(all.items.slice(base + 3));
      expect(page.cursor).toBe(all.cursor);

      const empty = await t.items(a, { cursor: all.cursor! });
      expect(empty).toEqual({ items: [], cursor: all.cursor });

      // The filter keeps matching events; the cursor is still the last event read.
      const helper = await t.items(a, { agent: "helper" });
      expect(helper.items.map((e) => (e.payload as { i: number }).i)).toEqual([0, 2, 4]);
      expect(helper.cursor).toBe(all.cursor);
      const delegated = await t.items(a, {
        agent: "d2",
        cursor: all.items[base]!.cursor,
      });
      expect(delegated.items.map((e) => (e.payload as { i: number }).i)).toEqual([2]);
      expect(delegated.cursor).toBe(all.cursor);

      expect((await t.history(a, { cursor: "bogus" })).status).toBe(400);
    });

    it("commits while streams are down, answers history 503, and delivers after the drain", async () => {
      const t = await setup();
      const a = await t.node();
      await t.createSession(a);
      const observer = t.observe(a);
      await t.command(a, {
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "one",
      });
      const completed = (n: number) => (f: unknown[]) =>
        onlyEvents(f).filter((e) => e.type === "turn.completed").length >= n;
      await observer.until("the first turn", completed(1));

      t.probe.down = true;
      const accepted = await t.command(a, {
        type: "message",
        requestId: "m2",
        idempotencyKey: "m2",
        content: "two",
      });
      // State commits without the streams: the turn runs to completion.
      await eventually("the second turn to settle", async () => {
        const response = await fetch(`${a.url}/v1/sessions/s1`, {
          headers: { authorization: `Bearer ${APP}` },
        });
        const view = (await response.json()) as { status: string };
        return !["running", "runnable"].includes(view.status) || undefined;
      });
      const outage = await t.history(a);
      expect(outage.status).toBe(503);
      expect(await outage.json()).toMatchObject({ code: "request_rejected" });

      t.probe.down = false;
      expect(await drainOutbox(contextOf(a.handle))).toBeGreaterThan(0);
      const recovered = await t.items(a);
      expect(seqs(recovered.items)).toEqual(range(0, recovered.items.length));
      expect(recovered.items.map((e) => e.cursor)).toContain(accepted.cursor);
      expect(recovered.items.filter((e) => e.type === "turn.completed")).toHaveLength(2);
      await observer.until(
        "every event",
        (f) => f.length >= recovered.items.length
      );
      expect(onlyEvents(observer.close())).toEqual(recovered.items);
      expect(await drainOutbox(contextOf(a.handle))).toBe(0);
    });

    it("wakes executors on another node through the work stream", async () => {
      const t = await setup();
      const toolCall: ModelProvider = async (effect) => {
        const call = effect.input as { prompt?: { kind?: string }[] };
        if (call.prompt?.at(-1)?.kind === "tool-result")
          return { output: [{ type: "text", text: "done" }] };
        return {
          output: [
            { type: "tool-call", id: "call-1", name: "save", args: { note: "hi" } },
          ],
        };
      };
      const a = await t.node({ executors: true, modelProvider: toolCall });
      const b = await t.node();
      const workBefore = await t.tailOf(WORK_STREAM);

      const executor = sse(`${b.url}/v1/executors/connect`, {
        authorization: `Bearer ${EXECUTOR}`,
      });
      await executor.until("the primer", (f) => f.length === 1);

      const agent = Agent({ id: "issue", name: "Issue" })
        .use({
          id: "notes",
          tools: [
            tool({
              name: "save",
              input: z.object({ note: z.string() }),
              output: z.object({ saved: z.literal(true) }),
              async run() {
                return { saved: true as const };
              },
            }),
          ],
        })
        .build();
      await t.createSession(a, "s1", agent.manifest);
      await t.command(a, {
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "save a note",
      });
      await executor.until("work_available from node A's commit", (f) => f.length >= 2);
      // The primer, then one frame per commit that signalled work.
      for (const frame of executor.close())
        expect(frame).toEqual({ type: "work_available" });
      expect(await t.tailOf(WORK_STREAM)).toBeGreaterThan(workBefore);

      const listed = await fetch(`${b.url}/v1/actions`, {
        headers: { authorization: `Bearer ${EXECUTOR}` },
      });
      expect(((await listed.json()) as { actions: unknown[] }).actions).toHaveLength(1);
    });

    it("ends observers on reset and restarts a re-created session's stream at 0", async () => {
      const t = await setup();
      const a = await t.node();
      await t.createSession(a);
      await t.commitConcurrently(a, 5);
      const observer = t.observe(a);
      await observer.until("the history", (f) => f.length === 5);

      const reset = await fetch(`${a.url}/v1/tenant/reset`, {
        method: "POST",
        headers: a.headers(),
        body: JSON.stringify({ requestId: "reset-1", scope: "sessions", activeWork: "cancel" }),
      });
      expect(reset.status).toBe(200);
      await eventually("the observer to end", () => observer.ended || undefined);
      expect(await t.tailOf(sessionStream("s1"))).toBe(0);

      await t.createSession(a);
      await t.commitConcurrently(a, 2);
      const fresh = await t.items(a);
      expect(seqs(fresh.items)).toEqual([0, 1]);
    });

    it("delivers a cancel to the node running the advance through the control stream", async () => {
      const t = await setup();
      let started!: () => void;
      const modelStarted = new Promise<void>((resolve) => (started = resolve));
      let aborted!: () => void;
      const modelAborted = new Promise<void>((resolve) => (aborted = resolve));
      const a = await t.node({
        modelProvider: (_effect, signal) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener("abort", () => {
              aborted();
              reject(new Error("aborted"));
            });
          }),
      });
      const b = await t.node();
      await t.createSession(a);
      await t.command(a, {
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "hang",
      });
      await modelStarted;
      await t.relayed(a);

      await t.command(b, {
        type: "cancel",
        requestId: "c1",
        idempotencyKey: "c1",
      });
      await Promise.race([
        modelAborted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("the advance on node A was not aborted")), 15_000)
        ),
      ]);
      expect(await t.records(CONTROL_STREAM)).toContainEqual({
        type: "session.cancel",
        sessionId: "s1",
      });
    });
  });
}
