/**
 * Triggers a client puts on one Agent (D88): `PUT /v1/agents/{agentId}/triggers/{triggerId}`
 * creates or replaces the Agent's trigger of origin `api` in the `Trigger` shape a definition
 * uses. The same body again changes nothing; another origin's id is refused; the checks and the
 * shared `count` apply; `DELETE` removes it; a move to a new version leaves it; every change is on
 * the Agent's events; and it fires through the same door as a definition's trigger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection, Trigger } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { triggerTimerKey } from "../src/tenant/triggers.js";
import { changedFields, definitionOfPut } from "../src/tenant/api-triggers.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, manifestOf, writeManifest } from "./support/agents.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "api-triggers-app-key-aaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };

const prompts: string[] = [];
const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { role?: string; content?: { type: string; text?: string }[] }[] }).prompt ?? [];
  const last = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))
    .at(-1);
  prompts.push(last ?? "");
  return { output: [{ type: "text", text: "ok" }] };
};

const bot = Agent({ id: "reporter", name: "Reporter" }).instructions("Do the work.").build();
const runtimeWith = (triggers: Record<string, Trigger>, extra: Record<string, unknown> = {}): RuntimeSection =>
  ({ kind: "none", triggers, ...extra }) as RuntimeSection;
const declared = { "hourly-sync": { schedule: "0 * * * *", session: "new", prompt: "sync" } };

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model, holdTimers: true });
  await deploy(runtime.url, headers, bot, { name: "reporter", runtime: runtimeWith(declared) });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
const put = (agent: string, id: string, body: unknown) => call("PUT", `/v1/agents/${agent}/triggers/${id}`, body);
const triggers = async (agent: string) => (await call("GET", `/v1/agents/${agent}/triggers`)).body.triggers as any[];
const triggerEvents = async (agent: string) =>
  ((await call("GET", `/v1/agents/${agent}/events?types=agent.trigger_created,agent.trigger_updated,agent.trigger_deleted`)).body.events ??
    []) as any[];

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const weekly = { schedule: "0 9 * * 1", timezone: "Europe/Berlin", session: "new", prompt: "Write this week's report.", title: "Weekly report" };

describe("PUT /v1/agents/{agentId}/triggers/{triggerId}", () => {
  it("creates an api trigger, active, with its next time, the principal and an event", async () => {
    const made = await put("reporter", "weekly", weekly);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({
      id: "weekly",
      kind: "schedule",
      origin: "api",
      title: "Weekly report",
      createdSessionId: null,
      status: "active",
      schedule: "0 9 * * 1",
      timezone: "Europe/Berlin",
      session: "new",
      prompt: "Write this week's report.",
    });
    expect(typeof made.body.principal).toBe("string");
    // 09:00 in Berlin is 08:00 UTC in winter; the jitter only moves it later.
    const next = new Date(made.body.nextRunAt);
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(8);
    const list = await triggers("reporter");
    expect(list.map((t) => [t.id, t.origin])).toEqual(
      expect.arrayContaining([
        ["hourly-sync", "manifest"],
        ["weekly", "api"],
      ]),
    );
    const events = await triggerEvents("reporter");
    expect(events.at(-1)).toMatchObject({
      type: "agent.trigger_created",
      payload: { triggerId: "weekly", kind: "schedule", origin: "api", session: "new", schedule: "0 9 * * 1", timezone: "Europe/Berlin" },
    });
  });

  it("changes nothing and records nothing for the same body again", async () => {
    const before = (await triggerEvents("reporter")).length;
    const again = await put("reporter", "weekly", weekly);
    expect(again.status).toBe(200);
    expect(again.body.origin).toBe("api");
    expect((await triggerEvents("reporter")).length).toBe(before);
  });

  it("replaces it with a new time, records what changed, and keeps a paused one paused", async () => {
    const moved = await put("reporter", "weekly", { ...weekly, timezone: "Asia/Calcutta" });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.nextRunAt).getUTCHours()).toBe(3);
    expect((await triggerEvents("reporter")).at(-1)).toMatchObject({
      type: "agent.trigger_updated",
      payload: { triggerId: "weekly", origin: "api", changed: ["timezone"], timezone: "Asia/Calcutta" },
    });
    expect((await call("POST", "/v1/agents/reporter/triggers/weekly/pause")).status).toBe(200);
    const paused = await put("reporter", "weekly", { ...weekly, schedule: "0 7 * * 1", timezone: "Asia/Calcutta" });
    expect(paused.body).toMatchObject({ status: "paused", schedule: "0 7 * * 1", nextRunAt: null });
    expect((await call("POST", "/v1/agents/reporter/triggers/weekly/resume")).status).toBe(200);
    const resumed = (await triggers("reporter")).find((t) => t.id === "weekly");
    expect(resumed.status).toBe("active");
    expect(new Date(resumed.nextRunAt).getUTCHours()).toBe(1);
  });

  it("refuses the id of the definition's trigger, and a body that isn't a trigger", async () => {
    const taken = await put("reporter", "hourly-sync", weekly);
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: "trigger_conflict" });
    expect((await put("reporter", "two", { schedule: "0 9 * * *", at: "2099-01-01T00:00:00Z", session: "new", prompt: "x" })).status).toBe(400);
    expect((await put("reporter", "zone", { schedule: "0 9 * * *", timezone: "Mars/Olympus", session: "new", prompt: "x" })).status).toBe(400);
    expect((await put("reporter", "past", { at: "2020-01-01T00:00:00Z", session: "new", prompt: "x" })).status).toBe(400);
    const badId = await put("reporter", "bad id!", weekly);
    expect(badId.status, JSON.stringify(badId.body)).toBe(400);
    expect((await put("nobody", "weekly", weekly)).status).toBe(404);
  });

  it("makes a webhook trigger with its endpoint, kept across a replace", async () => {
    const hook = await put("reporter", "acct-77", { webhook: "standard-webhooks", session: "s_acct_77", prompt: "A payment event." });
    expect(hook.status, JSON.stringify(hook.body)).toBe(200);
    expect(hook.body).toMatchObject({ kind: "webhook", status: "active", secretSet: false });
    expect(hook.body.webhookUrl).toMatch(/\/v1\/webhooks\/wh_/);
    const again = await put("reporter", "acct-77", { webhook: "standard-webhooks", session: "s_acct_77", prompt: "A payment event. Reconcile it." });
    expect(again.body.webhookUrl).toBe(hook.body.webhookUrl);
  });

  it("counts api and agent-made triggers against limits.triggers.count", async () => {
    await deploy(runtime.url, headers, bot, {
      name: "tight",
      id: "tight",
      runtime: runtimeWith({}, { limits: { triggers: { count: 1 } } }),
    });
    expect((await put("tight", "one", weekly)).status).toBe(200);
    const two = await put("tight", "two", weekly);
    expect(two.status).toBe(422);
    expect(two.body).toMatchObject({ code: "trigger_limit" });
    // Replacing the one it has is not a new trigger.
    expect((await put("tight", "one", { ...weekly, title: "Renamed" })).status).toBe(200);
  });

  it("fires through the same door as a definition's trigger", async () => {
    await put("reporter", "soon", { schedule: "0 * * * *", session: "soon-session", prompt: "api says hello" });
    await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => {
        const row = (await t.agentTrigger("reporter", "soon"))!;
        await t.putAgentTrigger({ ...row, nextFireAt: new Date(Date.now() - 1_000).toISOString() });
      }),
    );
    await runtime.handle.worker!.fire!(triggerTimerKey("reporter", "soon"));
    await until(
      async () => prompts,
      (seen) => seen.some((text) => text.includes("api says hello")),
    );
    const runs = (await call("GET", "/v1/agents/reporter/runs?limit=100")).body.runs as any[];
    expect(runs.find((run) => run.triggerId === "soon")).toMatchObject({ status: "started", sessionId: "soon-session" });
  });

  it("stays when the Agent moves to a new version", async () => {
    const saved = await writeManifest(
      runtime.url,
      headers,
      manifestOf(bot, { name: "reporter", runtime: runtimeWith({ "hourly-sync": { schedule: "30 * * * *", session: "new", prompt: "sync" } }) }),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await until(
      () => triggers("reporter"),
      (list) => list.find((t) => t.id === "hourly-sync")?.schedule === "30 * * * *",
    );
    expect(after.find((t) => t.id === "weekly")).toMatchObject({ origin: "api", schedule: "0 7 * * 1" });
  });

  it("is deleted over the API, with its origin on the event", async () => {
    const gone = await call("DELETE", "/v1/agents/reporter/triggers/weekly");
    expect(gone.status).toBe(200);
    expect((await triggers("reporter")).some((t) => t.id === "weekly")).toBe(false);
    expect((await triggerEvents("reporter")).at(-1)).toMatchObject({
      type: "agent.trigger_deleted",
      payload: { triggerId: "weekly", origin: "api" },
    });
    expect((await call("DELETE", "/v1/agents/reporter/triggers/hourly-sync")).body).toMatchObject({ code: "trigger_from_manifest" });
  });
});

describe("the put body", () => {
  it("keeps only the definition's fields, and names what changed", () => {
    const definition = definitionOfPut({ ...weekly });
    expect(definition).toEqual({ schedule: "0 9 * * 1", timezone: "Europe/Berlin", session: "new", prompt: "Write this week's report." });
    expect(changedFields(definition, { ...definition, timezone: "UTC" }, "a", "a")).toEqual(["timezone"]);
    expect(changedFields(definition, definition, "a", "b")).toEqual(["title"]);
    expect(changedFields(definition, definition, null, null)).toEqual([]);
  });
});
