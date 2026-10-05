/**
 * Installation acceptance (I1–I9) on a local Tenant (Docker Compose): one Tenant per
 * installation (protocol 5), driven by the packed nylorun, CLI and
 * @nylorun/admin as a developer installs them, under a temporary NYLORUN_HOME
 * and a unique Tenant name (NYLORUN_TENANT; never ~/.nylorun):
 *
 *   node scripts/acceptance/installation.mjs [--only I1,I3,...]
 *
 * Images: see scripts/lib/stack.mjs (built from this checkout, or named by
 * NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE). One Tenant serves the selected
 * cases and is reset at the end. I5 needs no containers.
 *
 * I1  one Tenant per installation: nylorun-operate status, /ready and nylorun status
 *     report exactly one, open; Runtime and Management API requests without
 *     Nylorun-Tenant work, each with its own key; there is no Admin API (/v1/admin/*
 *     is 404, even with the admin key) and no operator port
 * I2  protocol 4 compatibility: Nylorun-Tenant naming the Host's Tenant works,
 *     naming another Tenant is the opaque 404
 * I3  a request outside the protocol range fails with 426 before any mutation
 * I4  a Tenant restart (stop, start) restores sessions and agents; a database whose schema is
 *     newer than the Runtime leaves the Tenant unavailable (schema-too-new), which
 *     nylorun status reports
 * I5  sandbox reconciliation stays inside the Tenant's prefix (packed Runtime library)
 * I6  concurrent `nylorun start` on a running Tenant changes nothing; a refused
 *     start (host.json from a newer CLI) leaves the Tenant running
 * I7  the Tenant keeps running after the installing Project deletes node_modules
 * I8  two Projects linked to one Tenant (`nylorun start` with NYLORUN_TENANT)
 *     develop at once, each saving its agent; stopping one keeps the Tenant, its
 *     agent and the other Project's loop
 * I9  Project link rules: a moved checkout keeps its link; clones and worktrees
 *     do not inherit it; `nylorun start` links a worktree to the same Tenant
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessGroup } from "../lib/processes.mjs";
import { npm, packageName, root } from "../lib/repo.mjs";
import {
  ensureImages,
  eventually,
  hostTenant,
  PROTOCOL,
  runtimeGet,
  runtimeHeaders,
  withStack,
} from "../lib/stack.mjs";

const PROTOCOL_HEADER = "Nylorun-Protocol";
/** Protocol 4 clients named the Tenant; the Host still accepts the header (compatibility). */
const TENANT_HEADER = "Nylorun-Tenant";
/** A well-formed Tenant id that no installation here has. */
const OTHER_TENANT = "tn_0000000000000000000000000z";

/** `--only I2,I6,...` runs a subset, so CI can split the checks across jobs. */
const SCENARIOS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"];
const onlyIndex = process.argv.indexOf("--only");
const only =
  onlyIndex === -1
    ? undefined
    : new Set((process.argv[onlyIndex + 1] ?? "").split(",").filter(Boolean));
if (only && (only.size === 0 || [...only].some((id) => !SCENARIOS.includes(id))))
  throw new Error(`Usage: installation.mjs [--only ${SCENARIOS.join(",")}]`);
const selected = (id) => !only || only.has(id);

const results = [];
function pass(id, message) {
  results.push({ id, status: "PASS", message });
  console.log(`PASS ${id}: ${message}`);
}

function assertNotRealHome(path) {
  const real = join(homedir(), ".nylorun").replace(/\\/g, "/");
  const value = path.replace(/\\/g, "/");
  assert.ok(!value.startsWith(real), `must not use the real ~/.nylorun (${path})`);
}

async function packPackages(destination, names) {
  const packed = {};
  for (const name of names) {
    const result = JSON.parse(
      await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
        cwd: join(root, name),
        capture: true,
      }),
    );
    packed[name] = join(destination, result[0].filename);
  }
  return packed;
}

