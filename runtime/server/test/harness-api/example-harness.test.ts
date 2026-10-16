/**
 * The example harness (`examples/harness-minimal`, R4.8), written only against
 * `@nylorun/core/harness-api`, runs turns on a real Runtime beside ours: a custom harness runs
 * from its pod's image (protocol 16), so each pod Agent whose manifest names `minimal`
 * (`harness.id`) gets the example in its pod mode, which joins with the pod's join token and
 * connects over the Harness API's WebSocket with its host token, and says `hello` as `minimal`;
 * our harness (a harness service over a loopback WebSocket) stays connected. Sessions on those
 * Agents run on the example, the others on ours (R4.1). Its model
 * calls go through the Model Gate on the fixture model, metered there, and its bash calls are
 * journaled like ours. A harness built from the Harness API is held to what ours is: one run per
 * turn, effect ids keyed by turn and segment, cancels within 2 s, a restart that replays its
 * outcomes and never runs a command twice, nothing run for a tool the turn does not offer, no
 * retry of a budget refusal, and none of the Runtime's tokens in the record.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startHarnessListener } from "../../src/harness-api/ws-server.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { connect, serve } from "../../../../examples/harness-minimal/src/harness.js";
import { podHost } from "../../../../examples/harness-minimal/src/pod.js";
import { boot, server, until, type Started } from "../host/execution-support.js";
import { deploy } from "../support/agents.js";
import { fakeSandboxes } from "../support/fake-sandboxes.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/**
 * The example in its pod mode, as the host of pod `sandboxId`: it joins with the pod's join
 * token and connects with its host token until stopped; `restart` drops its connection and
 * connects again.
 */
function runExample(url: string, gatesUrl: string, pod: ReturnType<typeof podHost>) {
  let current: { stop(): Promise<void> } | undefined;
  const start = async () => {
    const channel = await connect(url, await pod.token());
    const stopping = new AbortController();
    const served = serve(channel, { name: "minimal", gatesUrl, signal: stopping.signal });
    current = {
      async stop() {
        stopping.abort();
        channel.close("stopped");
        await served.catch(() => undefined);
      },
    };
  };
  return {
    start,
    async restart() {
      // As a killed container: the connection goes with its run in hand, then a new one comes.
      await current?.stop();
      await start();
    },
    stop: async () => {
      await current?.stop();
      pod.stop();
    },
    /** The host token it connects with. */
    token: () => pod.token(),
  };
}

const agent = Agent({ id: "bot", name: "Bot" }).instructions("Answer briefly.").build();

/** The pod Agents the example runs, each from its own manifest naming `minimal`. */
const PODS = ["text", "box"] as const;
type Examples = Record<(typeof PODS)[number], ReturnType<typeof runExample>>;

/**
 * A Runtime with a gates service on 127.0.0.1, its fixture model on, sandbox pods on an
 * in-memory sandboxes service, our harness connected over a loopback WebSocket, Agent `bot` (on
 * ours), and pod Agents `text` and `box` (on `minimal`), each with the example as its pod's host.
 */
async function start(): Promise<Started & { examples: Examples; tokens: () => Promise<string[]> }> {
  // The gates service, and the run tokens the gate requires.
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
  const fake = fakeSandboxes();
  const runtime = await boot({ harness: "ws", pods: { client: fake, harnessImage: "nylorun-runtime:test" } });
  cleanups.push(() => runtime.close());
  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    attach: async () => (channel, peer) => runtime.handle.attachHarness!(channel, peer),
    harnessOfToken: (bearer) => runtime.handle.harnessOfToken!(bearer),
    hosts: async () => runtime.handle.hostAuthority?.(),
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => listener.close());
  const seeded = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
  });
  expect(seeded.status).toBe(200);

  await deploy(runtime.url, server, agent);
  const root = await mkdtemp(join(tmpdir(), "nylorun-example-pods-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const examples = {} as Examples;
  for (const id of PODS) {
    const made = await deploy(runtime.url, server, agent, {
      id,
      name: id,
      harness: "minimal",
      runtime: { kind: "pod", image: "harness-minimal:dev" },
    });
    // The fake runs the pod at once; the example is its entrypoint, with the pod's join token.
    const name = podName(runtime.tenantId, id, made.compute.pod!.volumeGeneration);
    const podUid = await until(async () => fake.podUid(name), (uid) => uid !== undefined, `the pod of ${id}`);
    const joinFile = join(root, `${id}.join`);
    await writeFile(joinFile, fake.joinToken(name)!);
    const pod = podHost({
      sandboxId: id,
      podUid: podUid!,
      joinFile,
      harnessUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""),
      root: join(root, id),
    });
    examples[id] = runExample(listener.url, runtime.gate!.url, pod);
    await examples[id].start();
    cleanups.push(() => examples[id].stop());
  }
  return Object.assign(runtime, {
    examples,
    tokens: () => Promise.all(PODS.map((id) => examples[id].token())),
  });
}

