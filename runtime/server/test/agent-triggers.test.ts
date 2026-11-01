/**
 * The triggers capability (D83): an agent whose version declares `harness.engine.triggers` lists,
 * creates and deletes its own triggers with the `triggers` tool, which the Runtime serves as a
 * `runtime` effect. Its rows are origin `agent`; they fire through the same door as a manifest's,
 * into the calling session (`this`) or one of their own (`<session>_t_<id>`). The Tenant's tool
 * policy covers the call (`kind: "runtime"`), people delete a row over the API, the limits come in
 * layers, and every run reaches the Tenant's runs stream.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { triggerTimerKey } from "../src/tenant/triggers.js";
import { runsCursor } from "../src/tenant/runs-stream.js";
import { triggersRefusal } from "../src/tenant/agent-triggers.js";
import type { Session } from "../src/tenant/context.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession, saveManifest, manifestOf } from "./support/agents.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "agent-triggers-app-key-aaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };

/** Each call's tool names and last user text; a message `call <json>` calls the triggers tool with it. */
const calls: { tools: string[]; last: string | undefined; system: string }[] = [];
const results: string[] = [];
const model: ModelProvider = async (effect) => {
  const input = effect.input as {
    tools?: { name: string }[];
    prompt?: { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
  };
  const prompt = input.prompt ?? [];
  const texts = (item: { content?: { type: string; text?: string }[] }) =>
    (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : []));
  const last = prompt.filter((item) => item.role === "user").flatMap(texts).at(-1);
  const system = prompt.filter((item) => item.kind === "instructions").flatMap(texts).join("");
  calls.push({ tools: (input.tools ?? []).map((tool) => tool.name), last, system });
  if (prompt.at(-1)?.kind === "tool-result") {
    results.push(JSON.stringify(prompt.at(-1)));
    return { output: [{ type: "text", text: "done" }] };
  }
  const call = last?.match(/^call (.*)$/s)?.[1];
  if (call) return { output: [{ type: "tool-call", id: `call-${calls.length}`, name: "triggers", args: JSON.parse(call) }] };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let n = 0;
const bot = Agent({ id: "router", name: "Router" }).instructions("Keep routines.").build();
const ENGINE = { triggers: true };

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  await deploy(runtime.url, headers, bot, { name: "router", runtime: { kind: "none" } as RuntimeSection, engine: ENGINE });
  await deploy(runtime.url, headers, bot, { name: "plain", id: "plain", runtime: { kind: "none" } as RuntimeSection, engine: {} });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
const get = async (path: string) => (await call("GET", path)).body;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const idle = (session: string) =>
  until(() => get(`/v1/sessions/${session}`), (v) => v.activeTurnId === null && v.queuedMessages === 0);

async function send(session: string, content: string): Promise<void> {
  n++;
  const response = await call("POST", `/v1/sessions/${session}/commands`, { type: "message", requestId: `r${n}`, idempotencyKey: `k${n}`, content });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  await idle(session);
}

/** Sends `call <input>` in `session` and answers what the tool returned to the model. */
async function tool(session: string, input: Record<string, unknown>): Promise<string> {
  const before = results.length;
  await send(session, `call ${JSON.stringify(input)}`);
  expect(results.length).toBe(before + 1);
  return results.at(-1)!;
}

async function open(id: string, agent = "router") {
  const opened = await openSession(runtime.url, headers, id, { agent, ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

const row = (agentId: string, triggerId: string) =>
  withTestSessionStore(runtime, (store) => store.tx((t) => t.agentTrigger(agentId, triggerId)));

/** Makes trigger `triggerId` due now and fires its timer. */
async function fire(agentId: string, triggerId: string) {
  const current = (await row(agentId, triggerId))!;
  await withTestSessionStore(runtime, (store) =>
    store.tx((t) => t.putAgentTrigger({ ...current, nextFireAt: new Date(Date.now() - 1_000).toISOString() })),
  );
  await runtime.handle.worker!.fire!(triggerTimerKey(agentId, triggerId));
}

const create = (fields: Record<string, unknown>) => ({ command: "create", prompt: "Check the build.", ...fields });

/** Reads `GET /v1/runs/stream` from `cursor` until `count` runs arrived or `ms` passed. */
async function streamed(cursor: string | undefined, count: number, ms = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const events: { cursor: string; run: Record<string, unknown> }[] = [];
  try {
    const response = await fetch(`${runtime.url}/v1/runs/stream${cursor ? `?cursor=${cursor}` : ""}`, {
      headers,
      signal: controller.signal,
    });
    if (response.status !== 200) return { status: response.status, body: await response.json(), events };
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (frame.includes("event: run") && data) events.push(JSON.parse(data.slice(6)));
      }
    }
    controller.abort();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, events };
}

describe("the triggers tool", () => {
  it("is offered, with its text, only when the session's version declares engine.triggers", async () => {
    await open("p1", "plain");
    await send("p1", "hello");
    expect(calls.at(-1)!.tools).not.toContain("triggers");
    await open("c1");
    await send("c1", "hello");
    expect(calls.at(-1)!.tools).toContain("triggers");
    expect(calls.at(-1)!.system).toContain("triggers tool");
  });

  it("refuses the effect when the version does not declare it (off means off)", async () => {
    // A model that names the tool anyway: our harness never offered it.
    const out = await tool("p1", create({ id: "x", in: "1h", session: "this" }));
    expect(out).toContain("tool.unknown");
    expect(await row("plain", "x")).toBeUndefined();
    // And the Runtime refuses the effect itself, whichever harness sends it.
    const refused = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => triggersRefusal(t, (await t.get<Session>("sessions", "p1"))!, {})),
    );
    expect(refused).toMatchObject({ kind: "failed", code: "tool.unavailable" });
    const subagent = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => triggersRefusal(t, (await t.get<Session>("sessions", "c1"))!, { agent: { id: "scout" } })),
    );
    expect(subagent).toMatchObject({ kind: "failed", code: "tool.forbidden" });
  });

  it("creates a follow-up in this session and one in its own, and lists them", async () => {
    const follow = await tool("c1", create({ id: "follow", title: "Follow up", in: "30m", session: "this" }));
    expect(follow).toContain('\\"session\\":\\"c1\\"');
    const followRow = (await row("router", "follow"))!;
    expect(followRow).toMatchObject({ origin: "agent", kind: "at", status: "active", title: "Follow up", createdSessionId: "c1", sessionId: "c1" });
    const ahead = Date.parse(followRow.nextFireAt!) - Date.now();
    expect(ahead).toBeGreaterThan(29 * 60_000);
    expect(ahead).toBeLessThanOrEqual(30 * 60_000);

    await tool("c1", create({ id: "daily", title: "Daily digest", schedule: "0 9 * * 1-5", timezone: "Europe/Berlin", session: "own", prompt: "Write the digest." }));
    expect(await row("router", "daily")).toMatchObject({ origin: "agent", kind: "schedule", sessionId: "c1_t_daily" });

    const listed = await tool("c1", { command: "list" });
    expect(listed).toContain("follow");
    expect(listed).toContain("c1_t_daily");
    expect(listed).toContain("Write the digest.");

    const events = (await get("/v1/agents/router/events")).events as { type: string; payload: any }[];
    expect(events.filter((event) => event.type === "agent.trigger_created").map((event) => event.payload.triggerId)).toEqual([
      "follow",
      "daily",
    ]);

    // The API lists them, with their origin; never a wake.
    const view = (await get("/v1/agents/router/triggers")).triggers as any[];
    expect(view.find((item) => item.id === "daily")).toMatchObject({
      origin: "agent",
      kind: "schedule",
      title: "Daily digest",
      createdSessionId: "c1",
      schedule: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      session: "c1_t_daily",
      prompt: "Write the digest.",
      status: "active",
    });
  });

  it("replaces the session's own trigger by id, and refuses another session's", async () => {
    const before = (await row("router", "daily"))!;
    await tool("c1", create({ id: "daily", title: "Digest", schedule: "0 10 * * 1-5", session: "own", prompt: "Write it." }));
    const after = (await row("router", "daily"))!;
    expect(after.generation).toBe(before.generation + 1);
    expect(after.definition).toMatchObject({ schedule: "0 10 * * 1-5", prompt: "Write it." });
    const events = (await get("/v1/agents/router/events")).events as { type: string; payload: any }[];
    expect(events.at(-1)).toMatchObject({ type: "agent.trigger_updated", payload: { triggerId: "daily" } });

    await open("c2");
    expect(await tool("c2", create({ id: "daily", in: "1h", session: "this" }))).toContain("tool.conflict");
    // c2 sees none of c1's triggers, and can't delete them.
    expect(await tool("c2", { command: "list" })).toContain('\\"triggers\\":[]');
    expect(await tool("c2", { command: "delete", id: "daily" })).toContain("tool.not-found");
  });

  it("refuses a cron that does not parse, a time in the past and a bad zone", async () => {
    expect(await tool("c1", create({ id: "fast", schedule: "61 * * * *", session: "this" }))).toContain("tool.invalid-input");
    expect(await tool("c1", create({ id: "past", at: "2020-01-01T00:00:00Z", session: "this" }))).toContain("is not in the future");
    expect(await tool("c1", create({ id: "zone", schedule: "0 9 * * *", timezone: "Mars/Olympus", session: "this" }))).toContain(
      "tool.invalid-input",
    );
    expect(await row("router", "fast")).toBeUndefined();
  });

  it("fires an own trigger into <session>_t_<id>, as a trigger's run, which can't create triggers", async () => {
    await tool(
      "c1",
      create({ id: "nest", in: "1h", session: "own", prompt: `call ${JSON.stringify(create({ id: "child", in: "1h", session: "this" }))}` }),
    );
    await fire("router", "nest");
    await idle("c1_t_nest");
    const session = await get("/v1/sessions/c1_t_nest");
    expect(session).toMatchObject({ id: "c1_t_nest", ownerUserId: "ada" });
    expect(results.at(-1)).toContain("A run can't create triggers");
    expect(await row("router", "child")).toBeUndefined();
    const [run] = (await get("/v1/agents/router/runs?triggerId=nest")).runs;
    expect(run).toMatchObject({ kind: "at", status: "started", sessionId: "c1_t_nest" });
    expect(await row("router", "nest")).toMatchObject({ status: "completed" });
    // The trigger's own session may list and delete it.
    expect(await tool("c1_t_nest", { command: "list" })).toContain("nest");
    expect(await tool("c1_t_nest", { command: "delete", id: "nest" })).toContain('\\"deleted\\":true');
    expect(await row("router", "nest")).toBeUndefined();
  });

  it("deletes the session's trigger with the tool", async () => {
    expect(await tool("c1", { command: "delete", id: "follow" })).toContain('\\"deleted\\":true');
    expect(await row("router", "follow")).toBeUndefined();
    const events = (await get("/v1/agents/router/events")).events as { type: string; payload: any }[];
    expect(events.at(-1)).toMatchObject({ type: "agent.trigger_deleted", payload: { triggerId: "follow", sessionId: "c1" } });
  });
});

