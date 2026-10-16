/**
 * Triggers (track T4, D74): an agent manifest's `runtime.triggers` start the Agent's turns with
 * no client connected. Triggers start active with a new Agent; a fire records one run, keyed by
 * its due time, on the session the trigger names; a fire after downtime is late, never a backfill;
 * a schedule adds at most one queued message to a busy session; pause, resume and run by hand; the
 * Tenant's limits checked at save and at fire.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeLimits, RuntimeSection, Trigger } from "@nylorun/core/contracts";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { cronOf, jitterMs, nextFireAt, triggerIssues, triggerTimerKey } from "../src/tenant/triggers.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, manifestOf, writeManifest } from "./support/agents.js";
import { setLimits } from "./support/limits.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "triggers-app-key-aaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };

const prompts: string[] = [];
const held = new Map<string, () => void>();
const model: ModelProvider = async (effect, signal) => {
  const prompt = (effect.input as { prompt?: { role?: string; content?: { type: string; text?: string }[] }[] }).prompt ?? [];
  const last = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))
    .at(-1);
  prompts.push(last ?? "");
  const hold = last?.match(/^hold:(\w+)$/)?.[1];
  if (hold)
    await new Promise<void>((resolve, reject) => {
      held.set(hold, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { output: [{ type: "text", text: "ok" }] };
};

const bot = Agent({ id: "cron", name: "Cron" }).instructions("Do the work.").build();
const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
const runtimeWith = (triggers: Record<string, Trigger>): RuntimeSection => ({ kind: "none", triggers }) as RuntimeSection;

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  await deploy(runtime.url, headers, bot, {
    name: "cron",
    runtime: runtimeWith({
      tick: { schedule: "* * * * *", session: "inbox", prompt: "tick" },
      once: { at: inAnHour, session: "new", prompt: "once" },
    }),
  });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, extra: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, { method, headers: { ...headers, ...extra } });
  return { status: response.status, body: await response.json() };
}

const triggers = async (agent = "cron") => (await call("GET", `/v1/agents/${agent}/triggers`)).body.triggers as any[];
const runs = async (agent = "cron") => (await call("GET", `/v1/agents/${agent}/runs?limit=100`)).body.runs as any[];

/** Makes trigger `id` due `agoMs` ago, then fires its timer as the execution would. */
async function fireDue(agentId: string, triggerId: string, agoMs = 1_000): Promise<string> {
  const due = new Date(Date.now() - agoMs).toISOString();
  await withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      const row = (await t.agentTrigger(agentId, triggerId))!;
      await t.putAgentTrigger({ ...row, status: "active", pausedReason: null, nextFireAt: due });
    }),
  );
  await runtime.handle.worker!.fire!(triggerTimerKey(agentId, triggerId));
  return due;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const session = async (id: string) => (await call("GET", `/v1/sessions/${encodeURIComponent(id)}`)).body;
const idle = (id: string) => until(() => session(id), (v) => v.activeTurnId === null && v.queuedMessages === 0);