/** A Project with `deps` installed from the packed tarballs (and `extra` from npm). */
async function installProject(cwd, packed, deps, { name = "nylorun-acceptance", extra = {} } = {}) {
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      dependencies: {
        ...Object.fromEntries(deps.map((dep) => [packageName(dep), `file:${packed[dep]}`])),
        ...extra,
      },
    }),
  );
  await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, capture: true });
}

/**
 * A request with `key` unless `headers` replace it: an application key for the Runtime API, a
 * management key for the Management API (`/v1/tenant/*`).
 */
async function request(url, path, { method = "GET", key, body, headers = {} } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(key ? runtimeHeaders(key) : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
}

async function ok(response) {
  const text = await response.text();
  assert.ok(response.ok, `${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const putAgent = (url, key, agentId, name = agentId) =>
  request(url, `/v1/agents/${agentId}`, {
    method: "PUT",
    key,
    body: {
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: { id: agentId, name, manifestSchemaVersion: 5, capabilities: [] },
    },
  }).then(ok);

const putSession = (url, key, sessionId, agentId) =>
  request(url, `/v1/sessions/${sessionId}`, {
    method: "PUT",
    key,
    body: { requestId: randomUUID(), agentId, ownerUserId: "acceptance" },
  }).then(ok);

const status = async (url, path, key, headers) => (await request(url, path, { key, headers })).status;

const readProject = async (project) => ({
  link: JSON.parse(await readFile(join(project, ".nylorun/link.json"), "utf8")),
  credentials: JSON.parse(await readFile(join(project, ".nylorun/credentials.json"), "utf8")),
});

// ── I5: sandbox reconciliation prefix isolation (no containers) ──
async function i5(temporary, packed) {
  const runtimeRoot = join(temporary, "h5-runtime");
  await installProject(runtimeRoot, packed, ["core", "harness", "runtime"]);
  const dist = join(runtimeRoot, "node_modules/@nylorun/runtime/dist");
  const { SandboxManager } = await import(pathToFileURL(join(dist, "sandbox/manager.js")).href);
  const { virtualBackend } = await import(
    pathToFileURL(join(dist, "adapters/sandbox/virtual.js")).href
  );

  const listed = [];
  const removed = [];
  const fakeBackend = {
    name: "virtual",
    isolation: "process",
    async probe() {
      return { name: "virtual", isolation: "process", available: true, reason: "acceptance fake" };
    },
    unmet() {
      return undefined;
    },
    async open() {
      return {
        async exec() {
          return { exitCode: 0, stdout: "", stderr: "", killed: false, timedOut: false };
        },
        async readFile() {
          return undefined;
        },
        async writeFile() {},
        async stop() {},
      };
    },
    async remove(key) {
      removed.push(key);
    },
    async list(prefix) {
      listed.push(prefix);
      return [`${prefix}aaaaaaaaaaaaaaaa`, "nylorun-other-tenant-bbbbbbbbbbbbbbbb"].filter((key) =>
        key.startsWith(prefix),
      );
    },
  };
  // The manager's records port (`SandboxRecords`), in memory.
  const memoryRecords = () => {
    const records = new Map();
    return {
      get: async (key) => records.get(key),
      async put(record) {
        records.set(record.key, record);
      },
      delete: async (key) => void records.delete(key),
      list: async () => [...records.values()],
      count: async () => records.size,
    };
  };

  // Two installations on one machine (two Tenants) share its sandbox backends.
  const tenantA = "tn_0000000000000000000000000a";
  const tenantB = "tn_0000000000000000000000000b";
  const manager = new SandboxManager({
    scope: tenantA,
    records: memoryRecords(),
    backends: [fakeBackend],
    preference: "auto",
    ephemeral: false,
    emit() {},
  });
  await manager.reconcile(() => false, () => false);
  assert.ok(listed.some((prefix) => prefix === `nylorun-${tenantA}-`));
  assert.ok(listed.every((prefix) => !prefix.includes(tenantB)), "never lists the other prefix");
  assert.ok(removed.every((key) => key.startsWith(`nylorun-${tenantA}-`)));
  assert.ok(!removed.some((key) => key.includes("other-tenant")), "never removes foreign keys");

  const sandboxes = join(temporary, "h5-sandboxes");
  const virtualA = virtualBackend({ root: join(sandboxes, tenantA) });
  const virtualB = virtualBackend({ root: join(sandboxes, tenantB) });
  await mkdir(join(sandboxes, tenantA), { recursive: true });
  await mkdir(join(sandboxes, tenantB), { recursive: true });
  const spec = (key) => ({
    key,
    image: "virtual",
    cpus: 1,
    memoryMiB: 512,
    network: { preset: "none", hosts: [], suffixes: [] },
  });
  await virtualA.open(spec(`nylorun-${tenantA}-aaaaaaaaaaaaaaaa`));
  await virtualB.open(spec(`nylorun-${tenantB}-bbbbbbbbbbbbbbbb`));
  assert.ok((await virtualA.list(`nylorun-${tenantA}-`)).every((k) => k.startsWith(`nylorun-${tenantA}-`)));
  assert.ok((await virtualB.list(`nylorun-${tenantB}-`)).every((k) => k.startsWith(`nylorun-${tenantB}-`)));
  assert.equal((await virtualA.list(`nylorun-${tenantB}-`)).length, 0);
  pass("I5", "sandbox reconcile lists only its own prefix; virtual backends stay Tenant-scoped");
}

// ── I1: one Tenant per installation ──
async function i1(url, stack, adminKey) {
  const operated = await stack.operateStatus();
  const { tenant } = operated;
  assert.equal(operated.tenants, undefined, "nylorun-operate reports one Tenant, not a list");
  assert.equal(tenant.state, "open", JSON.stringify(tenant));
  assert.match(tenant.id ?? "", /^tn_[0-9a-z]{26}$/);
  assert.equal((await stack.ready()).checks.tenant, true, "/ready reports the Tenant open");
  const reported = JSON.parse((await stack.nylorun(["status", "--json"], { echo: false })).stdout);
  assert.deepEqual(
    { id: reported.tenant?.id, state: reported.tenant?.state, ready: reported.runtime.ready },
    { id: tenant.id, state: "open", ready: true },
    "nylorun status reports the Tenant",
  );
  const { key } = await hostTenant(stack);
  const managementKey = await stack.managementKey();
  // Nothing in a request selects the Tenant: no Nylorun-Tenant header anywhere.
  await request(url, "/v1/tenant/config/seed", {
    method: "PUT",
    key: managementKey,
    body: { requestId: randomUUID(), sandbox: { backend: "virtual" } },
  }).then(ok);
  await putAgent(url, key, "installation-agent");
  await putSession(url, key, "sess-installation", "installation-agent");
  const vault = (
    await request(url, "/v1/tenant/vaults", {
      method: "POST",
      key: managementKey,
      body: { requestId: randomUUID(), idempotencyKey: randomUUID(), name: "Vault", ownerUserId: "acceptance" },
    }).then(ok)
  ).id;
  assert.deepEqual(
    (await runtimeGet(url, key, "/v1/agents")).agents.map((a) => a.manifest.id),
    ["installation-agent"],
  );
  assert.equal(await status(url, "/v1/sessions/sess-installation", key), 200);
  assert.equal(await status(url, `/v1/tenant/vaults/${vault}`, managementKey), 200);
  assert.equal(await status(url, "/v1/tenant", managementKey), 200);
  // Each key reaches its own API only (protocol 8).
  const crossed = await request(url, "/v1/tenant", { key });
  assert.equal(crossed.status, 403, "an application key does not reach the Management API");
  assert.equal((await crossed.json()).code, "key_role_mismatch");
  // The Host creates its Tenant itself, and there is no Admin API: no request accepts the
  // admin key, and no operator port is published.
  for (const [method, path] of [
    ["GET", "/v1/admin/status"],
    ["GET", "/v1/admin/keys"],
    ["GET", "/v1/admin/tenants"],
    ["POST", "/v1/admin/tenants"],
  ]) {
    const routes = await request(url, path, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, [PROTOCOL_HEADER]: PROTOCOL },
      ...(method === "POST" ? { body: { name: "should-not-create", idempotencyKey: randomUUID() } } : {}),
    });
    assert.equal(routes.status, 404, `${method} ${path} with the admin key`);
  }
  const stackEnv = await readFile(join(stack.home, "docker", ".env"), "utf8");
  assert.doesNotMatch(stackEnv, /NYLORUN_ADMIN_PORT/, "no operator port is published");
  assert.equal((await stack.operateStatus()).tenant.id, tenant.id, "still the one Tenant");
  pass("I1", "one open Tenant per installation; its APIs need no Nylorun-Tenant; no Admin API or operator port");
}

// ── I2: protocol 4 compatibility ──
async function i2(url, stack) {
  const { id, key } = await hostTenant(stack);
  const v4 = (tenantId) => ({ [PROTOCOL_HEADER]: "4", [TENANT_HEADER]: tenantId });
  assert.equal(await status(url, "/v1/me", key, v4(id)), 200, "a protocol 4 client naming the Host's Tenant");
  assert.equal(await status(url, "/v1/agents", key, v4(id)), 200);
  const other = await request(url, "/v1/agents", { key, headers: v4(OTHER_TENANT) });
  assert.equal(other.status, 404, "a protocol 4 client naming another Tenant");
  // Opaque: the same answer as an unknown key.
  const opaque = await request(url, "/v1/agents", { key: "0".repeat(64) });
  assert.equal(opaque.status, 404);
  assert.deepEqual(await other.json(), await opaque.json(), "the miss names nothing");
  pass("I2", "Nylorun-Tenant naming the Host's Tenant works; naming another is the opaque 404");
}

// ── I3: protocol range ──
async function i3(url, stack) {
  const { key } = await hostTenant(stack);
  assert.equal(await status(url, "/v1/me", key), 200);
  const rejected = await request(url, "/v1/agents/too-new", {
    method: "PUT",
    key,
    headers: { [PROTOCOL_HEADER]: "99" },
    body: {
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: { id: "too-new", name: "too-new", manifestSchemaVersion: 5, capabilities: [] },
    },
  });
  assert.equal(rejected.status, 426, await rejected.text());
  assert.ok(
    !(await runtimeGet(url, key, "/v1/agents")).agents.some((agent) => agent.manifest.id === "too-new"),
    "no agent was written",
  );
  pass("I3", "a client in the protocol range works; outside it, 426 before any mutation");
}

// ── I9: Project link rules ──
async function i9(url, stack, temporary) {
  const { id, key } = await hostTenant(stack);
  const project = join(temporary, "project-i9");
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"link-demo"}');
  await stack.start(["--no-studio"], { cwd: project });
  const linked = await readProject(project);
  assert.equal(linked.link.format, 3);
  assert.equal(linked.link.tenant, stack.env.NYLORUN_TENANT);
  assert.equal(linked.link.tenantId, id);
  assert.equal(linked.credentials.principalId, "project", "the link carries the application key project");
  assert.equal(
    linked.credentials.managementPrincipalId,
    "project-management",
    "and the management key project-management",
  );
  assert.notEqual(linked.credentials.applicationKey, key, "the project key is not the checks' key");
  assert.equal(await status(url, "/v1/me", linked.credentials.applicationKey), 200);
  assert.equal(await status(url, "/v1/tenant", linked.credentials.managementKey), 200);
  // A second start keeps the file: its key still authenticates.
  await stack.start(["--no-studio"], { cwd: project });
  assert.deepEqual((await readProject(project)).credentials, linked.credentials, "a later start keeps the key");

  // A moved checkout carries its link.
  const moved = join(temporary, "project-i9-moved");
  await cp(project, moved, { recursive: true });
  await rm(project, { recursive: true, force: true });
  const movedProject = await readProject(moved);
  assert.equal(movedProject.link.hostUrl, url);
  assert.equal(await status(url, "/v1/me", movedProject.credentials.applicationKey), 200);
  assert.equal(await status(url, "/v1/tenant", movedProject.credentials.managementKey), 200);
  // A fresh clone or a second worktree has no .nylorun (it is git-ignored).
  for (const directory of ["project-i9-clone", "project-i9-worktree"]) {
    await mkdir(join(temporary, directory));
    await writeFile(join(temporary, directory, "package.json"), '{"name":"link-demo"}');
    await assert.rejects(stat(join(temporary, directory, ".nylorun")));
  }
  // `nylorun start` in the worktree (on the same Tenant) links it to the same Tenant.
  const worktree = join(temporary, "project-i9-worktree");
  await stack.start(["--no-studio"], { cwd: worktree });
  const worktreeProject = await readProject(worktree);
  assert.equal(worktreeProject.link.tenantId, id);
  assert.equal(await status(url, "/v1/me", worktreeProject.credentials.applicationKey), 200);
  // The checkouts share the project's keys: linking the worktree rotated nothing.
  assert.equal(worktreeProject.credentials.applicationKey, movedProject.credentials.applicationKey);
  assert.equal(worktreeProject.credentials.managementKey, movedProject.credentials.managementKey);
  assert.equal(await status(url, "/v1/me", movedProject.credentials.applicationKey), 200);
  assert.equal(await status(url, "/v1/tenant", movedProject.credentials.managementKey), 200);
  pass("I9", "a moved checkout keeps its Project link; clone/worktree do not inherit; nylorun start links a worktree");
}

// ── I7: the Tenant outlives the installing Project's node_modules ──
async function i7(url, stack, packed, temporary) {
  const project = join(temporary, "project-i7");
  await installProject(project, packed, ["core", "nylorun"]);
  const projectCli = join(project, "node_modules/nylorun/dist/cli.js");
  const { stdout } = await stack.nylorun(["status", "--json"], { echo: false, entry: projectCli });
  assert.equal(JSON.parse(stdout).runtime.healthy, true);
  await rm(join(project, "node_modules"), { recursive: true, force: true });
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  assert.equal((await (await fetch(`${url}/health`)).json()).service, "nylorun-runtime");
  pass("I7", "the Tenant keeps running after the installing Project deletes node_modules");
}

// ── I6: concurrent and refused starts ──
async function i6(url, stack) {
  const containers = async () => (await stack.compose(["ps", "--quiet"])).trim().split("\n").sort();
  const hostFile = join(stack.home, "host.json");
  const before = { containers: await containers(), host: await readFile(hostFile, "utf8") };
  const [a, b] = await Promise.all([
    stack.nylorun(["start", "--no-studio"], { echo: false }),
    stack.nylorun(["start", "--no-studio"], { echo: false }),
  ]);
  for (const result of [a, b]) assert.match(result.stdout, new RegExp(`^Runtime\\s+${url}$`, "m"));
  assert.deepEqual(await containers(), before.containers, "no container was recreated");
  assert.equal(JSON.parse(await readFile(hostFile, "utf8")).hostId, JSON.parse(before.host).hostId);

  // host.json written by a newer CLI: start refuses before touching the containers.
  await writeFile(hostFile, JSON.stringify({ ...JSON.parse(before.host), format: 99 }, null, 2));
  const refused = await stack.nylorun(["start"], { check: false, echo: false });
  assert.notEqual(refused.code, 0, "start refuses a newer host.json");
  assert.equal((await fetch(`${url}/ready`)).status, 200, "the Tenant keeps running");
  assert.deepEqual(await containers(), before.containers);
  await writeFile(hostFile, before.host, { mode: 0o600 });
  pass("I6", "concurrent starts leave the running Tenant as it was; a refused start leaves it running");
}

// ── I8: two Projects linked to one Tenant run `npm run dev` at once ──
/** A Project's agent registry: one agent, `id`, named `name`. */
const writeAgents = (project, id, name) =>
  writeFile(
    join(project, "agents/index.ts"),
    `import { Agent } from "@nylorun/agents";\nexport const agents = [Agent({ id: "${id}", name: "${name}" }).build()];\n`,
  );

async function i8(url, stack, packed, temporary) {
  const makeProject = async (name) => {
    const project = join(temporary, `project-${name}`);
    await mkdir(join(project, "agents"), { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    // The Projects share the one Tenant, so each saves its own agent id.
    await writeAgents(project, name, name);
    // As the starter's: save each agent, then nothing runs (tsx watch saves again on an edit).
    await writeFile(
      join(project, "src/main.ts"),
      [
        'import { createClient } from "@nylorun/agents";',
        'import { agents } from "../agents/index.ts";',
        "const client = await createClient();",
        "for (const agent of agents) await client.saveAgent(agent);",
        "",
      ].join("\n"),
    );
    // The Project depends on the SDK only, as the starter does.
    await installProject(project, packed, ["core", "agents"], {
      name,
      extra: { tsx: "^4.20.0" },
    });
    // NYLORUN_TENANT names the running Tenant, so start attaches to it and links the Project.
    await stack.start(["--no-studio"], { cwd: project });
    return project;
  };
  const names = ["alpha-dev", "beta-dev"];
  const projects = await Promise.all(names.map(makeProject));
  const { id, key } = await hostTenant(stack);
  const group = new ProcessGroup();
  try {
    const devs = projects.map((project, index) =>
      group.start(
        `dev-${index}`,
        process.execPath,
        [join(project, "node_modules/tsx/dist/cli.mjs"), "watch", "src/main.ts"],
        { cwd: project, env: stack.env },
      ),
    );
    const keys = new Set();
    for (const project of projects) {
      const { link, credentials } = await readProject(project);
      assert.equal(link.hostUrl, url, "both Projects use the one Runtime");
      assert.equal(link.tenantId, id, "both Projects use the one Tenant");
      assert.equal(await status(url, "/v1/me", credentials.applicationKey), 200, "each Project's key authenticates");
      keys.add(credentials.applicationKey);
    }
    assert.equal(keys.size, 1, "concurrent starts share the one project key");
    // Each Project's `npm run dev` saves its agent on the one Tenant.
    const saved = async () =>
      new Map((await runtimeGet(url, key, "/v1/agents")).agents.map((a) => [a.manifest.id, a.manifest.name]));
    for (const name of names)
      await eventually(async () => (await saved()).has(name), { message: `the agent of ${name}` });

    await devs[0].stop();
    assert.equal((await fetch(`${url}/ready`)).status, 200, "the Tenant keeps running");
    assert.ok((await saved()).has(names[0]), "the stopped Project's agent stays saved");
    // The other Project still develops: an edit saves its agent again.
    await writeAgents(projects[1], names[1], `${names[1]} edited`);
    await eventually(async () => (await saved()).get(names[1]) === `${names[1]} edited`, {
      message: "the other Project to save its edited agent",
    });
    await devs[1].stop();
  } finally {
    await group.close();
  }
  pass("I8", "two Projects linked to one Tenant develop at once; stopping one leaves the Tenant, its agent and the other");
}

// ── I4: restart restores sessions; a too-new schema leaves the Tenant unavailable ──
async function i4(stack) {
  const url = stack.runtimeUrl;
  const { id, key } = await hostTenant(stack);
  const managementKey = await stack.managementKey();
  await putAgent(url, key, "restart-agent", "restart-agent-name");
  await putSession(url, key, "sess-restart", "restart-agent");
  await stack.nylorun(["stop"]);
  await stack.start(["--no-studio"]);
  assert.equal(await status(url, "/v1/sessions/sess-restart", key), 200);
  const agents = await runtimeGet(url, key, "/v1/agents");
  assert.ok(agents.agents.some((agent) => agent.manifest.name === "restart-agent-name"));
  assert.equal((await stack.operateStatus()).tenant.id, id, "the same Tenant after a restart");
  pass("I4", "a Tenant restart restores sessions and agents");

  // The Runtime records the migrations it applied in Drizzle's journal,
  // nylorun.__drizzle_migrations (runtime/src/store/postgres/migrate.ts). A migration this
  // Runtime does not ship is one a newer Runtime applied.
  assert.equal(
    await stack.psql(`SELECT count(*) > 0 FROM nylorun.__drizzle_migrations`),
    "t",
    "the database has a migration journal",
  );
  await stack.psql(
    `INSERT INTO nylorun.__drizzle_migrations (hash, created_at) VALUES ('from-a-newer-runtime', 9999999999999)`,
  );
  // Only the Runtime restarts: `nylorun start` would wait for the Tenant to open.
  await stack.compose(["restart", "runtime"]);
  // `nylorun status` reports the cause from nylorun-operate status in the runtime container.
  const unavailable = await eventually(
    async () => {
      const { tenant } = JSON.parse(
        (await stack.nylorun(["status", "--json"], { check: false, echo: false })).stdout,
      );
      // While the runtime restarts, status can say `unavailable` before it names a cause.
      return tenant?.state === "unavailable" && tenant.cause ? tenant : undefined;
    },
    { timeout: 120_000, message: "the Tenant to be unavailable with a cause" },
  );
  assert.equal(unavailable.cause, "schema-too-new", JSON.stringify(unavailable));
  // nylorun-operate reads the cause from the database, so it can name it before the restarted
  // Runtime listens: wait for the Runtime to answer, not ready.
  await eventually(
    async () => (await fetch(`${url}/ready`, { signal: AbortSignal.timeout(5_000) })).status === 503,
    { timeout: 120_000, message: "the restarted Runtime to answer /ready with 503 (readiness fails)" },
  );
  assert.equal(await status(url, "/v1/agents", key), 404, "the unavailable Tenant does not serve (opaque 404)");
  assert.equal(await status(url, "/v1/tenant", managementKey), 404, "nor its Management API");
  pass("I4", "a database schema newer than the Runtime leaves the Tenant unavailable (schema-too-new) and fails readiness");
}

const temporary = await mkdtemp(join(tmpdir(), "nylorun-acceptance-"));
assertNotRealHome(temporary);
try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const packed = await packPackages(artifacts, ["core", "harness", "agents", "admin", "runtime", "nylorun", "cli"]);

  if (selected("I5")) await i5(temporary, packed);

  if (SCENARIOS.some((id) => id !== "I5" && selected(id))) {
    // nylorun, the CLI and @nylorun/admin as a developer's npx installs them.
    const tools = join(temporary, "tools");
    await installProject(tools, packed, ["core", "agents", "admin", "nylorun", "cli"]);
    const images = await ensureImages();
    await withStack(
      {
        name: "nylorun-acceptance",
        cli: join(tools, "node_modules/nylorun/dist/cli.js"),
        nylo: join(tools, "node_modules/@nylorun/cli/dist/cli.js"),
        images,
        startArgs: ["--no-studio"],
      },
      async (stack) => {
        assertNotRealHome(stack.home);
        const url = stack.runtimeUrl;
        const { adminKey } = JSON.parse(
          await readFile(join(stack.home, "host-credentials.json"), "utf8"),
        );
        if (selected("I1")) await i1(url, stack, adminKey);
        if (selected("I2")) await i2(url, stack);
        if (selected("I3")) await i3(url, stack);
        if (selected("I9")) await i9(url, stack, temporary);
        if (selected("I7")) await i7(url, stack, packed, temporary);
        if (selected("I6")) await i6(url, stack);
        if (selected("I8")) await i8(url, stack, packed, temporary);
        // Last: it restarts the Tenant and leaves its Tenant unavailable.
        if (selected("I4")) await i4(stack);
      },
    );
  }

  console.log(`\nInstallation acceptance on a local Tenant${only ? ` (${[...only].join(",")})` : ""}:`);
  for (const item of results) console.log(`  ${item.status} ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
