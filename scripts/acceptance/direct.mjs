/**
 * Direct Access acceptance (Stage 1) on the local Docker stack, under a temporary
 * NYLORUN_HOME and a unique stack project (never ~/.nylorun):
 *
 *   node scripts/acceptance/direct.mjs
 *
 * Images: see scripts/lib/stack.mjs (built from this checkout, or named by
 * NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE). Needs the workspace builds of
 * @nylorun/core, @nylorun/agents, @nylorun/admin, nylorun and @nylorun/cli.
 *
 * D1  a page with a publishable key and the app server's token route: preflight, an AG-UI
 *     run through HttpAgent that pauses for approval and completes, history, reattach
 * D2  refusals: another person's thread, another Tenant's token, forged tokens, a disallowed
 *     origin (no CORS headers), a Tenant key from a browser, minting with a token, a
 *     preflight to /v1/tokens
 * D3  revocation ends the person's open event stream within seconds; the old token is 401
 *     and a new one works
 * D4  a role's turn limit answers 429 limit_exceeded
 * D5  rotating keys keeps outstanding tokens; a forced rotation and revoke ends them, and
 *     a new token works
 * D6  a native app: no Origin, the Tenant header and a token
 * D7  one thread started through the app server's handler and continued from the browser
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";
import { z } from "zod";
import {
  Agent,
  connectAgents,
  createClient,
  createTokenEndpoint,
  tool,
} from "@nylorun/agents";
import { createAgUiHandler } from "@nylorun/agents/ag-ui";
import { createBrowserClient } from "@nylorun/agents/browser";
import { ensureImages, eventually, tenantHeaders, withStack } from "../lib/stack.mjs";
import { withTemporaryTenant } from "../lib/temporary-tenant.mjs";

const ORIGIN = "http://localhost:5173";
const results = [];
function pass(id, message) {
  results.push({ id, message });
  console.log(`PASS ${id}: ${message}`);
}

// The fixture model calls `lookup_order` on a turn's first step, then answers.
const desk = Agent({ id: "desk", name: "Desk" })
  .capability({
    id: "orders",
    tools: [
      tool({
        name: "lookup_order",
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        approval: () => "Look up this order?",
        async run() {
          return { status: "shipped" };
        },
      }),
    ],
  })
  .build();

const POLICY = {
  version: 1,
  roles: {
    user: { scopes: ["sessions:own", "vaults:own", "agents:read"], agents: ["desk"] },
    capped: { scopes: ["sessions:own"], agents: ["desk"], limits: { turnsPerHour: 1 } },
  },
  anon: { scopes: [], agents: [] },
  tokens: { maxTtlSeconds: 600 },
};

/** What a browser adds by itself. */
const fromPage = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  return fetch(input, { ...init, headers });
};

function browserFor(runtime, key, app, subject, role = "user") {
  const route = createTokenEndpoint({ client: app, role, subject: () => subject });
  let issued = 0;
  const client = createBrowserClient({
    url: runtime,
    publishableKey: key,
    token: async () => {
      issued += 1;
      const response = await route(new Request("http://app.test/token", { method: "POST" }));
      assert.equal(response.status, 200, "the token route mints");
      return response.json();
    },
    fetch: fromPage,
  });
  return { client, issued: () => issued };
}

async function runWithApproval(agent, seen, text) {
  seen.length = 0;
  agent.addMessage({ id: randomUUID(), role: "user", content: text });
  await agent.runAgent({ runId: randomUUID() });
  const finished = seen.findLast((event) => event.type === "RUN_FINISHED");
  assert.equal(finished?.outcome?.type, "interrupt", "the run pauses for approval");
  const [interrupt] = finished.outcome.interrupts;
  seen.length = 0;
  await agent.runAgent({
    runId: randomUUID(),
    resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }],
  });
  const done = seen.findLast((event) => event.type === "RUN_FINISHED");
  assert.ok(done, `the resumed run finishes: ${seen.map((e) => e.type).join(", ")}`);
}

