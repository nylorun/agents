#!/usr/bin/env node
// Failures around a model call on a real `nylorun start` stack: a Worker killed
// during a model effect (Runtime architecture §11.4 and §17, case 3), and the
// Model Gate's hop (the gateway container, blueprint P1.1):
//
//   node scripts/smoke-failure.mjs      # npm run test:failure
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout
// unless NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI).
// Needs the CLI and @nylorun/admin built.
//
// 1. A stub OpenAI-compatible model runs in a container on the stack network,
//    from the Runtime image. It counts calls, and holds every call open until
//    it is released. The stack's Tenant's model is pointed at it (`PUT /v1/tenant/model`,
//    provider `custom`), so no test hook is needed in the Runtime.
// 2. A turn starts; its model effect is committed as `invoking` and the call
//    reaches the stub, which holds it.
// 3. `docker compose kill runtime` mid-call, then `docker compose start runtime`.
//    The gateway keeps the call (it is keyed by the effect id, P1.2).
// 4. Restate retries the advance on the restarted Runtime, which takes the
//    session over once the dead Worker's lease lapses, re-sends the journaled
//    call and joins it: the turn completes, nothing is `uncertain`, and the stub
//    saw one call.
// 5. The same for a graceful stop (SIGTERM) mid-call.
// 6. Every call crossed the gateway (one model_call line per call); the
//    runtime runs with the gate.
// 7. Gateway stopped: the turn fails with model.transient, nothing becomes
//    uncertain, and once it is back the next turn completes.
// 8. Gateway killed mid-call: the same, and the stub's request is closed.
// 9. Cancel mid-call: the stub sees its request aborted within 2 s.
// 10. The gateway refuses a caller without the stack's token.
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
// The stack is always reset at the end.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureImages,
  eventually,
  hostTenant,
  runtimeGet,
  runtimeHeaders,
  withStack,
} from "./lib/stack.mjs";
import { run } from "./lib/repo.mjs";

/** The stub model, run with `node -e` in the Runtime image. */
const STUB_MODEL = String.raw`
const http = require("node:http");
let calls = 0;
let aborted = 0;
let hold = true;
const held = new Set();
function answer(res) {
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
  const chunk = (body) => res.write("data: " + JSON.stringify({ ...base, ...body }) + "\n\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "stub answer" }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n");
}
/** A tool call to the MCP tool when the request offers it and no tool result came back yet. */
function toolCall(res) {
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
  const chunk = (body) => res.write("data: " + JSON.stringify({ ...base, ...body }) + "\n\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_mcp", type: "function", function: { name: "remote__slow", arguments: "{\"value\":1}" } }] }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n");
}
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/calls") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ calls, held: held.size, aborted }));
  }
  if (req.method === "POST" && req.url === "/hold") {
    hold = true;
    return res.end("{}");
  }
  if (req.method === "POST" && req.url === "/release") {
    hold = false;
    for (const pending of held) answer(pending);
    held.clear();
    return res.end("{}");
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls += 1;
      const body = JSON.parse(raw || "{}");
      const offered = (body.tools ?? []).some((tool) => tool.function?.name === "remote__slow");
      if (offered && body.messages?.at(-1)?.role !== "tool") return toolCall(res);
      if (!hold) return answer(res);
      held.add(res);
      // Closed before it was answered: the caller (the gateway) aborted it.
      res.on("close", () => {
        if (held.delete(res)) aborted += 1;
      });
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8080, "0.0.0.0");
`;

