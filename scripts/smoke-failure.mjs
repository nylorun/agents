#!/usr/bin/env node
// Failures around a model call on a real `nylorun start` Tenant: a Worker killed
// during a model effect (Runtime architecture §11.4 and §17, case 3), and the
// Model Gate's hop (the gateway container, blueprint P1.1):
//
//   node scripts/smoke-failure.mjs      # npm run test:failure
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout
// unless NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI).
// Needs the CLI and @nylorun/admin built.
//
// 1. A stub OpenAI-compatible model runs in a container on the Compose network,
//    from the Runtime image. It counts calls, and holds every call open until
//    it is released. The Tenant's model is pointed at it (`PUT /v1/tenant/model`,
//    provider `custom`), so no test hook is needed in the Runtime.
// 2. A turn starts; its model effect is committed as `invoking` and the call
//    reaches the stub, which holds it.
// 3. `docker compose kill runtime` mid-call, then `docker compose start runtime`.
//    The gateway keeps the call (it is keyed by the effect id, P1.2).
// 4. Restate retries the advance on the restarted Runtime, which takes the
//    session over once the dead Worker's lease lapses, re-sends the journaled
//    call and joins it: the turn completes, nothing is `uncertain`, and the stub
//    saw one call.
//    The harness (F6.2) runs the turn and connects again to the restarted Runtime.
// 5. The same for a graceful stop (SIGTERM) mid-call.
// 5a. The harness killed (kill -9) mid model call: the gateway keeps the call; the
//     restarted harness re-sends and joins it, so the stub saw one call.
// 5b. The harness killed mid `bash`: the effect is uncertain, the session waits.
// 6. Every call crossed the gateway (one model_call line per call); the
//    runtime runs with the gate.
// 7. Gateway stopped: the turn fails with model.transient, nothing becomes
//    uncertain, and once it is back the next turn completes.
// 8. Gateway killed mid-call: the same, and the stub's request is closed.
// 9. Cancel mid-call: the stub sees its request aborted within 2 s.
// 10. The gateway refuses a caller without the Host root's gateway token, a run
//     token on the keys route, and core's credential on a model call (F5).
// 11. A budget's cap is reached (P1.3): the turn fails with
//     model.budget_exhausted and the stub sees no call.
// 12. A remote MCP call through the Tool Gate (F4.1): a stub MCP server holds
//     `slow`; `docker compose kill runtime` mid-call, then start it. The gateway
//     keeps the call, the restarted Runtime re-sends and joins it: the turn
//     completes, nothing is uncertain, and the server ran the tool once. The
//     gateway logged the call (mcp_request); the runtime never did.
// 13. Runtime and gateway both killed mid MCP call: the restarted gateway finds
//     the call's crossing without an answer and answers uncertain, so the
//     session is uncertain and the server never runs the tool a second time.
//
// The Tenant is always reset at the end.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureImages,
  eventually,
  runtimeGet,
  runtimeHeaders,
  withStack,
} from "./lib/stack.mjs";
import { run } from "./lib/repo.mjs";
import { startStubModel } from "./lib/stub-model.mjs";


/**
 * The stub MCP server (F4.1), run with `node -e` in the Runtime image: Streamable HTTP with JSON
 * answers, one tool `slow` that holds every call until released. It counts calls.
 */
const STUB_MCP = String.raw`
const http = require("node:http");
let calls = 0;
let hold = true;
const held = new Set();
const reply = (res, id, result) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/calls") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ calls, held: held.size }));
  }
  if (req.method === "POST" && req.url === "/hold") {
    hold = true;
    return res.end("{}");
  }
  if (req.method === "POST" && req.url === "/release") {
    hold = false;
    for (const done of held) done();
    held.clear();
    return res.end("{}");
  }
  if (req.url !== "/mcp") {
    res.statusCode = 404;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      res.statusCode = 202;
      return res.end();
    }
    if (message.method === "initialize")
      return reply(res, message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "failure-mcp", version: "0.0.0" },
      });
    if (message.method === "tools/list")
      return reply(res, message.id, {
        tools: [{ name: "slow", description: "Holds until released.", inputSchema: { type: "object", properties: { value: { type: "number" } } } }],
      });
    if (message.method === "tools/call") {
      calls += 1;
      const done = () => reply(res, message.id, { content: [{ type: "text", text: "slow done" }] });
      if (!hold) return done();
      held.add(done);
      res.on("close", () => held.delete(done));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } }));
  });
}).listen(8080, "0.0.0.0");
`;

