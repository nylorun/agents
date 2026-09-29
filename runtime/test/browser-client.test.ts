/**
 * `@nylorun/agents/browser` against a real Host with browser access: a page with a publishable
 * key and the app server's token route creates a session, sends a message and reads the turn,
 * with an `Origin` on every request, and keeps working after its subject is revoked and a new
 * token is issued.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { createClient, createTokenEndpoint, type AgentsClient } from "@nylorun/agents";
import { createBrowserClient } from "@nylorun/agents/browser";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../src/tenant/ephemeral.js";

const ORIGIN = "http://localhost:5173";
let root: string;
let rt: EphemeralRuntime;
let app: AgentsClient;
let key: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-browser-client-"));
  rt = await startEphemeralRuntime({
    hostRoot: root,
    browserAccess: true,
    model: { kind: "scripted", output: "hello from the agent" },
  });
  app = createClient({ url: rt.url, key: rt.applicationKey, tenant: rt.tenantId });
  await app.saveAgent(Agent({ id: "support", name: "Support" }).build(), {
    implementationVersion: "dev",
  });
  await app.access.putPolicy({
    version: 1,
    roles: { user: { scopes: ["sessions:own", "agents:read"], agents: ["support"] } },
    anon: { scopes: [], agents: [] },
    tokens: { maxTtlSeconds: 600 },
  });
  key = (
    await app.access.publishableKeys.create({ name: "web", origins: ["http://localhost:*"] })
  ).key;
});
afterAll(async () => {
  await rt?.close();
  await rm(root, { recursive: true, force: true });
});

it("chats from a browser with a publishable key and subject tokens", async () => {
  const tokenRoute = createTokenEndpoint({ client: app, role: "user", subject: () => "app:pat" });
  let issued = 0;
  const nylo = createBrowserClient({
    url: rt.url,
    publishableKey: key,
    token: async () => {
      issued += 1;
      const response = await tokenRoute(new Request("http://app.test/token", { method: "POST" }));
      return response.json();
    },
    // What a browser adds by itself.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", ORIGIN);
      return fetch(input, { ...init, headers });
    },
  });
  expect(await nylo.subject()).toBe("app:pat");
  expect((await nylo.listAgents()).agents).toEqual([{ agentId: "support", name: "Support" }]);
  const session = await nylo.createSession({ id: "pat-1", agentId: "support" });
  const accepted = await session.input("hi", { idempotencyKey: "m1" });
  expect(accepted).toBeTruthy();
  const controller = new AbortController();
  let finished = false;
  for await (const event of session.observe({ signal: controller.signal })) {
    if (event.type === "turn.completed") {
      finished = true;
      controller.abort();
    }
  }
  expect(finished).toBe(true);

  // Revoked: the next call fetches a new token by itself and succeeds.
  await app.access.revokeSubject("app:pat");
  const before = issued;
  const list = await nylo.listSessions();
  expect(list.sessions.map((s) => s.id)).toEqual(["pat-1"]);
  expect(issued).toBe(before + 1);
});
