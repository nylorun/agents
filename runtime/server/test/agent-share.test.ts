/**
 * Sharing an Agent (protocol 16; an Environment from protocol 11): sessions on one Agent share its
 * sandbox's workspace, keyed by the Agent's id, and run their turns at the same time (D66), a flow
 * tree's sessions and other sessions alike.
 * `{ session }` sharing is gone: the Agent is what sessions share.
 */
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  sandboxWorkspaceOf,
  sessionHasSandbox,
  sessionSandboxSpec,
  type SessionSandboxRef,
} from "../src/sandbox/share.js";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";

const agentManifest = () => ({ manifestSchemaVersion: 7 as const, id: "bot", name: "Bot" });

it("keys a session's workspace by its Agent, and its events by the session", () => {
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
  // An Agent of kind none: no sandbox.
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
  const headers = { ...tenant.headers(), "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${tenant.url}${path}`, {
      method,
      headers,
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
  const open = async (id: string, agent: string, ownerUserId: string) => {
    const opened = await openSession(tenant.url, headers, id, { agent, ownerUserId });
    expect(opened.status, await opened.clone().text()).toBe(200);
  };
  return { tenant, headers, call, open, message, view, until, settled };
}

it("shares the workspace of one Agent between sessions, and runs their turns at once", { timeout: 60_000 }, async () => {
  const { model, open: release } = gated("none");
  const { tenant, headers, call, open, message, view, until, settled } = await boot(model);
  const bot = Agent({ id: "bot", name: "bot" }).instructions("Work.").build();
  await deploy(tenant.url, headers, bot, { id: "team/ws", runtime: { kind: "virtual" } });
  await open("solo-a", "team/ws", "ada");
  await open("solo-b", "team/ws", "bob");

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
  release();
  expect(await settled("solo-a")).toBe("completed");
  expect(await settled("solo-b")).toBe("completed");
});

it("runs a flow tree's turns and another session's turn on one Agent together", { timeout: 60_000 }, async () => {
  const { model, open: release } = gated("none");
  const { tenant, headers, call, open, message, view, until, settled } = await boot(model);
  const desk = Agent({ id: "desk", name: "desk" })
    .pipe(Agent({ id: "drafter", name: "drafter" }).instructions("Draft."))
    .build();
  await deploy(tenant.url, headers, desk, { id: "desk/ws", runtime: { kind: "virtual" } });
  await open("desk-1", "desk/ws", "ada");
  await open("outsider", "desk/ws", "ada");

  expect((await message("desk-1")).status).toBe(200);
  // The flow's agent started its own turn on the flow's Agent while the flow's turn holds it.
  const leaf = await until(async () => {
    const listed = (await call("GET", "/v1/sessions")).body.sessions as {
      id: string;
      agentId: string;
      activeTurnId: string | null;
    }[];
    return listed.find(
      (session) => !["desk-1", "outsider"].includes(session.id) && session.activeTurnId !== null,
    )?.id;
  });
  expect((await view("desk-1")).activeTurnId).not.toBeNull();
  expect((await view(leaf)).agentId).toBe("desk/ws");
  // Another session's turn starts beside the tree's.
  expect((await message("outsider")).status).toBe(200);
  await until(async () => ((await view("outsider")).activeTurnId ? true : undefined));
  release();
  expect(await settled("desk-1")).toBe("completed");
  expect(await settled(leaf)).toBe("completed");
  expect(await settled("outsider")).toBe("completed");
});

it("refuses the protocol 10 { session } share as an unknown field", { timeout: 60_000 }, async () => {
  const { model } = gated("none");
  const { tenant, headers, call, open } = await boot(model);
  await deploy(tenant.url, headers, Agent({ id: "bot", name: "bot" }).instructions("Work.").build(), {
    id: "lead/ws",
    runtime: { kind: "virtual" },
  });
  await open("lead-1", "lead/ws", "ada");
  const refused = await call("PUT", "/v1/sessions/helper-1", {
    requestId: "helper-1",
    agent: "lead/ws",
    ownerUserId: "ada",
    sandbox: { session: "lead-1" },
  });
  expect(refused.status).toBe(400);
  expect((await call("GET", "/v1/sessions/helper-1")).status).toBe(404);
});