describe("an Agent's triggers", () => {
  it("start active with the Agent, each with its next run, and the Agent says when it wakes", async () => {
    const list = await triggers();
    expect(list.map((t) => [t.id, t.kind, t.status])).toEqual([
      ["once", "at", "active"],
      ["tick", "schedule", "active"],
    ]);
    const tick = list.find((t) => t.id === "tick");
    expect(tick).toMatchObject({ schedule: "* * * * *", timezone: "UTC", session: "inbox", lastRunAt: null });
    const next = Date.parse(tick.nextRunAt);
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 66_000);
    expect(list.find((t) => t.id === "once").nextRunAt).toBe(inAnHour);
    expect((await call("GET", "/v1/agents/cron")).body.nextWakeAt).toBe(tick.nextRunAt);
  });

  it("runs on the session it names, opened on the first run, and records one run per due time", async () => {
    const due = await fireDue("cron", "tick");
    const [run] = await runs();
    expect(run).toMatchObject({ triggerId: "tick", kind: "schedule", dueAt: due, late: false, status: "started", sessionId: "inbox" });
    expect(run.turnId).toEqual(expect.any(String));
    const opened = await session("inbox");
    expect(opened).toMatchObject({ agentId: "cron", ownerUserId: "installation" });
    await idle("inbox");
    expect(prompts.at(-1)).toBe("tick");
    // The same due time again is the same run.
    await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => {
        const row = (await t.agentTrigger("cron", "tick"))!;
        await t.putAgentTrigger({ ...row, nextFireAt: due });
      }),
    );
    await runtime.handle.worker!.fire!(triggerTimerKey("cron", "tick"));
    expect((await runs()).filter((r) => r.dueAt === due)).toHaveLength(1);
    const after = (await triggers()).find((t) => t.id === "tick");
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.now());
    expect(after.lastRunAt).toEqual(expect.any(String));
    const events = (await call("GET", "/v1/agents/cron/events?types=agent.run")).body.events;
    expect(events.at(-1).payload).toMatchObject({ runId: run.id, triggerId: "tick", status: "started" });
  });

  it("fires once, marked late, after downtime, and computes the next run from now", async () => {
    await fireDue("cron", "tick", 10 * 60_000);
    const [run] = await runs();
    expect(run).toMatchObject({ late: true, status: "started" });
    expect((await runs()).filter((r) => r.late)).toHaveLength(1);
    expect(Date.parse((await triggers()).find((t) => t.id === "tick").nextRunAt)).toBeGreaterThan(Date.now());
    await idle("inbox");
  });

  it("adds at most one queued run to a busy session, and skips later fires as overlap", async () => {
    const sent = await fetch(`${runtime.url}/v1/sessions/inbox/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: "busy", idempotencyKey: "busy", content: "hold:inbox" }),
    });
    expect(sent.status).toBe(200);
    await until(async () => held.has("inbox"), Boolean);
    await fireDue("cron", "tick", 2_000);
    await fireDue("cron", "tick", 1_000);
    const [second, first] = await runs();
    expect(first).toMatchObject({ status: "queued", sessionId: "inbox" });
    expect(first.queuedMessageId).toEqual(expect.any(String));
    expect(second).toMatchObject({ status: "skipped", reason: "overlap" });
    expect((await session("inbox")).queuedMessages).toBe(1);
    held.get("inbox")!();
    await idle("inbox");
    expect(prompts.at(-1)).toBe("tick");
  });

  it("pauses and resumes; a paused trigger does not fire", async () => {
    const paused = await call("POST", "/v1/agents/cron/triggers/tick/pause");
    expect(paused.body.triggers.find((t: any) => t.id === "tick")).toMatchObject({ status: "paused", pausedReason: "manual", nextRunAt: null });
    const before = (await runs()).length;
    await runtime.handle.worker!.fire!(triggerTimerKey("cron", "tick"));
    expect((await runs()).length).toBe(before);
    const resumed = await call("POST", "/v1/agents/cron/triggers/tick/resume");
    const tick = resumed.body.triggers.find((t: any) => t.id === "tick");
    expect(tick).toMatchObject({ status: "active", pausedReason: null });
    expect(Date.parse(tick.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it("runs by hand once per Idempotency-Key, on a new session per run for session new", async () => {
    const first = await call("POST", "/v1/agents/cron/triggers/once/run", { "idempotency-key": "now-1" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.run).toMatchObject({ triggerId: "once", status: "started", sessionId: `run-${first.body.run.id}` });
    const again = await call("POST", "/v1/agents/cron/triggers/once/run", { "idempotency-key": "now-1" });
    expect(again.body.run.id).toBe(first.body.run.id);
    expect((await call("POST", "/v1/agents/cron/triggers/once/run")).status).toBe(400);
    await idle(first.body.run.sessionId);
    expect(prompts.at(-1)).toBe("once");
  });

  it("completes an at trigger once it fires, and refuses to resume it once its time passed", async () => {
    await fireDue("cron", "once");
    expect((await triggers()).find((t) => t.id === "once")).toMatchObject({ status: "completed", nextRunAt: null });
    const resumed = await call("POST", "/v1/agents/cron/triggers/once/resume");
    expect(resumed).toMatchObject({ status: 409, body: { code: "trigger_expired" } });
  });

  it("skips runs past triggerRunsPerHour", async () => {
    await withTestSessionStore(runtime, (store) => setLimits(store, { triggerRunsPerHour: 1 }));
    try {
      const run = await call("POST", "/v1/agents/cron/triggers/tick/run", { "idempotency-key": "capped" });
      expect(run.body.run).toMatchObject({ status: "skipped", reason: "rate_limited" });
    } finally {
      await withTestSessionStore(runtime, (store) => setLimits(store, { triggerRunsPerHour: 60 }));
    }
  });

  it("fails a run whose named session belongs to another Agent", async () => {
    await deploy(runtime.url, headers, bot, {
      name: "other",
      id: "other",
      runtime: runtimeWith({ steal: { schedule: "0 * * * *", session: "inbox", prompt: "x" } }),
    });
    const run = await call("POST", "/v1/agents/other/triggers/steal/run", { "idempotency-key": "steal" });
    expect(run.body.run).toMatchObject({ status: "failed", reason: "session_conflict", sessionId: "inbox" });
  });

  it("go with their Agent", async () => {
    await deploy(runtime.url, headers, bot, { name: "gone", id: "gone", runtime: runtimeWith({ t: { schedule: "0 * * * *", session: "s", prompt: "x" } }) });
    expect(await triggers("gone")).toHaveLength(1);
    expect((await call("DELETE", "/v1/agents/gone")).status).toBe(200);
    expect((await call("GET", "/v1/agents/gone/triggers")).status).toBe(404);
    await runtime.handle.worker!.fire!(triggerTimerKey("gone", "t"));
  });

  it("merge by id when the Agent moves to a new version: added ones arrive paused, dropped ones go", async () => {
    await deploy(runtime.url, headers, bot, {
      name: "moves",
      id: "moves",
      runtime: runtimeWith({
        keep: { schedule: "0 * * * *", session: "s", prompt: "x" },
        drop: { schedule: "0 * * * *", session: "s", prompt: "x" },
      }),
    });
    const before = (await triggers("moves")).find((t) => t.id === "keep").nextRunAt;
    // A tracking Agent of kind none moves to a saved version at once (T3).
    const saved = await writeManifest(
      runtime.url,
      headers,
      manifestOf(bot, {
        name: "moves",
        runtime: runtimeWith({
          keep: { schedule: "30 * * * *", session: "s", prompt: "y" },
          added: { schedule: "0 * * * *", session: "s", prompt: "x" },
        }),
      }),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await until(() => triggers("moves"), (list) => list.some((t) => t.id === "added"));
    expect(after.map((t) => [t.id, t.status, t.pausedReason])).toEqual([
      ["added", "paused", "new"],
      ["keep", "active", null],
    ]);
    const keep = after.find((t) => t.id === "keep");
    expect(keep.schedule).toBe("30 * * * *");
    expect(keep.nextRunAt).not.toBe(before);
  });

  it("are re-armed by the sweep without error", async () => {
    await runtime.handle.worker!.sweep();
  });
});

describe("saving triggers", () => {
  const save = (name: string, triggers: Record<string, unknown>) =>
    writeManifest(runtime.url, headers, manifestOf(bot, { name, runtime: { kind: "none", triggers } as never }));

  it("refuses a bad cron or time zone, a past at, a webhook (not yet), and a schedule under triggerMinIntervalMs", async () => {
    expect((await save("bad-cron", { a: { schedule: "61 * * * *", session: "s", prompt: "x" } })).status).toBe(400);
    expect((await save("bad-zone", { a: { schedule: "0 * * * *", timezone: "Nowhere/X", session: "s", prompt: "x" } })).status).toBe(400);
    expect((await save("past", { a: { at: "2020-01-01T00:00:00Z", session: "s", prompt: "x" } })).status).toBe(400);
    expect((await save("two", { a: { at: inAnHour, schedule: "0 * * * *", session: "s", prompt: "x" } })).status).toBe(400);
    expect((await save("hook", { a: { webhook: "standard-webhooks", session: "s", prompt: "x" } })).status).toBe(400);
    await withTestSessionStore(runtime, (store) => setLimits(store, { triggerMinIntervalMs: 120_000 }));
    try {
      const fast = await save("fast", { a: { schedule: "* * * * *", session: "s", prompt: "x" } });
      expect(fast.status).toBe(400);
      expect(JSON.stringify(fast.body)).toContain("triggerMinIntervalMs");
    } finally {
      await withTestSessionStore(runtime, (store) => setLimits(store, { triggerMinIntervalMs: 60_000 }));
    }
  });

  it("refuses a limit under its floor", async () => {
    const put = await fetch(`${runtime.url}/v1/tenant/limits`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ limits: { triggerMinIntervalMs: 1_000 } }),
    });
    expect(put.status).toBe(400);
    expect(await put.text()).toContain("floor");
  });
});

describe("the schedule", () => {
  const limits: RuntimeLimits = { ...RUNTIME_LIMIT_DEFAULTS };

  it("keeps a fixed offset per trigger within triggerJitterPercent and triggerJitterMaxMs", () => {
    const a = jitterMs("agent", "a", 3_600_000, limits);
    expect(a).toBe(jitterMs("agent", "a", 3_600_000, limits));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(300_000);
    expect(jitterMs("agent", "a", 60_000, limits)).toBeLessThan(6_000);
    expect(jitterMs("agent", "a", 3_600_000, { ...limits, triggerJitterPercent: 0 })).toBe(0);
  });

  it("follows croner across daylight saving in America/New_York", () => {
    const spring = cronOf({ schedule: "30 2 * * *", timezone: "America/New_York" }).nextRuns(2, new Date("2027-03-13T12:00:00Z"));
    // 02:30 does not exist on 14 March: that day's run is at 03:30 EDT.
    expect(spring.map((d) => d.toISOString())).toEqual(["2027-03-14T07:30:00.000Z", "2027-03-15T06:30:00.000Z"]);
    const fall = cronOf({ schedule: "30 1 * * *", timezone: "America/New_York" }).nextRuns(2, new Date("2027-11-06T12:00:00Z"));
    // 01:30 happens twice on 7 November: it runs once, at the first.
    expect(fall.map((d) => d.toISOString())).toEqual(["2027-11-07T05:30:00.000Z", "2027-11-08T06:30:00.000Z"]);
  });

  it("finds the next run after a time, shifted by the trigger's offset", () => {
    const trigger: Trigger = { schedule: "0 * * * *", session: "s", prompt: "x" };
    const after = new Date("2027-01-01T10:30:00Z");
    const next = nextFireAt("agent", "hourly", trigger, after, limits)!;
    const offset = next.getTime() - Date.parse("2027-01-01T11:00:00Z");
    expect(offset).toBe(jitterMs("agent", "hourly", 3_600_000, limits));
    expect(nextFireAt("agent", "x", { at: "2027-01-01T00:00:00Z", session: "s", prompt: "x" }, after, limits)).toBeNull();
  });

  it("checks the count, the prompt and the gap at save", () => {
    const many = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`t${i}`, { schedule: "0 * * * *", session: "s", prompt: "x" } as Trigger]),
    );
    expect(triggerIssues(many, { ...limits, triggersPerAgent: 2 }).join(" ")).toContain("triggersPerAgent");
    expect(triggerIssues({ a: { schedule: "0 * * * *", session: "s", prompt: "xx" } }, { ...limits, triggerPromptChars: 1 }).join(" ")).toContain(
      "triggerPromptChars",
    );
    expect(triggerIssues(many, limits)).toEqual([]);
  });
});
