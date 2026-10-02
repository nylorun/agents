/**
 * Harness for the failure cases of architecture §17 on the real infrastructure (see `README.md`
 * for the case map). Every Tenant here keeps its state in the test stack's Postgres, runs its
 * advances through the test stack's Restate, and relays its events to the test stack's s2-lite:
 *
 *   npm run test:stack:up -w @nylorun/runtime
 *   NYLORUN_TEST_STACK=1 npm run test:integration -w @nylorun/runtime
 *
 * The files skip unless NYLORUN_TEST_STACK=1.
 *
 * - A **Worker** is one process's Restate execution (`createHostExecution`) serving the Worker
 *   endpoint on the host, advertised to Restate (in Docker) as `http://host.docker.internal:<port>`.
 *   Every Worker uses a service prefix unique to the run, so runs sharing one Restate server never
 *   take each other's invocations. Two Workers with the same offset and prefix are the same
 *   deployment restarted.
 * - A **node** is one process's view of the Tenant: its own Tenant runtime (own Postgres pool,
 *   own S2 client, own Worker id) over the shared Tenant schema and basin. A node opened with an
 *   `api` Worker never serves advances, like an API node.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { LiveEvent } from "@nylorun/core/contracts";
import {
  createRestateExecution,
  type RestateExecutionOptions,
} from "../../src/adapters/execution/restate.js";
import { createS2Streams } from "../../src/adapters/streams/s2.js";
import type { ModelProvider } from "../../src/core/provider.js";
import type {
  AdvanceResult,
  DurableExecution,
  WorkerHandlers,
} from "../../src/execution/types.js";
import { createHostExecution, type HostExecution } from "../../src/host/execution.js";
import type { RuntimeServices } from "../../src/host/stack-config.js";
import { decodeCursor } from "../../src/record/index.js";
import { sessionStream, type DurableStreams } from "../../src/streams/types.js";
import { basinOf } from "../../src/streams/basin.js";
import type { TenantContext } from "../../src/tenant/context.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import type { TenantWorker } from "../../src/tenant/worker.js";
import { stackEndpoints } from "../stack/endpoints.js";
import { dropTestTenant, openTestSessionStore } from "../support/store.js";
import { boot, server, until, type Started } from "../host/execution-support.js";

/** Worker ports for the failure files (9230–9249 by default); each file takes a range. */
const PORT_BASE = Number(process.env.NYLORUN_TEST_FAILURE_WORKER_PORT_BASE ?? 9230);
/** Where Restate (in Docker) reaches the host. */
const WORKER_HOST_NAME = process.env.NYLORUN_TEST_WORKER_HOST ?? "host.docker.internal";
const RUN = `f${randomUUID().replaceAll("-", "").slice(0, 10)}`;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function restateOptions(
  offset: number,
  prefix: string,
  extra: Partial<RestateExecutionOptions> = {}
): RestateExecutionOptions {
  const endpoints = stackEndpoints();
  const port = PORT_BASE + offset;
  return {
    ingressUrl: endpoints.restate.ingressUrl,
    adminUrl: endpoints.restate.adminUrl,
    // 0.0.0.0: on Linux, host-gateway reaches the host on the bridge address.
    workerListen: { host: "0.0.0.0", port },
    workerAdvertisedUrl: `http://${WORKER_HOST_NAME}:${port}`,
    servicePrefix: `${RUN}_${prefix}_`,
    sweepIntervalMs: 200,
    retry: { initialIntervalMs: 50, maxIntervalMs: 500 },
    registrationTimeoutMs: 30_000,
    logger: () => {},
    ...extra,
  };
}

/** A Restate execution that records every advance result its Worker returns. */
export type Recording = DurableExecution & { results: AdvanceResult[] };

