/**
 * Opening sessions in the dashboard, in Chromium: a session an application
 * created (another owner, a sandbox, info) opens and shows its history, and a
 * flow's child session, whose agent is embedded and not registered, opens from
 * the Workflow tree. Only "New session" creates a session.
 *
 * Run with `npm run test:e2e` (builds first). Not part of `npm run check`:
 * it needs Playwright's Chromium (`npx playwright install chromium`).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/agents";
import { startStudioServer } from "../dist/server.js";

const ADMIN_KEY = "e".repeat(64);
const TENANT = "tn_00000000000000000000000001";
const WEB_ROOT = fileURLToPath(new URL("../dist/web", import.meta.url));

const AGENT = "orders";
const FLOW = "shipping";
const CHILD_AGENT = "logistics-planner";
const ALICE_SESSION = "s-alice";
const FLOW_SESSION = "s-flow";
const CHILD_SESSION = "wf_0123456789abcdef01234567";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

let seq = 0;
function event(sessionId: string, type: string, payload: unknown) {
  const n = seq++;
  return {
    schema: "nylorun.event/2",
    eventId: `ev_${n}`,
    tenantId: TENANT,
    sessionId,
    runId: null,
    turnId: "t1",
    incarnation: 0,
    epoch: 0,
    seq: n,
    cursor: Buffer.from(`${sessionId}:${n}`).toString("base64url"),
    time: new Date(Date.UTC(2026, 9, 5, 12, 0, n)).toISOString(),
    schemaVersion: 1,
    source: { kind: type.startsWith("command.") ? "api" : "loop", id: "test" },
    evidence: "observed",
    visibility: "public",
    retention: "full",
    type,
    payload,
  };
}

type Creation = Record<string, unknown>;

/** Session creation identity as the Runtime compares it (no requestId, vaults or selections). */
function identity(creation: Creation): string {
  const { requestId: _r, vaultIds: _v, credentialSelections: _c, ...rest } = creation;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * A Runtime that keeps sessions like the real one: `PUT` on an existing
 * session with other creation parameters answers 409, an unknown session 404.
 */
async function fakeRuntime() {
  const sessions = new Map<string, { creation: Creation; items: unknown[] }>([
    [
      ALICE_SESSION,
      {
        creation: { agentId: AGENT, ownerUserId: "app:alice", sandbox: {}, info: { tier: "gold" } },
        items: [
          event(ALICE_SESSION, "command.message", { type: "message", content: "Where is order 42?" }),
          event(ALICE_SESSION, "turn.completed", { output: "Order 42 ships today." }),
        ],
      },
    ],
    [
      FLOW_SESSION,
      {
        creation: { agentId: FLOW, ownerUserId: "app:alice" },
        items: [
          event(FLOW_SESSION, "node.started", { path: CHILD_AGENT, kind: "agent", key: CHILD_AGENT }),
          event(FLOW_SESSION, "node.agent", { path: CHILD_AGENT, sessionId: CHILD_SESSION, turnId: "t1" }),
        ],
      },
    ],
    [
      CHILD_SESSION,
      {
        creation: { agentId: CHILD_AGENT, ownerUserId: "app:alice" },
        items: [event(CHILD_SESSION, "turn.completed", { output: "Route via Rotterdam." })],
      },
    ],
  ]);
  const puts: { id: string; body: Creation }[] = [];
  const view = (id: string) => {
    const creation = sessions.get(id)!.creation;
    return {
      id,
      agentId: creation.agentId,
      ownerUserId: creation.ownerUserId,
      manifestHash: "h",
      implementationVersion: "1",
      status: "idle",
      activeTurnId: null,
      vaultIds: [],
      credentialSelections: [],
      sandboxOwnerId: null,
      sandbox: creation.sandbox ?? null,
      mcpSnapshot: null,
      mcpDiagnostics: [],
      uncertainEffects: [],
    };
  };
  const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = (req.url ?? "").split("?")[0]!;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") return send(200, { status: "ok", protocol });
    if (path === "/v1/tenant") return send(200, { tenant: { id: TENANT, name: "orders" } });
    if (path === "/v1/agents")
      return send(200, {
        agents: [
          { agentId: AGENT, manifest: { id: AGENT, name: "Orders", capabilities: [] }, manifestHash: "h", implementationVersion: "1" },
          {
            agentId: FLOW,
            manifest: {
              kind: "workflow",
              workflowSchemaVersion: 3,
              id: FLOW,
              name: "Shipping",
              root: { chain: [{ agent: CHILD_AGENT }] },
              agents: { [CHILD_AGENT]: { id: CHILD_AGENT, name: "Logistics planner", capabilities: [] } },
            },
            manifestHash: "h",
            implementationVersion: "1",
          },
        ],
      });
    if (path === "/v1/sessions")
      return send(200, {
        sessions: [...sessions].map(([id, s]) => ({
          id,
          agentId: s.creation.agentId,
          ownerUserId: s.creation.ownerUserId,
          status: "idle",
          activeTurnId: null,
        })),
      });
    const match = /^\/v1\/sessions\/([^/]+)(\/items|\/events)?$/u.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const session = sessions.get(id);
      if (req.method === "PUT") {
        const body = JSON.parse(raw) as Creation;
        puts.push({ id, body });
        if (session && identity(session.creation) !== identity(body))
          return send(409, { code: "request_rejected", message: "Session already exists with different creation parameters" });
        if (!session) sessions.set(id, { creation: body, items: [] });
        return send(200, view(id));
      }
      if (!session) return send(404, { code: "not_found", message: "Session not found" });
      if (match[2] === "/items") return send(200, { items: session.items, cursor: null });
      if (match[2] === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return; // held open, like a live stream
      }
      return send(200, view(id));
    }
    if (path === "/v1/tenant/providers" || path === "/v1/tenant/models") return send(200, { providers: [] });
    if (path === "/v1/tenant/vaults") return send(200, { vaults: [] });
    if (path === "/v1/tenant/model") return send(200, { configured: false });
    send(200, {});
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, puts, close: () => (server.closeAllConnections(), server.close()) };
}

