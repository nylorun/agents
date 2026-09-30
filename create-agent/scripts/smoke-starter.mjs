/**
 * Packed create-agent starter on the local Docker stack:
 *
 *   node create-agent/scripts/smoke-starter.mjs
 *
 * - Packs the workspace (or takes NYLORUN_STACK_TARBALLS from release:check),
 *   scaffolds the starter from the packed creator, installs it offline from
 *   the tarballs and builds it. Its only Nylorun dependencies are
 *   @nylorun/agents and @nylorun/core; it has no Nylorun devDependency.
 * - Installs nylorun (the stack) and @nylorun/cli (nylo, the Runtime client)
 *   from their tarballs into a separate tools directory, as `npx` would.
 * - Builds (or reuses, see scripts/lib/stack.mjs) the Runtime and Studio
 *   images and, under a temporary NYLORUN_HOME, runs `nylorun up`, then
 *   `nylo tenant create` in the project (the Tenant and the Project link),
 *   then the project's `npm run dev`: the starter registers `assistant` and its
 *   Action endpoint, the Runtime in Docker reaches it (a ping), and `nylorun
 *   studio` lands on that Tenant (303 +
 *   cookie, /_studio/tenants, the Tenant proxy).
 * - A source edit re-registers the agent; stopping dev keeps the stack; a
 *   second dev reuses the link; the compiled `npm start` registers with the
 *   three Project variables.
 * - A temporary Tenant with the fixture model (scripts/lib/temporary-tenant.mjs)
 *   runs one turn through Studio's proxy that calls the starter's own
 *   `lookup_order` tool through its Action endpoint; the Tenant is deleted afterwards and
 *   the Project's Tenant and link are untouched.
 * - Without Docker on PATH, `nylorun up` says so.
 *
 * The Project's own Tenant has no model (the starter's .env names none), so
 * it is checked as not configured; the turn runs on the temporary Tenant only.
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { root, npmCli, run } from "../../scripts/lib/repo.mjs";
import { ProcessGroup } from "../../scripts/lib/processes.mjs";
import {
  ensureImages,
  eventually,
  studioSession,
  tenantGet,
  tenantHeaders,
  withStack,
} from "../../scripts/lib/stack.mjs";
import { withTemporaryTenant } from "../../scripts/lib/temporary-tenant.mjs";

// A wedged runner must not hold the job; a healthy run is a few minutes.
const SMOKE_DEADLINE_MS = Number(process.env.NYLORUN_SMOKE_DEADLINE_MS ?? 20 * 60_000);
const smokeDeadline = setTimeout(() => {
  console.error(`smoke-starter exceeded ${SMOKE_DEADLINE_MS}ms wall clock; aborting.`);
  process.exit(2);
}, SMOKE_DEADLINE_MS);
smokeDeadline.unref?.();

const temporary = await mkdtemp(join(tmpdir(), "nylorun-starter-smoke-"));
/** Output lines per process label, without the `[label] ` prefix. */
const output = new Map();
const group = new ProcessGroup({
  log(line) {
    console.log(line);
    const match = /^\[([^\]]+)\] (.*)$/.exec(line);
    if (!match) return;
    if (!output.has(match[1])) output.set(match[1], []);
    output.get(match[1]).push(match[2]);
  },
});
const tarballs = process.env.NYLORUN_STACK_TARBALLS
  ? JSON.parse(await readFile(process.env.NYLORUN_STACK_TARBALLS, "utf8"))
  : {};
// @nylorun/studio is private (the ghcr.io/nylorun/studio image), and the
// Runtime runs in its image, so neither is installed anywhere.
const names = ["core", "agents", "admin", "nylorun", "cli", "create-agent"];

const field = (text, name) => new RegExp(`^${name}\\s+(\\S+)`, "m").exec(text)?.[1];

async function readProject(project) {
  const [link, credentials] = await Promise.all(
    ["link.json", "credentials.json"].map(async (file) =>
      JSON.parse(await readFile(join(project, ".nylorun", file), "utf8")),
    ),
  );
  return { link, credentials };
}

