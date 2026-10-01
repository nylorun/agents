#!/usr/bin/env node
// `nylorun start` smoke under a temporary Host root:
//
//   node scripts/smoke-stack.mjs
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout
// unless NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI).
// Needs the CLI and @nylorun/admin built. Starts the stack, checks
// `nylorun status --json` and the Runtime's /ready (Postgres, Restate, S2),
// checks that Studio is printed without a login token, creates a Tenant
// through @nylorun/admin, mints a Studio login, creates a Tenant in Studio and
// links a Project to it with `nylo tenant use`, embeds Studio the way Babai
// does (frame allowlist, a Tenant-limited token, a bearer session), runs
// `nylorun down` and `nylorun up` (the stack's files and the Tenant are kept),
// checks that every file in the Host root belongs to this user (the bind
// mount's UID/GID), and always ends with `nylorun reset --yes`.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintStudioLoginToken } from "@nylorun/admin";
import { ensureImages, studioSession, tenantGet, withStack } from "./lib/stack.mjs";

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
    assert.equal((await fetch(`${studio.origin}/_studio/tenants`, { headers: bearer })).status, 403);

    // Studio creates a Tenant; a Project links it with no key of its own.
    const createdInStudio = await studio.get("/_studio/tenants", {
      method: "POST",
      headers: { origin: studio.origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "studio-smoke" }),
    });
    assert.equal(createdInStudio.status, 201, await createdInStudio.clone().text());
    const studioTenant = (await createdInStudio.json()).tenant;
    const project = await mkdtemp(join(tmpdir(), "nylorun-studio-project-"));
    let link;
    let credentials;
    try {
      // The Project lookup stops at the home directory, so give it a .nylorun/.
      await mkdir(join(project, ".nylorun"), { recursive: true });
      await writeFile(join(project, "package.json"), '{"name":"studio-project"}');
      await stack.nylo(["tenant", "use", studioTenant.id], { cwd: project });
      link = JSON.parse(await readFile(join(project, ".nylorun", "link.json"), "utf8"));
      credentials = JSON.parse(await readFile(join(project, ".nylorun", "credentials.json"), "utf8"));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
    assert.equal(link.tenantId, studioTenant.id);
    assert.equal(credentials.principalId, "project");
    assert.ok(
      await tenantGet(runtimeUrl, studioTenant.id, credentials.applicationKey, "/v1/agents"),
      "the derived project key reaches the Tenant API",
    );

    // `down` and `up` are the Compose spellings of `stop` and `start`: a second
    // `up` reuses the stack it set up, and the stopped volumes keep the Tenant.
    const stackFiles = async () => [
      await readFile(join(home, "stack", "compose.yaml"), "utf8"),
      await readFile(join(home, "stack", ".env"), "utf8"),
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
    assert.ok((await admin.listTenants()).some((t) => t.id === tenant.id), "the Tenant survives down and up");

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
