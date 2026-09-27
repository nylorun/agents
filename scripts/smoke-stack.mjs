#!/usr/bin/env node
// `nylorun start` smoke under a temporary Host root:
//
//   node scripts/smoke-stack.mjs
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout
// unless NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI).
// Needs the CLI and @nylorun/admin built. Starts the stack, checks
// `nylorun status --json` and the Runtime's /ready (Postgres, Restate, S2),
// creates a Tenant through @nylorun/admin, mints a Studio login, checks that
// every file in the Host root belongs to this user (the bind mount's UID/GID),
// and always ends with `nylorun reset --yes`.
import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureImages, studioSession, withStack } from "./lib/stack.mjs";

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
    assert.match(studioUrl ?? "", /^http:\/\/localhost:\d+\/login\?token=/);

    const status = JSON.parse((await stack.nylorun(["status", "--json"])).stdout);
    assert.equal(status.state, "running");
    assert.equal(status.project, stack.project);
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
    const logs = await stack.nylorun(["logs", "restate", "--tail", "100000"], { echo: false });
    assert.ok(logs.stdout.includes(`kid: "${identityKey}"`), "Restate logs the same key id");

    const admin = await stack.admin();
    assert.equal((await admin.status()).host?.url, runtimeUrl, "admin status reports the public URL");
    const { tenant, applicationKey } = await admin.createTenant({ name: "stack-smoke" });
    assert.ok(applicationKey);
    assert.ok((await admin.listTenants()).some((t) => t.id === tenant.id));

    const studio = await studioSession(await stack.studioLogin());
    const listed = await (await studio.get("/_studio/tenants")).json();
    assert.ok(listed.tenants.some((t) => t.id === tenant.id), "Studio lists the Tenant");

    // The Runtime and Studio run as this user, so nothing in the bind-mounted
    // Host root may belong to anyone else (Linux maps UIDs through unchanged).
    const uid = process.getuid();
    const foreign = (await walk(home)).filter((entry) => entry.uid !== uid);
    assert.deepEqual(foreign, [], `every file in ${home} belongs to uid ${uid}`);
    assert.ok(
      (await walk(join(home, "tenants"))).length > 0,
      "the Runtime wrote the Tenant into the Host root",
    );

    await stack.nylorun(["reset", "--yes"]);
    assert.deepEqual(await readdir(join(home, "tenants")), [], "reset deletes the Tenants");
  });
  console.log("Stack smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