function recording(inner: DurableExecution): Recording {
  const results: AdvanceResult[] = [];
  return {
    results,
    wake: (...args) => inner.wake(...args),
    deliver: (...args) => inner.deliver(...args),
    timer: (...args) => inner.timer(...args),
    armSweep: (tenantId) => inner.armSweep(tenantId),
    disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
    stop: () => inner.stop(),
    stuckInvocations: (tenantId) => inner.stuckInvocations!(tenantId),
    start: (handlers: WorkerHandlers) =>
      inner.start({
        ...handlers,
        advance: async (...args) => {
          const result = await handlers.advance(...args);
          results.push(result);
          return result;
        },
      }),
  };
}

export interface Worker {
  host: HostExecution;
  execution: Recording;
}

export interface NodeOptions {
  worker: Worker;
  workerId?: string;
  modelProvider?: ModelProvider;
  ownerLeaseMs?: number;
  /** Replaces the node's own S2 client (fault injection); the caller closes it. */
  streams?: DurableStreams;
}

export type Node = Started & { streams: DurableStreams };

/**
 * One failure case's Tenant on the real stack. `dispose` stops every Worker, closes every node,
 * deletes the basin and drops the schema.
 */
export class FailureTenant {
  readonly tenantId = newTenantId();
  private root?: string;
  private readonly workers: Worker[] = [];
  private readonly nodes: Node[] = [];
  private readonly clients: DurableStreams[] = [];
  private readonly cleanups: (() => Promise<void> | void)[] = [];
  private readonly finals: (() => Promise<void> | void)[] = [];

  /** A new S2 client on the test stack's s2-lite (or on `endpoint`, e.g. a proxy). */
  s2(endpoint = stackEndpoints().s2.endpoint): DurableStreams {
    const client = createS2Streams({ endpoint, basinPrefix: "fail-" });
    this.clients.push(client);
    return client;
  }

  /** A Worker (a process's Restate execution). Not started. */
  worker(input: {
    offset: number;
    prefix: string;
    services?: RuntimeServices;
    restate?: Partial<RestateExecutionOptions>;
    advanceGraceMs?: number;
    advanceDeadlineMs?: number;
    /** Wraps the Restate execution (fault injection). */
    wrap?: (execution: DurableExecution) => DurableExecution;
    resolve?: (tenantId: string) => Promise<TenantWorker | undefined>;
  }): Worker {
    const restate = createRestateExecution(
      restateOptions(input.offset, input.prefix, input.restate)
    );
    const execution = recording(input.wrap ? input.wrap(restate) : restate);
    const host = createHostExecution({
      execution,
      services: input.services ?? new Set(["core", "loop"] as const),
      resolve: input.resolve ?? (async () => undefined),
      ...(input.advanceGraceMs !== undefined ? { advanceGraceMs: input.advanceGraceMs } : {}),
      ...(input.advanceDeadlineMs !== undefined
        ? { advanceDeadlineMs: input.advanceDeadlineMs }
        : {}),
    });
    const worker = { host, execution };
    this.workers.push(worker);
    return worker;
  }

  /** Opens the Tenant on a new node. The first node creates the Tenant and the basin. */
  async node(options: NodeOptions): Promise<Node> {
    if (!this.root) {
      this.root = await mkdtemp(join(tmpdir(), "nylorun-failure-"));
      // The basin exists before the first node opens, as `createTenant` makes it.
      await this.s2().ensureTenant(this.tenantId);
    }
    const streams = options.streams ?? this.s2();
    const runtime = await boot({
      hostRoot: this.root,
      tenantId: this.tenantId,
      execution: options.worker.host.tenantExecution,
      streams,
      sweepIntervalMs: 200,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      ...(options.ownerLeaseMs !== undefined ? { ownerLeaseMs: options.ownerLeaseMs } : {}),
    });
    const node = Object.assign(runtime, { streams });
    this.nodes.push(node);
    return node;
  }

  /** Closes a node now (a process that stopped), keeping the Tenant's data. */
  async closeNode(node: Node): Promise<void> {
    const at = this.nodes.indexOf(node);
    if (at >= 0) this.nodes.splice(at, 1);
    await node.close();
  }

