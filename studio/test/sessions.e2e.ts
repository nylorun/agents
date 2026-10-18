/**
 * Opening sessions in the dashboard, in Chromium (protocol 16): a session an
 * application created on an Agent (another owner, info) opens and shows its
 * history, and a flow's child session, which runs on the flow's Agent with the
 * embedded agent's loop, opens from the Workflow tree. Only "New session"
 * creates a session, on the Agent picked.
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

/** Agents: `orders` (made from manifest `orders` v1, which has a v2), `shipping` (a flow). */
const AGENT = "orders";
const FLOW = "shipping";
/** An Agent guarded for another owner: Studio's sessions may not run on it. */
const GUARDED = "bob-orders";
/** The agent a flow embeds: its child session runs on the flow's Agent. */
const CHILD_AGENT = "logistics-planner";
const ALICE_SESSION = "s-alice";
const FLOW_SESSION = "s-flow";
const CHILD_SESSION = "wf_0123456789abcdef01234567";
const FILES_SESSION = "s-files";
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
type Upload = { query: string; contentType: string; length: string; bytes: Buffer };
type Command = { sessionId: string; body: Record<string, any> };
type StoredArtifact = { id: string; name: string; contentType: string; sessionId: string; bytes: Buffer };

const time = "2026-10-10T00:00:00.000Z";
const ordersLoop = { instructions: ["Answer about orders."], tools: [] };
const flowLoop = {
  kind: "workflow",
  root: { chain: [{ agent: CHILD_AGENT }] },
  agents: { [CHILD_AGENT]: { manifestSchemaVersion: 7, id: CHILD_AGENT, name: "Logistics planner" } },
};
const manifestView = (name: string, version: number, harness: object) => ({
  name,
  version,
  hash: `${name}-${version}`,
  manifest: { manifestSchemaVersion: 8, name, harness, runtime: { kind: "virtual" } },
  savedBy: { actor: "application" },
  createdAt: time,
  agents: 1,
});
const MANIFESTS: Record<string, Record<number, ReturnType<typeof manifestView>>> = {
  orders: { 1: manifestView("orders", 1, ordersLoop), 2: manifestView("orders", 2, ordersLoop) },
  shipping: { 1: manifestView("shipping", 1, flowLoop) },
};
const agentView = (id: string, manifest: string, fields: Record<string, unknown> = {}) => ({
  id,
  manifest,
  resolvedVersion: 1,
  manifestHash: "h",
  tracking: manifest.includes("@") ? "pinned" : "tracking",
  kind: "virtual",
  harness: "nylorun",
  owner: null,
  labels: {},
  state: "sleeping",
  attention: [],
  desired: "on",
  compute: { state: "ready" },
  runtime: { resources: { cpus: 1, memory: "1024MiB" }, network: { allowedHosts: [] }, harness: "nylorun", lifecycle: {} },
  limits: {
    artifacts: { fileBytes: 1, totalBytes: 1 },
    skills: { totalBytes: 1 },
    disk: { versionBytes: 1, versionEntries: 1 },
  },
  sessions: [],
  slots: [],
  disk: { latestVersion: null, operation: null },
  forkedFrom: null,
  lastUsedAt: time,
  createdAt: time,
  updatedAt: time,
  ...fields,
});

/** Session creation identity as the Runtime compares it (no requestId). */
function identity(creation: Creation): string {
  const { requestId: _r, ...rest } = creation;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * A Runtime that keeps sessions like the real one: `PUT` on an existing
 * session with other creation parameters answers 409, an unknown session 404.
 */
/** When each session opened and last changed, as `session-reads` lists them. */
const SESSION_TIMES: Record<string, { createdAt: string; lastEventAt: string | null }> = {
  [ALICE_SESSION]: { createdAt: "2026-10-01T09:00:00.000Z", lastEventAt: "2026-10-15T11:00:00.000Z" },
  [FLOW_SESSION]: { createdAt: "2026-10-02T09:00:00.000Z", lastEventAt: "2026-10-14T11:00:00.000Z" },
  [CHILD_SESSION]: { createdAt: "2026-10-03T09:00:00.000Z", lastEventAt: "2026-10-13T11:00:00.000Z" },
  // No events yet: its last activity is when it opened.
  [FILES_SESSION]: { createdAt: "2026-10-12T09:00:00.000Z", lastEventAt: null },
};
const usageNumbers = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedTokens: 200,
  cacheWriteTokens: 0,
  reasoningTokens: 50,
  costUsd: 0.0123,
});