const MCP_ALIAS = "failure-mcp";
const docker = (args, options = {}) => run("docker", args, { capture: true, timeout: 120_000, ...options });

async function request(runtimeUrl, tenant, path, { method = "GET", body } = {}) {
  // `/v1/tenant/*` is the Management API: it takes the management key.
  const key = path.startsWith("/v1/tenant/") ? tenant.managementKey : tenant.key;
  const response = await fetch(`${runtimeUrl}${path}`, {
    method,
    headers: runtimeHeaders(key, body ? { "content-type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const types = (history) => history.items.map((item) => item.type);
const count = (history, type) => types(history).filter((t) => t === type).length;
/**
 * The history once it holds `n` events of `type`. `/items` reads the session's stream, which
 * the relay feeds from the record after commit (Durable Streams §7, §9.4), so it can trail the
 * session view, most after a restart. The relay keeps a session's order: what the record holds
 * before that event is in the history too.
 */
const historyWith = (read, type, n = 1) =>
  eventually(
    async () => {
      const history = await read();
      if (count(history, type) >= n) return history;
      throw new Error(types(history).join(", "));
    },
    { timeout: 30_000, message: `${n} ${type} in the history` },
  );

try {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const images = await ensureImages();
  await withStack({ name: "nylorun-smoke-failure", images }, async (stack) => {
    const { runtimeUrl } = stack;

    // The stub model on the Compose network, reachable from the host for its counters; it
    // holds every answer until released.
    const mcpName = `${stack.project}-${MCP_ALIAS}`;
    const model = await startStubModel(stack, images.runtime, { hold: true });
    try {
      const stubUrl = model.url;
      const stub = model.stats;

      // The Host's one Tenant; its state is in schema `nylorun`.
      const tenant = await stack.tenant();
      const schema = "nylorun";

      await request(runtimeUrl, tenant, "/v1/tenant/model", {
        method: "PUT",
        body: { requestId: randomUUID(), idempotencyKey: randomUUID(), ...model.model },
      });
      await request(runtimeUrl, tenant, "/v1/agents/bot", {
        method: "PUT",
        body: {
          requestId: randomUUID(),
          implementationVersion: "dev",
          manifest: { id: "bot", name: "Bot", manifestSchemaVersion: 5, capabilities: [] },
        },
      });
      await request(runtimeUrl, tenant, "/v1/sessions/s1", {
        method: "PUT",
        body: { requestId: randomUUID(), agentId: "bot", ownerUserId: "failure-smoke" },
      });
      const message = (n) =>
        request(runtimeUrl, tenant, "/v1/sessions/s1/commands", {
          method: "POST",
          body: { type: "message", requestId: `m${n}`, idempotencyKey: `m${n}`, content: "hello" },
        });
      const session = () => runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s1");
      const history = () => runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s1/items");

      // The turn's model call is in flight: its intent is committed and the stub holds it.
      await message(1);
      await eventually(async () => (await stub()).held === 1, {
        timeout: 60_000,
        message: "the model call to reach the stub",
      });
      assert.equal((await stub()).calls, 1);
      assert.equal(await stack.psql(`SELECT status FROM ${schema}.effects`), "invoking");
      const owner = await stack.psql(`SELECT owner FROM ${schema}.sessions WHERE id = 's1'`);
      assert.ok(owner, "a Worker owns the session");
      console.log(`[failure] model call in flight under ${owner} (${elapsed()})`);

      // Kill the Runtime mid-call: the gateway keeps the call, keyed by the effect id (P1.2).
      // The harness (F6.2) runs the turn; it stays up and connects again.
      const harnessStarted = () =>
        docker(["inspect", "--format", "{{.State.StartedAt}} {{.RestartCount}}", `${stack.project}-harness`]);
      const harnessBefore = await harnessStarted();
      await stack.compose(["kill", "runtime"]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal((await stub()).held, 1, "the gateway kept the provider call after the Runtime died");
      await stack.compose(["start", "runtime"]);
      const ready = () =>
        eventually(
          async () => (await fetch(`${runtimeUrl}/ready`, { signal: AbortSignal.timeout(5_000) })).ok,
          { timeout: 120_000, message: "the restarted Runtime to be ready" },
        );
      await ready();
      console.log(`[failure] Runtime killed and restarted (${elapsed()})`);
      // /ready reports the Tenant's harnesses (no key).
      await eventually(async () => (await stack.ready()).harness?.connected === 1, {
        timeout: 120_000,
        interval: 500,
        message: "the harness to connect to the restarted Runtime",
      });
      assert.equal(await harnessStarted(), harnessBefore, "the harness container kept running");
      assert.equal((await stack.ready()).harness.mode, "remote");

      // The restarted Worker takes the session over once the dead lease lapses, re-sends the
      // journaled call and joins it: the turn completes with one provider call.
      await fetch(`${stubUrl}/release`, { method: "POST" });
      await eventually(async () => (await session()).status === "completed", {
        timeout: 180_000,
        interval: 1000,
        message: "the turn to complete after takeover",
      });
      const recovered = await historyWith(history, "turn.completed");
      assert.equal(count(recovered, "effect.uncertain"), 0, types(recovered).join(", "));
      assert.equal(count(recovered, "turn.completed"), 1);
      assert.equal(count(recovered, "message.assistant"), 1);
      const seqs = recovered.items.map((item) =>
        Number(Buffer.from(item.cursor, "base64url").toString("utf8").split(":").at(-1)),
      );
      // Served history skips the seqs of internal events (transcript.updated): seqs only increase.
      assert.equal(seqs[0], 0, "the history starts at the first event");
      assert.ok(
        seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]),
        "the history has no duplicate and nothing out of order",
      );
      // Give a duplicate call every chance to show up before counting.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.deepEqual(
        await stub(),
        { calls: 1, held: 0, aborted: 0 },
        "one provider call: the restarted Runtime joined the call the gateway kept",
      );
      console.log(`[failure] kill -9 mid-call: recovered with one provider call (${elapsed()})`);

      // A graceful stop (SIGTERM) mid-call: the same.
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      await message(2);
      await eventually(async () => (await stub()).held === 1, {
        timeout: 60_000,
        message: "the second model call to reach the stub",
      });
      await stack.compose(["stop", "runtime"]);
      await stack.compose(["start", "runtime"]);
      await ready();
      await fetch(`${stubUrl}/release`, { method: "POST" });
      await eventually(async () => (await session()).status === "completed", {
        timeout: 180_000,
        interval: 1000,
        message: "the turn to complete after a graceful restart",
      });
      const restarted = await historyWith(history, "turn.completed", 2);
      assert.equal(count(restarted, "effect.uncertain"), 0, types(restarted).join(", "));
      assert.equal(count(restarted, "turn.completed"), 2);
      assert.deepEqual(await stub(), { calls: 2, held: 0, aborted: 0 }, "one call per turn");
      console.log(`[failure] graceful stop mid-call: recovered with one provider call (${elapsed()})`);

      // 5a. The harness (F6.2) killed mid model call: core loses the connection, the gateway
      // keeps the call; the restarted harness re-sends it and joins it. One provider call.
      const harnessHealthy = () =>
        eventually(
          async () =>
            (await stack.compose(["ps", "--format", "{{.Health}}", "harness"])).trim() === "healthy",
          { timeout: 120_000, interval: 1000, message: "the harness to be healthy (connected)" },
        );
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      const beforeHarness = (await stub()).calls;
      await message(20);
      await eventually(async () => (await stub()).held === 1, {
        timeout: 60_000,
        message: "the model call to reach the stub from the harness",
      });
      await stack.compose(["kill", "harness"]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal((await stub()).held, 1, "the gateway kept the provider call after the harness died");
      await stack.compose(["start", "harness"]);
      await harnessHealthy();
      await fetch(`${stubUrl}/release`, { method: "POST" });
      await eventually(async () => (await session()).status === "completed", {
        timeout: 180_000,
        interval: 1000,
        message: "the turn to complete after the harness came back",
      });
      const afterHarness = await historyWith(history, "turn.completed", 3);
      assert.equal(count(afterHarness, "effect.uncertain"), 0, types(afterHarness).join(", "));
      assert.equal(count(afterHarness, "turn.completed"), 3);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.deepEqual(
        await stub(),
        { calls: beforeHarness + 1, held: 0, aborted: 0 },
        "one provider call: the restarted harness joined the call the gateway kept",
      );
      console.log(`[failure] harness killed mid model call: one provider call (${elapsed()})`);

      // 5b. The harness killed mid `bash`: the workspace call is lost with it, so the effect is
      // uncertain and the session waits for a decision; nothing runs it twice.
      await request(runtimeUrl, tenant, "/v1/sessions/s3", {
        method: "PUT",
        body: { requestId: randomUUID(), agentId: "bot", ownerUserId: "failure-smoke", sandbox: {} },
      });
      await request(runtimeUrl, tenant, "/v1/sessions/s3/commands", {
        method: "POST",
        body: { type: "message", requestId: "b1", idempotencyKey: "b1", content: 'call bash {"command":"sleep 120"}' },
      });
      await eventually(
        async () =>
          (await stack.psql(
            `SELECT count(*) FROM ${schema}.effects WHERE session_id = 's3' AND kind = 'tool' AND status = 'invoking'`,
          )) === "1",
        { timeout: 60_000, interval: 250, message: "bash to be running in the harness" },
      );
      await stack.compose(["kill", "harness"]);
      await stack.compose(["start", "harness"]);
      await harnessHealthy();
      const bashed = await eventually(
        async () => {
          const view = await runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s3");
          return ["completed", "failed", "cancelled", "uncertain"].includes(view.status) ? view : undefined;
        },
        { timeout: 180_000, interval: 1000, message: "the bash turn to settle" },
      );
      assert.equal(bashed.status, "uncertain", JSON.stringify(bashed));
      assert.equal(bashed.uncertainEffects.length, 1, JSON.stringify(bashed.uncertainEffects));
      const bashHistory = await historyWith(
        () => runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s3/items"),
        "effect.uncertain",
      );
      assert.equal(count(bashHistory, "effect.uncertain"), 1, types(bashHistory).join(", "));
      assert.equal(count(bashHistory, "tool.completed"), 0, "bash never completed");
      console.log(`[failure] harness killed mid bash: the effect is uncertain (${elapsed()})`);

      // 6. Every call crossed the gateway, and the runtime runs with it.
      const gatewayLogs = (await stack.compose(["logs", "--no-log-prefix", "gateway"])).split("\n");
      const modelCalls = gatewayLogs.filter(
        (line) => line.includes('"message":"model_call"') && line.includes(tenant.id),
      );
      assert.ok(modelCalls.length >= 2, `model_call lines in the gateway: ${modelCalls.length}`);
      assert.ok(!gatewayLogs.join("\n").includes("stub-model-key"), "the gateway never logs the key");
      const runtimeLogs = await stack.compose(["logs", "--no-log-prefix", "runtime"]);
      assert.ok(runtimeLogs.includes('"modelGate":"http://gateway:4100"'), "the runtime calls the gate");

      const settled = () =>
        eventually(
          async () => {
            const view = await session();
            return ["completed", "failed", "cancelled", "uncertain"].includes(view.status)
              ? view
              : undefined;
          },
          { timeout: 120_000, interval: 500, message: "the turn to settle" },
        );
      // s1's turns fail in cases 7, 8 and 11 only: each waits for its own `turn.failed`.
      let failed = 0;
      const lastFailure = async () =>
        (await historyWith(history, "turn.failed", ++failed)).items
          .filter((item) => item.type === "turn.failed")
          .at(-1)?.payload;
      const gatewayHealthy = () =>
        eventually(
          async () =>
            (await stack.compose(["ps", "--format", "{{.Health}}", "gateway"])).trim() === "healthy",
          { timeout: 120_000, interval: 1000, message: "the gateway to be healthy" },
        );

      // 7. Gateway stopped: a clean, retryable failure; nothing uncertain.
      await stack.compose(["stop", "gateway"]);
      await message(3);
      assert.equal((await settled()).status, "failed");
      assert.equal((await lastFailure())?.error?.code, "model.transient");
      assert.equal(count(await history(), "effect.uncertain"), 0, "no uncertain effect");
      await stack.compose(["start", "gateway"]);
      await gatewayHealthy();
      await message(4);
      assert.equal((await settled()).status, "completed");
      console.log(`[failure] gateway stopped: model.transient, then recovered (${elapsed()})`);

      // 8. Gateway killed mid-call: the same, and the provider request is closed.
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      const callsBefore = (await stub()).calls;
      await message(5);
      await eventually(async () => (await stub()).held === 1, {
        timeout: 60_000,
        message: "the model call to reach the stub through the gateway",
      });
      await stack.compose(["kill", "gateway"]);
      assert.equal((await settled()).status, "failed");
      const lost = await lastFailure();
      assert.equal(lost?.error?.code, "model.transient");
      assert.equal(count(await history(), "effect.uncertain"), 0, "no uncertain effect");
      await eventually(async () => (await stub()).held === 0, {
        timeout: 30_000,
        message: "the killed gateway's provider request to close",
      });
      await stack.compose(["start", "gateway"]);
      await gatewayHealthy();
      await fetch(`${stubUrl}/release`, { method: "POST" });
      await message(6);
      assert.equal((await settled()).status, "completed");
      assert.equal((await stub()).calls, callsBefore + 2);
      console.log(`[failure] gateway killed mid-call: model.transient, then recovered (${elapsed()})`);

      // 9. Cancel mid-call reaches the provider through the hop.
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      await message(7);
      await eventually(async () => (await stub()).held === 1, {
        timeout: 60_000,
        message: "the model call to reach the stub",
      });
      const abortedBefore = (await stub()).aborted;
      const cancelledAt = Date.now();
      await request(runtimeUrl, tenant, "/v1/sessions/s1/commands", {
        method: "POST",
        body: { type: "cancel", requestId: "c2", idempotencyKey: "c2" },
      });
      await eventually(async () => (await stub()).aborted === abortedBefore + 1, {
        timeout: 2_000,
        interval: 50,
        message: "the provider request to be aborted within 2 s of the cancel",
      });
      console.log(`[failure] cancel aborted the provider request in ${Date.now() - cancelledAt} ms`);
      assert.equal((await settled()).status, "cancelled");
      await fetch(`${stubUrl}/release`, { method: "POST" });

      // 10. The gateway refuses a caller without the Host root's gateway token.
      const refused = await stack.compose([
        "exec", "-T", "runtime", "node", "-e",
        "fetch('http://gateway:4100/nylorun/v1/model-calls',{method:'POST',headers:{authorization:'Bearer '+'00'.repeat(32)}}).then(r=>console.log(r.status))",
      ]);
      assert.equal(refused.trim(), "401", "a wrong gates token is refused");
      // Two credentials (F5): a run token, signed by the Tenant's key as core mints one, never
      // reaches the keys; core's credential never calls the model.
      const crossed = await stack.compose([
        "exec", "-T", "-e", `SMOKE_TENANT=${tenant.id}`, "runtime", "node", "--input-type=module", "-e",
        [
          "const gate = 'http://gateway:4100/nylorun/v1';",
          "const core = { authorization: 'Bearer ' + process.env.NYLORUN_GATES_TOKEN, 'content-type': 'application/json' };",
          "const now = Math.floor(Date.now() / 1000);",
          "const claims = { iss: 'urn:nylorun:tenant:' + process.env.SMOKE_TENANT, aud: 'nylorun-gates', sub: 'smoke', trn: 'smoke', agt: 'smoke', epc: 1, iat: now, exp: now + 60, jti: 'smoke' };",
          "const signed = await (await fetch(gate + '/keys/sign', { method: 'POST', headers: core, body: JSON.stringify({ args: [{ typ: 'nylorun-run+jwt', claims }] }) })).json();",
          "const run = { authorization: 'Bearer ' + signed.result.token, 'content-type': 'application/json' };",
          "const keys = await fetch(gate + '/keys/sign', { method: 'POST', headers: run, body: JSON.stringify({ args: [{ typ: 'x', claims: {} }] }) });",
          "const model = await fetch(gate + '/model-calls', { method: 'POST', headers: core, body: '{}' });",
          "console.log(keys.status + ' ' + model.status);",
        ].join(" "),
      ]);
      assert.equal(crossed.trim(), "401 401", "a run token on /keys and core's credential on model calls are refused");

      // 11. A cap one token above today's spend: one more call runs, the next is refused at
      // the gateway before it reaches the provider. The ledger recorded every call.
      const spent = await request(runtimeUrl, tenant, "/v1/tenant/usage?period=day");
      assert.ok(spent.calls >= 1 && spent.tokens > 0, `the ledger recorded the calls: ${JSON.stringify(spent)}`);
      await request(runtimeUrl, tenant, "/v1/tenant/budgets", {
        method: "PUT",
        body: { requestId: randomUUID(), budgets: [{ scope: "tenant", period: "day", limitTokens: spent.tokens + 1 }] },
      });
      await message(8);
      assert.equal((await settled()).status, "completed");
      const capped = (await stub()).calls;
      await message(9);
      assert.equal((await settled()).status, "failed");
      assert.equal((await lastFailure())?.error?.code, "model.budget_exhausted");
      assert.equal((await stub()).calls, capped, "a capped call never reaches the provider");
      await request(runtimeUrl, tenant, "/v1/tenant/budgets", {
        method: "PUT",
        body: { requestId: randomUUID(), budgets: [] },
      });
      console.log(`[failure] a reached cap fails the turn with model.budget_exhausted (${elapsed()})`);
      console.log(`[failure] Model Gate cases passed (${elapsed()})`);

      // 12. A remote MCP call through the Tool Gate (F4.1), held by the stub MCP server.
      await docker([
        "run", "--detach", "--rm",
        "--name", mcpName,
        "--network", stack.project, // the Tenant's network is named after its Compose project
        "--network-alias", MCP_ALIAS,
        "--publish", "127.0.0.1::8080",
        "--entrypoint", "node",
        images.runtime,
        "-e", STUB_MCP,
      ]);
      const mcpPublished = (await docker(["port", mcpName, "8080/tcp"])).split("\n")[0].trim();
      const mcpStub = async () => (await fetch(`http://${mcpPublished}/calls`)).json();
      await eventually(() => mcpStub().then(() => true), { timeout: 30_000, message: "the stub MCP server" });
      await request(runtimeUrl, tenant, "/v1/agents/tooler", {
        method: "PUT",
        body: {
          requestId: randomUUID(),
          implementationVersion: "dev",
          manifest: {
            id: "tooler",
            name: "Tooler",
            manifestSchemaVersion: 5,
            capabilities: [
              {
                id: "remote-tools",
                type: "agent",
                mcpServers: { remote: { name: "remote", type: "streamable-http", url: `http://${MCP_ALIAS}:8080/mcp` } },
              },
            ],
          },
        },
      });
      await request(runtimeUrl, tenant, "/v1/sessions/s2", {
        method: "PUT",
        body: { requestId: randomUUID(), agentId: "tooler", ownerUserId: "failure-smoke" },
      });
      const toolSession = () => runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s2");
      const toolHistory = () => runtimeGet(runtimeUrl, tenant.key, "/v1/sessions/s2/items");
      const toolMessage = (n) =>
        request(runtimeUrl, tenant, "/v1/sessions/s2/commands", {
          method: "POST",
          body: { type: "message", requestId: `t${n}`, idempotencyKey: `t${n}`, content: 'call remote__slow {"value":1}' },
        });
      const toolSettled = () =>
        eventually(
          async () => {
            const view = await toolSession();
            return ["completed", "failed", "cancelled", "uncertain"].includes(view.status) ? view : undefined;
          },
          { timeout: 180_000, interval: 1000, message: "the MCP turn to settle" },
        );

      await toolMessage(1);
      await eventually(async () => (await mcpStub()).held === 1, {
        timeout: 60_000,
        message: "the MCP call to reach the stub MCP server",
      });
      await stack.compose(["kill", "runtime"]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal((await mcpStub()).held, 1, "the gateway kept the MCP call after the Runtime died");
      await stack.compose(["start", "runtime"]);
      await ready();
      await fetch(`http://${mcpPublished}/release`, { method: "POST" });
      assert.equal((await toolSettled()).status, "completed");
      const toolRecovered = await historyWith(toolHistory, "turn.completed");
      assert.equal(count(toolRecovered, "effect.uncertain"), 0, types(toolRecovered).join(", "));
      assert.equal(count(toolRecovered, "tool.completed"), 1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.deepEqual(await mcpStub(), { calls: 1, held: 0 }, "the server ran the tool once");
      const mcpLines = (await stack.compose(["logs", "--no-log-prefix", "gateway"]))
        .split("\n")
        .filter((line) => line.includes('"message":"mcp_request"') && line.includes('"what":"call"'));
      assert.ok(mcpLines.length >= 1, "the gateway made the MCP call");
      assert.ok(
        !(await stack.compose(["logs", "--no-log-prefix", "runtime"])).includes("mcp_request"),
        "the runtime never calls the MCP server itself",
      );
      console.log(`[failure] kill -9 mid MCP call: recovered with one tool run (${elapsed()})`);

      // 13. Runtime and gateway both killed mid MCP call: never run twice.
      await fetch(`http://${mcpPublished}/hold`, { method: "POST" });
      await toolMessage(2);
      await eventually(async () => (await mcpStub()).held === 1, {
        timeout: 60_000,
        message: "the second MCP call to reach the stub MCP server",
      });
      await stack.compose(["kill", "runtime"]);
      await stack.compose(["kill", "gateway"]);
      await stack.compose(["start", "gateway"]);
      await gatewayHealthy();
      await stack.compose(["start", "runtime"]);
      await ready();
      assert.equal((await toolSettled()).status, "uncertain");
      await historyWith(toolHistory, "effect.uncertain");
      await fetch(`http://${mcpPublished}/release`, { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal((await mcpStub()).calls, 2, "the lost call was never run again");
      console.log(`[failure] runtime and gateway killed mid MCP call: uncertain, run once (${elapsed()})`);
      console.log(`[failure] Tool Gate cases passed (${elapsed()})`);
    } finally {
      await model.remove();
      await docker(["rm", "--force", mcpName]).catch(() => {});
    }
  });
  console.log("Failure smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