  /** Runs `fn` during `dispose`, before the Workers stop (e.g. releasing a blocked model). */
  onDispose(fn: () => Promise<void> | void): void {
    this.cleanups.push(fn);
  }

  /** Runs `fn` at the end of `dispose`, after every node closed (e.g. a proxy they used). */
  atEnd(fn: () => Promise<void> | void): void {
    this.finals.push(fn);
  }

  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0).reverse()) await cleanup();
    for (const worker of this.workers.splice(0).reverse())
      await worker.host.stop().catch(() => undefined);
    for (const node of this.nodes.splice(0).reverse()) await node.close().catch(() => undefined);
    const [first] = this.clients;
    if (first) await first.deleteTenant(this.tenantId).catch(() => undefined);
    for (const client of this.clients.splice(0)) await client.close().catch(() => undefined);
    if (this.root) {
      await rm(this.root, { recursive: true, force: true });
      await dropTestTenant(this.tenantId).catch(() => undefined);
    }
    for (const fn of this.finals.splice(0).reverse()) await fn();
  }
}

export const contextOf = (node: Started): TenantContext =>
  (node.handle as unknown as { ctx: TenantContext }).ctx;

export const workerOf = (node: Started): TenantWorker => (node.handle as TenantRuntime).worker;

/** The session's history through the Tenant API (read from S2). */
export async function items(node: Started, id = "s1"): Promise<LiveEvent[]> {
  const response = await fetch(`${node.url}/v1/sessions/${id}/items`, { headers: server });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: LiveEvent[] }).items;
}

export const seqsOf = (events: readonly LiveEvent[]) =>
  events.map((event) => decodeCursor(event.sessionId, event.cursor));

export const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

export const typesOf = (events: readonly LiveEvent[]) => events.map((event) => event.type);

export const countOf = (events: readonly LiveEvent[], type: string) =>
  events.filter((event) => event.type === type).length;

/**
 * Asserts the session's history is complete and exactly once everywhere: the S2 stream holds
 * the record's sequences `0..n-1` with no gap or duplicate, its tail is the session's log head,
 * and the Tenant API serves the same events. Returns the events.
 */
export async function completeHistory(node: Node, id = "s1"): Promise<LiveEvent[]> {
  const store = await openTestSessionStore(node);
  try {
    const basin = basinOf(
      node.tenantId,
      (await store.tx((t) => t.basinGenerations())).current
    );
    const stream = sessionStream(id);
    const headOf = async () =>
      (await store.record().heads(undefined, 10_000)).find((h) => h.sessionId === id)?.head ?? 0;
    // The relay appends after commit, retrying while S2 is down.
    await until(
      async () => ({ head: await headOf(), tail: await node.streams.tail(basin, stream) }),
      ({ head, tail }) => head > 0 && tail === head,
      `the stream of ${id} to reach the record's head`,
      30_000
    );
    const records: { seq: number; body: LiveEvent }[] = [];
    for await (const record of node.streams.read<LiveEvent>(basin, stream, 0, {
      follow: false,
    }))
      records.push(record);
    expect(records.map((record) => record.seq)).toEqual(range(0, records.length));
    expect(seqsOf(records.map((record) => record.body))).toEqual(range(0, records.length));
    expect(records.length).toBe(await headOf());
    const served = await items(node, id);
    // Internal events (transcript.updated) are in the stream but never served.
    expect(served).toEqual(
      records.map((record) => record.body).filter((event) => event.visibility !== "internal")
    );
    return served;
  } finally {
    await store.close();
  }
}

type TenantRef = { root: string; tenantId: string };

/** A session's effects, straight from Postgres. */
export async function effectsOf(node: TenantRef, id = "s1") {
  const store = await openTestSessionStore(node);
  try {
    return await store.tx((t) =>
      t.effectsForSession(id, { statuses: ["pending", "invoking", "uncertain", "completed"] })
    );
  } finally {
    await store.close();
  }
}