async function fakeRuntime(sessionReads = false) {
  const sessions = new Map<string, { creation: Creation; items: unknown[] }>([
    [
      ALICE_SESSION,
      {
        creation: { agent: AGENT, ownerUserId: "app:alice", info: { tier: "gold" } },
        items: [
          event(ALICE_SESSION, "command.message", { type: "message", content: "Where is order 42?" }),
          // The model call the Usage tab lists as eff_1.
          event(ALICE_SESSION, "message.assistant", {
            invocationId: "1",
            text: "Order 42 ships today.",
            toolCalls: [],
            effectId: "eff_1",
          }),
          event(ALICE_SESSION, "turn.completed", { output: "Order 42 ships today." }),
        ],
      },
    ],
    [
      FLOW_SESSION,
      {
        creation: { agent: FLOW, ownerUserId: "app:alice" },
        items: [
          event(FLOW_SESSION, "node.started", { path: CHILD_AGENT, kind: "agent", key: CHILD_AGENT }),
          event(FLOW_SESSION, "node.agent", { path: CHILD_AGENT, sessionId: CHILD_SESSION, turnId: "t1" }),
        ],
      },
    ],
    [
      CHILD_SESSION,
      {
        // A flow's child session runs on the flow's Agent.
        creation: { agent: FLOW, ownerUserId: "app:alice" },
        items: [event(CHILD_SESSION, "turn.completed", { output: "Route via Rotterdam." })],
      },
    ],
    [
      FILES_SESSION,
      {
        creation: { agent: AGENT, ownerUserId: "app:alice" },
        items: [
          event(FILES_SESSION, "command.message", {
            type: "message",
            parts: [
              { type: "text", text: "What does this diagram show?" },
              { type: "file", artifactId: "art_seed", version: 1 },
            ],
          }),
        ],
      },
    ],
  ]);
  const artifacts = new Map<string, StoredArtifact>([
    ["art_seed", { id: "art_seed", name: "diagram.png", contentType: "image/png", sessionId: FILES_SESSION, bytes: PNG }],
  ]);
  const uploads: Upload[] = [];
  const commands: Command[] = [];
  const artifactView = (a: StoredArtifact) => ({
    artifactId: a.id,
    kind: "file",
    name: a.name,
    contentType: a.contentType,
    sessionId: a.sessionId,
    latestVersion: 1,
    createdAt: time,
    updatedAt: time,
    versions: [{ version: 1, size: a.bytes.length, sha256: "0".repeat(64), contentType: a.contentType, source: "upload", createdAt: time }],
  });
  const puts: { id: string; body: Creation }[] = [];
  const coverage: string[] = [];
  const agentOf = (id: string) => String(sessions.get(id)!.creation.agent);
  const manifestOf = (agentId: string) => (agentId === FLOW ? "shipping" : "orders");
  const view = (id: string) => {
    const creation = sessions.get(id)!.creation;
    return {
      id,
      agentId: creation.agent,
      ownerUserId: creation.ownerUserId,
      manifest: { name: manifestOf(agentOf(id)), version: 1 },
      manifestHash: "h",
      harness: "nylorun",
      status: "idle",
      activeTurnId: null,
      mcpSnapshot: null,
      mcpDiagnostics: [],
      uncertainEffects: [],
    };
  };
  const agents = () =>
    [
      agentView(AGENT, "orders"),
      agentView(FLOW, "shipping"),
      agentView(GUARDED, "orders@1", { owner: "app:bob" }),
    ].map((agent) => ({
      ...agent,
      sessions: [...sessions]
        .filter(([, s]) => s.creation.agent === agent.id)
        .map(([id, s]) => ({ id, ownerUserId: s.creation.ownerUserId, status: "idle", activeTurnId: null })),
    }));
  const protocol = {
    min: PROTOCOL_VERSION,
    max: PROTOCOL_VERSION,
    features: [...PROTOCOL_FEATURES, ...(sessionReads ? ["session-reads"] : [])],
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const raw = bytes.toString("utf8");
    const [path = "", query = ""] = (req.url ?? "").split("?");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") return send(200, { status: "ok", protocol });
    if (path === "/v1/tenant") return send(200, { tenant: { id: TENANT, name: "orders" } });
    if (path === "/v1/agents") return send(200, { agents: agents() });
    const agentMatch = /^\/v1\/agents\/([^/]+)$/u.exec(path);
    if (agentMatch) {
      const found = agents().find((agent) => agent.id === decodeURIComponent(agentMatch[1]!));
      return found ? send(200, found) : send(404, { code: "not_found", message: "Agent not found" });
    }
    if (path === "/v1/agent-manifests")
      return send(200, { manifests: [MANIFESTS.orders![2], MANIFESTS.shipping![1]] });
    const manifestMatch = /^\/v1\/agent-manifests\/([^/]+)(?:\/versions\/(\d+))?$/u.exec(path);
    if (manifestMatch) {
      const versions = MANIFESTS[manifestMatch[1]!]!;
      return send(200, versions[Number(manifestMatch[2] ?? Math.max(...Object.keys(versions).map(Number)))]);
    }
    if (path === "/v1/sessions" && sessionReads) {
      assert.match(query, /(?:^|&)limit=200(?:&|$)/u);
      return send(200, {
        sessions: [...sessions].map(([id, s]) => ({
          id,
          agentId: s.creation.agent,
          ownerUserId: s.creation.ownerUserId,
          status: "idle",
          activeTurnId: null,
          lastTurnId: null,
          createdAt: SESSION_TIMES[id]?.createdAt ?? time,
          lastEventAt: SESSION_TIMES[id]?.lastEventAt ?? null,
        })),
        nextCursor: null,
      });
    }
    const usageMatch = /^\/v1\/sessions\/([^/]+)\/(usage|calls\/model|manifest)$/u.exec(path);
    if (sessionReads && usageMatch) {
      const id = decodeURIComponent(usageMatch[1]!);
      const asOf = "2026-10-15T11:00:00.000Z";
      if (usageMatch[2] === "manifest") {
        const agentId = agentOf(id);
        // The loop each session pinned: a flow's child runs its embedded agent's.
        const manifest =
          id === CHILD_SESSION
            ? flowLoop.agents[CHILD_AGENT]
            : agentId === FLOW
              ? { id: "shipping", ...flowLoop }
              : { manifestSchemaVersion: 7, id: "orders", ...ordersLoop };
        return send(200, {
          sessionId: id,
          agentId,
          definition: { name: manifestOf(agentId), version: 1 },
          manifestHash: "h",
          manifest,
        });
      }
      if (usageMatch[2] === "usage")
        return send(200, {
          sessionId: id,
          turnId: null,
          asOf,
          ...usageNumbers(1234, 567),
          calls: 1,
          duplicates: 0,
          unpricedCalls: 0,
          unreportedCalls: 0,
          unknownQualityCalls: 0,
          costSplit: { input: 0.0081, cacheRead: 0.0002, cacheWrite: 0, output: 0.004 },
          splitCalls: 1,
          modelTimeMs: 4200,
          timedCalls: 1,
        });
      return send(200, {
        asOf,
        nextCursor: null,
        calls: [
          {
            id: "call_1",
            effectId: "eff_1",
            sessionId: id,
            turnId: "t1",
            manifestName: "orders",
            provider: "openai",
            model: "gpt-test",
            at: "2026-10-15T10:59:58.000Z",
            startedAt: "2026-10-15T10:59:53.800Z",
            endedAt: "2026-10-15T10:59:58.000Z",
            outcome: "completed",
            usage: {
              ...usageNumbers(1234, 567),
              duplicate: false,
              tokensReported: true,
              costKnown: true,
              costSplit: { input: 0.0081, cacheRead: 0.0002, cacheWrite: 0, output: 0.004 },
            },
          },
        ],
      });
    }
    if (path === "/v1/sessions")
      return send(200, {
        sessions: [...sessions].map(([id, s]) => ({
          id,
          agentId: s.creation.agent,
          ownerUserId: s.creation.ownerUserId,
          status: "idle",
          activeTurnId: null,
        })),
      });
    if (req.method === "POST" && path === "/v1/artifacts") {
      const params = new URLSearchParams(query);
      const contentType = req.headers["content-type"] ?? "";
      uploads.push({ query, contentType, length: req.headers["content-length"] ?? "", bytes });
      const stored = {
        id: `art_${uploads.length}`,
        name: params.get("name")!,
        contentType,
        sessionId: params.get("sessionId")!,
        bytes,
      };
      artifacts.set(stored.id, stored);
      const view = artifactView(stored);
      return send(201, { artifact: view, version: view.versions[0] });
    }
    const artifactMatch = /^\/v1\/artifacts\/([^/]+)(\/versions\/1\/content)?$/u.exec(path);
    if (artifactMatch) {
      const stored = artifacts.get(decodeURIComponent(artifactMatch[1]!));
      if (!stored) return send(404, { code: "not_found", message: "Artifact not found" });
      if (!artifactMatch[2]) return send(200, artifactView(stored));
      res.writeHead(200, { "content-type": stored.contentType, "content-length": String(stored.bytes.length) });
      return res.end(stored.bytes);
    }
    const commandMatch = /^\/v1\/sessions\/([^/]+)\/commands$/u.exec(path);
    if (req.method === "POST" && commandMatch) {
      const body = JSON.parse(raw) as Record<string, any>;
      commands.push({ sessionId: decodeURIComponent(commandMatch[1]!), body });
      // Any file is accepted (protocol 15): the agent's harness decides how its model sees it.
      return send(202, { accepted: true, eventId: `ev_${seq++}` });
    }
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
    if (path === "/v1/tenant/credential-coverage") {
      const { agentId } = JSON.parse(raw) as { agentId: string };
      coverage.push(agentId);
      return send(200, {
        agentId,
        complete: false,
        entries: [
          {
            kind: "mcp",
            name: "tickets",
            serverName: "tickets",
            url: "https://mcp.tickets.example/mcp",
            required: false,
            status: "missing",
            message: "Called without a credential.",
          },
        ],
      });
    }
    // Protocol 12: the selected model's inputs.
    if (path === "/v1/tenant/providers")
      return send(200, {
        providers: [{ id: "openai", name: "OpenAI", model: "gpt-test", active: true, inputs: ["text", "image", "pdf"] }],
      });
    if (path === "/v1/tenant/models")
      return send(200, { providers: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-test", name: "GPT Test" }] }] });
    if (path === "/v1/tenant/model") return send(200, { configured: false });
    send(200, {});
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    puts,
    coverage,
    uploads,
    commands,
    close: () => (server.closeAllConnections(), server.close()),
  };
}

async function withStudio(
  run: (context: {
    page: Page;
    studioUrl: string;
    puts: { id: string; body: Creation }[];
    coverage: string[];
    uploads: Upload[];
    commands: Command[];
  }) => Promise<void>,
  sessionReads = false,
) {
  const runtime = await fakeRuntime(sessionReads);
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
    // The Tenant's root opens its Agents.
    await page.waitForURL(new RegExp(`/tenants/${TENANT}(?:/agents)?$`, "u"));
    await run({
      page,
      studioUrl: studio.url,
      puts: runtime.puts,
      coverage: runtime.coverage,
      uploads: runtime.uploads,
      commands: runtime.commands,
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await studio.close();
    runtime.close();
  }
}

test("a session an application created for another owner, on an Agent and with info, opens with its history", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Where is order 42?" }).waitFor();
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    await page.getByRole("link", { name: `Agent: ${AGENT}`, exact: true }).waitFor();
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

test("an agent or session segment that does not decode is not found, and the next route opens", async () => {
  await withStudio(async ({ page, puts }) => {
    // The server answers 400 for an undecodable path, so only in-app
    // navigation (a link, an embedder's `navigate`) reaches one.
    const visit = (path: string) =>
      page.evaluate((url) => {
        history.pushState(null, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/tenants/${TENANT}${path}`);
    await visit("/agents/%E0");
    await page.getByRole("heading", { name: "Agent not found" }).waitFor();
    await visit(`/agents/${AGENT}/sessions/%E0`);
    await page.getByRole("heading", { name: "Session not found" }).waitFor();
    await visit("/sessions/%E0%A4%A");
    await page.getByText("This Tenant has no session %E0%A4%A.").waitFor();
    assert.equal(await page.getByText("Something went wrong in this view").count(), 0);
    await visit(`/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    assert.deepEqual(puts, []);
  });
});

test("Studio opens on its Agents; each opens its page, which lists its sessions", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents`);
    const sidebar = page.locator("[data-sidebar=sidebar]");
    // A flow's child session runs on the flow's Agent.
    await sidebar.locator(`a[href$="/agents/${FLOW}"]`).click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${FLOW}`);
    await page.getByRole("tab", { name: "Sessions", exact: true, selected: true }).waitFor();
    await page.getByRole("link", { name: FLOW_SESSION, exact: true }).waitFor();
    await page.getByRole("link", { name: CHILD_SESSION, exact: true }).waitFor();
    // An Agent's page lists the sessions on it; none is special.
    await sidebar.locator(`a[href$="/agents/${AGENT}"]`).click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}`);
    await page.getByRole("heading", { name: AGENT, exact: true }).waitFor();
    await page.getByRole("link", { name: FILES_SESSION, exact: true }).waitFor();
    await page.getByRole("link", { name: ALICE_SESSION, exact: true }).click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
  });
});

test("an Agent's sessions show each one's last activity, newest first", async () => {
  await withStudio(
    async ({ page, studioUrl }) => {
      await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}`);
      const order = () =>
        page.$$eval("tbody tr", (rows) => rows.map((row) => row.querySelector("td")?.textContent ?? ""));
      await page.getByRole("link", { name: ALICE_SESSION, exact: true }).waitFor();
      await page.locator("tbody tr", { hasText: FILES_SESSION }).locator("time").waitFor();
      assert.deepEqual(await order(), [ALICE_SESSION, FILES_SESSION]);
      // A session with no events counts from when it opened.
      assert.equal(
        await page.locator("tbody tr", { hasText: FILES_SESSION }).locator("time").getAttribute("datetime"),
        SESSION_TIMES[FILES_SESSION]!.createdAt,
      );
    },
    true,
  );
});

test("a Runtime without session reads shows sessions with no times", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}`);
    await page.getByRole("link", { name: ALICE_SESSION, exact: true }).waitFor();
    await page.getByRole("columnheader", { name: /Last activity/u }).waitFor();
    assert.equal(await page.locator("tbody time").count(), 0);
  });
});

test("a session's inspector hides and shows, and stays as it was left", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.getByRole("tab", { name: "Events", exact: true }).waitFor();
    await page.getByRole("button", { name: "Hide inspector" }).click();
    await page.getByRole("button", { name: "Show inspector" }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Events", exact: true }).count(), 0);
    // The chat keeps the whole width, and the choice outlives a reload.
    await page.reload();
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Events", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Show inspector" }).click();
    await page.getByRole("tab", { name: "Events", exact: true }).waitFor();
  });
});

test("a chat message shows its time only while it is hovered", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    const message = page.locator("article", { hasText: "Where is order 42?" });
    const stamp = message.locator("time");
    await stamp.waitFor({ state: "attached" });
    const opacity = () => stamp.evaluate((element) => getComputedStyle(element).opacity);
    assert.equal(await opacity(), "0");
    assert.match((await stamp.getAttribute("title")) ?? "", /^2026-10-05 \d\d:\d\d:\d\d$/u);
    await message.hover();
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll("article")]
          .filter((article) => article.textContent?.includes(text))
          .some((article) => getComputedStyle(article.querySelector("time")!).opacity === "1"),
      "Where is order 42?",
    );
  });
});

test("a session's Usage tab is one ledger of the session, its turns and each model call", async () => {
  await withStudio(
    async ({ page, studioUrl }) => {
      await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
      await page.getByRole("tab", { name: "Usage", exact: true }).click();
      await page.waitForURL(/inspector=usage/u);
      const panel = page.getByRole("tabpanel");
      // The session: tokens and cost by kind, adding up to the total.
      const session = panel.getByRole("region", { name: "Session" });
      await session.getByText("1 model call · 4.2s model time · 1 turn").waitFor();
      const rows = session.locator("tbody tr");
      assert.deepEqual(
        (await rows.allTextContents()).map((text) => text.replace(/\s+/gu, " ").trim()),
        [
          "Cached input20010%$0.00022%",
          "Uncached input1,23462%$0.008166%",
          "Output56728%$0.004033%",
          "Total2,001$0.0123",
        ],
      );
      await session.getByText("Output includes 50 reasoning tokens.").waitFor();
      // The turn, then its call, with the same columns.
      const calls = panel.getByRole("region", { name: "Model calls" }).locator("tbody tr");
      assert.equal(await calls.count(), 2);
      assert.match((await calls.nth(0).textContent()) ?? "", /Turn 1.*1 call.*200.*1,234.*567.*2,001.*4\.2s.*\$0\.0123/u);
      assert.match((await calls.nth(1).textContent()) ?? "", /#1.*200.*1,234.*567.*2,001.*4\.2s.*\$0\.0123/u);
      // Its menu opens the call's event in the Events tab.
      await calls.nth(1).hover();
      await page.getByRole("button", { name: "More options for call 1" }).click();
      await page.getByRole("menuitem", { name: /View event/u }).click();
      await page.waitForURL(/inspector=events/u);
      await page.getByRole("button", { name: "Close event details" }).waitFor();
      await page.getByText("message.assistant", { exact: true }).waitFor();
    },
    true,
  );
});

test("a sidebar Agent's + opens a session on it, for the local developer, and none on one guarded for another owner", async () => {
  await withStudio(async ({ page, puts, coverage }) => {
    const sidebar = page.locator("[data-sidebar=sidebar]");
    // A session always runs on one Agent: it starts from its Agent, never from a menu of them.
    assert.equal(await sidebar.getByRole("button", { name: "New session", exact: true }).count(), 0);
    await sidebar.getByRole("button", { name: `New session on ${GUARDED}` }).waitFor({ state: "attached" });
    assert.equal(await sidebar.getByRole("button", { name: `New session on ${GUARDED}` }).isDisabled(), true);
    await sidebar.locator(`a[href$="/agents/${AGENT}"]`).hover();
    await sidebar.getByRole("button", { name: `New session on ${AGENT}`, exact: true }).click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await page.waitForURL(new RegExp(`/agents/${AGENT}/sessions/[0-9a-f-]{36}$`, "u"));
    assert.equal(puts.length, 1);
    const { requestId: _id, ...body } = puts[0]!.body;
    assert.deepEqual(body, { agent: AGENT, ownerUserId: "local-developer" });
    // Its Manifest tab, under Deployed: where it runs, and what its tools get from the Agent's vault.
    await page.getByRole("link", { name: `Agent: ${AGENT}`, exact: true }).waitFor();
    await page.getByRole("tab", { name: "Manifest", exact: true }).click();
    await page.getByRole("tab", { name: "Deployed", exact: true }).click();
    await page.waitForURL(/inspector=manifest&view=deployed/u);
    const panel = page.getByRole("tabpanel", { name: "Deployed" });
    await panel.getByText("orders v1", { exact: true }).waitFor();
    await panel.getByText("MCP server tickets", { exact: true }).waitFor();
    await panel.getByText("No credential", { exact: true }).waitFor();
    assert.ok(coverage.includes(AGENT));
    // Its manifest is older than the latest: the Agent moves by a fork.
    await page.getByRole("tab", { name: "Declared", exact: true }).click();
    await page.getByText("v2 is the latest", { exact: false }).waitFor();
  }, true);
});

test("an Agent's page starts a session on it", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}`);
    await page.getByRole("main").getByRole("button", { name: "New session" }).click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await page.waitForURL(new RegExp(`/agents/${AGENT}/sessions/[0-9a-f-]{36}$`, "u"));
    assert.equal(puts[0]!.body.agent, AGENT);
  });
});

