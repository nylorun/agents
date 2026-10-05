/**
 * Packed create-agent starter on a local Tenant:
 *
 *   node create-agent/scripts/smoke-starter.mjs
 *
 * - Packs the workspace (or takes NYLORUN_STACK_TARBALLS from release:check),
 *   scaffolds the starter from the packed creator, installs it offline from
 *   the tarballs and builds it. Its only Nylorun dependencies are
 *   @nylorun/agents and @nylorun/core; it has no Nylorun devDependency.
 * - Installs nylorun (local Tenants) and @nylorun/cli (nylo, the Runtime client)
 *   from their tarballs into a separate tools directory, as `npx` would.
 * - Builds (or reuses, see scripts/lib/stack.mjs) the Runtime and Studio
 *   images and, under a temporary NYLORUN_HOME, runs `nylorun start` in the
 *   project with NYLORUN_TENANT naming the test Tenant (its containers and
 *   the Project link), then the project's `npm run dev`: the
 *   starter registers `assistant` and its Action endpoint, the Runtime in
 *   Docker reaches it (a ping), and `nylorun studio` lands on that Tenant
 *   (303 + cookie, /_studio/hello, the Tenant proxy).
 * - A source edit re-registers the agent; stopping dev keeps the Tenant running; a
 *   second dev reuses the link; the compiled `npm start` registers with the
 *   two Project variables.
 * - The Tenant, reset and seeded with the fixture model
 *   (scripts/lib/stack-tenant.mjs), runs one turn through Studio's proxy that
 *   calls the starter's own `lookup_order` tool through its Action endpoint;
 *   the Project link is untouched.
 * - Without Docker on PATH, `nylorun start` says so.
 *
 * The Tenant has no model at first (the starter's .env names none), so it is
 * checked as not configured before the fixture model is seeded.
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
  runtimeGet,
  runtimeHeaders,
  studioSession,
  withStack,
} from "../../scripts/lib/stack.mjs";
import { withResetTenant } from "../../scripts/lib/stack-tenant.mjs";

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

      // 1-2. `nylorun start` in the project sets up and starts the Tenant (named by
      // NYLORUN_TENANT) and links the project.
      const { runtimeUrl } = await stack.start([], { cwd: project });
      assert.match(runtimeUrl ?? "", /^http:\/\/localhost:\d+$/);
      const { link, credentials } = await readProject(project);
      assert.equal(link.format, 3);
      assert.equal(link.tenant, env.NYLORUN_TENANT, "the link names the Tenant");
      assert.equal(link.hostUrl, runtimeUrl);
      assert.equal((await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777, 0o600);
      const { tenant } = await stack.operateStatus();
      assert.equal(tenant.state, "open");
      assert.equal(tenant.id, link.tenantId, "the link names the Host's one Tenant");
      // The application key `project`, put by `nylorun start` and listed (never shown) by the
      // Management API, and the management key `project-management` beside it.
      assert.equal(credentials.principalId, "project");
      assert.match(credentials.applicationKey, /^[0-9a-f]{64}$/);
      assert.equal(credentials.managementPrincipalId, "project-management");
      assert.ok(
        (await runtimeGet(runtimeUrl, credentials.managementKey, "/v1/tenant/keys")).keys.some(
          (key) => key.id === "project",
        ),
        "the Management API lists the project key",
      );

      const key = credentials.applicationKey;
      const tenantId = link.tenantId;
      const registered = (name) =>
        eventually(
          async () =>
            (await runtimeGet(runtimeUrl, key, "/v1/agents")).agents?.some(
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
            headers: runtimeHeaders(key),
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

      // No model: the starter's .env names none (step 9 seeds the fixture model). The
      // Management API takes the project's management key, which `nylorun start` wrote too.
      const model = await runtimeGet(runtimeUrl, credentials.managementKey, "/v1/tenant/model");
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
      const hello = await (await studio.get("/_studio/hello")).json();
      assert.equal(hello.tenant?.id, tenantId, "Studio serves the Host's Tenant");
      const proxied = await studio.get(`/_studio/tenants/${tenantId}/runtime/v1/agents`);
      assert.equal(proxied.status, 200, await proxied.clone().text());
      assert.ok(
        (await proxied.json()).agents.some((agent) => agent.manifest?.id === "assistant"),
        "Studio's Tenant proxy serves the agent",
      );
      const home = await studio.get("/", { redirect: "manual" });
      assert.equal(home.status, 302);
      assert.equal(home.headers.get("location"), `/tenants/${tenantId}`);
      assert.equal(
        (await fetch(`${studio.origin}/_studio/hello`)).status,
        200,
        "Studio on its loopback address needs no sign-in",
      );
      assert.equal(
        (
          await fetch(`${studio.origin}/_studio/hello`, {
            headers: { authorization: "Bearer forged" },
          })
        ).status,
        401,
        "Studio refuses a forged credential",
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
      assert.equal((await fetch(`${runtimeUrl}/ready`)).status, 200, "the Tenant keeps running");
      await disconnected();

      // 7. A second dev reuses the running Tenant and the Project link.
      const again = group.start("dev-again", process.execPath, [npmCli(), "run", "dev"], {
        cwd: project,
        env,
      });
      await connected();
      assert.equal((await readProject(project)).link.tenantId, tenantId);
      assert.equal((await stack.operateStatus()).tenant.id, tenantId, "the Tenant is reused");
      await again.stop();
      await disconnected();

      // 8. The compiled application (built before the edit) connects with the
      // two Project variables and registers its own manifest.
      const started = group.start("start", process.execPath, [npmCli(), "start"], {
        cwd: project,
        env: {
          ...env,
          NYLORUN_RUNTIME_URL: runtimeUrl,
          NYLORUN_SERVER_KEY: key,
        },
      });
      await registered("Order assistant");
      await connected();
      await started.stop();

      // 9. The Tenant, reset and seeded with the fixture model, runs a turn that
      // calls the starter's tool.
      await withResetTenant({ stack, name: "starter-smoke" }, async (fixture) => {
        assert.equal(fixture.id, tenantId, "the Host's one Tenant");
        // The two variables take precedence over the Project link.
        const runner = group.start("dev-fixture", process.execPath, [npmCli(), "run", "dev"], {
          cwd: project,
          env: { ...env, ...fixture.env },
        });
        const login = await stack.studioLogin();
        const fixtureStudio = await studioSession(login);
        const tenantApi = (path, init = {}) =>
          fixtureStudio.get(`/_studio/tenants/${tenantId}/runtime${path}`, {
            ...init,
            headers: {
              ...(init.body ? { "content-type": "application/json", origin: fixtureStudio.origin } : {}),
              ...init.headers,
            },
          });
        await eventually(
          async () =>
            (await (await tenantApi("/v1/agents")).json()).agents?.some(
              (agent) => agent.manifest?.id === "assistant",
            ),
          { timeout: 120_000, message: "the assistant on the reset Tenant" },
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
        // The fixture model calls lookup_order; the starter's Action endpoint runs it
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
      assert.equal((await stack.operateStatus()).tenant.id, tenantId, "the reset kept the Tenant");

      // 10. Without Docker, `nylorun start` says what to install and starts nothing.
      const noDocker = await run(process.execPath, [nylorunBin, "start"], {
        cwd: project,
        capture: true,
        timeout: 60_000,
        env: { ...env, PATH: dirname(process.execPath) },
      }).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(noDocker, "nylorun start fails without Docker");
      assert.match(`${noDocker.stderr}${noDocker.stdout}`, /Docker is required/);
    },
  );
  console.log(
    "PASS: packed starter (agents + core only) on a local Tenant: nylorun start in the project creates the Tenant and the link, npm run dev serves and registers the Action endpoint, nylorun studio lands on the Tenant, source restart, Tenant outlives dev, link reuse, compiled npm start, a fixture-model turn on the reset Tenant, Docker missing.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(smokeDeadline);
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}