try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  for (const name of names) {
    if (tarballs[name]) continue;
    const packed = JSON.parse(
      await run(
        process.execPath,
        [npmCli(), "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts],
        { cwd: join(root, name), capture: true },
      ),
    );
    tarballs[name] = join(artifacts, packed[0].filename);
  }
  for (const name of names)
    console.log(
      `${name}: ${tarballs[name].split("/").at(-1)} sha256 ${createHash("sha256")
        .update(await readFile(tarballs[name]))
        .digest("hex")}`,
    );

  const creator = join(temporary, "creator");
  await mkdir(creator);
  await run("tar", ["-xzf", tarballs["create-agent"], "-C", creator]);
  const { starterFiles } = await import(
    pathToFileURL(join(creator, "package/dist/scaffold.js")).href
  );
  const pins = JSON.parse(await readFile(join(creator, "package/compatibility.json"), "utf8"));
  const project = join(temporary, "app");
  const files = await starterFiles(pins);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = JSON.parse(files["package.json"]);
  assert.equal(manifest.scripts.dev, "tsx watch --env-file-if-exists=.env src/main.ts");
  assert.equal(manifest.scripts.start, "node dist/src/main.js");
  assert.ok(!JSON.stringify(manifest.scripts).includes("serve"));
  assert.ok(!JSON.stringify(manifest.scripts).includes("nylorun"), "no script runs nylorun");
  assert.deepEqual(
    Object.keys(manifest.devDependencies).filter((name) => name.includes("nylorun")),
    [],
    "the project has no Nylorun devDependency",
  );
  assert.equal(manifest.dependencies["@nylorun/runtime"], undefined);
  // Offline install: every @nylorun package from its tarball.
  manifest.dependencies["@nylorun/agents"] = `file:${tarballs.agents}`;
  manifest.dependencies["@nylorun/core"] = `file:${tarballs.core}`;
  await writeFile(join(project, "package.json"), JSON.stringify(manifest, null, 2));
  await run(process.execPath, [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: project,
  });
  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });

  const tree = JSON.parse(
    await run(process.execPath, [npmCli(), "ls", "--all", "--json"], {
      cwd: project,
      capture: true,
    }),
  );
  const installed = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (name.startsWith("@nylorun/") || name === "nylorun") installed.add(name);
      walk(child);
    }
  };
  walk(tree);
  assert.deepEqual(
    [...installed].sort(),
    ["@nylorun/agents", "@nylorun/core"],
    "the project installs only agents and core, including development dependencies",
  );

  // The two tools, beside the project rather than in it (what npx runs).
  const tools = join(temporary, "tools");
  await mkdir(tools);
  await writeFile(
    join(tools, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(
        ["core", "agents", "admin", "nylorun", "cli"].map((name) => [
          name === "nylorun" ? "nylorun" : `@nylorun/${name}`,
          `file:${tarballs[name]}`,
        ]),
      ),
    }),
  );
  await run(process.execPath, [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: tools,
  });
  const nylorunBin = join(tools, "node_modules/nylorun/dist/cli.js");
  const nyloBin = join(tools, "node_modules/@nylorun/cli/dist/cli.js");

  const images = await ensureImages();
  await withStack(
    { name: "nylorun-starter-smoke", cli: nylorunBin, nylo: nyloBin, images, start: false },
    async (stack) => {
      const { env } = stack;

      // 1. `nylorun up` sets up and starts the stack; it creates no Tenant.
      const up = (await stack.nylorun(["up"], { cwd: project })).stdout;
      const runtimeUrl = field(up, "Runtime");
      assert.match(runtimeUrl ?? "", /^http:\/\/localhost:\d+$/, up);
      assert.match(field(up, "Studio") ?? "", /^http:\/\/localhost:\d+$/, up);
      const admin = await stack.admin(
        pathToFileURL(join(tools, "node_modules/@nylorun/admin/dist/index.js")).href,
      );
      assert.deepEqual(await admin.listTenants(), [], "nylorun up creates no Tenant");

      // 2. `nylo tenant create` creates the Project's Tenant and links it.
      const created = (await stack.nylo(["tenant", "create"], { cwd: project })).stdout;
      assert.match(created, /^Tenant\s+\S+\s+tn_\w+\s+\(created\)$/m, created);
      assert.match(created, /^Model\s+not configured/m, created);
      const { link, credentials } = await readProject(project);
      assert.equal(link.hostUrl, runtimeUrl);
      assert.equal((await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777, 0o600);
      const tenants = await admin.listTenants();
      assert.ok(
        tenants.some((t) => t.id === link.tenantId && t.state === "open"),
        "the Admin API lists the Project's Tenant",
      );

      const key = credentials.applicationKey;
      const tenantId = link.tenantId;
      const registered = (name) =>
        eventually(
          async () =>
            (await tenantGet(runtimeUrl, tenantId, key, "/v1/agents")).agents?.some(
              (agent) => agent.manifest?.id === "assistant" && agent.manifest?.name === name,
            ),
          { timeout: 120_000, message: `agent "assistant" named ${name}` },
        );
      // The Runtime (in Docker) reaches the app's Action endpoint on this machine: a ping
      // through it answers 200 while dev runs, and 502 once dev stops.
      const ping = async () =>
        (
          await fetch(`${runtimeUrl}/v1/endpoints/assistant/ping`, {
            method: "POST",
            headers: tenantHeaders(tenantId, key),
            signal: AbortSignal.timeout(15_000),
          })
        ).status;
      const connected = () =>
        eventually(async () => (await ping()) === 200, {
          message: "the Runtime to reach the assistant's Action endpoint",
        });
      const disconnected = () =>
        eventually(async () => (await ping()) === 502, {
          message: "the Action endpoint to stop answering after dev stops",
        });

      // 3. The project's own `npm run dev` finds the Runtime through the link.
      const dev = group.start("dev", process.execPath, [npmCli(), "run", "dev"], {
        cwd: project,
        env,
      });
      await registered("Order assistant");
      await connected();

      // No model: the starter's .env names none (the temporary Tenant below uses the fixture model).
      const model = await tenantGet(runtimeUrl, tenantId, key, "/v1/tenant/model");
      assert.equal(model.configured, false, JSON.stringify(model));

      // 4. `nylorun studio` in the project reads the link and lands on its Tenant.
      const studioUrl = field(
        (await stack.nylorun(["studio", "--no-open"], { cwd: project, echo: false })).stdout,
        "Studio",
      );
      assert.match(studioUrl ?? "", /^http:\/\/localhost:\d+\/login\?token=/);
      assert.equal(new URL(studioUrl).searchParams.get("next"), `/tenants/${tenantId}`);
      const studio = await studioSession(studioUrl);
      assert.equal(studio.location, `/tenants/${tenantId}`);
      const listed = await (await studio.get("/_studio/tenants")).json();
      assert.ok(listed.tenants.some((t) => t.id === tenantId), "Studio lists the Tenant");
      const proxied = await studio.get(`/_studio/tenants/${tenantId}/runtime/v1/agents`);
      assert.equal(proxied.status, 200, await proxied.clone().text());
      assert.ok(
        (await proxied.json()).agents.some((agent) => agent.manifest?.id === "assistant"),
        "Studio's Tenant proxy serves the agent",
      );
      assert.equal((await studio.get("/", { redirect: "manual" })).status, 200);
      assert.equal(
        (await fetch(`${studio.origin}/_studio/tenants`)).status,
        401,
        "Studio refuses requests without a session",
      );
      assert.equal(
        (await fetch(studioUrl, { redirect: "manual" })).status,
        401,
        "a login link is single-use",
      );

      // 5. A source edit restarts the application and re-registers the agent.
      const source = join(project, "agents/assistant/agent.ts");
      await writeFile(
        source,
        (await readFile(source, "utf8")).replace("Order assistant", "Updated order assistant"),
      );
      await registered("Updated order assistant");
      await connected();

      // 6. Ctrl-C stops the Project only.
      await dev.stop();
      assert.equal((await fetch(`${runtimeUrl}/ready`)).status, 200, "the stack keeps running");
      await disconnected();

      // 7. A second dev reuses the running stack and the Project link.
      const again = group.start("dev-again", process.execPath, [npmCli(), "run", "dev"], {
        cwd: project,
        env,
      });
      await connected();
      assert.equal((await readProject(project)).link.tenantId, tenantId);
      assert.equal((await admin.listTenants()).length, 1, "the Tenant is reused");
      await again.stop();
      await disconnected();

      // 8. The compiled application (built before the edit) connects with the
      // three Project variables and registers its own manifest.
      const started = group.start("start", process.execPath, [npmCli(), "start"], {
        cwd: project,
        env: {
          ...env,
          NYLORUN_RUNTIME_URL: runtimeUrl,
          NYLORUN_TENANT: tenantId,
          NYLORUN_SERVER_KEY: key,
        },
      });
      await registered("Order assistant");
      await connected();
      await started.stop();

      // 9. A temporary fixture-model Tenant runs a turn that calls the
      // starter's tool, and is deleted afterwards.
      let temporaryId;
      await withTemporaryTenant({ admin, name: "starter-smoke" }, async (temporaryTenant) => {
        temporaryId = temporaryTenant.id;
        assert.notEqual(temporaryId, tenantId, "a new, temporary Tenant");
        // The three variables take precedence over the Project link.
        const runner = group.start("dev-temporary", process.execPath, [npmCli(), "run", "dev"], {
          cwd: project,
          env: { ...env, ...temporaryTenant.env },
        });
        const login = await stack.studioLogin();
        const temporaryStudio = await studioSession(login);
        const tenantApi = (path, init = {}) =>
          temporaryStudio.get(`/_studio/tenants/${temporaryId}/runtime${path}`, {
            ...init,
            headers: {
              ...(init.body ? { "content-type": "application/json", origin: temporaryStudio.origin } : {}),
              ...init.headers,
            },
          });
        await eventually(
          async () =>
            (await (await tenantApi("/v1/agents")).json()).agents?.some(
              (agent) => agent.manifest?.id === "assistant",
            ),
          { timeout: 120_000, message: "the assistant on the temporary Tenant" },
        );
        assert.equal((await readProject(project)).link.tenantId, tenantId, "the link is untouched");
        const sessionId = `smoke-${Date.now()}`;
        const session = await tenantApi(`/v1/sessions/${sessionId}`, {
          method: "PUT",
          body: JSON.stringify({ requestId: `${sessionId}-create`, agentId: "assistant" }),
        });
        assert.ok(session.ok, `create session: ${session.status} ${await session.clone().text()}`);
        const sent = await tenantApi(`/v1/sessions/${sessionId}/commands`, {
          method: "POST",
          body: JSON.stringify({
            type: "message",
            requestId: `${sessionId}-message`,
            idempotencyKey: `${sessionId}-message`,
            content: "Look up order demo-123",
          }),
        });
        assert.ok(sent.ok, `send message: ${sent.status} ${await sent.clone().text()}`);
        // The fixture model calls lookup_order; the starter's executor runs it
        // and the model answers with its result.
        const answer = await eventually(
          async () => {
            const { items } = await (await tenantApi(`/v1/sessions/${sessionId}/items`)).json();
            const text = JSON.stringify(items ?? []);
            return text.includes("Order lookup complete") && text.includes("shipped") ? text : undefined;
          },
          { timeout: 120_000, message: "the assistant's answer from lookup_order" },
        );
        assert.ok(answer.includes("demo-123"), "the tool ran for demo-123");
        await runner.stop();
      });
      const remaining = await admin.listTenants();
      assert.ok(!remaining.some((t) => t.id === temporaryId), "the temporary Tenant is gone");
      assert.ok(remaining.some((t) => t.id === tenantId), "the Project's Tenant remains");

      // 10. Without Docker, `nylorun up` says what to install and starts nothing.
      const noDocker = await run(process.execPath, [nylorunBin, "up"], {
        cwd: project,
        capture: true,
        timeout: 60_000,
        env: { ...env, PATH: dirname(process.execPath) },
      }).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(noDocker, "nylorun up fails without Docker");
      assert.match(`${noDocker.stderr}${noDocker.stdout}`, /Docker is required/);
    },
  );
  console.log(
    "PASS: packed starter (agents + core only) on the stack: nylorun up starts the stack without a Tenant, nylo tenant create creates and links it, npm run dev registers and connects the executor, nylorun studio lands on the Tenant, source restart, stack outlives dev, link reuse, compiled npm start, a temporary fixture-model Tenant's turn and its deletion, Docker missing.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(smokeDeadline);
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}
