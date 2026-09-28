/**
 * Remote access check (Phase 2, W2.3): an app server on this machine reaching a
 * Runtime on another machine through its reverse proxy, as DEPLOYMENT.md
 * "Reaching the Runtime from another machine" sets it up.
 *
 *   NYLORUN_RUNTIME_URL=https://runtime.example.com \
 *   NYLORUN_TENANT=tn_… NYLORUN_SERVER_KEY=… \
 *   node scripts/acceptance/remote.mjs --placement lan --fixture-model
 *
 * Use a Tenant made for this check (`npx @nylorun/cli tenant create
 * remote-check` on the Runtime's machine, outside a Project): `--fixture-model`
 * switches its model calls to the Runtime's deterministic fixture model.
 *
 * R1  the proxy serves /health over TLS, answers the Admin API with 403 and
 *     passes Origin through, so the Runtime still refuses browsers
 * R2  a chat with an approval through the AG-UI handler: the connection is
 *     dropped mid-run, reattach sends the rest, and the approved tool runs in
 *     this machine's executor
 * R3  an event stream and the executor's connection stay open through
 *     `--idle-minutes` (default 10) of silence, with keepalives arriving
 *     unbuffered, and both work afterwards
 *
 * Prints a summary to paste into the PR. It never prints the key.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Agent, connectAgents, createClient, tool } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";

const { values: flags } = parseArgs({
  options: {
    placement: { type: "string", default: "unspecified" },
    "idle-minutes": { type: "string", default: "10" },
    "fixture-model": { type: "boolean", default: false },
  },
});
const idleMinutes = Number(flags["idle-minutes"]);
assert.ok(Number.isFinite(idleMinutes) && idleMinutes >= 0, "--idle-minutes must be a number");

const url = process.env.NYLORUN_RUNTIME_URL?.replace(/\/$/, "");
const tenant = process.env.NYLORUN_TENANT;
const key = process.env.NYLORUN_SERVER_KEY;
if (!url || !tenant || !key)
  throw new Error("Set NYLORUN_RUNTIME_URL (the reverse proxy), NYLORUN_TENANT and NYLORUN_SERVER_KEY.");
const target = new URL(url);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
assert.ok(
  target.protocol === "https:" || loopback,
  "The reverse proxy must use TLS: the Tenant key travels on every request.",
);
if (!flags["fixture-model"])
  throw new Error(
    "Pass --fixture-model with a Tenant made for this check: the checks rely on the fixture model calling lookup_order.",
  );

const SUBJECT = "remote:check";
const results = [];
const started = Date.now();
function pass(id, message) {
  results.push({ id, message });
  console.log(`PASS ${id}: ${message}`);
}
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The handler's session id for a person's thread (`sessionIdFor` in agents/src/ag-ui/handler.ts). */
const sessionOf = (subject, agentId, threadId) =>
  createHash("sha256").update(`${subject}\u0000${agentId}\u0000${threadId}`).digest("hex").slice(0, 32);

/** The first interrupt of a run's RUN_FINISHED (AG-UI puts it on the event or its outcome). */
function interruptOf(events) {
  const finished = events.find((e) => e.type === "RUN_FINISHED");
  return (finished?.interrupts ?? finished?.outcome?.interrupts ?? [])[0];
}

const runtimeHeaders = (extra = {}) => ({
  authorization: `Bearer ${key}`,
  "Nylorun-Tenant": tenant,
  "Nylorun-Protocol": "2",
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
  for (const path of ["/v1/admin/status", "/v1/admin/tenants"]) {
    const admin = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(admin.status, 403, `the proxy blocks ${path} (got ${admin.status})`);
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

// The fixture model calls lookup_order on a turn's first step, then answers.
const agent = Agent({ id: "remote-check", name: "Remote check" })
  .use({
    id: "orders",
    tools: [
      tool({
        name: "lookup_order",
        input: z.object({ orderId: z.string() }),
        output: z.object({ orderId: z.string(), status: z.string() }),
        approval: ({ orderId }) => `Look up order ${orderId}?`,
        async run({ orderId }) {
          return { orderId, status: "shipped" };
        },
      }),
    ],
  })
  .build();

async function main() {
  const version = await r1();
  const seed = await fetch(`${url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtimeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
  });
  assert.ok(seed.ok, `seeding the fixture model: ${seed.status} ${await seed.text()}`);

  // The executor's own connection, counted so a reconnect during the idle window shows.
  let executorConnects = 0;
  const client = createClient({
    url,
    key,
    tenant,
    fetch: (input, init) => {
      if (new URL(String(input)).pathname === "/v1/executors/connect") executorConnects += 1;
      return fetch(input, init);
    },
  });
  const connection = connectAgents({ agents: [agent], application: client });
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
    await connection.ready;
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
    const connectsBefore = executorConnects;
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
    assert.equal(executorConnects, connectsBefore, "the executor stayed connected (no reconnect while idle)");

    // After the silence: the open stream delivers a new turn, and the executor runs a tool.
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
    assert.ok(done.some((e) => e.type === "TOOL_CALL_RESULT"), "the executor ran the tool after the idle window");
    idleStream.abort();
    await watching;
    pass(
      "R3",
      `${seconds(idleMs)} idle: the event stream stayed open (${keepalives.length} keepalives, largest gap ${seconds(maxGap)}), the executor never reconnected, and both worked in ${seconds(Date.now() - t1)} afterwards`,
    );

    const cert = await certificate();
    console.log(`
Remote access check (paste into the PR)
  placement     ${flags.placement}
  proxy         ${target.origin}
  certificate   ${cert}
  runtime       ${version}
  idle window   ${idleMinutes} min
  duration      ${seconds(Date.now() - started)}
  finished      ${new Date().toISOString()}
${results.map((r) => `  PASS ${r.id}  ${r.message}`).join("\n")}`);
  } finally {
    idleStream.abort();
    await connection.close();
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
