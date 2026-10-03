/**
 * The harness red-team suite (F6.2 W8): what code running in the harness container can reach.
 * `scripts/smoke-redteam.mjs` runs it with the harness service's own definition (its image,
 * user, environment, mounts and network), with the real harness stopped:
 *
 *   docker compose run --rm --no-deps -T --entrypoint node harness --input-type=module - < this
 *
 * Every check must be refused. It prints one JSON line per check (`{check, ok, detail}`) and
 * steps for the smoke (`{step: "leasing"}` when its `lease` waits, `{step: "held", ...}` once
 * it holds session A's run, when the smoke cancels A), and exits 1 when a check failed.
 *
 * Inputs (environment): SMOKE_SESSION_A, SMOKE_SESSION_B (session ids), SMOKE_POSTGRES_IP,
 * SMOKE_HOST_PORTS (host ports, comma-separated, that must not answer: Restate's), SMOKE_PROTOCOL,
 * SMOKE_SECRET_HASHES (sha256 hex of the stack's other secrets, comma-separated),
 * SMOKE_PLUGINS (the read-only plugins mount), and the harness's own NYLORUN_HARNESS_TOKEN.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect as connectHttp2 } from "node:http2";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";

const require = createRequire("/app/runtime/package.json");
const { WebSocket } = require("ws");

const env = process.env;
const TOKEN = env.NYLORUN_HARNESS_TOKEN ?? "";
const SESSION_A = env.SMOKE_SESSION_A ?? "";
const SESSION_B = env.SMOKE_SESSION_B ?? "";
const PROTOCOL = env.SMOKE_PROTOCOL ?? "6";
const SECRET_HASHES = new Set((env.SMOKE_SECRET_HASHES ?? "").split(",").filter(Boolean));
const failures = [];

function report(check, ok, detail = "") {
  if (!ok) failures.push(check);
  console.log(JSON.stringify({ check, ok, detail: String(detail).slice(0, 400) }));
}
const step = (name, fields = {}) => console.log(JSON.stringify({ step: name, ...fields }));

/** Whether a TCP connection opens within `ms` (a refusal, an unknown name or a timeout: no). */
function opens(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value, why) => {
      socket.destroy();
      resolve({ value, why });
    };
    socket.setTimeout(ms, () => done(false, "timeout"));
    socket.once("connect", () => done(true, "connected"));
    socket.once("error", (error) => done(false, error.code ?? error.message));
  });
}

async function http(url, { method = "GET", headers = {}, body, host } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...(host ? { host } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, text, json };
  } catch (error) {
    return { status: 0, text: String(error?.cause?.code ?? error?.message ?? error) };
  }
}

/** The status of an HTTP/2 request (the Worker endpoint speaks h2c only). */
function http2Status(origin, path, headers = {}) {
  return new Promise((resolve) => {
    const client = connectHttp2(origin);
    const timer = setTimeout(() => {
      client.destroy();
      resolve("timeout");
    }, 10_000);
    const done = (value) => {
      clearTimeout(timer);
      client.close();
      resolve(value);
    };
    client.on("error", (error) => done(`error ${error.code ?? error.message}`));
    const request = client.request({ ":method": "GET", ":path": path, ...headers });
    request.on("response", (answer) => done(answer[":status"]));
    request.on("error", (error) => done(`error ${error.code ?? error.message}`));
    request.end();
  });
}

/**
 * Refused by the Tenant or Admin API: 401, or the opaque 404 an unknown credential gets
 * (`{"status":"rejected","code":"not_found"}`, the same as for a route that does not exist).
 */
const apiRefused = (answer) =>
  answer.status === 401 || (answer.status === 404 && answer.json?.status === "rejected");

/** The WebSocket upgrade's answer: `open`, or the refusal's HTTP status. */
function upgrade(path, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://runtime:4200${path}`, { headers, handshakeTimeout: 10_000 });
    socket.once("open", () => {
      socket.close();
      resolve("open");
    });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.once("error", (error) => resolve(`error ${error.message}`));
  });
}