test("a flow node in the Workflow tree opens its child session, which runs on the flow's Agent", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${FLOW}/sessions/${FLOW_SESSION}`);
    // A workflow session opens on its Events tab's Progress view, the tree.
    await page.getByRole("tab", { name: "Events", exact: true, selected: true }).waitFor();
    await page.getByRole("tab", { name: "Progress", exact: true, selected: true }).waitFor();
    await page.getByRole("main").getByRole("link", { name: new RegExp(CHILD_AGENT, "u") }).first().click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${FLOW}/sessions/${CHILD_SESSION}`);
    await page.locator("article", { hasText: "Route via Rotterdam." }).waitFor();
    // Back to the flow from the child.
    await page.getByRole("link", { name: FLOW_SESSION, exact: true }).waitFor();
    // It runs the embedded agent's loop.
    await page.getByRole("tab", { name: "Manifest", exact: true }).click();
    await page.getByRole("heading", { name: "Logistics planner" }).waitFor();
    assert.deepEqual(puts, []);
  }, true);
});

test("files attached to a message are uploaded into the session, then sent as its file parts", async () => {
  await withStudio(async ({ page, studioUrl, uploads, commands }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const picker = page.locator('input[type="file"]');
    // Any file goes, whatever the model reads (protocol 15).
    assert.equal(await picker.getAttribute("accept"), null);
    await picker.setInputFiles([
      { name: "chart.png", mimeType: "image/png", buffer: PNG },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("ship by Friday") },
    ]);
    const chips = page.locator('[data-slot="attachment"]');
    await chips.filter({ hasText: "chart.png" }).locator("img").waitFor();
    await chips.filter({ hasText: "notes.txt" }).getByText("14 B").waitFor();
    // Files alone can be sent; remove one, attach it again.
    await page.getByRole("button", { name: "Remove notes.txt" }).click();
    assert.equal(await chips.count(), 1);
    await picker.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("ship by Friday") }]);
    await page.getByRole("textbox", { name: "Message" }).fill("Summarise these");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="attachment"]').length === 0);
    assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "");
    assert.deepEqual(
      uploads.map(({ query, contentType, length }) => ({ query, contentType, length })),
      [
        { query: `name=chart.png&sessionId=${ALICE_SESSION}`, contentType: "image/png", length: String(PNG.length) },
        { query: `name=notes.txt&sessionId=${ALICE_SESSION}`, contentType: "text/plain", length: "14" },
      ],
    );
    assert.deepEqual(uploads[0]!.bytes, PNG, "sent as it is: not resized or converted");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.sessionId, ALICE_SESSION);
    assert.equal(typeof commands[0]!.body.idempotencyKey, "string");
    assert.deepEqual(commands[0]!.body.parts, [
      { type: "text", text: "Summarise these" },
      { type: "file", artifactId: "art_1", version: 1 },
      { type: "file", artifactId: "art_2", version: 1 },
    ]);
  });
});

