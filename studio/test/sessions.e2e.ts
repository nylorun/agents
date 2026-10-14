/**
 * Opening sessions in the dashboard, in Chromium: a session an application
 * created (another owner, an Environment, info) opens and shows its history, and a
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
const environmentView = (id: string, ownerUserId: string | null) => ({
  id,
  kind: "virtual",
  labels: {},
  recipe: { resources: { cpus: 1, memory: "1024MiB" }, network: { allowedHosts: [] }, harness: "nylorun", lifecycle: {} },
  version: 1,
  appliedVersion: 1,
  ownerUserId,
  state: "ready",
  lastUsedAt: time,
  sessions: [],
  createdAt: time,
  updatedAt: time,
});
const ENVIRONMENTS = [environmentView("team/build", null), environmentView("users/alice", "app:alice")];

/** Session creation identity as the Runtime compares it (no requestId). */
function identity(creation: Creation): string {
  const { requestId: _r, ...rest } = creation;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * A Runtime that keeps sessions like the real one: `PUT` on an existing
 * session with other creation parameters answers 409, an unknown session 404.
 */
async function fakeRuntime(environments = false) {
  const sessions = new Map<string, { creation: Creation; items: unknown[] }>([
    [
      ALICE_SESSION,
      {
        creation: { agentId: AGENT, ownerUserId: "app:alice", environment: "team/build", info: { tier: "gold" } },
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
    [
      FILES_SESSION,
      {
        creation: { agentId: AGENT, ownerUserId: "app:alice" },
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
  const coverage: (string | null)[] = [];
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
      environment: typeof creation.environment === "string" ? { id: creation.environment, version: 1 } : null,
      mcpSnapshot: null,
      mcpDiagnostics: [],
      uncertainEffects: [],
    };
  };
  const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };
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
    if (path === "/v1/agents")
      return send(200, {
        agents: [
          { agentId: AGENT, manifest: { manifestSchemaVersion: 7, id: AGENT, name: "Orders" }, manifestHash: "h", implementationVersion: "1" },
          {
            agentId: FLOW,
            manifest: {
              kind: "workflow",
              workflowSchemaVersion: 3,
              id: FLOW,
              name: "Shipping",
              root: { chain: [{ agent: CHILD_AGENT }] },
              agents: { [CHILD_AGENT]: { manifestSchemaVersion: 7, id: CHILD_AGENT, name: "Logistics planner" } },
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
      // Like a model that reads text and images: a video is refused at accept.
      const refused = (body.parts ?? [])
        .filter((part: any) => part.type === "file" && artifacts.get(part.artifactId)?.contentType.startsWith("video/"))
        .map((part: any) => {
          const stored = artifacts.get(part.artifactId)!;
          return { artifactId: stored.id, name: stored.name, mediaType: stored.contentType, reason: "this model does not read video" };
        });
      if (refused.length)
        return send(422, {
          code: "attachment_unsupported",
          message: "The model does not read one of the message's files.",
          details: { parts: refused },
        });
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
    if (path === "/v1/environments") return send(200, { environments: environments ? ENVIRONMENTS : [] });
    if (path === "/v1/environments/team%2Fbuild") return send(200, ENVIRONMENTS[0]);
    if (path === "/v1/tenant/credential-coverage") {
      const { agentId, environmentId } = JSON.parse(raw) as { agentId: string; environmentId?: string };
      coverage.push(environmentId ?? null);
      const covered = environmentId === "team/build";
      return send(200, {
        agentId,
        environmentId: environmentId ?? null,
        complete: covered,
        // Only the Tenant with Environments has an agent that declares an MCP server.
        entries: !environments ? [] : [
          {
            kind: "mcp",
            name: "tickets",
            serverName: "tickets",
            url: "https://mcp.tickets.example/mcp",
            required: false,
            status: covered ? "covered" : "missing",
            ...(covered ? { credential: { environmentId, name: "tickets" } } : {}),
            message: covered ? "Sends tickets." : "Called without a credential.",
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
    coverage: (string | null)[];
    uploads: Upload[];
    commands: Command[];
  }) => Promise<void>,
  environments = false,
) {
  const runtime = await fakeRuntime(environments);
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

test("a session an application created for another owner, on an Environment and with info, opens with its history", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Where is order 42?" }).waitFor();
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    await page.getByRole("link", { name: "Environment: team/build", exact: true }).waitFor();
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

test("the session list shows every session and filters on an agent, from the table and the sidebar", async () => {
  await withStudio(async ({ page, studioUrl }) => {
    const rows = (count: number) =>
      page.waitForFunction((n) => document.querySelectorAll("tbody tr").length === n, count);
    await page.getByRole("link", { name: ALICE_SESSION, exact: true }).waitFor();
    await rows(4);
    await page.getByRole("button", { name: "Filter by agent" }).click();
    await page.getByRole("menuitemcheckbox", { name: /^Shipping/u }).click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/sessions?agent=${FLOW}`);
    await rows(1);
    await page.getByRole("link", { name: FLOW_SESSION, exact: true }).waitFor();
    // A flow's embedded agent, not registered, is a filter too.
    await page.getByRole("link", { name: new RegExp(`^${CHILD_AGENT}`, "u") }).click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/sessions?agent=${CHILD_AGENT}`);
    await page.getByRole("link", { name: CHILD_SESSION, exact: true }).waitFor();
    await rows(1);
    // An agent's page is its filtered list.
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}`);
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/sessions?agent=${AGENT}`);
    await page.getByRole("link", { name: ALICE_SESSION, exact: true }).click();
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
  });
});

test("New session creates the session for the local developer, with no Environment when the Tenant has none", async () => {
  await withStudio(async ({ page, puts }) => {
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByRole("menuitem", { name: "Orders" }).click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await page.waitForURL(new RegExp(`/agents/${AGENT}/sessions/[0-9a-f-]{36}$`, "u"));
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.body.agentId, AGENT);
    assert.equal(puts[0]!.body.ownerUserId, "local-developer");
    assert.equal(puts[0]!.body.environment, undefined);
    // Its Environment tab says it has none: no sandbox, no secrets.
    await page.getByText("Environment: None", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByText("This session names no Environment", { exact: false }).waitFor();
  });
});

test("New session names the Environment picked, checks its coverage, and refuses one guarded for another owner", async () => {
  await withStudio(async ({ page, studioUrl, puts, coverage }) => {
    const sheet = page.getByRole("dialog", { name: "New session · Orders" });
    const start = async () => {
      await page.goto(`${studioUrl}/tenants/${TENANT}`);
      await page.getByRole("button", { name: "New session" }).click();
      await page.getByRole("menuitem", { name: "Orders" }).click();
      await sheet.waitFor();
    };
    // None: no sandbox, no credentials.
    await start();
    await sheet.getByText("No credential", { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("radio", { name: /users\/alice/u }).isDisabled(), true);
    await sheet.getByRole("button", { name: "Start session" }).click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.body.environment, undefined);
    // An Environment: its coverage, then a session that names it.
    await start();
    await sheet.getByRole("radio", { name: /team\/build/u }).check();
    await sheet.getByText("Covered", { exact: true }).waitFor();
    await sheet.getByText("Sends tickets", { exact: true }).waitFor();
    await sheet.getByRole("button", { name: "Start session" }).click();
    await page.getByRole("link", { name: "Environment: team/build", exact: true }).waitFor();
    assert.equal(puts.length, 2);
    assert.equal(puts[1]!.body.environment, "team/build");
    assert.equal(puts[1]!.body.ownerUserId, "local-developer");
    assert.ok(coverage.includes("team/build"));
  }, true);
});

test("a flow node in the Workflow tree opens its child session, whose agent is not registered", async () => {
  await withStudio(async ({ page, studioUrl, puts }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${FLOW}/sessions/${FLOW_SESSION}`);
    await page.getByRole("main").getByRole("link", { name: new RegExp(CHILD_AGENT, "u") }).first().click();
    await page.waitForURL(`${studioUrl}/tenants/${TENANT}/agents/${CHILD_AGENT}/sessions/${CHILD_SESSION}`);
    await page.locator("article", { hasText: "Route via Rotterdam." }).waitFor();
    // Back to the flow from the child.
    await page.getByRole("link", { name: FLOW_SESSION, exact: true }).waitFor();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByText(CHILD_AGENT).first().waitFor();
    assert.deepEqual(puts, []);
  });
});

test("files attached to a message are uploaded into the session, then sent as its file parts", async () => {
  await withStudio(async ({ page, studioUrl, uploads, commands }) => {
    await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${ALICE_SESSION}`);
    await page.locator("article", { hasText: "Order 42 ships today." }).waitFor();
    const picker = page.locator('input[type="file"]');
    // The model reads text, images and PDFs.
    assert.equal(
      await picker.getAttribute("accept"),
      "text/*,.md,.json,.csv,.txt,image/*,application/pdf",
    );
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

test("a file the model does not read keeps the draft, says why, and is not uploaded again on resend", async () => {
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
    await page.getByRole("alert").filter({ hasText: "The model does not read one of the message's files." }).waitFor();
    const chips = page.locator('[data-slot="attachment"]');
    await chips.filter({ hasText: "clip.mp4" }).getByText("this model does not read video").waitFor();
    assert.equal(await chips.filter({ hasText: "notes.txt" }).getByText("14 B").count(), 1);
    assert.equal(await message.inputValue(), "What happens here?");
    assert.equal(uploads.length, 2);
    assert.equal(commands.length, 1);
    // Without the video, the same draft goes; the text file is not uploaded twice.
    await page.getByRole("button", { name: "Remove clip.mp4" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="attachment"]').length === 0);
    assert.equal(uploads.length, 2);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1]!.body.parts, [
      { type: "text", text: "What happens here?" },
      { type: "file", artifactId: "art_2", version: 1 },
    ]);
    assert.notEqual(commands[1]!.body.idempotencyKey, commands[0]!.body.idempotencyKey);
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
    await page.waitForURL(/inspector=artifacts&artifact=art_seed&artifactVersion=1/u);
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