describe("agent rows across versions", () => {
  it("keeps agent rows through an upgrade, pauses them while the version lacks engine.triggers, and resumes them", async () => {
    await deploy(runtime.url, headers, bot, { name: "mover", id: "mover", runtime: { kind: "none" } as RuntimeSection, engine: ENGINE });
    await open("m1", "mover");
    await tool("m1", create({ id: "keep", title: "Keep", in: "2h", session: "this" }));
    // A version without the capability: the Agent moves; the row stays.
    const without = manifestOf(bot, { name: "mover", runtime: { kind: "none" } as RuntimeSection, engine: {} });
    await saveManifest(runtime.url, headers, without);
    await until(() => get("/v1/agents/mover"), (v) => v.resolvedVersion === 2);
    expect(await row("mover", "keep")).toMatchObject({ origin: "agent", status: "active" });
    // Due while the version lacks it: not run, not deleted: paused.
    await fire("mover", "keep");
    expect(await row("mover", "keep")).toMatchObject({ status: "paused", pausedReason: "undeclared" });
    expect((await get("/v1/agents/mover/runs")).runs).toEqual([]);
    // A version that declares it again resumes it.
    await saveManifest(runtime.url, headers, manifestOf(bot, { name: "mover", runtime: { kind: "none" } as RuntimeSection, engine: ENGINE }));
    await until(() => row("mover", "keep"), (value) => value?.status !== "paused");
    expect(await row("mover", "keep")).toMatchObject({ status: "active", pausedReason: null });
  });
});