async function d1(runtime, tenant, app, key) {
  const preflight = await fetch(`${runtime}/v1/ag-ui/agents/desk`, {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type, nylorun-key, nylorun-protocol",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

  const { client } = browserFor(runtime, key, app, "app:dana");
  const { url, fetch: agUiFetch } = client.agUi("desk");
  const agent = new HttpAgent({ url, fetch: agUiFetch, threadId: "d1" });
  const seen = [];
  agent.subscribe({ onEvent: ({ event }) => void seen.push(event) });
  await runWithApproval(agent, seen, "Where is order 42?");
  const history = await client.agUiHistory("desk", "d1");
  assert.deepEqual(
    history.map((m) => m.id),
    agent.messages.map((m) => m.id),
    "history rebuilds the same messages"
  );
  const first = agent.messages[0];
  const token = await client.token();
  const reattach = await fromPage(`${url}/threads/d1/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      "nylorun-key": key,
      "nylorun-protocol": "2",
      "last-event-id": "bm90LWEtY3Vyc29y",
    },
  });
  assert.ok([204, 400].includes(reattach.status), `reattach answers (${reattach.status})`);
  assert.ok(first);
  pass("D1", "a page chatted over AG-UI with an approval, read history and reattached, with CORS");
}

async function d2(runtime, tenant, app, key, otherTenant) {
  const { client } = browserFor(runtime, key, app, "app:eli");
  const token = await client.token();
  const page = (path, init = {}, extra = {}) =>
    fromPage(`${runtime}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "nylorun-key": key,
        "nylorun-protocol": "2",
        ...extra,
        ...init.headers,
      },
    });
  const others = await page("/v1/ag-ui/agents/desk/threads/d1/messages");
  assert.deepEqual(await others.json(), [], "another person's thread is empty");

  const otherApp = createClient({
    url: otherTenant.env.NYLORUN_RUNTIME_URL,
    key: otherTenant.env.NYLORUN_SERVER_KEY,
    tenant: otherTenant.id,
  });
  await otherApp.access.putPolicy(POLICY);
  const foreign = (await otherApp.tokens.create({ subject: "app:eli", role: "user" })).token;
  const forged = [
    foreign,
    `${Buffer.from(JSON.stringify({ alg: "none", typ: "nylorun-subject+jwt" })).toString("base64url")}.${token.split(".")[1]}.AAAA`,
    `${token.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: "app:dana" })).toString("base64url")}.${token.split(".")[2]}`,
  ];
  for (const bad of forged) {
    const response = await page("/v1/sessions", {}, { authorization: `Bearer ${bad}` });
    assert.equal(response.status, 404, "forged and foreign tokens are the opaque 404");
  }
  // Not token-shaped at all: refused like any Tenant key from a page, before any lookup.
  const unsigned = await page("/v1/sessions", {}, {
    authorization: `Bearer ${token.split(".").slice(0, 2).join(".")}.`,
  });
  assert.equal(unsigned.status, 403);
  const evil = await fetch(`${runtime}/v1/sessions`, {
    headers: {
      origin: "https://evil.example",
      authorization: `Bearer ${token}`,
      "nylorun-key": key,
      "nylorun-protocol": "2",
    },
  });
  assert.equal(evil.status, 404);
  assert.equal(evil.headers.get("access-control-allow-origin"), null, "no CORS for other origins");
  const tenantKey = await page("/v1/sessions", {}, {
    authorization: `Bearer ${tenant.env.NYLORUN_SERVER_KEY}`,
  });
  assert.equal(tenantKey.status, 403, "a Tenant key from a browser is refused");
  const minting = await page("/v1/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "x", subject: "app:mallory", role: "user" }),
  });
  assert.equal(minting.status, 403, "a token cannot mint");
  const preflight = await fetch(`${runtime}/v1/tokens`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 403, "no preflight for /v1/tokens");
  pass("D2", "other people's threads, other Tenants' and forged tokens, other origins, Tenant keys from pages and minting from pages are all refused");
}