async function api(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

type Item = {
  type: string;
  seq: number;
  turnId?: string;
  runId?: string;
  payload: any;
  source?: { kind: string; id?: string };
  evidence?: string;
};
type Call = { effectId: string; toolName?: string; status?: string; error?: { code: string } };

/** Sends `content` and waits for the turn's end. */
async function say(runtime: Started, session: string, content: string, n: number): Promise<Item[]> {
  await api(runtime, "POST", `/v1/sessions/${session}/commands`, {
    type: "message",
    requestId: `m-${session}-${n}`,
    idempotencyKey: `m-${session}-${n}`,
    content,
  });
  return until(
    async () => (await api(runtime, "GET", `/v1/sessions/${session}/items`)).body.items as Item[],
    (list) => list.filter((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type)).length >= n,
    `turn ${n} of ${session}`,
    30_000
  );
}

/** Opens session `id` on Agent `on`: `bot` runs on ours, `text` and `box` on the example. */
const open = async (runtime: Started, id: string, on: "bot" | (typeof PODS)[number] = "bot") =>
  expect((await api(runtime, "PUT", `/v1/sessions/${id}`, { requestId: `s-${id}`, agent: on, ownerUserId: "u" })).status).toBe(
    200
  );

it("completes fixture turns on the example beside ours, each harness serving its own sessions", async () => {
  const runtime = await start();
  await open(runtime, "s1", "text");
  await open(runtime, "ours");
  expect((await api(runtime, "GET", "/v1/sessions/s1")).body.harness).toBe("minimal");
  expect((await api(runtime, "GET", "/v1/sessions/ours")).body.harness).toBe("nylorun");

  const first = await say(runtime, "s1", "fixture:text", 1);
  expect(first.find((item) => item.type === "turn.completed")?.payload).toMatchObject({
    output: "fixture ok",
    agentId: "text",
    totals: { steps: 1 },
  });
  const assistant = first.find((item) => item.type === "message.assistant");
  expect(assistant?.payload).toMatchObject({ text: "fixture ok" });
  // The example wrote it: the log says so (R4.9).
  expect(assistant).toMatchObject({ source: { kind: "harness", id: "minimal" }, evidence: "claimed" });
  const calls = (await api(runtime, "GET", "/v1/sessions/s1/calls/model")).body.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ provider: "fixture", usage: { costUsd: 0 } });

  // Our harness serves the session pinned to it, at the same time.
  const ours = await say(runtime, "ours", "fixture:text", 1);
  expect(ours.find((item) => item.type === "message.assistant")).toMatchObject({
    payload: { text: "fixture ok" },
    source: { kind: "harness", id: "nylorun" },
  });

  // A second turn reads the first one back from the transcript: its prompt is longer.
  const second = await say(runtime, "s1", "fixture:text", 2);
  expect(second.filter((item) => item.type === "turn.completed")).toHaveLength(2);
  const both = (await api(runtime, "GET", "/v1/sessions/s1/calls/model")).body.calls as {
    usage: { inputTokens: number };
  }[];
  expect(both).toHaveLength(2);
  const [shorter, longer] = both.map((call) => call.usage.inputTokens).sort((a, b) => a - b);
  expect(longer).toBeGreaterThan(shorter! + 5);
  expect((await api(runtime, "GET", "/v1/sessions/s1")).body.status).toBe("completed");
}, 90_000);

it("runs bash for a session on a pod Agent, journaled and reported like ours", async () => {
  const runtime = await start();
  await open(runtime, "s2", "box");

  const items = await say(runtime, "s2", 'fixture:tool bash {"command":"echo hi"}', 1);
  expect(items.find((item) => item.type === "tool.completed")).toMatchObject({
    payload: { toolName: "bash", output: { exitCode: 0, stdout: "hi\n" } },
    source: { kind: "harness", id: "minimal" },
  });
  const done = items.find((item) => item.type === "turn.completed");
  expect(done?.payload.output).toMatch(/^fixture tool completed: .*hi/);
  const calls = (await api(runtime, "GET", "/v1/sessions/s2/calls/model")).body.calls;
  expect(calls.map((call: { provider: string }) => call.provider)).toEqual(["fixture", "fixture"]);
}, 90_000);

const TERMINAL = /^turn\.(completed|failed|cancelled)$/;
const items = async (runtime: Started, session: string) =>
  (await api(runtime, "GET", `/v1/sessions/${session}/items`)).body.items as Item[];