describe("the tool policy covers runtime tools", () => {
  it("holds a create an ask rule matches, with its input, and serves the approved call once", async () => {
    await deploy(runtime.url, headers, bot, { name: "asker", id: "asker", runtime: { kind: "none" } as RuntimeSection, engine: ENGINE });
    const policy = await fetch(`${runtime.url}/v1/tenant/tool-policy`, {
      method: "PUT",
      headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            effect: "ask",
            kind: "runtime",
            tool: "triggers",
            when: { command: { equals: "create" }, session: { equals: "own" } },
            reason: "A routine needs a person",
          },
        ],
      }),
    });
    expect(policy.status, await policy.clone().text()).toBe(200);
    await open("a1", "asker");
    // A follow-up asks nothing.
    await tool("a1", create({ id: "soon", in: "1h", session: "this" }));
    expect(await row("asker", "soon")).toBeDefined();

    n++;
    const input = create({ id: "weekly", title: "Weekly", schedule: "0 9 * * 1", session: "own" });
    const sent = await call("POST", "/v1/sessions/a1/commands", { type: "message", requestId: `r${n}`, idempotencyKey: `k${n}`, content: `call ${JSON.stringify(input)}` });
    expect(sent.status).toBe(200);
    await until(() => get("/v1/sessions/a1"), (v) => v.status === "paused");
    expect(await row("asker", "weekly")).toBeUndefined();
    const items = (await get("/v1/sessions/a1/items?limit=500")).items as { type: string; payload: any }[];
    const paused = items.filter((item) => item.type === "turn.paused").at(-1)!;
    const [held] = paused.payload.interactions;
    expect(held.interaction).toMatchObject({
      kind: "approval",
      reason: "A routine needs a person",
      tool: "triggers",
      metadata: { tool: "triggers", kind: "runtime", input },
    });
    const before = results.length;
    const approved = await call("POST", "/v1/sessions/a1/commands", {
      type: "approve",
      requestId: "ap1",
      idempotencyKey: "ap1",
      interactionId: held.interaction.id,
      approved: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await idle("a1");
    expect(results.length).toBe(before + 1);
    expect(results.at(-1)).toContain("a1_t_weekly");
    expect(await row("asker", "weekly")).toMatchObject({ origin: "agent", status: "active", sessionId: "a1_t_weekly" });
    const created = ((await get("/v1/agents/asker/events")).events as { type: string; payload: any }[]).filter(
      (event) => event.type === "agent.trigger_created" && event.payload.triggerId === "weekly",
    );
    expect(created).toHaveLength(1);
    const completed = ((await get("/v1/sessions/a1/items?limit=500")).items as { type: string; payload: any }[]).filter(
      (item) => item.type === "tool.completed",
    );
    expect(completed.at(-1)!.payload).toMatchObject({ status: "completed", policy: { decision: "ask" } });
    await fetch(`${runtime.url}/v1/tenant/tool-policy`, {
      method: "PUT",
      headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ rules: [] }),
    });
  });
});

