/**
 * Tenant acceptance (H1–H9) on the local Docker stack, driven by the packed
 * CLI and @nylorun/admin as a developer installs them, under a temporary
 * NYLORUN_HOME and a unique stack project (never ~/.nylorun):
 *
 *   node scripts/acceptance/tenants.mjs [--only H1,H3,...]
 *
 * Images: see scripts/lib/stack.mjs (built from this checkout, or named by
 * NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE). One stack serves the selected
 * cases and is reset at the end. H5 needs no stack.
 *
 * H1  two Tenants on one Runtime: agents, sessions, events, vaults isolated
 * H2  two Projects, each linked with `nylo tenant create`, develop at once; stopping one keeps the stack and the other
 * H3  a stack restart restores sessions in both Tenants; a Tenant whose schema
 *     is newer than the Runtime is quarantined, the others keep working
 * H4  executor rotation disconnects only the affected Tenant's stream
 * H5  sandbox reconciliation stays inside the Tenant's prefix (packed Runtime library)
 * H6  a request outside the protocol range fails with 426 before any mutation
 * H7  concurrent `nylorun start` on a running stack changes nothing; a refused
 *     start (host.json from a newer CLI) leaves the stack running
 * H8  the stack keeps running after the installing Project deletes node_modules
 * H9  Project link rules: a moved checkout keeps its link; clones and worktrees do not inherit it
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
  tenantGet,
  tenantHeaders,
  withStack,
} from "../lib/stack.mjs";

const PROTOCOL_HEADER = "Nylorun-Protocol";

/** `--only H2,H6,...` runs a subset, so CI can split the checks across jobs. */
const SCENARIOS = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9"];
const onlyIndex = process.argv.indexOf("--only");
const only =
  onlyIndex === -1
    ? undefined
    : new Set((process.argv[onlyIndex + 1] ?? "").split(",").filter(Boolean));
if (only && (only.size === 0 || [...only].some((id) => !SCENARIOS.includes(id))))
  throw new Error(`Usage: tenants.mjs [--only ${SCENARIOS.join(",")}]`);
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