const STUB_ALIAS = "failure-model";

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
  const response = await fetch(`${runtimeUrl}${path}`, {
    method,
    headers: runtimeHeaders(tenant.key, body ? { "content-type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const types = (history) => history.items.map((item) => item.type);
const count = (history, type) => types(history).filter((t) => t === type).length;

try {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const images = await ensureImages();
  await withStack({ name: "nylorun-smoke-failure", images }, async (stack) => {
    const { runtimeUrl } = stack;

    // The stub model on the stack network, reachable from the host for its counters.
    const stubName = `${stack.project}-${STUB_ALIAS}`;
    const mcpName = `${stack.project}-${MCP_ALIAS}`;
    await docker([
      "run", "--detach", "--rm",
      "--name", stubName,
      "--network", `${stack.project}_default`,
      "--network-alias", STUB_ALIAS,
      "--publish", "127.0.0.1::8080",
      "--entrypoint", "node",
      images.runtime,
      "-e", STUB_MODEL,
    ]);
    try {
      const published = (await docker(["port", stubName, "8080/tcp"])).split("\n")[0].trim();
      const stubUrl = `http://${published}`;
      const stub = async () => (await fetch(`${stubUrl}/calls`)).json();
      await eventually(() => stub().then(() => true), { timeout: 30_000, message: "the stub model" });

      // The stack's one Tenant; its state is in schema `nylorun`.
      const tenant = await hostTenant(await stack.admin());
      const schema = "nylorun";

      await request(runtimeUrl, tenant, "/v1/tenant/model", {
        method: "PUT",
        body: {
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          provider: "custom",
          model: "stub",
          baseUrl: `http://${STUB_ALIAS}:8080/v1`,
          // The stub ignores it; the custom provider needs a key.
          auth: { type: "api_key", key: "stub-model-key" },
        },
      });
      await request(runtimeUrl, tenant, "/v1/agents/bot", {
        method: "PUT",
        body: {
          requestId: randomUUID(),
          implementationVersion: "dev",
          manifest: { id: "bot", name: "Bot", manifestSchemaVersion: 4, capabilities: [] },
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

      // The restarted Worker takes the session over once the dead lease lapses, re-sends the
      // journaled call and joins it: the turn completes with one provider call.
      await fetch(`${stubUrl}/release`, { method: "POST" });
      await eventually(async () => (await session()).status === "completed", {
        timeout: 180_000,
        interval: 1000,
        message: "the turn to complete after takeover",
      });
      const recovered = await history();
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
      const restarted = await history();
      assert.equal(count(restarted, "effect.uncertain"), 0, types(restarted).join(", "));
      assert.equal(count(restarted, "turn.completed"), 2);
      assert.deepEqual(await stub(), { calls: 2, held: 0, aborted: 0 }, "one call per turn");
      console.log(`[failure] graceful stop mid-call: recovered with one provider call (${elapsed()})`);

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
      const lastFailure = async () =>
        (await history()).items.filter((item) => item.type === "turn.failed").at(-1)?.payload;
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

      // 10. The gateway refuses a caller without the stack's token.
      const refused = await stack.compose([
        "exec", "-T", "runtime", "node", "-e",
        "fetch('http://gateway:4100/nylorun/v1/model-calls',{method:'POST',headers:{authorization:'Bearer '+'00'.repeat(32)}}).then(r=>console.log(r.status))",
      ]);
      assert.equal(refused.trim(), "401", "a wrong gates token is refused");

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
        "--network", `${stack.project}_default`,
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
            manifestSchemaVersion: 4,
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
          body: { type: "message", requestId: `t${n}`, idempotencyKey: `t${n}`, content: "use the tool" },
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
      const toolRecovered = await toolHistory();
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
      assert.ok(count(await toolHistory(), "effect.uncertain") >= 1, "the lost call is uncertain");
      await fetch(`http://${mcpPublished}/release`, { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal((await mcpStub()).calls, 2, "the lost call was never run again");
      console.log(`[failure] runtime and gateway killed mid MCP call: uncertain, run once (${elapsed()})`);
      console.log(`[failure] Tool Gate cases passed (${elapsed()})`);
    } finally {
      await docker(["rm", "--force", stubName]).catch(() => {});
      await docker(["rm", "--force", mcpName]).catch(() => {});
    }
  });
  console.log("Failure smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
