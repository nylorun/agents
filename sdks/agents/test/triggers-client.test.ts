/**
 * The triggers capability's client calls (D83, Host feature `agent-triggers`):
 * `client.agents.deleteTrigger` and `client.runs.stream`; and `client.agents.putTrigger` (D88,
 * Host feature `api-triggers`).
 */
import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import type { TenantRun } from "@nylorun/core/contracts";
import { AgentsClient } from "../src/client.js";
import { RuntimeError } from "../src/http.js";

const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function fake(respond: (method: string, path: string, headers: Headers) => Response, features = HOST_PROTOCOL.features) {
  const sent: { method: string; path: string; search: string; headers: Headers }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL, features } });
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      sent.push({ method, path: String(input).slice(RUNTIME.length).split("?")[0]!, search: url.search, headers });
      return respond(method, url.pathname, headers);
    },
  });
  return { client, sent };
}

const run = (runId: string): TenantRun => ({
  runId,
  agentId: "users/ada/bot",
  triggerId: "daily",
  kind: "schedule",
  status: "started",
  reason: null,
  sessionId: "c1_t_daily",
  turnId: "t1",
  queuedMessageId: null,
  dueAt: "2026-11-02T09:00:00.000Z",
  firedAt: "2026-11-02T09:00:01.000Z",
  late: false,
  origin: "agent",
  title: "Daily",
});

const sse = (events: { cursor: string; run: TenantRun }[]) =>
  new Response(events.map((event) => `id: ${event.cursor}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("client.agents.putTrigger", () => {
  const daily = { schedule: "0 8 * * *", timezone: "Asia/Calcutta", session: "new", prompt: "Is the review due?", title: "Daily review" };

  it("puts the trigger by an Agent id with slashes and answers its view", async () => {
    const bodies: unknown[] = [];
    const sent: string[] = [];
    const client = new AgentsClient({
      url: RUNTIME,
      key: KEY,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
        sent.push(`${init?.method} ${String(input).slice(RUNTIME.length)}`);
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "daily", kind: "schedule", origin: "api", principal: "app_bot", status: "active" });
      },
    });
    const view = await client.agents.putTrigger("orgs/o/people/m/review", "daily", daily);
    expect(view).toMatchObject({ id: "daily", origin: "api", principal: "app_bot" });
    expect(sent).toEqual(["PUT /v1/agents/orgs%2Fo%2Fpeople%2Fm%2Freview/triggers/daily"]);
    expect(bodies).toEqual([daily]);
  });

  it("throws the Runtime's 409 for another origin's id", async () => {
    const { client } = fake(() => Response.json({ error: "taken", code: "trigger_conflict" }, { status: 409 }));
    const error = await client.agents.putTrigger("bot", "nightly", daily).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).status).toBe(409);
  });

  it("needs a Runtime with api-triggers", async () => {
    const { client, sent } = fake(() => Response.json({}), HOST_PROTOCOL.features.filter((feature) => feature !== "api-triggers"));
    await expect(client.agents.putTrigger("bot", "daily", daily)).rejects.toThrow(/api-triggers/);
    expect(sent).toEqual([]);
  });
});

describe("client.agents.deleteTrigger", () => {
  it("deletes an agent's trigger by an Agent id with slashes", async () => {
    const { client, sent } = fake(() => Response.json({ id: "daily" }));
    await expect(client.agents.deleteTrigger("users/ada/bot", "daily")).resolves.toBeUndefined();
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual(["DELETE /v1/agents/users%2Fada%2Fbot/triggers/daily"]);
  });

  it("throws the Runtime's 409 for a manifest's trigger", async () => {
    const { client } = fake(() =>
      Response.json({ error: "declared by the manifest", code: "trigger_from_manifest" }, { status: 409 }),
    );
    const error = await client.agents.deleteTrigger("bot", "nightly").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).status).toBe(409);
  });

  it("needs a Runtime with agent-triggers", async () => {
    const { client, sent } = fake(() => Response.json({}), HOST_PROTOCOL.features.filter((feature) => feature !== "agent-triggers"));
    await expect(client.agents.deleteTrigger("bot", "daily")).rejects.toThrow(/agent-triggers/);
    expect(sent).toEqual([]);
  });
});

describe("client.runs.stream", () => {
  it("yields each run with its cursor, and resumes from the cursor it is given", async () => {
    const controller = new AbortController();
    const { client, sent } = fake(() => sse([{ cursor: "c1", run: run("run_1") }, { cursor: "c2", run: run("run_2") }]));
    const seen: { cursor: string; run: TenantRun }[] = [];
    for await (const event of client.runs.stream({ cursor: "c0", signal: controller.signal })) {
      seen.push(event);
      if (seen.length === 2) controller.abort();
    }
    expect(seen).toEqual([
      { cursor: "c1", run: run("run_1") },
      { cursor: "c2", run: run("run_2") },
    ]);
    expect(sent[0]!.path).toBe("/v1/runs/stream");
    expect(sent[0]!.headers.get("last-event-id")).toBe("c0");
  });

  it("throws the Runtime's 410 for a cursor from before a reset", async () => {
    const { client } = fake(() => Response.json({ error: "expired", code: "cursor_expired" }, { status: 410 }));
    const read = async () => {
      for await (const _ of client.runs.stream({ cursor: "old" })) return;
    };
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).status).toBe(410);
  });
});