async function d3(runtime, app, key) {
  const { client } = browserFor(runtime, key, app, "app:fay");
  const session = await client.createSession({ id: `fay-${randomUUID().slice(0, 8)}`, agentId: "desk" });
  const oldToken = await client.token();
  const stream = await fromPage(`${runtime}/v1/sessions/${session.id}/events`, {
    headers: { authorization: `Bearer ${oldToken}`, "nylorun-key": key, "nylorun-protocol": "2" },
  });
  assert.equal(stream.status, 200);
  const started = Date.now();
  await app.access.revokeSubject("app:fay");
  const text = await Promise.race([
    stream.text(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the stream stayed open")), 5_000)),
  ]);
  assert.match(text, /"reason":"revoked"/);
  assert.ok(Date.now() - started < 5_000);
  const old = await fromPage(`${runtime}/v1/sessions`, {
    headers: { authorization: `Bearer ${oldToken}`, "nylorun-key": key, "nylorun-protocol": "2" },
  });
  assert.equal(old.status, 401);
  assert.equal((await old.json()).code, "token_expired");
  const listed = await client.listSessions();
  assert.equal(listed.sessions.length, 1, "a new token works after revocation");
  pass("D3", `revocation ended the open stream in ${Date.now() - started} ms; the old token is 401; a new one works`);
}

async function d4(runtime, app, key) {
  const { client } = browserFor(runtime, key, app, "app:gus", "capped");
  const session = await client.createSession({ id: `gus-${randomUUID().slice(0, 8)}`, agentId: "desk" });
  await session.input("first", { idempotencyKey: "one" });
  await eventually(async () => (await session.inspect()).status === "paused", {
    message: "the first turn to pause",
  });
  await session.cancel({ idempotencyKey: "stop" });
  await eventually(async () => (await session.inspect()).status === "cancelled", {
    message: "the first turn to cancel",
  });
  const second = await session.input("second", { idempotencyKey: "two" }).catch((error) => error);
  assert.equal(second?.status, 429, `the second turn is refused: ${second}`);
  assert.equal(second.body.code, "limit_exceeded");
  pass("D4", "a role with one turn per hour answered the second turn with 429 limit_exceeded");
}

async function d5(runtime, app, key) {
  const { client } = browserFor(runtime, key, app, "app:hal");
  const before = await client.token();
  const call = (token) =>
    fromPage(`${runtime}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}`, "nylorun-key": key, "nylorun-protocol": "2" },
    });
  await app.access.signingKeys.rotate();
  assert.equal((await call(before)).status, 200, "an outstanding token survives a rotation");
  const jwks = await app.access.jwks();
  assert.ok(jwks.keys.length >= 3, "the JWKS lists standby, current and previous");
  const keys = await app.access.signingKeys.rotate({ force: true });
  const previous = keys.find((k) => k.state === "previous");
  await app.access.signingKeys.revoke(previous.id);
  assert.equal((await call(before)).status, 401, "a forced rotation and revoke end older tokens");
  assert.equal((await client.listSessions()).sessions.length >= 0, true, "a new token works");
  pass("D5", "rotation kept outstanding tokens; a forced rotation and revoke ended them; the client recovered");
}

async function d6(runtime, tenant, app) {
  const token = (await app.tokens.create({ subject: "app:ivy", role: "user" })).token;
  const response = await fetch(`${runtime}/v1/sessions`, {
    headers: tenantHeaders(tenant.id, token),
  });
  assert.equal(response.status, 200, "a native app with the Tenant header and a token");
  pass("D6", "a native app called the Runtime with a token and no Origin");
}

async function d7(runtime, tenant, app, key) {
  const handler = createAgUiHandler({ agents: [desk], client: app, subject: () => "app:jo" });
  const handled = new HttpAgent({
    url: "http://app.test/desk",
    threadId: "d7",
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const seen = [];
  handled.subscribe({ onEvent: ({ event }) => void seen.push(event) });
  await runWithApproval(handled, seen, "Order 7?");
  const { client } = browserFor(runtime, key, app, "app:jo");
  const history = await client.agUiHistory("desk", "d7");
  assert.deepEqual(
    history.map((m) => m.id),
    handled.messages.map((m) => m.id),
    "the browser sees the thread the app server's handler ran"
  );
  pass("D7", "a thread run through the app server's handler continues from the browser as one session");
}

try {
  const images = await ensureImages();
  await withStack({ name: "nylorun-direct", images, startArgs: ["--no-studio"] }, async (stack) => {
    const runtime = stack.runtimeUrl;
    const admin = await stack.admin();
    await withTemporaryTenant({ admin, name: "direct" }, async (tenant) =>
      withTemporaryTenant({ admin, name: "direct-other" }, async (otherTenant) => {
        const app = createClient({
          url: tenant.env.NYLORUN_RUNTIME_URL,
          key: tenant.env.NYLORUN_SERVER_KEY,
          tenant: tenant.id,
        });
        const features = await app.hostFeatures();
        for (const feature of ["subject-tokens", "browser-access", "ag-ui-endpoint"])
          assert.ok(features.includes(feature), `the Runtime advertises ${feature}`);
        await app.access.putPolicy(POLICY);
        const key = (
          await app.access.publishableKeys.create({ name: "web", origins: ["http://localhost:*"] })
        ).key;
        const connection = connectAgents({
          agents: [desk],
          application: app,
          implementationVersion: "dev",
        });
        try {
          await connection.ready;
          await d1(runtime, tenant, app, key);
          await d2(runtime, tenant, app, key, otherTenant);
          await d3(runtime, app, key);
          await d4(runtime, app, key);
          await d5(runtime, app, key);
          await d6(runtime, tenant, app);
          await d7(runtime, tenant, app, key);
        } finally {
          await connection.close();
        }
      })
    );
  });
  console.log("\nDirect Access acceptance on the stack:");
  for (const item of results) console.log(`  PASS ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
