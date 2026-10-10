/**
 * Remote access check (Phase 2, W2.3): an app server on this machine reaching a
 * Runtime on another machine through its reverse proxy, as DEPLOYMENT.md
 * "Reaching the Runtime from another machine" sets it up.
 *
 *   NYLORUN_RUNTIME_URL=https://runtime.example.com NYLORUN_SERVER_KEY=… NYLORUN_MANAGEMENT_KEY=… \
 *   node scripts/acceptance/remote.mjs --placement lan --fixture-model \
 *     --tools-url https://tunnel.example.com --tools-port 3000
 *
 * Use an installation made for this check (on the Runtime's machine, `npx
 * nylorun start` in a project made for it; `npx -p nylorun nylo env` there
 * prints its application key, and `npx nylorun key put remote-check --management`
 * prints a management key): `--fixture-model` switches its Tenant's model calls
 * to the Runtime's deterministic fixture model through the Management API.
 * `--tools-url` is where the remote Runtime reaches this machine's tool service,
 * which answers the check agent's `lookup_order` HTTP tool (a tunnel such as
 * ngrok or Cloudflare Tunnel to `--tools-port`).
 *
 * R1  the proxy serves /health over TLS, nothing answers /v1/admin/* (the Runtime
 *     has no Admin API: 404, or 403 from a proxy that still blocks the prefix) and
 *     the proxy passes Origin through, so the Runtime still refuses browsers;
 *     requests name no Tenant (protocol 5: the Host serves one)
 * R2  a chat with an approval through the AG-UI handler: the connection is
 *     dropped mid-run, reattach sends the rest, and the Runtime calls the
 *     approved HTTP tool on this machine's tool service
 * R3  an event stream stays open through `--idle-minutes` (default 10) of
 *     silence, with keepalives arriving unbuffered, and afterwards it carries
 *     a new turn and the Runtime calls the tool on this machine again
 *
 * Prints a summary to paste into the PR. It never prints the keys.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createServer } from "node:http";
import { Agent, PROTOCOL_VERSION, createClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import { startToolService } from "../lib/tool-service.mjs";

const { values: flags } = parseArgs({
  options: {
    placement: { type: "string", default: "unspecified" },
    "idle-minutes": { type: "string", default: "10" },
    "fixture-model": { type: "boolean", default: false },
    "tools-url": { type: "string" },
    "tools-port": { type: "string", default: "3000" },
  },
});
const toolsUrl = flags["tools-url"]?.replace(/\/$/, "");
const toolsPort = Number(flags["tools-port"]);
if (!toolsUrl)
  throw new Error(
    "Pass --tools-url: the URL the remote Runtime reaches this machine's tool service at (a tunnel to --tools-port).",
  );
assert.ok(Number.isInteger(toolsPort) && toolsPort > 0, "--tools-port must be a port number");
const idleMinutes = Number(flags["idle-minutes"]);
assert.ok(Number.isFinite(idleMinutes) && idleMinutes >= 0, "--idle-minutes must be a number");

const url = process.env.NYLORUN_RUNTIME_URL?.replace(/\/$/, "");
const key = process.env.NYLORUN_SERVER_KEY;
const managementKey = process.env.NYLORUN_MANAGEMENT_KEY;
if (!url || !key || !managementKey)
  throw new Error(
    "Set NYLORUN_RUNTIME_URL (the reverse proxy), NYLORUN_SERVER_KEY and NYLORUN_MANAGEMENT_KEY.",
  );
const target = new URL(url);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
assert.ok(
  target.protocol === "https:" || loopback,
  "The reverse proxy must use TLS: the Tenant key travels on every request.",
);
if (!flags["fixture-model"])
  throw new Error(
    "Pass --fixture-model with an installation made for this check: the checks rely on the fixture model calling lookup_order.",
  );

const SUBJECT = "remote:check";
const results = [];
const started = Date.now();
function pass(id, message) {
  results.push({ id, message });
  console.log(`PASS ${id}: ${message}`);
}
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The handler's session id for a person's thread (`sessionIdFor` in sdks/agents/src/ag-ui/handler.ts). */
const sessionOf = (subject, agentId, threadId) =>
  createHash("sha256").update(`${subject}\u0000${agentId}\u0000${threadId}`).digest("hex").slice(0, 32);

/** The first interrupt of a run's RUN_FINISHED (AG-UI puts it on the event or its outcome). */
function interruptOf(events) {
  const finished = events.find((e) => e.type === "RUN_FINISHED");
  return (finished?.interrupts ?? finished?.outcome?.interrupts ?? [])[0];
}

/** Headers with the application key, or `credential` (the management key for `/v1/tenant/*`). */
const runtimeHeaders = (extra = {}, credential = key) => ({
  authorization: `Bearer ${credential}`,
  "Nylorun-Protocol": String(PROTOCOL_VERSION),
  ...extra,
});

