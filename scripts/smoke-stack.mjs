#!/usr/bin/env node
// `nylorun start` smoke under a temporary Host root:
//
//   node scripts/smoke-stack.mjs
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout
// unless NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI).
// Needs the CLI and @nylorun/admin built. Starts the stack outside any project
// (no Project link), checks `nylorun status --json` and the Runtime's /ready
// (Postgres, Restate, S2), checks that Studio is printed without a login
// token, that the Admin API reports the Host's one open Tenant, mints a Studio
// login that lands on it, embeds Studio the way Babai does (frame allowlist, a
// Tenant-limited token, a bearer session), links a Project with `nylorun
// start` in its directory (the same stack through NYLORUN_STACK), runs
// `nylorun down` and `nylorun up` (the stack's files and the Tenant are kept),
// checks that every file in the Host root belongs to this user (the bind
// mount's UID/GID), and always ends with `nylorun reset --yes`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintStudioLoginToken } from "@nylorun/admin";
import { ensureImages, hostTenant, runtimeGet, studioSession, withStack } from "./lib/stack.mjs";

/** Every entry under `dir`, with its owner. */
async function walk(dir) {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await lstat(path);
    entries.push({ path, uid: info.uid, gid: info.gid });
    if (entry.isDirectory()) entries.push(...(await walk(path)));
  }
  return entries;
}

