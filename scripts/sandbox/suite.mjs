#!/usr/bin/env node
// Pod sandboxes end to end (F7.2 8b, S10) on a real cluster:
//
//   npm run test:sandboxes -- --context kind-nylorun --host-address 172.17.0.1
//   npm run test:sandboxes -- --context docker-desktop
//
// Starts a Tenant under a temporary Host root (`nylorun start --no-studio`), points its model at
// a stub OpenAI-compatible model on the Compose network (it counts calls and can hold them),
// runs `nylorun sandbox enable`, then through the Tenant API:
//
// - create a pod sandbox → its engine joins (host epoch > 0); a turn's bash runs in the pod
//   (hostname is the pod's), and the pod's NetworkPolicy keeps the API server closed to the
//   command (the engine waited for it: `sandbox_network_policy_in_force` in its log);
// - stop → suspended (no pod), the next turn resumes it on the same volume;
// - `docker compose kill -s KILL runtime` mid model call: the turn completes, nothing uncertain,
//   one upstream call per model effect;
// - `kubectl delete pod --force` mid model call: a new pod joins (`sandbox.relaunched`), the
//   turn completes with one upstream call per model effect;
// - idle (`limits.idle: 20s`) → suspended; TTL (45 s, retain) → expired, turns refused
//   (`sandbox_expired`), revived by a PUT with a longer TTL; TTL with `onExpiry: delete`;
// - the sandboxes container restarted (`docker restart`) right after a create;
// - reset → a new, empty volume; PVC and pod deleted → `sandbox.lost`, turns refused
//   (`sandbox_lost`) until a reset;
// - no pod mounts a host path; `nylorun sandbox disable` → kind pod is `sandbox_unavailable`.
//
// Needs kubectl, a context with agent-sandbox v1.0.5 or none, the workspace builds (`npm run
// build`), and the images pods use present on the cluster's node (CI: `kind load docker-image`
// of the runtime image and python:3.13-slim). Images: NYLORUN_RUNTIME_IMAGE and
// NYLORUN_SANDBOXES_IMAGE when set (CI), else built from this checkout. Only the named context
// is touched; the namespace this suite creates is deleted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { run } from "../lib/repo.mjs";
import { ensureImages, eventually, hostTenant, runtimeHeaders, withStack } from "../lib/stack.mjs";

const { values: options } = parseArgs({
  options: {
    context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
    "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
  },
});
const context = options.context;
const started = Date.now();
const step = (message) => console.log(`\n[pods ${Math.round((Date.now() - started) / 1000)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The stub model, run with `node -e` in the Runtime image on the Compose network. A request that
 * offers `bash` and whose last message is not a tool result gets a bash call; any other gets
 * an answer that repeats the last tool result. It counts calls, and holds them while asked to.
 */
const STUB_MODEL = String.raw`
const http = require("node:http");
let calls = 0;
let hold = false;
const held = new Set();
function stream(res, delta, finish) {
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
  const chunk = (body) => res.write("data: " + JSON.stringify({ ...base, ...body }) + "\n\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n");
}
function answer(res, body) {
  const last = body.messages?.at(-1);
  const bash = (body.tools ?? []).map((tool) => tool.function?.name).find((name) => /(^|_)bash$/.test(name ?? ""));
  if (bash && last?.role !== "tool")
    return stream(res, { tool_calls: [{ index: 0, id: "call_" + calls, type: "function", function: { name: bash, arguments: JSON.stringify({ command: process.env.COMMAND }) } }] }, "tool_calls");
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  stream(res, { content: "result: " + text }, "stop");
}
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/calls") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ calls, held: held.size }));
  }
  if (req.method === "POST" && req.url === "/hold") { hold = true; return res.end("{}"); }
  if (req.method === "POST" && req.url === "/release") {
    hold = false;
    for (const pending of held) pending();
    held.clear();
    return res.end("{}");
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls += 1;
      const body = JSON.parse(raw || "{}");
      if (!hold) return answer(res, body);
      const done = () => answer(res, body);
      held.add(done);
      res.on("close", () => held.delete(done));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8080, "0.0.0.0");
