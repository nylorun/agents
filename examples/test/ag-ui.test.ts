/**
 * The AG-UI example (`src/ag-ui/`) as a browser sees it: two signed-in people chat with the
 * support agent through the backend, against an in-process Runtime whose fixture model calls
 * `lookup_order`. Each person reaches only their own threads, a forged `Nylorun-*` header
 * changes nothing, and no response carries the application key, Runtime URL or Tenant id.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { createClient } from "@nylorun/agents";
import { startEphemeralRuntime, type EphemeralRuntime } from "@nylorun/runtime";
import { createSupportApp } from "../src/ag-ui/app.js";
import { testDatabase } from "./database.js";

let hostRoot: string;
let database: Awaited<ReturnType<typeof testDatabase>>;
let runtime: EphemeralRuntime;
let server: Server;
let base: string;
/** Every body and header the browser received, for the leak check. */
const received: string[] = [];

beforeAll(async () => {
  hostRoot = await mkdtemp(join(tmpdir(), "examples-ag-ui-"));
  database = await testDatabase();
  runtime = await startEphemeralRuntime({
    hostRoot,
    model: { kind: "fixture" },
    database: database.url,
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  const app = createSupportApp({ client });
  server = createServer(app.listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await app.register(origin);
  base = `${origin}/api/agui`;
}, 60_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await runtime?.close();
  await database?.drop();
  await rm(hostRoot, { recursive: true, force: true });
});

/** fetch as a browser signed in as `user`, recording what came back. */
async function browser(path: string, user: string | undefined, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(user ? { cookie: `demo_user=${user}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string>),
    },
  });
  const text = await response.text();
  received.push(text, JSON.stringify([...response.headers]));
  return { status: response.status, text };
}

const history = async (user: string, threadId: string, headers: Record<string, string> = {}) => {
  const reply = await browser(`/support/threads/${threadId}/messages`, user, { headers });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.text) as { id: string; role: string; content?: string }[];
};

function chat(user: string, threadId: string) {
  const agent = new HttpAgent({
    url: `${base}/support`,
    headers: { cookie: `demo_user=${user}` },
    threadId,
  });
  const events: { type: string; [key: string]: unknown }[] = [];
  agent.subscribe({ onEvent: ({ event }) => void events.push(event as never) });
  return { agent, events };
}

describe("the AG-UI example", () => {
  it("runs a chat with an approval for a signed-in person", async () => {
    const { agent, events } = chat("ada", "t-ada");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Where is demo-123? Ada asking." });
    await agent.runAgent({ runId: crypto.randomUUID() });
    const finished = events.find((e) => e.type === "RUN_FINISHED") as {
      outcome?: { type?: string; interrupts?: { id: string; reason?: string }[] };
      interrupt?: unknown;
    };
    const interrupts =
      (finished as { interrupts?: { id: string }[] }).interrupts ??
      finished.outcome?.interrupts ??
      [];
    expect(interrupts.length, JSON.stringify(finished)).toBe(1);

    events.length = 0;
    await agent.runAgent({
      runId: crypto.randomUUID(),
      resume: [{ interruptId: interrupts[0]!.id, status: "resolved", payload: { approved: true } }],
    } as never);
    const types = events.map((e) => e.type);
    expect(types).toContain("TOOL_CALL_RESULT");
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => String(e.delta))
      .join("");
    expect(text).toContain("Order lookup complete");
    expect(text).toContain("shipped");
    expect((await history("ada", "t-ada")).length).toBeGreaterThan(1);
  });

  it("keeps each person to their own threads", async () => {
    expect(await history("bob", "t-ada")).toEqual([]);
    const { agent } = chat("bob", "t-ada");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Is my order here?" });
    await agent.runAgent({ runId: crypto.randomUUID() });
    const bob = await history("bob", "t-ada");
    const ada = await history("ada", "t-ada");
    expect(bob.length).toBeGreaterThan(0);
    const adaIds = new Set(ada.map((m) => m.id));
    expect(bob.some((m) => adaIds.has(m.id))).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("Ada asking");
    expect(JSON.stringify(ada)).not.toContain("Is my order here?");
  });

  it("ignores Nylorun-* headers the browser sends", async () => {
    const forged = await history("bob", "t-ada", {
      "Nylorun-Subject": "app:ada",
      "Nylorun-Scopes": "sessions:own",
    });
    expect(JSON.stringify(forged)).not.toContain("Ada asking");
    expect(forged.map((m) => m.id)).toEqual((await history("bob", "t-ada")).map((m) => m.id));
  });

  it("answers 401 without a signed-in person and 404 for other agents", async () => {
    expect((await browser("/support/threads/t-ada/messages", undefined)).status).toBe(401);
    expect((await browser("/assistant/threads/t-ada/messages", "ada")).status).toBe(404);
  });

  it("never sends the browser the application key, the Runtime URL or the Tenant id", async () => {
    // A cursor the Runtime cannot read is the browser's mistake, not the Runtime's failure.
    const reattach = await browser("/support/threads/t-ada/events", "ada", {
      headers: { "Last-Event-ID": "not-a-cursor" },
    });
    expect(reattach.status).toBe(400);
    const all = received.join("\n");
    expect(received.length).toBeGreaterThan(5);
    expect(all).not.toContain(runtime.applicationKey);
    expect(all).not.toContain(runtime.url);
    expect(all).not.toContain(runtime.tenantId);
  });
});
