/**
 * Sharing an Environment (protocol 11): sessions that name one Environment share its sandbox's
 * workspace, keyed by the Environment's id, and run their turns at the same time (D66), a flow
 * tree's sessions and other sessions alike.
 * `{ session }` sharing is gone: the Environment is what sessions share.
 */
import { afterEach, expect, it } from "vitest";
import { Agent, createClient } from "@nylorun/agents";
import {
  sandboxWorkspaceOf,
  sessionHasSandbox,
  sessionSandboxSpec,
  type SessionSandboxRef,
} from "../src/sandbox/share.js";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const agentManifest = () => ({ manifestSchemaVersion: 7 as const, id: "bot", name: "Bot" });

it("keys a session's workspace by its Environment, and its events by the session", () => {
  const spec = { network: { preset: "none" as const }, idle: "15m" };
  const sessions: SessionSandboxRef[] = [
    { id: "a", ownerUserId: "ada", manifest: agentManifest(), environmentId: "team/ws", sandbox: spec },
    { id: "b", ownerUserId: "bob", manifest: agentManifest(), environmentId: "team/ws", sandbox: spec },
  ];
  expect(sessions.map((session) => sandboxWorkspaceOf(session))).toEqual([
    { ownerId: "a", environmentId: "team/ws" },
    { ownerId: "b", environmentId: "team/ws" },
  ]);
  expect(sessionSandboxSpec(sessions[0]!)).toEqual(spec);
  expect(sessionHasSandbox(sessions[0]!)).toBe(true);
  // No Environment, or one of kind none: no sandbox.
  const bare: SessionSandboxRef = { id: "c", ownerUserId: "ada", manifest: agentManifest() };
  expect(sandboxWorkspaceOf(bare)).toEqual({ ownerId: "c" });
  expect(sessionHasSandbox(bare)).toBe(false);
  const none: SessionSandboxRef = { ...bare, environmentId: "plain/ws" };
  expect(sessionHasSandbox(none)).toBe(false);
  // The spec is the one the session pinned at open (protocol 15): its manifest holds none.
  expect(sessionSandboxSpec(bare)).toBeUndefined();
});

const APP = "environment-share-app-key-aaaaaaaa";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Model calls of every session but `free` wait until `open()`. */
function gated(free: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const model: ModelProvider = async (effect) => {
    if (effect.sessionId !== free) await gate;
    return { output: [{ type: "text", text: "ok" }] };
  };
  return { model, open: () => open() };
}

async function boot(model: ModelProvider) {
  const tenant = await startTestTenant({ applicationKey: APP, modelProvider: model });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${tenant.url}${path}`, {
      method,
      headers: { ...tenant.headers(), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  let n = 0;
  const message = (sessionId: string) => {
    n += 1;
    return call("POST", `/v1/sessions/${sessionId}/commands`, {
      type: "message",
      requestId: `m${n}`,
      idempotencyKey: `m${n}`,
      content: "go",
    });
  };
  const view = async (sessionId: string) => (await call("GET", `/v1/sessions/${sessionId}`)).body;
  const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out");
  };
  const settled = (sessionId: string) =>
    until(async () => {
      const status = (await view(sessionId)).status as string;
      return ["completed", "failed", "cancelled"].includes(status) ? status : undefined;
    });
  return { tenant, client, call, message, view, until, settled };
}

it("shares the workspace of one Environment between sessions, and runs their turns at once", { timeout: 60_000 }, async () => {
  const { model, open } = gated("none");
  const { client, call, message, view, until, settled } = await boot(model);
  const bot = Agent({ id: "bot" }).instructions("Work.").build();
  const helper = Agent({ id: "helper" }).instructions("Help.").build();
  await client.saveAgent(bot, { implementationVersion: "v1" });
  await client.saveAgent(helper, { implementationVersion: "v1" });
  await client.environments.put("team/ws", {});
  await client.createSession({ id: "solo-a", agentId: "bot", ownerUserId: "ada", environment: "team/ws" });
  await client.createSession({ id: "solo-b", agentId: "helper", ownerUserId: "bob", environment: "team/ws" });

  // One workspace: what one session writes, the other reads.
  expect(
    (await call("POST", "/v1/sessions/solo-a/sandbox/write", { path: "notes.txt", content: "from a" })).body
  ).toMatchObject({ kind: "completed" });
  expect(JSON.stringify((await call("POST", "/v1/sessions/solo-b/sandbox/read", { path: "notes.txt" })).body)).toContain(
    "from a"
  );

  // Both turns run at once (D66).
  expect((await message("solo-a")).status).toBe(200);
  await until(async () => ((await view("solo-a")).activeTurnId ? true : undefined));
  expect((await message("solo-b")).status).toBe(200);
  await until(async () => ((await view("solo-b")).activeTurnId ? true : undefined));
  expect((await view("solo-a")).activeTurnId).not.toBeNull();
  open();
  expect(await settled("solo-a")).toBe("completed");
  expect(await settled("solo-b")).toBe("completed");
});

it("runs a flow tree's turns and another session's turn on one Environment together", { timeout: 60_000 }, async () => {
  const { model, open } = gated("none");
  const { client, call, message, view, until, settled } = await boot(model);
  const desk = Agent({ id: "desk" })
    .pipe(Agent({ id: "drafter" }).instructions("Draft."))
    .build();
  await client.saveAgent(desk, { implementationVersion: "v1" });
  await client.saveAgent(Agent({ id: "solo" }).instructions("Work.").build(), { implementationVersion: "v1" });
  await client.environments.put("desk/ws", {});
  await client.createSession({ id: "desk-1", agentId: "desk", ownerUserId: "ada", environment: "desk/ws" });
  await client.createSession({ id: "outsider", agentId: "solo", ownerUserId: "ada", environment: "desk/ws" });

  expect((await message("desk-1")).status).toBe(200);
  // The flow's agent started its own turn on the Environment while the flow's turn holds it.
  const leaf = await until(async () => {
    const listed = (await call("GET", "/v1/sessions")).body.sessions as {
      id: string;
      agentId: string;
      activeTurnId: string | null;
    }[];
    return listed.find((session) => session.agentId === "drafter" && session.activeTurnId !== null)?.id;
  });
  expect((await view("desk-1")).activeTurnId).not.toBeNull();
  expect((await view(leaf)).environment).toEqual({ id: "desk/ws", version: 1 });
  // Another session's turn starts beside the tree's.
  expect((await message("outsider")).status).toBe(200);
  await until(async () => ((await view("outsider")).activeTurnId ? true : undefined));
  open();
  expect(await settled("desk-1")).toBe("completed");
  expect(await settled(leaf)).toBe("completed");
  expect(await settled("outsider")).toBe("completed");
});

it("refuses the protocol 10 { session } share as an unknown field", { timeout: 60_000 }, async () => {
  const { model } = gated("none");
  const { client, call } = await boot(model);
  await client.saveAgent(Agent({ id: "bot" }).instructions("Work.").build(), { implementationVersion: "v1" });
  await client.environments.put("lead/ws", {});
  await client.createSession({ id: "lead-1", agentId: "bot", ownerUserId: "ada", environment: "lead/ws" });
  const refused = await call("PUT", "/v1/sessions/helper-1", {
    requestId: "helper-1",
    agentId: "bot",
    ownerUserId: "ada",
    sandbox: { session: "lead-1" },
  });
  expect(refused.status).toBe(400);
  expect((await call("GET", "/v1/sessions/helper-1")).status).toBe(404);
});