/** A Harness API connection with the harness token: `request(method, params)` and messages. */
function harnessConnection() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://runtime:4200/nylorun/harness/v1", {
      headers: { authorization: `Bearer ${TOKEN}`, "nylorun-harness-api": "1" },
      maxPayload: 64 * 1024 * 1024,
    });
    let next = 1;
    const pending = new Map();
    const messages = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.t === "res") {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        if (waiter) frame.ok ? waiter.resolve(frame.r) : waiter.reject(Object.assign(new Error(frame.e.message), { code: frame.e.code }));
      } else if (frame.t === "msg") messages.push(frame);
      else if (frame.t === "req") socket.send(JSON.stringify({ t: "res", id: frame.id, ok: false, e: { code: "invalid", message: "red team" } }));
    });
    socket.once("open", () =>
      resolve({
        messages,
        request(method, params) {
          const id = next++;
          socket.send(JSON.stringify({ t: "req", id, m: method, p: params }));
          return new Promise((ok, fail) => pending.set(id, { resolve: ok, reject: fail }));
        },
        close: () => socket.close(),
      }),
    );
    socket.once("error", reject);
  });
}

/** The error code `promise` is refused with, or `answered` when it is not. */
const refusal = (promise) =>
  promise.then(
    (result) => `answered ${JSON.stringify(result).slice(0, 200)}`,
    (error) => error.code ?? error.message,
  );

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** Secret-shaped strings: hex of 32+ characters and base64 of 40+. */
const CANDIDATES = /[0-9a-fA-F]{32,}|[A-Za-z0-9+/_-]{40,}={0,2}/g;
function holdsSecret(text) {
  for (const match of text.matchAll(CANDIDATES)) if (SECRET_HASHES.has(sha256(match[0]))) return true;
  return false;
}

// 1. The stores, Restate, the Object store and published host ports are out of reach.
const unreachable = [
  ["postgres", 5432],
  ["restate", 8080],
  ["restate", 9070],
  ["s2-lite", 80],
  ["rustfs", 9000],
  ["studio", 3000],
  ...(env.SMOKE_POSTGRES_IP ? [[env.SMOKE_POSTGRES_IP, 5432]] : []),
  ...(env.SMOKE_HOST_PORTS ?? "")
    .split(",")
    .filter(Boolean)
    .map((port) => ["host.docker.internal", Number(port)]),
];
for (const [host, port] of unreachable) {
  const { value, why } = await opens(host, port);
  report(`tcp ${host}:${port} refused`, !value, why);
}

// 2. No other secret in its environment (`/proc/1/environ` is this process's: the service's).
const environ = readFileSync("/proc/1/environ", "utf8").split("\0").filter(Boolean);
const names = environ.map((line) => line.slice(0, line.indexOf("=")));
for (const name of [
  "NYLORUN_GATES_TOKEN",
  "NYLORUN_DATABASE_URL",
  "NYLORUN_KEYS_URL",
  "NYLORUN_OBJECT_STORE_SECRET_KEY",
  "NYLORUN_OBJECT_STORE_ACCESS_KEY",
  "NYLORUN_RESTATE_IDENTITY_KEY",
  "NYLORUN_RESTATE_ADMIN_URL",
  "NYLORUN_RESTATE_INGRESS_URL",
  "NYLORUN_SANDBOXES_TOKEN",
  "NYLORUN_ADMIN_KEY",
  "POSTGRES_PASSWORD",
])
  report(`env has no ${name}`, !names.includes(name));
report("env holds no other secret of the stack", !holdsSecret(environ.join("\n")), `${SECRET_HASHES.size} secrets`);

// 3. No file it can read is a key or holds a secret.
const KEY_FILES = new Set(["vault-kek", "host-credentials.json", "restate-identity.pem", "credentials.json"]);
const found = [];
let scanned = 0;
function walk(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 12) walk(path, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (KEY_FILES.has(entry.name)) found.push(path);
    try {
      if (statSync(path).size > 4 * 1024 * 1024) continue;
      const text = readFileSync(path, "utf8");
      scanned += 1;
      if (text.includes("PRIVATE KEY-----") || holdsSecret(text)) found.push(path);
    } catch {
      /* unreadable: fine */
    }
  }
}
for (const dir of ["/harness", "/nylorun", "/run", "/tmp", "/home", "/root", "/etc", "/var", "/opt", "/srv", "/mnt", "/media", ...(env.SMOKE_PLUGINS ? [env.SMOKE_PLUGINS] : [])])
  walk(dir);
report("no readable file is a key or holds a secret", found.length === 0, found.length ? found.join(", ") : `${scanned} files read`);
for (const path of ["/nylorun/keys/vault-kek", "/nylorun/host-credentials.json", "/nylorun/docker/restate-identity.pem", "/nylorun/docker/.env", "/run/nylorun/restate-identity.pem"])
  report(`${path} absent`, !existsSync(path));