test("the message box keeps focus while a turn runs, so a paste into the focused field lands", async () => {
  await withStudio(async ({ page, studioUrl, commands }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Where is order 42?");
    await message.press("Enter");
    await page.getByPlaceholder(`${AGENT} is working…`).waitFor();
    // The box turns read-only as the message leaves; the command lands just after.
    for (let i = 0; i < 100 && commands.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(commands.length, 1);
    // Read-only, not disabled: focus stays in the box for the next message.
    assert.equal(await message.getAttribute("aria-disabled"), "true");
    assert.deepEqual(
      await message.evaluate((element: HTMLTextAreaElement) => ({
        disabled: element.disabled,
        readOnly: element.readOnly,
        focused: element === document.activeElement,
      })),
      { disabled: false, readOnly: true, focused: true },
    );
    await page.keyboard.type("too soon");
    assert.equal(await message.inputValue(), "");
  });
});

test("the message box inserts the text a paste carries, not what the clipboard holds after", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Where is ");
    // A paste built in the page has no default insertion: the text lands only if
    // the box inserts it from the event, as dictation tools that restore the
    // clipboard right after pasting need.
    const paste = (text: string) =>
      message.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      }, text);
    await paste("order 42?");
    assert.equal(await message.inputValue(), "Where is order 42?");
    await paste(" And 43?");
    assert.equal(await message.inputValue(), "Where is order 42? And 43?");
  });
});