const calls = async (runtime: Started, session: string, kind: "model" | "tool", turnId?: string) =>
  (await api(runtime, "GET", `/v1/sessions/${session}/calls/${kind}${turnId ? `?turnId=${turnId}` : ""}`)).body.calls as Call[];
const tool = (name: string, args: Record<string, unknown>) => `fixture:tool ${name} ${JSON.stringify(args)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `content` without waiting: the turn's id. */
async function send(runtime: Started, session: string, content: string): Promise<string> {
  const requestId = randomUUID();
  await api(runtime, "POST", `/v1/sessions/${session}/commands`, { type: "message", requestId, idempotencyKey: requestId, content });
  const list = await until(
    () => items(runtime, session),
    (all) => all.some((item) => item.type === "command.message" && item.payload?.requestId === requestId),
    "the message's turn"
  );
  return list.find((item) => item.type === "command.message" && item.payload?.requestId === requestId)!.turnId!;
}

/** Waits for turn `turnId` to end: its events. */
const ended = async (runtime: Started, session: string, turnId: string, timeoutMs = 30_000) =>
  (
    await until(
      () => items(runtime, session),
      (all) => all.some((item) => item.turnId === turnId && TERMINAL.test(item.type)),
      `the end of turn ${turnId}`,
      timeoutMs
    )
  ).filter((item) => item.turnId === turnId);

const terminal = (events: Item[]) => events.find((item) => TERMINAL.test(item.type));

async function cancel(runtime: Started, session: string): Promise<number> {
  const requestId = randomUUID();
  await api(runtime, "POST", `/v1/sessions/${session}/commands`, { type: "cancel", requestId, idempotencyKey: requestId });
  return Date.now();
}

it("reports each turn under one run, and keys every effect by its turn and segment", async () => {
  const runtime = await start();
  await open(runtime, "t", "text");
  await open(runtime, "b", "box");
  const turns = [
    ["t", await send(runtime, "t", "fixture:text")],
    ["b", await send(runtime, "b", tool("bash", { command: "echo hi" }))],
  ] as const;
  for (const [session, turnId] of turns) {
    const reported = (await ended(runtime, session, turnId)).filter((item) => item.source?.kind === "harness");
    expect(reported.length).toBeGreaterThan(0);
    expect(new Set(reported.map((item) => item.runId)).size, turnId).toBe(1);
    expect(reported[0]!.runId).toBeTruthy();
    const effects = [...(await calls(runtime, session, "model", turnId)), ...(await calls(runtime, session, "tool", turnId))];
    expect(effects.length).toBeGreaterThan(0);
    const prefix = new RegExp(`^${turnId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+:.`);
    for (const { effectId } of effects) expect(effectId).toMatch(prefix);
  }
}, 90_000);

it("runs nothing for a tool the turn does not offer, and ends a budget refusal without a retry", async () => {
  const runtime = await start();
  await open(runtime, "u", "box");
  await open(runtime, "money", "text");

  const unoffered = "nylorun_fixture_unoffered";
  const turnId = await send(runtime, "u", `fixture:unoffered ${unoffered} ${JSON.stringify({ command: "echo should-not-run" })}`);
  const events = await ended(runtime, "u", turnId);
  const end = terminal(events);
  expect(end?.type).toBe("turn.completed");
  expect(String(end?.payload.output)).toMatch(/^fixture tool failed/);
  expect(events.filter((item) => item.type === "environment.exec")).toEqual([]);
  expect(
    events.filter((item) => item.type === "tool.completed" && item.payload?.toolName === unoffered && item.payload?.status === "completed")
  ).toEqual([]);
  expect(
    (await calls(runtime, "u", "tool", turnId)).filter((row) => row.toolName === unoffered && row.status === "completed" && !row.error)
  ).toEqual([]);

  const budget = await send(runtime, "money", "fixture:budget");
  await ended(runtime, "money", budget);
  await sleep(1_000); // A retry would come after the end.
  const refused = (await items(runtime, "money")).filter((item) => item.turnId === budget);
  expect(terminal(refused)).toMatchObject({ type: "turn.failed", payload: { error: { code: "model.budget_exhausted" } } });
  expect(refused.filter((item) => item.type === "model.failed")).toHaveLength(1);
  expect(refused.filter((item) => item.type === "message.assistant")).toEqual([]);
  expect((await calls(runtime, "money", "model", budget)).length).toBeLessThanOrEqual(1);
}, 90_000);

it("cancels a turn within 2 s during a model call and during a command", async () => {
  const runtime = await start();
  await open(runtime, "quiet", "text");
  await open(runtime, "busy", "box");

  // During a model call: the fixture model answers after 5 s, unless the call is cancelled.
  const sent = Date.now();
  const modelTurn = await send(runtime, "quiet", "fixture:slow 5");
  await until(async () => (await api(runtime, "GET", "/v1/sessions/quiet")).body.status, (status) => status === "running", "the turn to run");
  await sleep(1_000);
  const modelAt = await cancel(runtime, "quiet");
  const model = await ended(runtime, "quiet", modelTurn, 10_000);
  expect(Date.now() - modelAt).toBeLessThanOrEqual(2_000);
  expect(terminal(model)?.type).toBe("turn.cancelled");
  // Past the 5 s the call would have taken, it is still not metered: the gate cancelled it.
  await sleep(Math.max(0, sent + 6_500 - Date.now()));
  expect(await calls(runtime, "quiet", "model", modelTurn)).toEqual([]);

  // During a command.
  const commandTurn = await send(runtime, "busy", tool("bash", { command: "sleep 20" }));
  await until(() => calls(runtime, "busy", "tool", commandTurn), (rows) => rows.length > 0, "the command to start");
  await sleep(300);
  const commandAt = await cancel(runtime, "busy");
  const command = await ended(runtime, "busy", commandTurn, 10_000);
  expect(Date.now() - commandAt).toBeLessThanOrEqual(2_000);
  const end = terminal(command)!;
  expect(end.type).toBe("turn.cancelled");
  await sleep(500);
  const after = (await items(runtime, "busy")).filter(
    (item) => item.turnId === commandTurn && item.source?.kind === "harness" && item.seq > end.seq && item.type !== "environment.exec"
  );
  expect(after).toEqual([]);
  expect((await calls(runtime, "busy", "tool", commandTurn)).find((row) => row.toolName === "bash")?.status).toBe("cancelled");
}, 90_000);

it("replays a model outcome after a restart mid-command, and never settles the interrupted command as completed", async () => {
  const runtime = await start();
  await open(runtime, "r", "box");
  const marker = `restart-${randomUUID().slice(0, 8)}.marker`;
  const turnId = await send(runtime, "r", tool("bash", { command: `echo ran >> ${marker}; sleep 30` }));
  await until(() => calls(runtime, "r", "tool", turnId), (rows) => rows.length > 0, "the bash call to be journaled");
  await sleep(1_000);
  const before = await calls(runtime, "r", "model", turnId);
  expect(before.length).toBeGreaterThan(0);

  await runtime.examples.box.restart();
  await until(
    async () => {
      const all = await items(runtime, "r");
      return all.some((item) => item.turnId === turnId && TERMINAL.test(item.type))
        ? "ended"
        : (await api(runtime, "GET", "/v1/sessions/r")).body.status;
    },
    (state) => ["ended", "uncertain", "waiting", "paused"].includes(state),
    "the interrupted turn to settle",
    180_000
  );
  const events = (await items(runtime, "r")).filter((item) => item.turnId === turnId);
  expect(JSON.stringify(events)).not.toContain("effect_drift");
  const after = await calls(runtime, "r", "model", turnId);
  for (const call of before) expect(after.filter((row) => row.effectId === call.effectId), call.effectId).toHaveLength(1);
  expect(new Set(after.map((row) => row.effectId)).size).toBe(after.length);

  const rows = (await calls(runtime, "r", "tool", turnId)).filter((row) => row.toolName === "bash");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status === "uncertain" || rows[0]!.status === "invoking" || rows[0]!.error?.code === "tool.interrupted").toBe(true);

  // The command ran once: the marker has one line.
  const count = await ended(runtime, "r", await send(runtime, "r", tool("bash", { command: `wc -l < ${marker}` })));
  expect(String(count.find((item) => item.type === "tool.completed")?.payload.output.stdout).trim()).toBe("1");
}, 240_000);

it("keeps the Runtime's tokens out of the record when a command prints its environment", async () => {
  const runtime = await start();
  await open(runtime, "e", "box");
  await open(runtime, "t2", "text");
  await ended(runtime, "e", await send(runtime, "e", tool("bash", { command: "echo nylorun-env; env" })));
  await ended(runtime, "t2", await send(runtime, "t2", "fixture:text"));
  for (const session of ["e", "t2"]) {
    const record = JSON.stringify([
      await items(runtime, session),
      await calls(runtime, session, "model"),
      await calls(runtime, session, "tool"),
    ]);
    expect(record).toContain(session === "e" ? "nylorun-env" : "fixture ok");
    expect(record).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/);
    expect(record).not.toMatch(/NYLORUN_[A-Z_]*(?:TOKEN|SECRET|KEY)=[^\s"\\]{8,}/);
    for (const token of await runtime.tokens()) expect(record).not.toContain(token);
  }
}, 90_000);