/** A session's row with its ownership columns, straight from Postgres. */
export async function sessionRow(node: TenantRef, id = "s1") {
  const store = await openTestSessionStore(node);
  try {
    return (await store.tx((t) => t.get("sessions", id))) as {
      status: string;
      owner: string | null;
      epoch: number;
      ownerExpiresAt?: string | null;
    };
  } finally {
    await store.close();
  }
}

export interface SseClient {
  /** Parsed `data:` frames, in arrival order. */
  readonly frames: LiveEvent[];
  until(what: string, done: (frames: LiveEvent[]) => boolean, timeoutMs?: number): Promise<void>;
  /** Disconnects and returns the frames received. */
  close(): LiveEvent[];
}

/** Session SSE on `node`, resuming after `lastEventId` when given. */
export function sse(node: Started, lastEventId?: string, id = "s1"): SseClient {
  const abort = new AbortController();
  const frames: LiveEvent[] = [];
  let failure: Error | undefined;
  void (async () => {
    const response = await fetch(`${node.url}/v1/sessions/${id}/events`, {
      headers: {
        authorization: server.authorization,
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
      signal: abort.signal,
    });
    if (response.status !== 200) throw new Error(`SSE answered ${response.status}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data && !abort.signal.aborted) frames.push(JSON.parse(data.slice(6)) as LiveEvent);
      }
    }
  })().catch((error: Error) => {
    if (!abort.signal.aborted) failure = error;
  });
  return {
    frames,
    async until(what, done, timeoutMs = 30_000) {
      await until(
        async () => {
          if (failure) throw failure;
          return done(frames);
        },
        (ok) => ok,
        what,
        timeoutMs
      );
    },
    close() {
      abort.abort();
      return [...frames];
    },
  };
}

/** Waits until a Worker has returned no advance result for `quietMs`. */
export async function quiet(worker: Worker, quietMs = 1000, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = worker.execution.results.length;
  let since = Date.now();
  for (;;) {
    await sleep(50);
    const now = worker.execution.results.length;
    if (now !== seen) {
      seen = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the Worker to go quiet");
  }
}

/**
 * A TCP proxy in front of a service on 127.0.0.1 (S2 here). `down()` drops every connection and
 * refuses new ones, like a service that is gone; `up()` serves again on the same port.
 */
export async function tcpProxy(targetPort: number): Promise<{
  endpoint: string;
  down(): Promise<void>;
  up(): Promise<void>;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;
  const listen = async () => {
    const next = createServer((client) => {
      const upstream = connect({ host: "127.0.0.1", port: targetPort });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(port, "127.0.0.1", () => {
        next.off("error", reject);
        resolve();
      });
    });
    port = (next.address() as { port: number }).port;
    server = next;
  };
  const down = async () => {
    const current = server;
    server = undefined;
    for (const socket of sockets) socket.destroy();
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  };
  await listen();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    down,
    up: async () => {
      if (!server) await listen();
    },
    close: down,
  };
}

/**
 * Throws Restate's state away: the test stack's `restate` container is recreated, so every
 * registered deployment, queued invocation, sweep chain and idempotency key is gone (the
 * container keeps its state in its own filesystem; there is no volume). Waits until the admin
 * API and the ingress answer again on the same ports.
 */
export async function wipeRestate(): Promise<void> {
  const compose = fileURLToPath(new URL("../stack/compose.yaml", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "-f",
        compose,
        "up",
        "--detach",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "restate",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`recreating restate failed (${code}): ${stderr}`))
    );
  });
  const { restate } = stackEndpoints();
  await until(
    async () => {
      try {
        const [admin, ingress] = await Promise.all([
          fetch(`${restate.adminUrl}/health`),
          fetch(`${restate.ingressUrl}/restate/health`),
        ]);
        return admin.ok && ingress.ok;
      } catch {
        return false;
      }
    },
    (ok) => ok,
    "Restate to answer after the wipe",
    120_000
  );
}