async function request(url, path, { method = "GET", tenant, body, headers = {} } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(tenant ? tenantHeaders(tenant.id, tenant.key) : {}),
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

const putAgent = (url, tenant, agentId = "shared-agent") =>
  request(url, `/v1/agents/${agentId}`, {
    method: "PUT",
    tenant,
    body: {
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: {
        id: agentId,
        name: `${tenant.name}-${agentId}`,
        manifestSchemaVersion: 4,
        capabilities: [],
      },
    },
  }).then(ok);

const putSession = (url, tenant, sessionId, agentId = "shared-agent") =>
  request(url, `/v1/sessions/${sessionId}`, {
    method: "PUT",
    tenant,
    body: { requestId: randomUUID(), agentId, ownerUserId: "acceptance" },
  }).then(ok);

const createVault = async (url, tenant, name) =>
  (
    await request(url, "/v1/vaults", {
      method: "POST",
      tenant,
      body: {
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        name,
        ownerUserId: "acceptance",
      },
    }).then(ok)
  ).id;

const seedVirtual = (url, tenant) =>
  request(url, "/v1/tenant/config/seed", {
    method: "PUT",
    tenant,
    body: { requestId: randomUUID(), sandbox: { backend: "virtual" } },
  }).then(ok);

/** A Tenant through the packed @nylorun/admin: `{ id, key, name }`. */
async function newTenant(admin, name) {
  const { tenant, applicationKey } = await admin.createTenant({ name });
  return { id: tenant.id, key: applicationKey, name };
}

const status = async (url, path, tenant) => (await request(url, path, { tenant })).status;

// ── H5: sandbox reconciliation prefix isolation (no stack) ──
async function h5(temporary, packed) {
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
  // The manager's view of a Session Store: `tx(fn)` hands `fn` a transaction.
  const memoryStore = () => {
    const tables = new Map();
    const transaction = {
      get: async (table, key) => tables.get(table)?.get(key),
      async put(table, key, value) {
        if (!tables.has(table)) tables.set(table, new Map());
        tables.get(table).set(key, value);
      },
      delete: async (table, key) => void tables.get(table)?.delete(key),
      all: async (table) => [...(tables.get(table)?.values() ?? [])],
    };
    return { tx: async (fn) => fn(transaction) };
  };

  const tenantA = "tn_0000000000000000000000000a";
  const tenantB = "tn_0000000000000000000000000b";
  const manager = new SandboxManager({
    scope: tenantA,
    store: memoryStore(),
    backends: [fakeBackend],
    preference: "auto",
    ephemeral: false,
    emit() {},
  });
  await manager.reconcile(() => false);
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
  pass("H5", "sandbox reconcile lists only its own prefix; virtual backends stay Tenant-scoped");
}

// ── H1 + H4: two Tenants on one Runtime, isolation and executor rotation ──
async function h1h4(url, admin) {
  const alpha = await newTenant(admin, "project-alpha");
  const beta = await newTenant(admin, "project-beta");
  for (const tenant of [alpha, beta]) {
    await seedVirtual(url, tenant);
    await putAgent(url, tenant);
  }
  await putSession(url, alpha, "sess-alpha");
  await putSession(url, beta, "sess-beta");
  const vaultA = await createVault(url, alpha, "Vault A");
  const vaultB = await createVault(url, beta, "Vault B");

  if (selected("H1")) {
    // The same agent id in both Tenants, each with its own manifest.
    const agentsA = await tenantGet(url, alpha.id, alpha.key, "/v1/agents");
    const agentsB = await tenantGet(url, beta.id, beta.key, "/v1/agents");
    assert.deepEqual(agentsA.agents.map((a) => a.manifest.name), ["project-alpha-shared-agent"]);
    assert.deepEqual(agentsB.agents.map((a) => a.manifest.name), ["project-beta-shared-agent"]);
    assert.equal(await status(url, "/v1/sessions/sess-alpha", alpha), 200);
    assert.equal(await status(url, "/v1/sessions/sess-beta", alpha), 404, "cross-Tenant session");
    assert.equal(await status(url, "/v1/sessions/sess-beta/events", alpha), 404, "cross-Tenant events");
    assert.ok([200, 404].includes(await status(url, "/v1/sessions/sess-alpha/events", alpha)));
    assert.equal(await status(url, `/v1/vaults/${vaultA}`, alpha), 200);
    assert.equal(await status(url, `/v1/vaults/${vaultB}`, alpha), 404, "cross-Tenant vault");
    // A Tenant key never opens another Tenant (the miss stays opaque).
    assert.ok(
      [401, 404].includes(await status(url, "/v1/tenant", { id: beta.id, key: alpha.key })),
      "a key is bound to its Tenant",
    );
    pass("H1", "two Tenants on one Runtime; same agent id; agents/sessions/events/vaults isolated");
  }

  if (selected("H4")) {
    const register = (tenant, token) =>
      request(url, "/v1/executors", {
        method: "PUT",
        tenant,
        body: { executors: [{ token, agentId: "shared-agent", implementationVersion: "dev" }] },
      });
    const connect = (tenant, token) =>
      fetch(`${url}/v1/executors/connect`, {
        headers: { ...tenantHeaders(tenant.id, token), accept: "text/event-stream" },
      });
    assert.equal((await register(alpha, "token-alpha-1-aaaaaaaa")).status, 200);
    assert.equal((await register(beta, "token-beta-1-bbbbbbbbb")).status, 200);
    const streamA = await connect(alpha, "token-alpha-1-aaaaaaaa");
    const streamB = await connect(beta, "token-beta-1-bbbbbbbbb");
    assert.equal(streamA.status, 200);
    assert.equal(streamB.status, 200);
    const readerA = streamA.body.getReader();
    const readerB = streamB.body.getReader();
    await readerA.read();
    await readerB.read();
    const rotated = await register(alpha, "token-alpha-2-aaaaaaaa");
    assert.equal(rotated.status, 200);
    assert.equal((await rotated.json()).executors[0].rotated, true);
    let ended = false;
    for (let i = 0; i < 40 && !ended; i++) ended = (await readerA.read()).done;
    assert.equal(ended, true, "the rotated stream ends");
    const peekB = await Promise.race([
      readerB.read(),
      new Promise((resolve) => setTimeout(() => resolve({ open: true }), 200)),
    ]);
    assert.ok(peekB.open || peekB.done === false, "the other Tenant's stream stays open");
    const oldToken = await connect(alpha, "token-alpha-1-aaaaaaaa");
    assert.equal(oldToken.status, 404);
    const newToken = await connect(alpha, "token-alpha-2-aaaaaaaa");
    assert.equal(newToken.status, 200);
    await newToken.body.cancel();
    await readerB.cancel().catch(() => {});
    pass("H4", "executor rotation disconnects only the affected Tenant's stream");
  }
}

// ── H6: protocol range ──
async function h6(url, admin, adminKey) {
  // The packed admin client speaks the Runtime's protocol.
  const compatible = await newTenant(admin, "compat-ok");
  assert.equal(await status(url, "/v1/tenant", compatible), 200);
  const before = (await admin.listTenants()).length;
  // The Admin API answers on the operator listener; the Runtime port has no admin routes.
  const onRuntimePort = await request(url, "/v1/admin/tenants", {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}` },
    body: { name: "should-not-create", idempotencyKey: randomUUID() },
  });
  assert.equal(onRuntimePort.status, 404, "the Runtime port serves no admin routes");
  const rejected = await request(admin.adminUrl, "/v1/admin/tenants", {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, [PROTOCOL_HEADER]: "99" },
    body: { name: "should-not-create", idempotencyKey: randomUUID() },
  });
  assert.equal(rejected.status, 426, await rejected.text());
  assert.equal((await admin.listTenants()).length, before, "no Tenant was created");
  const tenantRejected = await request(url, "/v1/tenant", {
    headers: { ...tenantHeaders(compatible.id, compatible.key), [PROTOCOL_HEADER]: "99" },
  });
  assert.equal(tenantRejected.status, 426);
  pass("H6", "a client in the protocol range works; outside it, 426 before any mutation");
}

// ── H9: Project link rules ──
async function h9(url, admin, temporary) {
  const tenant = await newTenant(admin, "link-demo");
  const { hostId } = (await admin.status()).host;
  const project = join(temporary, "project-h9");
  const writeLink = async (directory) => {
    await mkdir(join(directory, ".nylorun"), { recursive: true });
    await writeFile(
      join(directory, ".nylorun/link.json"),
      JSON.stringify({ hostUrl: url, hostId, tenantId: tenant.id }, null, 2),
    );
    await writeFile(
      join(directory, ".nylorun/credentials.json"),
      JSON.stringify({ applicationKey: tenant.key, executors: {} }, null, 2),
    );
  };
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"link-demo"}');
  await writeLink(project);

  // A moved checkout carries its link.
  const moved = join(temporary, "project-h9-moved");
  await cp(project, moved, { recursive: true });
  await rm(project, { recursive: true, force: true });
  const movedLink = JSON.parse(await readFile(join(moved, ".nylorun/link.json"), "utf8"));
  const movedCredentials = JSON.parse(await readFile(join(moved, ".nylorun/credentials.json"), "utf8"));
  assert.equal(
    await status(url, "/v1/tenant", { id: movedLink.tenantId, key: movedCredentials.applicationKey }),
    200,
  );
  // A fresh clone or a second worktree has no .nylorun (it is git-ignored).
  for (const directory of ["project-h9-clone", "project-h9-worktree"]) {
    await mkdir(join(temporary, directory));
    await assert.rejects(stat(join(temporary, directory, ".nylorun")));
  }
  // Linking a worktree explicitly (tenant use) reaches the same Tenant.
  await writeLink(join(temporary, "project-h9-worktree"));
  assert.equal(await status(url, "/v1/tenant", tenant), 200);
  pass("H9", "a moved checkout keeps its Project link; clone/worktree do not inherit; explicit links work");
}

// ── H8: the stack outlives the installing Project's node_modules ──
async function h8(url, stack, packed, temporary) {
  const project = join(temporary, "project-h8");
  await installProject(project, packed, ["core", "nylorun"]);
  const projectCli = join(project, "node_modules/nylorun/dist/cli.js");
  const { stdout } = await stack.nylorun(["status", "--json"], { echo: false, entry: projectCli });
  assert.equal(JSON.parse(stdout).runtime.healthy, true);
  await rm(join(project, "node_modules"), { recursive: true, force: true });
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  assert.equal((await (await fetch(`${url}/health`)).json()).service, "nylorun-runtime");
  pass("H8", "the stack keeps running after the installing Project deletes node_modules");
}

// ── H7: concurrent and refused starts ──
async function h7(url, stack) {
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

  // host.json written by a newer CLI: start refuses before touching the stack.
  await writeFile(hostFile, JSON.stringify({ ...JSON.parse(before.host), format: 99 }, null, 2));
  const refused = await stack.nylorun(["start"], { check: false, echo: false });
  assert.notEqual(refused.code, 0, "start refuses a newer host.json");
  assert.equal((await fetch(`${url}/ready`)).status, 200, "the stack keeps running");
  assert.deepEqual(await containers(), before.containers);
  await writeFile(hostFile, before.host, { mode: 0o600 });
  pass("H7", "concurrent starts leave the running stack as it was; a refused start leaves it running");
}

// ── H2: two Projects, each linked with `nylo tenant create`, run `npm run dev` at once ──
async function h2(url, stack, packed, temporary) {
  const makeProject = async (name) => {
    const project = join(temporary, `project-${name}`);
    await mkdir(join(project, "agents"), { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "agents/index.ts"),
      `import { Agent } from "@nylorun/agents";\nexport const agents = [Agent({ id: "shared-agent", name: "${name}" })];\n`,
    );
    await writeFile(
      join(project, "src/main.ts"),
      `import { connectAgents } from "@nylorun/agents";\nimport { agents } from "../agents/index.ts";\nawait connectAgents({ agents }).ready;\n`,
    );
    // The Project depends on the SDK only, as the starter does.
    await installProject(project, packed, ["core", "agents"], {
      name,
      extra: { tsx: "^4.20.0" },
    });
    await stack.nylo(["tenant", "create"], { cwd: project, echo: false });
    return project;
  };
  const projects = await Promise.all(["alpha-dev", "beta-dev"].map(makeProject));
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
    const tenants = await Promise.all(
      projects.map(async (project) => {
        const link = JSON.parse(await readFile(join(project, ".nylorun/link.json"), "utf8"));
        const credentials = JSON.parse(await readFile(join(project, ".nylorun/credentials.json"), "utf8"));
        assert.equal(link.hostUrl, url, "both Projects use the one Runtime");
        return { id: link.tenantId, key: credentials.applicationKey };
      }),
    );
    assert.notEqual(tenants[0].id, tenants[1].id, "each Project has its own Tenant");
    const connected = (tenant) =>
      tenantGet(url, tenant.id, tenant.key, "/v1/executors").then((body) =>
        body.executors.some((e) => e.agentId === "shared-agent" && e.connected),
      );
    for (const tenant of tenants)
      await eventually(() => connected(tenant), { message: `executor of ${tenant.id}` });

    await devs[0].stop();
    assert.equal((await fetch(`${url}/ready`)).status, 200, "the stack keeps running");
    await eventually(async () => !(await connected(tenants[0])), { message: "the stopped Project to disconnect" });
    assert.equal(await status(url, "/v1/tenant", tenants[1]), 200);
    assert.equal(await connected(tenants[1]), true, "the other Project stays connected");
    await devs[1].stop();
  } finally {
    await group.close();
  }
  pass("H2", "two linked Projects develop on one stack; stopping one leaves the stack and the other");
}

// ── H3: restart restores sessions; a too-new Tenant schema quarantines that Tenant ──
async function h3(stack, admin) {
  const url = stack.runtimeUrl;
  const alpha = await newTenant(admin, "restart-alpha");
  const beta = await newTenant(admin, "restart-beta");
  const gamma = await newTenant(admin, "schema-newer");
  for (const tenant of [alpha, beta]) {
    await putAgent(url, tenant);
    await putSession(url, tenant, `sess-${tenant.name}`);
  }
  // The Postgres Session Store keeps each Tenant in schema "tenant_<id>" with a
  // schema_version table (runtime/src/store/postgres/migrations).
  const schema = `tenant_${gamma.id}`;
  assert.equal(
    await stack.psql(`SELECT to_regclass('"${schema}".schema_version') IS NOT NULL`),
    "t",
    `Tenant schema ${schema} has a schema_version table`,
  );
  await stack.psql(
    `INSERT INTO "${schema}".schema_version (version, name) VALUES (999999, 'from-a-newer-runtime')`,
  );

  await stack.nylorun(["stop"]);
  await stack.start(["--no-studio"]);
  for (const tenant of [alpha, beta]) {
    assert.equal(await status(url, `/v1/sessions/sess-${tenant.name}`, tenant), 200);
    const agents = await tenantGet(url, tenant.id, tenant.key, "/v1/agents");
    assert.equal(agents.agents[0].manifest.name, `${tenant.name}-shared-agent`);
  }
  pass("H3", "a stack restart restores sessions and agents in both Tenants");

  const quarantined = await eventually(
    async () => {
      const tenant = await admin.getTenant(gamma.id);
      return tenant.state === "quarantined" ? tenant : undefined;
    },
    { message: `Tenant ${gamma.id} to be quarantined` },
  );
  assert.equal(quarantined.quarantine?.code, "schema-too-new", JSON.stringify(quarantined));
  assert.notEqual(await status(url, "/v1/tenant", gamma), 200, "the quarantined Tenant does not serve");
  for (const tenant of [alpha, beta]) assert.equal(await status(url, "/v1/tenant", tenant), 200);
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  pass("H3", "a Tenant schema newer than the Runtime quarantines only that Tenant (schema-too-new)");
}

const temporary = await mkdtemp(join(tmpdir(), "nylorun-acceptance-"));
assertNotRealHome(temporary);
try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const packed = await packPackages(artifacts, ["core", "harness", "agents", "admin", "runtime", "nylorun", "cli"]);

  if (selected("H5")) await h5(temporary, packed);

  if (SCENARIOS.some((id) => id !== "H5" && selected(id))) {
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
        const admin = await stack.admin(
          pathToFileURL(join(tools, "node_modules/@nylorun/admin/dist/index.js")).href,
        );
        const { adminKey } = JSON.parse(
          await readFile(join(stack.home, "host-credentials.json"), "utf8"),
        );
        if (selected("H1") || selected("H4")) await h1h4(url, admin);
        if (selected("H6")) await h6(url, admin, adminKey);
        if (selected("H9")) await h9(url, admin, temporary);
        if (selected("H8")) await h8(url, stack, packed, temporary);
        if (selected("H7")) await h7(url, stack);
        if (selected("H2")) await h2(url, stack, packed, temporary);
        // Last: it restarts the stack.
        if (selected("H3")) await h3(stack, admin);
      },
    );
  }

  console.log(`\nTenant acceptance on the stack${only ? ` (${[...only].join(",")})` : ""}:`);
  for (const item of results) console.log(`  ${item.status} ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