try {
  const images = await ensureImages();
  await withStack({ name: "nylorun-smoke-stack", images, start: false }, async (stack) => {
    const { home } = stack;
    const { runtimeUrl, studioUrl } = await stack.start();
    assert.match(studioUrl ?? "", /^http:\/\/localhost:\d+$/, "nylorun start prints Studio without a token");

    const status = JSON.parse((await stack.nylorun(["status", "--json"])).stdout);
    assert.equal(status.state, "running");
    assert.equal(status.project, stack.project);
    assert.equal(status.runtime.healthy, true);
    assert.equal(status.runtime.url, runtimeUrl);
    for (const service of ["postgres", "restate", "s2", "gateway", "runtime", "studio"]) {
      const entry = status.services.find((s) => s.service === service);
      assert.equal(entry?.state, "running", `${service} is running`);
      assert.ok(entry.health === "" || entry.health === "healthy", `${service} is healthy`);
    }

    // The combined packing: model calls cross the gateway (the Model Gate), which sees only
    // the Tenant directory, and the runtime holds no model credential.
    assert.equal(status.gateway.healthy, true, "status reports the gateway healthy");
    const printenv = async (service, name) =>
      (await stack.compose(["exec", "-T", service, "printenv", name], { check: false })).trim();
    assert.equal(await printenv("runtime", "NYLORUN_GATES_URL"), "http://gateway:4100");
    assert.equal(
      await printenv("runtime", "NYLORUN_GATES_TOKEN"),
      await printenv("gateway", "NYLORUN_GATES_TOKEN"),
      "the runtime and the gateway share the gates token",
    );
    const mounted = (await stack.compose(["exec", "-T", "gateway", "ls", "-A", "/nylorun"])).trim();
    assert.equal(mounted, "keys\ntenant", "the gateway mounts only the Tenant directory and the vault key");

    // Custody (F4.2): the vault key and the stack's secrets are hidden from the runtime
    // container, and no file it can read holds the key.
    const vaultKey = (await readFile(join(home, "keys", "vault-kek"), "utf8")).trim();
    assert.equal(Buffer.from(vaultKey, "base64").length, 32, "nylorun start wrote the vault key");
    for (const hidden of ["/nylorun/keys", "/nylorun/docker"])
      assert.equal(
        (await stack.compose(["exec", "-T", "runtime", "ls", "-A", hidden])).trim(),
        "",
        `${hidden} is empty in the runtime container`,
      );
    const scan = String.raw`
const fs = require("node:fs"), path = require("node:path");
const key = process.argv[1];
const found = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && fs.statSync(full).size < 4 * 1024 * 1024)
      try { if (fs.readFileSync(full, "utf8").includes(key)) found.push(full); } catch {}
  }
};
walk("/nylorun");
console.log(JSON.stringify(found));
`;
    const holding = JSON.parse(
      (await stack.compose(["exec", "-T", "runtime", "node", "-e", scan, vaultKey])).trim(),
    );
    assert.deepEqual(holding, [], "no file the runtime container reads holds the vault key");
    assert.equal(await printenv("runtime", "NYLORUN_KEYS_URL"), "http://gateway:4100");

    const ready = await fetch(`${runtimeUrl}/ready`);
    const readyBody = await ready.json();
    assert.equal(ready.status, 200, JSON.stringify(readyBody));
    assert.deepEqual(
      { postgres: readyBody.checks.postgres, restate: readyBody.checks.restate, s2: readyBody.checks.s2 },
      { postgres: true, restate: true, s2: true },
    );

    // Restate loaded the key whose public half the Runtime was given.
    const stackEnv = await readFile(join(home, "docker", ".env"), "utf8");
    const identityKey = /^NYLORUN_RESTATE_IDENTITY_KEY=(publickeyv1_\w+)$/m.exec(stackEnv)?.[1];
    assert.ok(identityKey, ".env holds the Restate identity key");
    const logs = await stack.nylorun(["logs", "restate", "--tail", "100000"], { echo: false });
    assert.ok(logs.stdout.includes(`kid: "${identityKey}"`), "Restate logs the same key id");

    // The Runtime created the installation's one Tenant on its first start.
    const admin = await stack.admin();
    assert.equal((await admin.status()).host?.url, runtimeUrl, "admin status reports the public URL");
    const tenant = await hostTenant(admin);
    assert.ok(await runtimeGet(runtimeUrl, tenant.key, "/v1/agents"), "the derived project key reaches the Tenant API");
    assert.ok(!existsSync(join(home, ".nylorun")), "start outside a project writes no Project link");

    const studio = await studioSession(await stack.studioLogin());
    assert.equal(studio.location, `/tenants/${tenant.id}`, "the login lands on the Tenant");
    const hello = await (await studio.get("/_studio/hello")).json();
    assert.equal(hello.tenant?.id, tenant.id, "Studio serves the Host's Tenant");

    // Embedding (Studio §8): Babai's origins may frame the dashboard, and a
    // Tenant-limited token becomes a bearer session that reaches that Tenant only.
    const embedOrigins = ["nylorun://localhost", "http://nylorun.localhost"];
    assert.deepEqual(status.studio.embedOrigins, embedOrigins, "status lists the embed origins");
    const shell = await fetch(`${studio.origin}/tenants/${tenant.id}?embed=1`);
    assert.equal(shell.status, 200, "the dashboard shell needs no session");
    assert.equal(shell.headers.get("content-security-policy"), `frame-ancestors ${embedOrigins.join(" ")}`);
    assert.equal(shell.headers.get("x-frame-options"), null);
    const { adminKey } = JSON.parse(await readFile(join(home, "host-credentials.json"), "utf8"));
    const login = await mintStudioLoginToken({
      studioUrl: studio.origin,
      adminKey,
      tenant: tenant.id,
      subject: "stack-smoke",
    });
    assert.equal(login.tenant, tenant.id);
    const exchanged = await fetch(`${studio.origin}/_studio/sessions`, {
      method: "POST",
      headers: { origin: studio.origin, "content-type": "application/json" },
      body: JSON.stringify({ token: login.token }),
    });
    assert.equal(exchanged.status, 201, await exchanged.clone().text());
    const bearer = { authorization: `Bearer ${(await exchanged.json()).sessionToken}` };
    const own = await fetch(`${studio.origin}/_studio/tenants/${tenant.id}/runtime/v1/agents`, { headers: bearer });
    assert.equal(own.status, 200, `an embedded session reaches its Tenant (${await own.clone().text()})`);
    const others = await fetch(`${studio.origin}/_studio/tenants/tn_0000000000000000000000000z/runtime/v1/agents`, { headers: bearer });
    assert.equal(others.status, 404, "an embedded session reaches no other Tenant");

    // `nylorun start` in a project attaches it to the running stack (NYLORUN_STACK)
    // and links it to the stack's Tenant with the derived project key.
    const project = await mkdtemp(join(tmpdir(), "nylorun-stack-project-"));
    let link;
    let credentials;
    try {
      await mkdir(join(project, ".nylorun"), { recursive: true });
      await writeFile(join(project, "package.json"), '{"name":"stack-project"}');
      await stack.start([], { cwd: project });
      link = JSON.parse(await readFile(join(project, ".nylorun", "link.json"), "utf8"));
      credentials = JSON.parse(await readFile(join(project, ".nylorun", "credentials.json"), "utf8"));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
    assert.equal(link.format, 2);
    assert.equal(link.stack, stack.env.NYLORUN_STACK);
    assert.equal(link.hostUrl, runtimeUrl);
    assert.equal(link.tenantId, tenant.id);
    assert.equal(credentials.principalId, "project");
    assert.equal(credentials.applicationKey, tenant.key);

    // `down` and `up` are the Compose spellings of `stop` and `start`: a second
    // `up` reuses the stack it set up, and the stopped volumes keep the Tenant.
    const stackFiles = async () => [
      await readFile(join(home, "docker", "compose.yaml"), "utf8"),
      await readFile(join(home, "docker", ".env"), "utf8"),
    ];
    const before = await stackFiles();
    await stack.nylorun(["down"]);
    // `status` exits 3 while the Runtime does not answer, and still reports the state.
    const stopped = await stack.nylorun(["status", "--json"], { check: false });
    assert.equal(stopped.code, 3);
    assert.equal(JSON.parse(stopped.stdout).state, "stopped");
    const up = await stack.nylorun(["up"]);
    assert.match(up.stdout, /^Runtime\s+http:\/\/localhost:\d+$/m);
    assert.deepEqual(await stackFiles(), before, "up reuses the stack's files");
    assert.equal(JSON.parse((await stack.nylorun(["status", "--json"])).stdout).runtime.healthy, true);
    assert.equal((await admin.status()).tenant.id, tenant.id, "the Tenant survives down and up");

    // The Runtime and Studio run as this user, so nothing in the bind-mounted
    // Host root may belong to anyone else (Linux maps UIDs through unchanged).
    const uid = process.getuid();
    const foreign = (await walk(home)).filter((entry) => entry.uid !== uid);
    assert.deepEqual(foreign, [], `every file in ${home} belongs to uid ${uid}`);
    assert.ok(
      (await walk(join(home, "tenant"))).length > 0,
      "the Runtime wrote the Tenant into the Host root",
    );

    await stack.nylorun(["reset", "--yes"]);
    assert.ok(
      !existsSync(join(home, "tenant")) || (await readdir(join(home, "tenant"))).length === 0,
      "reset deletes the Tenant's files",
    );
  });
  console.log("Stack smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