// 4. Nothing is mounted outside /harness/*, but the plugins directory, read-only.
const SYSTEM = ["/", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"];
const mounts = readFileSync("/proc/self/mountinfo", "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const fields = line.split(" ");
    return { point: fields[4].replace(/\\040/g, " "), options: fields[5] };
  })
  .filter(({ point }) => !SYSTEM.includes(point) && !/^\/(proc|sys|dev)(\/|$)/.test(point));
const harnessDirs = ["sandboxes", "plugin-data", "home", "tmp"].map((dir) => `/harness/${dir}`);
const outside = mounts.filter(
  ({ point, options }) =>
    !harnessDirs.includes(point) && !(point === env.SMOKE_PLUGINS && options.split(",").includes("ro")),
);
report(
  "mounts only /harness/* (and the plugins directory read-only)",
  outside.length === 0 && harnessDirs.every((dir) => mounts.some((m) => m.point === dir)),
  JSON.stringify(outside.length ? outside : mounts),
);

// 5. The harness token is refused everywhere but the Harness API.
const bearer = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const gate = "http://gateway:4100/nylorun/v1";
const withHarnessToken = [
  ["gateway keys/sign", `${gate}/keys/sign`, { args: [{ typ: "nylorun-run+jwt", claims: {} }] }],
  ["gateway deliveries", `${gate}/deliveries`, { url: "http://example.com", body: "", headers: {}, timeoutMs: 1000 }],
  ["gateway model-calls", `${gate}/model-calls`, { effectId: "e", invocationId: "i", call: { prompt: [], tools: [] } }],
  ["gateway mcp/connect", `${gate}/mcp/connect`, { server: { sessionId: SESSION_B, capabilityId: "c", serverName: "s" } }],
];
for (const [name, url, body] of withHarnessToken) {
  const answer = await http(url, { method: "POST", headers: bearer(TOKEN), body });
  report(`${name} refuses the harness token`, answer.status === 401, `${answer.status} ${answer.text.slice(0, 120)}`);
}
const tenantApi = await http("http://runtime:4000/v1/sessions", {
  headers: { authorization: `Bearer ${TOKEN}`, "nylorun-protocol": PROTOCOL },
});
report("Tenant API refuses the harness token", apiRefused(tenantApi), `${tenantApi.status} ${tenantApi.text.slice(0, 120)}`);
const adminApi = await http("http://runtime:4001/v1/admin/status", {
  headers: { authorization: `Bearer ${TOKEN}`, "nylorun-protocol": PROTOCOL },
});
report("Admin API refuses the harness token", apiRefused(adminApi), `${adminApi.status} ${adminApi.text.slice(0, 120)}`);
const worker = await http2Status("http://runtime:9080", "/discover", { authorization: `Bearer ${TOKEN}` });
report("Worker endpoint refuses a caller without Restate's identity", worker === 401 || worker === 403, worker);

// 6. The Harness API's door: the token, the version header, the path and the Host.
const good = { authorization: `Bearer ${TOKEN}`, "nylorun-harness-api": "1" };
report("Harness API refuses no token", (await upgrade("/nylorun/harness/v1", { "nylorun-harness-api": "1" })) === 401);
report(
  "Harness API refuses a wrong token",
  (await upgrade("/nylorun/harness/v1", { ...good, authorization: `Bearer ${"00".repeat(32)}` })) === 401,
);
report("Harness API refuses a missing version", (await upgrade("/nylorun/harness/v1", { authorization: good.authorization })) === 426);
report("Harness API serves one path", (await upgrade("/nylorun/harness/v2", good)) === 404);
report("Harness API checks the Host", (await upgrade("/nylorun/harness/v1", { ...good, host: "evil.example:4200" })) === 421);

// 7. Runs this connection does not hold.
const api = await harnessConnection();
const hello = await api.request("hello", { api: 1, name: "redteam", version: "0", capabilities: {} });
const tenantId = hello.tenantId;
const unheld = randomUUID();
const intent = (runId, sessionId) => ({
  runId,
  effect: {
    effectId: `${randomUUID()}:0:model:x`,
    sessionId,
    turnId: randomUUID(),
    agentId: "redteam",
    manifestHash: "x",
    kind: "model",
    context: {},
  },
  requestHash: "0".repeat(64),
});
const notHeld = {
  "lease.renew": { runId: unheld },
  "transcript.read": { runId: unheld },
  "effect.outcome": { runId: unheld, effectId: "e", value: 1 },
  "session.mcp": { runId: unheld, diagnostics: [] },
  "lease.release": { runId: unheld, reason: "shutdown" },
};
for (const [method, params] of Object.entries(notHeld))
  report(`${method} for an unheld run: run_not_held`, (await refusal(api.request(method, params))) === "run_not_held");