async function withStudio(run: (context: { page: Page; studioUrl: string; puts: { id: string; body: Creation }[] }) => Promise<void>) {
  const runtime = await fakeRuntime();
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: WEB_ROOT,
    log: () => {},
  });
  const browser: Browser = await chromium.launch();
  try {
    const minted = await fetch(`${studio.url}/_studio/login-tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const { url } = (await minted.json()) as { url: string };
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    await page.waitForURL(`${studio.url}/tenants/${TENANT}`);
    await run({ page, studioUrl: studio.url, puts: runtime.puts });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await studio.close();
    runtime.close();
  }
}

test("a session an application created for another owner, with a sandbox and info, opens with its history", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Where is order 42?" }).waitFor();
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    assert.equal(await page.getByText("Runtime HTTP 409").count(), 0);
    assert.deepEqual(puts, [], "opening an existing session never PUTs it");
  });
});

test("a session id nobody created is not found, and is not created", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/s-missing`);
    await page.getByRole("heading", { name: "Session not found" }).waitFor();
    assert.deepEqual(puts, []);
  });
});

test("New session creates the session for the local developer", async () => {
  await withStudio(async ({ page, puts }) => {
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await page.waitForURL(new RegExp(`/agents/${AGENT}/sessions/[0-9a-f-]{36}$`, "u"));
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.body.agentId, AGENT);
    assert.equal(puts[0]!.body.ownerUserId, "local-developer");
  });
});

test("a flow node in the Workflow tree opens its child session, whose agent is not registered", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${FLOW}/sessions/${FLOW_SESSION}`);
    await page.getByRole("link", { name: new RegExp(CHILD_AGENT, "u") }).first().click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${CHILD_AGENT}/sessions/${CHILD_SESSION}`);
    await page.locator("article", { hasText: "Route via Rotterdam." }).waitFor();
    // Back to the flow from the child.
    await page.getByRole("link", { name: FLOW_SESSION, exact: true }).waitFor();
    await page.getByRole("tab", { name: "Agent Manifest" }).click();
    await page.getByText(CHILD_AGENT).first().waitFor();
    assert.deepEqual(puts, []);
  });
});
