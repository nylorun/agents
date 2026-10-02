/**
 * A browser chats over AG-UI with the Runtime directly: `@ag-ui/client`'s `HttpAgent` with the
 * browser client's `agUi()` fetch, a publishable key and an `Origin` on every request. A run
 * whose token expires mid-stream is reattached with a new token, and the agent sees one run.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HttpAgent, type BaseEvent } from "@ag-ui/client";
import { Agent } from "@nylorun/core/define";
import { createClient } from "@nylorun/agents";
import { createBrowserClient } from "@nylorun/agents/browser";
import { startEphemeralRuntime } from "../src/tenant/ephemeral.js";
import { testPool } from "./support/store.js";

const ORIGIN = "http://localhost:5173";
const withOrigin: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", ORIGIN);
  return fetch(input, { ...init, headers });
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-browser-ag-ui-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const rt = await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    browserAccess: true,
    model: { kind: "scripted", output: "hello from the agent" },
  });
  cleanup.push(() => rt.close());
  const app = createClient({ url: rt.url, key: rt.applicationKey, tenant: rt.tenantId });
  await app.saveAgent(Agent({ id: "support", name: "Support" }).build(), {
    implementationVersion: "dev",
  });
  await app.access.putPolicy({
    version: 1,
    roles: { user: { scopes: ["sessions:own"], agents: ["support"] } },
    anon: { scopes: [], agents: [] },
    tokens: { maxTtlSeconds: 600 },
  });
  const key = (
    await app.access.publishableKeys.create({ name: "web", origins: ["http://localhost:*"] })
  ).key;
  return { rt, app, key };
}

it("runs a chat through HttpAgent and rebuilds it from history", async () => {
  const { rt, app, key } = await setup();
  const nylo = createBrowserClient({
    url: rt.url,
    publishableKey: key,
    token: async () => app.tokens.create({ subject: "app:lin", role: "user" }),
    fetch: withOrigin,
  });
  const { url, fetch: agUiFetch } = nylo.agUi("support");
  const agent = new HttpAgent({ url, fetch: agUiFetch, threadId: "t1" });
  const seen: BaseEvent[] = [];
  agent.subscribe({ onEvent: ({ event }) => void seen.push(event) });
  agent.addMessage({ id: "m1", role: "user", content: "hi" });
  await agent.runAgent({ runId: "r1" });
  expect(seen[0]!.type).toBe("RUN_STARTED");
  expect(seen.at(-1)!.type).toBe("RUN_FINISHED");
  expect(agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "hello from the agent" });
  const history = await nylo.agUiHistory("support", "t1");
  expect((history as { id: string }[]).map((m) => m.id)).toEqual(agent.messages.map((m) => m.id));
});

it("reattaches a run whose token expires mid-stream, so the agent sees one run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const root = await mkdtemp(join(tmpdir(), "nylorun-browser-ag-ui-slow-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { startTestTenant } = await import("./support/tenant.js");
  const APP = "browser-ag-ui-app-token-aaaaaaaaaa";
  const slow = await startTestTenant({
    applicationKey: APP,
    vaultKek: Buffer.alloc(32, 4).toString("base64"),
    modelProvider: async () => {
      await gate;
      return { output: [{ type: "text", text: "worth the wait" }] };
    },
  });
  cleanup.push(async () => {
    release();
    await slow.close();
  });
  const app = createClient({ url: slow.url, key: APP, tenant: slow.tenantId });
  await app.saveAgent(Agent({ id: "support", name: "Support" }).build(), {
    implementationVersion: "dev",
  });
  await app.access.putPolicy({
    version: 1,
    roles: { user: { scopes: ["sessions:own"], agents: ["support"] } },
    anon: { scopes: [], agents: [] },
    tokens: { maxTtlSeconds: 600 },
  });
  // A token that has half a second left when the run starts; later calls get fresh ones.
  const short = await app.tokens.create({ subject: "app:mo", role: "user", ttlSeconds: 60 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 59_500);
  let issued = 0;
  let reattached = 0;
  const nylo = createBrowserClient({
    url: slow.url,
    // No Host in front of this Tenant: a native app, so no Origin and no publishable key check.
    publishableKey: `nr_pub_${slow.tenantId}_${"0".repeat(32)}`,
    token: async () => {
      issued += 1;
      return issued === 1 ? short : app.tokens.create({ subject: "app:mo", role: "user" });
    },
    // The Tenant has no such publishable key: send the Tenant header instead.
    fetch: (input, init) => {
      if (String(input).includes("/threads/slow/events")) reattached += 1;
      const headers = new Headers(init?.headers);
      headers.delete("nylorun-key");
      headers.set("nylorun-tenant", slow.tenantId);
      return fetch(input, { ...init, headers });
    },
  });
  const { url, fetch: agUiFetch } = nylo.agUi("support");
  const agent = new HttpAgent({ url, fetch: agUiFetch, threadId: "slow" });
  const seen: BaseEvent[] = [];
  agent.subscribe({ onEvent: ({ event }) => void seen.push(event) });
  agent.addMessage({ id: "m1", role: "user", content: "take your time" });
  const running = agent.runAgent({ runId: "r1" });
  // Let the Runtime end the first stream at the token's expiry, then let the model answer.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  release();
  await running;
  const types = seen.map((event) => event.type);
  expect(types.filter((t) => t === "RUN_STARTED")).toHaveLength(1);
  expect(types.filter((t) => t === "RUN_FINISHED")).toHaveLength(1);
  expect(types.some((t) => t === "CUSTOM")).toBe(false);
  expect(agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "worth the wait" });
  expect(issued).toBeGreaterThanOrEqual(2);
  expect(reattached).toBeGreaterThanOrEqual(1);
});