`;
const STUB_ALIAS = "pods-model";

/** kubectl on the named context only. */
async function kubectl(args, { check = true, timeout = 120_000 } = {}) {
  try {
    return await run("kubectl", ["--context", context, ...args], { capture: true, timeout });
  } catch (error) {
    if (check) throw error;
    return undefined;
  }
}

try {
  const images = await ensureImages({ only: ["runtime", "sandboxes"] });
  await withStack({ name: "nylorun-sbx-pods", images, startArgs: ["--no-studio"] }, async (stack) => {
    const namespace = `nylorun-sbx-${stack.project}`;
    const stubName = `${stack.project}-${STUB_ALIAS}`;
    const docker = (args, extra = {}) => run("docker", args, { capture: true, timeout: 120_000, ...extra });
    let tenant;
    const api = async (method, path, body, { ok = true } = {}) => {
      const response = await fetch(`${stack.runtimeUrl}${path}`, {
        method,
        headers: runtimeHeaders(tenant.key, body ? { "content-type": "application/json" } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : undefined;
      if (ok) assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
      return { status: response.status, body: parsed };
    };
    const sandbox = async (id) => (await api("GET", `/v1/sandboxes/${encodeURIComponent(id)}`)).body;
    const events = async (id) =>
      (await api("GET", `/v1/sandboxes/${encodeURIComponent(id)}/events`)).body.events.map((event) => event.type);
    const until = (what, check, timeout = 180_000) => eventually(check, { timeout, interval: 1000, message: what });
    const observed = (id, state, timeout) =>
      until(`${id} ${state}`, async () => (await sandbox(id)).pod.observed === state, timeout);
    const podOf = async (name) => {
      const pods = JSON.parse(await kubectl(["get", "pods", "-n", namespace, "-l", `nylorun.dev/sandbox=${name}`, "-o", "json"]));
      return pods.items.find((pod) => !pod.metadata.deletionTimestamp);
    };
    let stubUrl;
    const stub = async () => (await fetch(`${stubUrl}/calls`)).json();
    let messages = 0;
    const message = (session) => {
      messages += 1;
      return api("POST", `/v1/sessions/${session}/commands`, {
        type: "message",
        requestId: `m${messages}`,
        idempotencyKey: `m${messages}`,
        content: "run it",
      }, { ok: false });
    };
    const settled = async (session) => {
      let last;
      await until(`${session} settles`, async () => {
        last = (await api("GET", `/v1/sessions/${session}`)).body;
        return ["completed", "failed", "cancelled", "uncertain"].includes(last.status);
      }, 300_000);
      return last;
    };
    const items = async (session) => (await api("GET", `/v1/sessions/${session}/items`)).body.items;
    const lastAnswer = async (session) =>
      JSON.stringify((await items(session)).filter((item) => item.type === "message.assistant").at(-1)?.payload ?? {});
    /** A turn that completes, with exactly `calls` upstream model calls. */
    const turn = async (session, { calls = 2 } = {}) => {
      const before = (await stub()).calls;
      const sent = await message(session);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const done = await settled(session);
      assert.equal(done.status, "completed", JSON.stringify(done));
      await sleep(2000);
      assert.equal((await stub()).calls - before, calls, "one upstream call per model effect");
      return lastAnswer(session);
    };
    const open = (session, sandboxId) =>
      api("PUT", `/v1/sessions/${session}`, {
        requestId: randomUUID(),
        agentId: "bot",
        ownerUserId: "pods-suite",
        sandbox: { id: sandboxId },
      });

    try {
      tenant = await hostTenant(await stack.admin());

      step("stub model on the Compose network");
      // The API server's service address: the pod's NetworkPolicy must keep commands from it.
      const blocked = "10.96.0.1/443";
      const command = `hostname; echo pod > out.txt; (timeout 3 bash -c '</dev/tcp/${blocked}' && echo API-OPEN) || echo API-CLOSED`;
      await docker([
        "run", "--detach", "--rm", "--name", stubName,
        "--network", stack.project, "--network-alias", STUB_ALIAS,
        "--publish", "127.0.0.1::8080",
        "--entrypoint", "node", images.runtime,
        "-e", STUB_MODEL.replace("process.env.COMMAND", JSON.stringify(command)),
      ]);
      stubUrl = `http://${(await docker(["port", stubName, "8080/tcp"])).split("\n")[0].trim()}`;
      await until("the stub model", () => stub().then(() => true), 30_000);
      await api("PUT", "/v1/tenant/model", {
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        provider: "custom",
        model: "stub",
        baseUrl: `http://${STUB_ALIAS}:8080/v1`,
        auth: { type: "api_key", key: "stub-model-key" },
      });
      await api("PUT", "/v1/agents/bot", {
        requestId: randomUUID(),
        implementationVersion: "dev",
        manifest: { id: "bot", name: "Bot", manifestSchemaVersion: 4, capabilities: [] },
      });

      step(`nylorun sandbox enable --context ${context}`);
      const enable = ["sandbox", "enable", "--context", context, "--no-pull"];
      if (options["host-address"]) enable.push("--host-address", options["host-address"]);
      await stack.nylorun(enable, { timeout: 900_000 });
      tenant = await hostTenant(await stack.admin());
      await api("PUT", "/v1/tenant/sandbox", {
        requestId: randomUUID(),
        limits: { idle: "10m", ttl: "2h" },
        lifecycle: { onExpiry: "retain", stopGrace: "10s" },
      });
      const cluster = (await api("GET", "/v1/tenant/sandbox")).body.cluster;
      assert.equal(cluster?.namespace, namespace, JSON.stringify(cluster));

      step("create → the engine joins; a bash turn runs in the pod");
      const created = await api("PUT", "/v1/sandboxes/pods%2Fone", { kind: "pod" });
      assert.equal(created.body.pod.desired, "running");
      await observed("pods/one", "running", 420_000);
      await until("the engine joins", async () => (await events("pods/one")).includes("sandbox.running"), 300_000);
      const name = await stack.psql("SELECT k8s_name FROM nylorun.sandbox_resources WHERE id = 'pods/one'");
      const firstPod = await podOf(name);
      assert.ok(firstPod, "the sandbox's pod exists");
      const log = await kubectl(["logs", "-n", namespace, firstPod.metadata.name, "-c", "workload"]);
      assert.match(log, /sandbox_network_policy_in_force/, "the engine waited for its NetworkPolicy");
      assert.ok(
        !(firstPod.spec.volumes ?? []).some((volume) => volume.hostPath),
        "no host path in the pod",
      );
      await open("s1", "pods/one");
      const first = await turn("s1");
      assert.match(first, new RegExp(firstPod.metadata.name), "bash ran in the pod");
      assert.match(first, /API-CLOSED/, "the API server is closed to the pod's commands");
      const file = await api("POST", "/v1/sessions/s1/sandbox/read", { path: "out.txt" });
      assert.match(JSON.stringify(file.body), /pod/);

      step("stop → suspended; the next turn resumes it on the same volume");
      await api("POST", "/v1/sandboxes/pods%2Fone/stop");
      await observed("pods/one", "suspended");
      await until("no pod while suspended", async () => !(await podOf(name)));
      await turn("s1");
      const kept = await api("POST", "/v1/sessions/s1/sandbox/read", { path: "out.txt" });
      assert.match(JSON.stringify(kept.body), /pod/, "files survive a stop");

      step("kill -9 the runtime mid model call");
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      let before = (await stub()).calls;
      assert.equal((await message("s1")).status, 200);
      await until("a model call held", async () => (await stub()).held === 1);
      await stack.compose(["kill", "-s", "KILL", "runtime"]);
      await stack.compose(["start", "runtime"]);
      await until("the runtime is ready", async () => (await fetch(`${stack.runtimeUrl}/ready`).catch(() => ({ ok: false }))).ok);
      await fetch(`${stubUrl}/release`, { method: "POST" });
      let done = await settled("s1");
      assert.equal(done.status, "completed", JSON.stringify(done));
      await sleep(3000);
      assert.equal((await stub()).calls - before, 2, "one upstream call per model effect after kill -9");
      assert.ok(!(await items("s1")).some((item) => item.type === "effect.uncertain"), "nothing uncertain");

      step("force-delete the pod mid model call");
      await fetch(`${stubUrl}/hold`, { method: "POST" });
      before = (await stub()).calls;
      assert.equal((await message("s1")).status, 200);
      await until("a model call held", async () => (await stub()).held === 1);
      const doomed = await podOf(name);
      await kubectl(["delete", "pod", "-n", namespace, doomed.metadata.name, "--force", "--grace-period=0"]);
      await until("a new pod", async () => {
        const next = await podOf(name);
        return next && next.metadata.uid !== doomed.metadata.uid;
      });
      await until("the new pod joins", async () => (await events("pods/one")).includes("sandbox.relaunched"), 300_000);
      await fetch(`${stubUrl}/release`, { method: "POST" });
      done = await settled("s1");
      assert.equal(done.status, "completed", JSON.stringify(done));
      await sleep(3000);
      assert.equal((await stub()).calls - before, 2, "one upstream call per model effect after a force delete");

      step("TTL (45 s): retain and delete; the sandboxes service restarted after a create");
      await api("PUT", "/v1/sandboxes/pods%2Fttl", { kind: "pod", lifecycle: { ttl: "45s" } });
      await docker(["restart", `${stack.project}-sandboxes`]);
      await observed("pods/ttl", "running", 420_000);
      await open("s-ttl", "pods/ttl");
      await observed("pods/ttl", "expired", 240_000);
      const refused = await message("s-ttl");
      assert.equal(refused.body.code, "sandbox_expired", JSON.stringify(refused.body));
      await api("PUT", "/v1/sandboxes/pods%2Fttl", { lifecycle: { ttl: "1h" } });
      await observed("pods/ttl", "running", 420_000);
      await turn("s-ttl");
      await api("PUT", "/v1/tenant/sandbox", {
        requestId: randomUUID(),
        limits: { idle: "20s", ttl: "2h" },
        lifecycle: { onExpiry: "delete", stopGrace: "10s" },
      });
      await api("PUT", "/v1/sandboxes/pods%2Fttl-delete", { kind: "pod", lifecycle: { ttl: "45s" } });
      await until("expired and deleted", async () => (await api("GET", "/v1/sandboxes/pods%2Fttl-delete", undefined, { ok: false })).status === 404, 300_000);

      step("idle (20 s) → suspended");
      await observed("pods/ttl", "suspended", 180_000);
      assert.ok((await events("pods/ttl")).includes("sandbox.suspended"));
      // Idle long enough again for the steps below.
      await api("PUT", "/v1/tenant/sandbox", {
        requestId: randomUUID(),
        limits: { idle: "10m", ttl: "2h" },
        lifecycle: { onExpiry: "retain", stopGrace: "10s" },
      });

      step("reset → a new, empty volume");
      await api("POST", "/v1/sandboxes/pods%2Fone/reset");
      await observed("pods/one", "running", 420_000);
      await until("the old Sandbox is deleted", async () => !(await kubectl(["get", "sandbox", "-n", namespace, name], { check: false })));
      // Ready first, then its engine joins: read once the new pod serves the workspace.
      let empty;
      await until("the new pod's engine serves the workspace", async () => {
        empty = await api("POST", "/v1/sessions/s1/sandbox/read", { path: "out.txt" }, { ok: false });
        return empty.status !== 409;
      });
      assert.match(JSON.stringify(empty.body), /not_found|No file/, "a reset starts from an empty volume");

      step("PVC and pod deleted → sandbox.lost; turns refused until a reset");
      const resetName = await stack.psql("SELECT k8s_name FROM nylorun.sandbox_resources WHERE id = 'pods/one'");
      await kubectl(["delete", "pvc", "-n", namespace, `data-${resetName}`, "--wait=false"]);
      const victim = await podOf(resetName);
      await kubectl(["delete", "pod", "-n", namespace, victim.metadata.name, "--force", "--grace-period=0"]);
      await observed("pods/one", "lost", 300_000);
      assert.ok((await events("pods/one")).includes("sandbox.lost"));
      const lost = await message("s1");
      assert.equal(lost.body.code, "sandbox_lost", JSON.stringify(lost.body));
      await api("POST", "/v1/sandboxes/pods%2Fone/reset");
      await observed("pods/one", "running", 420_000);

      step("nylorun sandbox disable → kind pod is sandbox_unavailable");
      await stack.nylorun(["sandbox", "disable", "--delete-namespace"], { timeout: 600_000 });
      tenant = await hostTenant(await stack.admin());
      const unavailable = await api("PUT", "/v1/sandboxes/pods%2Fafter", { kind: "pod" }, { ok: false });
      assert.equal(unavailable.status, 409);
      assert.equal(unavailable.body.code, "sandbox_unavailable");
      const stopped = await message("s1");
      assert.equal(stopped.body.code, "sandbox_unavailable", JSON.stringify(stopped.body));
    } catch (error) {
      await kubectl(["get", "sandbox,pod,pvc,secret", "-n", namespace, "-o", "wide"], { check: false }).then((out) => out && console.error(out));
      await kubectl(["describe", "pods", "-n", namespace], { check: false }).then((out) => out && console.error(out));
      await kubectl(["logs", "-n", namespace, "-l", "nylorun.dev/role=sandbox", "-c", "workload", "--tail", "100"], { check: false }).then((out) => out && console.error(out));
      await stack.compose(["logs", "--tail", "150", "runtime", "gateway", "sandboxes"], { check: false }).then(console.error, () => {});
      throw error;
    } finally {
      await docker(["rm", "--force", stubName]).catch(() => undefined);
      await kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], { check: false });
    }
  });
  console.log(`\n[pods] passed in ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