test("a file the model does not read is sent like any other: the harness tells the model (protocol 15)", async () => {
  await withStudio(async ({ page, studioUrl, uploads, commands }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const picker = page.locator('input[type="file"]');
    await picker.setInputFiles([
      { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("not really a video") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("ship by Friday") },
    ]);
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("What happens here?");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="attachment"]').length === 0);
    assert.equal(await message.inputValue(), "");
    assert.equal(uploads.length, 2);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]!.body.parts, [
      { type: "text", text: "What happens here?" },
      { type: "file", artifactId: "art_1", version: 1 },
      { type: "file", artifactId: "art_2", version: 1 },
    ]);
  });
});

test("a message's files show their name, type and an image's thumbnail, and open the artifact", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${FILES_SESSION}`);
    const article = page.locator("article", { hasText: "What does this diagram show?" });
    const preview = article.locator('[data-slot="attachment-preview"]');
    await preview.getByText("diagram.png").waitFor();
    await preview.getByText("image/png · 70 B").waitFor();
    await preview.getByRole("img", { name: "diagram.png" }).waitFor();
    await preview.click();
    await page.waitForURL(/inspector=record&artifact=art_seed&artifactVersion=1/u);
  });
});

test("a file dropped on the message card or pasted into it is attached", async () => {
  await withStudio(async ({ page, studioUrl, uploads }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const card = page.locator('[data-slot="composer-card"]');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["a,b"], "rows.csv", { type: "text/csv" }));
      return data;
    });
    await card.dispatchEvent("dragover", { dataTransfer: transfer });
    await page.locator('[data-slot="composer-card"][data-dragging]').waitFor();
    await card.dispatchEvent("drop", { dataTransfer: transfer });
    await page.locator('[data-slot="composer-card"]:not([data-dragging])').waitFor();
    await page.locator('[data-slot="attachment"]', { hasText: "rows.csv" }).waitFor();
    await page.getByRole("textbox", { name: "Message" }).evaluate((textarea, clipboardData) => {
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, transfer);
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="attachment"]').length === 2);
    assert.equal(uploads.length, 0, "nothing is uploaded until the message is sent");
  });
});