describe("DELETE /v1/agents/{id}/triggers/{triggerId}", () => {
  it("deletes an agent's trigger, and refuses a manifest's with 409 trigger_from_manifest", async () => {
    await deploy(runtime.url, headers, bot, {
      name: "mixed",
      id: "mixed",
      runtime: { kind: "none", triggers: { nightly: { schedule: "0 2 * * *", session: "night", prompt: "Tidy up." } } } as RuntimeSection,
      engine: ENGINE,
    });
    await open("x1", "mixed");
    await tool("x1", create({ id: "mine", in: "1h", session: "this" }));
    const refused = await call("DELETE", "/v1/agents/mixed/triggers/nightly");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "trigger_from_manifest" });
    expect((await call("DELETE", "/v1/agents/mixed/triggers/nope")).status).toBe(404);
    const deleted = await call("DELETE", "/v1/agents/mixed/triggers/mine");
    expect(deleted).toEqual({ status: 200, body: { id: "mine" } });
    expect(await row("mixed", "mine")).toBeUndefined();
    const events = (await get("/v1/agents/mixed/events")).events as { type: string; payload: any }[];
    expect(events.at(-1)).toMatchObject({ type: "agent.trigger_deleted", payload: { triggerId: "mine" } });
  });

  it("pauses, resumes and runs an agent's trigger like a manifest's", async () => {
    await tool("x1", create({ id: "pausable", schedule: "0 9 * * *", session: "this" }));
    const paused = await call("POST", "/v1/agents/mixed/triggers/pausable/pause", {});
    expect(paused.body.triggers.find((item: any) => item.id === "pausable")).toMatchObject({ status: "paused", origin: "agent" });
    const resumed = await call("POST", "/v1/agents/mixed/triggers/pausable/resume", {});
    expect(resumed.body.triggers.find((item: any) => item.id === "pausable")).toMatchObject({ status: "active" });
    const ran = await call("POST", "/v1/agents/mixed/triggers/pausable/run", undefined, { "idempotency-key": "run-1" });
    expect(ran.body.run).toMatchObject({ triggerId: "pausable", status: "started", sessionId: "x1" });
    await idle("x1");
  });
});

