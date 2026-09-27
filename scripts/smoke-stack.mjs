#!/usr/bin/env node
// `nylorun start` smoke on locally built images, under a temporary Host root:
//
//   docker build -f runtime/Dockerfile -t nylorun-runtime:ci .
//   docker build -f studio/Dockerfile -t nylorun-studio:ci .
//   NYLORUN_RUNTIME_IMAGE=nylorun-runtime:ci NYLORUN_STUDIO_IMAGE=nylorun-studio:ci \
//     node scripts/smoke-stack.mjs
//
// Needs the CLI and @nylorun/admin built. Starts the stack, checks
// `nylorun status --json` and the Runtime's /ready (Postgres, Restate, S2),
// creates a Tenant through @nylorun/admin, mints a Studio login, checks that
// every file in the Host root belongs to this user (the bind mount's UID/GID),
// and always ends with `nylorun reset --yes`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "cli", "dist", "cli.js");

for (const name of ["NYLORUN_RUNTIME_IMAGE", "NYLORUN_STUDIO_IMAGE"])
  if (!process.env[name]?.trim())
    throw new Error(`${name} must name a locally built image`);

const home = await mkdtemp(join(tmpdir(), "nylorun-stack-smoke-"));
const env = {
  ...process.env,
  NYLORUN_HOME: home,
  NYLORUN_STACK_PROJECT: process.env.NYLORUN_STACK_PROJECT || "nylorun-smoke",
};

function nylorun(args, { check = true, echo = true } = {}) {
  console.log(`$ nylorun ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (echo) process.stdout.write(result.stdout);
  if (check && result.status !== 0)
    throw new Error(`nylorun ${args.join(" ")} exited with ${result.status}`);
  return result;
}

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

let failed = false;
try {
  const start = nylorun(["start"]);
  const runtimeUrl = /^Runtime\s+(\S+)/m.exec(start.stdout)?.[1];
  assert.ok(runtimeUrl, "start prints the Runtime URL");
  assert.match(start.stdout, /^Studio\s+http:\/\/localhost:\d+\/login\?token=/m);

  const status = JSON.parse(nylorun(["status", "--json"]).stdout);
  assert.equal(status.state, "running");
  assert.equal(status.runtime.healthy, true);
  assert.equal(status.runtime.url, runtimeUrl);
  for (const service of ["postgres", "restate", "s2", "runtime", "studio"]) {
    const entry = status.services.find((s) => s.service === service);
    assert.equal(entry?.state, "running", `${service} is running`);
    assert.ok(entry.health === "" || entry.health === "healthy", `${service} is healthy`);
  }

  const ready = await fetch(`${runtimeUrl}/ready`);
  const readyBody = await ready.json();
  assert.equal(ready.status, 200, JSON.stringify(readyBody));
  assert.deepEqual(
    { postgres: readyBody.checks.postgres, restate: readyBody.checks.restate, s2: readyBody.checks.s2 },
    { postgres: true, restate: true, s2: true },
  );

  // Restate loaded the key whose public half the Runtime was given.
  const stackEnv = await readFile(join(home, "stack", ".env"), "utf8");
  const identityKey = /^NYLORUN_RESTATE_IDENTITY_KEY=(publickeyv1_\w+)$/m.exec(stackEnv)?.[1];
  assert.ok(identityKey, ".env holds the Restate identity key");
  const logs = nylorun(["stack", "logs", "restate", "--tail", "100000"], { echo: false });
  assert.ok(logs.stdout.includes(`kid: "${identityKey}"`), "Restate logs the same key id");

  const { createAdmin } = await import("@nylorun/admin");
  const admin = createAdmin({ home });
  assert.equal((await admin.status()).host?.url, runtimeUrl, "admin status reports the public URL");
  const { tenant, applicationKey } = await admin.createTenant({ name: "stack-smoke" });
  assert.ok(applicationKey);
  assert.ok((await admin.listTenants()).some((t) => t.id === tenant.id));

  const login = nylorun(["stack", "studio", "--no-open"]);
  const loginUrl = /^Studio\s+(\S+)/m.exec(login.stdout)?.[1];
  assert.match(loginUrl ?? "", /^http:\/\/localhost:\d+\/login\?token=/);
  const redeemed = await fetch(loginUrl, { redirect: "manual" });
  assert.ok(redeemed.status >= 300 && redeemed.status < 400, `login redirects (${redeemed.status})`);
  assert.ok(redeemed.headers.get("set-cookie"), "login sets a session cookie");

  // The Runtime and Studio run as this user, so nothing in the bind-mounted
  // Host root may belong to anyone else (Linux maps UIDs through unchanged).
  const uid = process.getuid();
  const foreign = (await walk(home)).filter((entry) => entry.uid !== uid);
  assert.deepEqual(foreign, [], `every file in ${home} belongs to uid ${uid}`);
  assert.ok(
    (await walk(join(home, "tenants"))).length > 0,
    "the Runtime wrote the Tenant into the Host root",
  );
  console.log("Stack smoke passed.");
} catch (error) {
  failed = true;
  console.error(error);
  nylorun(["stack", "logs", "--tail", "200"], { check: false });
} finally {
  nylorun(["reset", "--yes"], { check: !failed });
  if (!failed) assert.deepEqual(await readdir(join(home, "tenants")), []);
  await rm(home, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