const unheldIntent = await refusal(api.request("effect.intent", intent(unheld, SESSION_B)));
report("effect.intent for an unheld run: run_not_held", unheldIntent === "run_not_held", unheldIntent);
const claimB = await refusal(
  api.request("event", { sessionId: SESSION_B, turnId: null, type: "sandbox.state", payload: { state: "running" } }),
);
report("a claim for an unheld session: run_not_held", claimB === "run_not_held", claimB);
const claimRun = await refusal(
  api.request("event", { runId: unheld, sessionId: SESSION_B, turnId: null, type: "sandbox.exec", payload: {} }),
);
report("a claim naming an unheld run: run_not_held", claimRun === "run_not_held", claimRun);

// 8. Session A's run, taken by this connection while the real harness is stopped.
step("leasing");
const leased = await Promise.race([
  api.request("lease", {}),
  new Promise((_, reject) => setTimeout(() => reject(new Error("no run offered in 180 s")), 180_000)),
]);
const run = leased.run;
report("leased session A's run", run.sessionId === SESSION_A && typeof run.token === "string", run.sessionId);
const runIntent = await refusal(api.request("effect.intent", intent(run.runId, SESSION_B)));
report("an intent of session B under A's run: invalid", runIntent === "invalid", runIntent);
const claimOther = await refusal(
  api.request("event", { runId: run.runId, sessionId: SESSION_B, turnId: null, type: "sandbox.state", payload: {} }),
);
report("a claim for session B under A's run: run_not_held", claimOther === "run_not_held", claimOther);
const now = new Date().toISOString();
const foreignRecord = await refusal(
  api.request("event", {
    runId: run.runId,
    sessionId: SESSION_A,
    turnId: run.turnId,
    type: "sandbox.state",
    payload: { state: "running" },
    record: {
      key: `tn_00000000000000000000000000/${SESSION_A}`,
      sessionId: SESSION_A,
      backend: "virtual",
      image: "x",
      state: "running",
      createdAt: now,
      updatedAt: now,
    },
  }),
);
report("a workspace record outside the Tenant's prefix: invalid", foreignRecord === "invalid", `${foreignRecord} (Tenant ${tenantId})`);

// 9. A's run token at the gateway: its own session only, no keys, no deliveries.
const runHeaders = bearer(run.token);
const keys = await http(`${gate}/keys/sign`, { method: "POST", headers: runHeaders, body: { args: [{ typ: "x", claims: {} }] } });
report("keys/sign refuses a run token", keys.status === 401, keys.status);
const delivery = await http(`${gate}/deliveries`, {
  method: "POST",
  headers: runHeaders,
  body: { url: "http://example.com", body: "", headers: {}, timeoutMs: 1000 },
});
report("deliveries refuse a run token", delivery.status === 401, delivery.status);
const namingB = await http(`${gate}/model-calls`, {
  method: "POST",
  headers: runHeaders,
  body: { sessionId: SESSION_B, effectId: "e", invocationId: "i", call: { prompt: [], tools: [] } },
});
report("a model call naming session B under A's token is refused", namingB.status === 400, `${namingB.status} ${namingB.text.slice(0, 160)}`);
const mcpB = await http(`${gate}/mcp/connect`, {
  method: "POST",
  headers: runHeaders,
  body: { server: { sessionId: SESSION_B, capabilityId: "c", serverName: "s" } },
});
report("MCP connect for session B under A's token: 403", mcpB.status === 403, `${mcpB.status} ${mcpB.text.slice(0, 160)}`);

// 10. Cancelled: A's token is stale at once.
step("held", { sessionId: run.sessionId, runId: run.runId });
let stale;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  stale = await http(`${gate}/model-calls`, { method: "POST", headers: runHeaders, body: {} });
  if (stale.status === 409) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
report("after A's cancel its run token is stale: 409 run_stale", stale?.status === 409 && stale.json?.error?.code === "run_stale", `${stale?.status} ${stale?.text.slice(0, 160)}`);
report("core sent cancel for A's run", api.messages.some((m) => m.m === "cancel" && m.p?.runId === run.runId));
api.close();

console.log(JSON.stringify({ done: true, failures }));
process.exit(failures.length === 0 ? 0 : 1);