describe("limits in layers", () => {
  it("refuses runtime.limits.triggers looser than the Tenant's", async () => {
    const response = await fetch(`${runtime.url}/v1/agent-manifests/loose`, {
      method: "PUT",
      headers,
      body: JSON.stringify(
        manifestOf(bot, {
          name: "loose",
          runtime: { kind: "none", limits: { triggers: { count: 1_000, minIntervalMs: 1_000, runsPerHour: 10_000 } } } as RuntimeSection,
          engine: ENGINE,
        }),
      ),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("limits.triggers.count");
    expect(text).toContain("limits.triggers.minIntervalMs");
    expect(text).toContain("limits.triggers.runsPerHour");
  });

  it("holds the agent to the manifest's own count and interval", async () => {
    await deploy(runtime.url, headers, bot, {
      name: "small",
      id: "small",
      runtime: { kind: "none", limits: { triggers: { count: 1, minIntervalMs: 900_000 } } } as RuntimeSection,
      engine: ENGINE,
    });
    await open("s1", "small");
    expect(await tool("s1", create({ id: "often", schedule: "*/5 * * * *", session: "this" }))).toContain("900000");
    await tool("s1", create({ id: "one", schedule: "*/15 * * * *", session: "this" }));
    expect(await row("small", "one")).toBeDefined();
    expect(await tool("s1", create({ id: "two", in: "1h", session: "this" }))).toContain(
      "This Agent has 1 triggers, the most it can have. Delete one to add another.",
    );
    // Replacing the one it has is no new trigger.
    expect(await tool("s1", create({ id: "one", in: "1h", session: "this" }))).toContain('\\"status\\":\\"active\\"');
  });
});

describe("the Tenant runs stream", () => {
  it("carries each run once, with its Agent, origin and title, from a cursor", async () => {
    const first = await streamed(undefined, 1_000, 1_000);
    expect(first.status).toBe(200);
    const seen = first.events.map((event) => event.run.runId);
    expect(new Set(seen).size).toBe(seen.length);
    const cursor = first.events.at(-1)?.cursor;
    await deploy(runtime.url, headers, bot, { name: "streamer", id: "streamer", runtime: { kind: "none" } as RuntimeSection, engine: ENGINE });
    await open("r1", "streamer");
    await tool("r1", create({ id: "ping", title: "Ping", in: "1h", session: "own" }));
    await fire("streamer", "ping");
    await idle("r1_t_ping");
    const next = await streamed(cursor, 1);
    expect(next.events.map((event) => event.run)).toEqual([
      expect.objectContaining({ agentId: "streamer", triggerId: "ping", kind: "at", status: "started", sessionId: "r1_t_ping", origin: "agent", title: "Ping" }),
    ]);
    const row = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => (await t.listTriggerRuns("streamer", { limit: 10 }))[0]),
    );
    expect(row!.streamedAt).not.toBeNull();
  });

  it("appends a run the commit's append missed from the sweep", async () => {
    const before = await streamed(undefined, 10_000, 1_000);
    const cursor = before.events.at(-1)?.cursor;
    const firedAt = new Date(Date.now() - 10_000).toISOString();
    await withTestSessionStore(runtime, (store) =>
      store.tx((t) =>
        t.insertTriggerRun({
          id: "run_missed",
          agentId: "streamer",
          triggerId: "ping",
          kind: "at",
          runKey: "manual:ping:missed",
          dueAt: firedAt,
          firedAt,
          late: false,
          status: "skipped",
          reason: "overlap",
          sessionId: null,
          turnId: null,
          queuedMessageId: null,
          origin: "agent",
          title: "Ping",
          streamedAt: null,
        }),
      ),
    );
    const after = await streamed(cursor, 1);
    expect(after.events.map((event) => event.run.runId)).toEqual(["run_missed"]);
    await until(
      () => withTestSessionStore(runtime, (store) => store.tx(async (t) => (await t.unstreamedTriggerRuns({ firedBefore: new Date().toISOString(), limit: 10 })).length)),
      (count) => count === 0,
    );
  });

  it("refuses a malformed cursor, and a cursor from before a reset with 410 cursor_expired", async () => {
    expect((await streamed("bm90LWEtY3Vyc29y", 1)).status).toBe(400);
    const before = await streamed(undefined, 10_000, 1_000);
    const old = before.events.at(-1)!.cursor;
    const reset = await fetch(`${runtime.url}/v1/tenant/reset`, {
      method: "POST",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ requestId: "reset-runs", scope: "sessions", activeWork: "cancel" }),
    });
    expect(reset.status).toBe(200);
    // The triggers sessions made went with the sessions; the manifest's stay.
    expect(await row("streamer", "ping")).toBeUndefined();
    expect(await row("mixed", "nightly")).toBeDefined();
    const stale = await streamed(old, 1);
    expect(stale.status).toBe(410);
    expect(stale.body).toMatchObject({ code: "cursor_expired" });
    const generation = await withTestSessionStore(runtime, (store) => store.tx(async (t) => (await t.basinGenerations()).current));
    expect(generation).toBeGreaterThan(0);
    // The new basin's stream starts at 0, and a cursor in it reads on.
    const run = await call("POST", "/v1/agents/mixed/triggers/nightly/run", undefined, { "idempotency-key": "after-reset" });
    expect(run.status).toBe(200);
    const fresh = await streamed(undefined, 1);
    expect(fresh.events.map((event) => event.run.runId)).toEqual([run.body.run.id]);
    expect(fresh.events[0]!.cursor).toBe(runsCursor(generation, 0));
  });
});
