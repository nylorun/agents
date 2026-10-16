#!/usr/bin/env node
// Track T4's exit test (Wake, D74 to D77) on a single-server install, as one scenario:
//
//   node scripts/t4-exit.mjs        # npm run test:t4-exit
//
// Starts a Tenant (Compose) with its fixture model, saves the agent manifest `wake` with an
// every-minute schedule and a Standard Webhooks endpoint, makes the Agent `wake`, and checks the
// blueprint's exit test clause by clause with no client driving the schedule:
//
// - every run of the schedule lands in the session it names, opened by its first run;
// - a signed delivery sent during a turn is queued, and starts the next turn;
// - a forged signature and a stale timestamp are refused and run nothing; a replayed delivery
//   answers its first run;
// - fires of the schedule while its session is busy add one queued run, and the rest are skipped
//   (`overlap`);
// - a server stopped across due times fires once, late, when it starts again, and backfills
//   none; then the schedule goes on.
//
// The 24-hour run of the exit test is this scenario's schedule, left running: one minute here
// stands in for an hour.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { ensureImages, eventually, runtimeHeaders, withStack } from "./lib/stack.mjs";

const started = Date.now();
const step = (message) => console.log(`\n[t4-exit ${Math.round((Date.now() - started) / 1000)}s] ${message}`);
let failed = false;
const check = (ok, detail) => {
  console.log(`${ok ? "pass" : "fail"} ${detail}`);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The manifest: a schedule every minute on session inbox, a webhook on session alerts, and a tool
 * the Tenant's tool policy holds for approval, which keeps a turn waiting (its session busy) for as
 * long as the check needs.
 */
const manifest = {
  manifestSchemaVersion: 8,
  name: "wake",
  harness: {
    instructions: ["Do what each message asks."],
    tools: [{ name: "hold", inputSchema: { type: "object", properties: {} }, http: { url: "https://example.com/hold", method: "POST" } }],
  },
  runtime: {
    kind: "none",
    triggers: {
      tick: { schedule: "* * * * *", session: "inbox", prompt: "fixture:text" },
      alerts: { webhook: "standard-webhooks", session: "alerts", prompt: "An alert arrived. Look into it." },
    },
  },
};

const images = await ensureImages({ only: ["runtime"] });
await withStack({ name: "nylorun-t4-exit", images, startArgs: ["--no-studio"] }, async (stack) => {
  let tenant = await stack.tenant();
  // Protocol 17: a message to a busy session is queued.
  const headers = (key) => runtimeHeaders(key, { "content-type": "application/json", "Nylorun-Protocol": "17" });
  const api = async (method, path, body, key = tenant.key) => {
    const response = await fetch(`${stack.runtimeUrl}${path}`, {
      method,
      headers: headers(key),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const ok = async (method, path, body, key) => {
    const answer = await api(method, path, body, key);
    assert.ok(answer.status < 300, `${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  const runs = async () => (await ok("GET", "/v1/agents/wake/runs?limit=200")).runs;
  const tickRuns = async () => (await runs()).filter((run) => run.triggerId === "tick");
  const items = async (session) => (await ok("GET", `/v1/sessions/${session}/items?limit=500`)).items;
  const view = (session) => ok("GET", `/v1/sessions/${session}`);
  const idle = (session, timeout = 180_000) =>
    eventually(async () => {
      const v = await view(session);
      return v.activeTurnId === null && v.queuedMessages === 0 && v;
    }, { timeout, interval: 1000, message: `session ${session} to go idle` });
  const send = (session, content) => {
    const requestId = randomUUID();
    return ok("POST", `/v1/sessions/${session}/commands`, { type: "message", requestId, idempotencyKey: requestId, content });
  };

  await ok("PUT", "/v1/tenant/config/seed", { requestId: randomUUID(), fixtureModel: true }, tenant.managementKey);
  // The Tenant's tool policy holds each call of `hold` for a person.
  const policy = await api("PUT", "/v1/tenant/tool-policy", { rules: [{ effect: "ask", tool: "hold", agent: "wake" }] }, tenant.managementKey);
  assert.ok(policy.status < 300, `the tool policy: ${policy.status} ${JSON.stringify(policy.body)}`);

  step("the agent manifest wake, and the Agent wake made from it: its triggers start active");
  await ok("PUT", "/v1/agent-manifests/wake", { requestId: randomUUID(), ...manifest });
  await ok("PUT", "/v1/agents/wake", { requestId: randomUUID(), manifest: "wake" });
  const triggers = (await ok("GET", "/v1/agents/wake/triggers")).triggers;
  check(
    triggers.every((trigger) => trigger.status === "active"),
    `triggers ${triggers.map((trigger) => `${trigger.id} ${trigger.status}`).join(", ")}`,
  );
  const made = await ok("POST", "/v1/agents/wake/triggers/alerts/secret", {});
  const key = Buffer.from(made.secret.slice("whsec_".length), "base64");
  const deliver = (body, { id = `msg_${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000), signWith = key } = {}) => {
    const signature = createHmac("sha256", signWith).update(`${id}.${timestamp}.${body}`).digest("base64");
    return fetch(made.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
      },
      body,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  };

  step("a signed delivery during a turn is queued; forged, stale and replayed deliveries run nothing new");
  await ok("PUT", "/v1/sessions/alerts", { requestId: randomUUID(), agent: "wake", ownerUserId: "installation" });
  await send("alerts", "fixture:slow 20");
  const during = await deliver(JSON.stringify({ alert: "disk_full", host: "db-2" }), { id: "msg_during" });
  check(during.status === 202 && during.body.status === "queued", `a delivery during a turn: ${during.status} ${JSON.stringify(during.body)}`);
  await idle("alerts");
  const alerts = await items("alerts");
  check(alerts.some((item) => item.type === "queue.taken"), "the queued delivery started the next turn (queue.taken)");
  const forged = await deliver("{}", { signWith: Buffer.alloc(32, 1) });
  const stale = await deliver("{}", { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const replay = await deliver(JSON.stringify({ alert: "disk_full", host: "db-2" }), { id: "msg_during" });
  check(forged.status === 401, `a forged signature: ${forged.status}`);
  check(stale.status === 401, `a stale timestamp: ${stale.status}`);
  check(replay.status === 202 && replay.body.runId === during.body.runId, `a replay answers the first run: ${replay.body.runId}`);
  check((await runs()).filter((run) => run.triggerId === "alerts").length === 1, "one run of alerts");

  step("the schedule runs on the session it names, opened by its first run");
  const first = await eventually(async () => (await tickRuns()).find((run) => run.status === "started"), {
    timeout: 150_000,
    interval: 2000,
    message: "the schedule's first run",
  });
  const inbox = await view("inbox");
  check(first.sessionId === "inbox" && inbox.agentId === "wake", `the first run is on ${first.sessionId}, opened on ${inbox.agentId}`);
  await idle("inbox");
  const message = (await items("inbox")).find((item) => item.type === "command.message");
  check(message?.payload?.cause?.kind === "trigger" && message.payload.cause.runId === first.id, "its message names the run that sent it");

  step("fires while the session is busy: one queued run, the rest skipped as overlap");
  // The turn waits for approval of `hold`, so the session stays busy across fires.
  await send("inbox", "fixture:tool hold {}");
  const held = await eventually(
    async () => (await view("inbox")).waits?.find((wait) => wait?.interaction?.kind === "approval")?.interaction,
    { timeout: 60_000, interval: 1000, message: "the inbox turn to wait for approval" },
  );
  const busyFrom = new Date().toISOString();
  const busy = await eventually(
    async () => {
      const later = (await tickRuns()).filter((run) => run.firedAt >= busyFrom);
      return later.some((run) => run.status === "queued") && later.some((run) => run.reason === "overlap") && later;
    },
    { timeout: 240_000, interval: 2000, message: "a queued and an overlapping fire of the schedule" },
  );
  check(busy.filter((run) => run.status === "queued").length === 1, `one queued run while busy (${busy.map((run) => run.status).join(", ")})`);
  // Denied, the turn ends; the queued run's message starts the next.
  const requestId = randomUUID();
  await ok("POST", "/v1/sessions/inbox/commands", { type: "approve", requestId, idempotencyKey: requestId, interactionId: held.id, approved: false });
  await idle("inbox");

  step("a server stopped across due times fires once, late, and backfills none");
  await stack.nylorun(["down"]);
  const stoppedAt = Date.now();
  // The next due time comes within a minute (and its jitter); stay down past it, a second one,
  // and the Host's lateGraceMs (2 minutes), so it is late when the server starts again.
  console.log(`down until ${new Date(stoppedAt + 210_000).toISOString()}`);
  await sleep(210_000);
  const up = new Date().toISOString();
  await stack.nylorun(["up", "--no-studio"]);
  tenant = await stack.tenant();
  await eventually(async () => (await tickRuns()).some((run) => run.firedAt >= up), {
    timeout: 180_000,
    interval: 2000,
    message: "the schedule's run after the restart",
  });
  const after = (await tickRuns()).filter((run) => run.firedAt >= up && run.dueAt < up);
  check(
    after.length === 1 && after[0].late === true,
    `one run, late, for the due times missed while down (${after.map((run) => `${run.dueAt} late=${run.late}`).join(", ") || "none"})`,
  );
  check(
    after.length === 1 && Date.parse(up) - Date.parse(after[0].dueAt) > 60_000,
    "more than one due time passed while down, and none was backfilled",
  );
  const next = await eventually(async () => (await tickRuns()).find((run) => run.dueAt > up && !run.late), {
    timeout: 150_000,
    interval: 2000,
    message: "the schedule's next run after the restart",
  });
  check(next.status === "started" || next.status === "queued", `the schedule goes on: ${next.dueAt} ${next.status}`);
  check((await tickRuns()).every((run) => run.sessionId === "inbox"), "every run of the schedule is on inbox");
});
if (failed) {
  console.error("\nT4 exit test failed");
  process.exitCode = 1;
} else console.log("\nT4 exit test passed");