/** The proxy's certificate, for the record. */
function certificate() {
  if (target.protocol !== "https:") return Promise.resolve("none (loopback)");
  return new Promise((resolve) => {
    const socket = tlsConnect(
      { host: target.hostname, port: Number(target.port || 443), servername: target.hostname },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(
          `${cert.subject?.CN ?? cert.subjectaltname ?? "?"}, issued by ${cert.issuer?.O ?? cert.issuer?.CN ?? "?"}, valid to ${cert.valid_to}`,
        );
      },
    );
    socket.on("error", (error) => resolve(`unreadable (${error.message})`));
  });
}

/** Reads SSE frames from a response: `{ id, comment, event }` per frame. */
async function* frames(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      yield { id, comment: block.startsWith(":"), event: data ? JSON.parse(data) : undefined };
    }
  }
}

// ── R1: the reverse proxy ──
async function r1() {
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(health.status, 200, "GET /health through the proxy");
  const body = await health.json();
  for (const feature of ["transcript-events", "subject-headers"])
    assert.ok(body.protocol?.features?.includes(feature), `the Runtime advertises ${feature}`);
  // The Runtime has no Admin API (404); a proxy configured for an older Runtime may still
  // block the prefix (403).
  for (const path of ["/v1/admin/status", "/v1/admin/tenants"]) {
    const admin = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(15_000) });
    assert.ok([403, 404].includes(admin.status), `nothing answers ${path} (got ${admin.status})`);
  }
  const browser = await fetch(`${url}/v1/agents`, {
    headers: runtimeHeaders({ origin: "https://evil.example" }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(browser.status, 403, "a request with Origin reaches the Runtime, which refuses it");
  const server = await fetch(`${url}/v1/agents`, {
    headers: runtimeHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(server.status, 200, `the Tenant API answers the application key (${server.status})`);
  pass("R1", `the proxy serves Runtime ${body.version}, blocks the Admin API and keeps Origin`);
  return body.version;
}

/**
 * The fixture model calls lookup_order on a turn's first step, then answers. The tool is an
 * HTTP tool of `service` (this machine), reached through the tunnel; each call waits for approval.
 */
function checkAgent(service) {
  return Agent({ id: "remote-check", name: "Remote check" })
    .tools(
      service.tool(
        "lookup_order",
        {
          input: z.object({ orderId: z.string() }),
          output: z.object({ orderId: z.string(), status: z.string() }),
          approval: "always",
        },
        `${toolsUrl}/lookup_order`,
      ),
    )
    .build();
}

async function main() {
  const version = await r1();
  const seed = await fetch(`${url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtimeHeaders({ "content-type": "application/json" }, managementKey),
    body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
  });
  assert.ok(seed.ok, `seeding the fixture model: ${seed.status} ${await seed.text()}`);

  const client = createClient({ url, key });
  // The tool service, counting the calls that reach this machine through the tunnel.
  const service = await startToolService(
    { lookup_order: ({ orderId }) => ({ orderId, status: "shipped" }) },
    { port: toolsPort },
  );
  const toolCalls = () => service.calls.length;
  const agent = checkAgent(service);
  const handler = createAgUiHandler({
    agents: [agent],
    client,
    subject: (request) => request.headers.get("x-user") ?? undefined,
  });
  const app = createServer(toNodeListener(handler));
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const idleStream = new AbortController();
  try {
    await client.saveAgent(agent);
    const post = (body, signal) =>
      fetch(`${base}/remote-check`, {
        method: "POST",
        headers: { "x-user": SUBJECT, "content-type": "application/json" },
        body: JSON.stringify({ tools: [], context: [], state: {}, forwardedProps: {}, ...body }),
        signal,
      });
    const collect = async (response) => {
      const events = [];
      for await (const { event } of frames(response)) if (event) events.push(event);
      return events;
    };

    // ── R2: chat, drop, reattach, approve ──
    const thread = `remote-${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    const reading = new AbortController();
    const first = await post(
      {
        threadId: thread,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Where is demo-123?" }],
      },
      reading.signal,
    );
    assert.equal(first.status, 200, `run: ${first.status}`);
    let lastId;
    for await (const { id, event } of frames(first)) {
      if (id) lastId = id;
      if (event?.type === "TOOL_CALL_END") break;
    }
    reading.abort();
    assert.ok(lastId, "the run sent a cursor before the drop");
    const again = await fetch(`${base}/remote-check/threads/${thread}/events`, {
      headers: { "x-user": SUBJECT, "last-event-id": lastId },
    });
    assert.equal(again.status, 200, `reattach: ${again.status}`);
    const rest = await collect(again);
    const interrupt = interruptOf(rest);
    assert.ok(interrupt, `reattach delivered the approval: ${JSON.stringify(rest.map((e) => e.type))}`);
    const resumed = await collect(
      await post({
        threadId: thread,
        runId: randomUUID(),
        messages: [],
        resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }],
      }),
    );
    const text = resumed
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    assert.ok(resumed.some((e) => e.type === "TOOL_CALL_RESULT"), "the approved tool ran");
    assert.ok(toolCalls() > 0, "the Runtime called the tool on this machine's tool service");
    assert.ok(text.includes("shipped"), `the answer carries the tool's result: ${text}`);
    pass(
      "R2",
      `chat with an approval, a dropped connection and a reattach completed in ${seconds(Date.now() - t0)}`,
    );

    // ── R3: idle ──
    const person = client.as(SUBJECT);
    const session = await person.session(sessionOf(SUBJECT, agent.id, thread)).inspect();
    assert.equal(session.ownerUserId, SUBJECT, "the thread's session belongs to its subject");
    // Subscribe after everything the thread has so far, so the stream carries only new events.
    let tail;
    for (;;) {
      const page = await person.session(session.id).history(tail ? { cursor: tail } : {});
      if (!page.cursor || page.cursor === tail || page.items.length === 0) break;
      tail = page.cursor;
    }
    const stream = await fetch(`${url}/v1/sessions/${encodeURIComponent(session.id)}/events`, {
      headers: runtimeHeaders({
        accept: "text/event-stream",
        "Nylorun-Subject": SUBJECT,
        "Nylorun-Scopes": "sessions:own",
        ...(tail ? { "last-event-id": tail } : {}),
      }),
      signal: idleStream.signal,
    });
    assert.equal(stream.status, 200, `event stream: ${stream.status}`);
    const keepalives = [];
    const streamed = [];
    let streamEnded = false;
    const watching = (async () => {
      try {
        for await (const { comment, event } of frames(stream)) {
          if (comment) keepalives.push(Date.now());
          if (event) streamed.push(event);
        }
      } catch (error) {
        if (!idleStream.signal.aborted) throw error;
      } finally {
        streamEnded = true;
      }
    })();
    const callsBefore = toolCalls();
    const idleStart = Date.now();
    for (let minute = 1; minute <= idleMinutes; minute += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      console.log(`  idle ${minute}/${idleMinutes} min: ${keepalives.length} keepalives, stream ${streamEnded ? "closed" : "open"}`);
      assert.ok(!streamEnded, `the event stream closed after ${minute} idle minutes`);
    }
    const idleMs = Date.now() - idleStart;
    const gaps = keepalives.map((at, i) => at - (i === 0 ? idleStart : keepalives[i - 1]));
    const maxGap = Math.max(0, ...gaps, keepalives.length ? Date.now() - keepalives.at(-1) : idleMs);
    if (idleMinutes > 0)
      assert.ok(maxGap < 30_000, `keepalives arrive unbuffered (largest gap ${seconds(maxGap)})`);
    // After the silence: the open stream carries a new turn, and the Runtime calls the tool here.
    const t1 = Date.now();
    await collect(
      await post({
        threadId: thread,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Thanks, anything else?" }],
      }),
    );
    const deadline = Date.now() + 30_000;
    while (!streamed.some((e) => e.type === "turn.completed") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(streamed.some((e) => e.type === "turn.completed"), "the idle stream delivered the new turn");
    const other = `remote-${randomUUID().slice(0, 8)}`;
    const paused = await collect(
      await post({
        threadId: other,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "And demo-123 again?" }],
      }),
    );
    const next = interruptOf(paused);
    assert.ok(next, `the second thread paused for approval: ${JSON.stringify(paused.map((e) => e.type))}`);
    const done = await collect(
      await post({
        threadId: other,
        runId: randomUUID(),
        messages: [],
        resume: [{ interruptId: next.id, status: "resolved", payload: { approved: true } }],
      }),
    );
    assert.ok(done.some((e) => e.type === "TOOL_CALL_RESULT"), "the tool ran after the idle window");
    assert.ok(toolCalls() > callsBefore, "the Runtime called the tool on this machine after the idle window");
    idleStream.abort();
    await watching;
    pass(
      "R3",
      `${seconds(idleMs)} idle: the event stream stayed open (${keepalives.length} keepalives, largest gap ${seconds(maxGap)}), and the stream and a tool call to this machine worked in ${seconds(Date.now() - t1)} afterwards`,
    );

    const cert = await certificate();
    console.log(`
Remote access check (paste into the PR)
  placement     ${flags.placement}
  proxy         ${target.origin}
  tools         ${new URL(toolsUrl).origin}
  certificate   ${cert}
  runtime       ${version}
  idle window   ${idleMinutes} min
  duration      ${seconds(Date.now() - started)}
  finished      ${new Date().toISOString()}
${results.map((r) => `  PASS ${r.id}  ${r.message}`).join("\n")}`);
  } finally {
    idleStream.abort();
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await service.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
