/**
 * Packed create-agent starter on the local Docker stack:
 *
 *   node create-agent/scripts/smoke-starter.mjs
 *
 * - Packs the workspace (or takes NYLORUN_STACK_TARBALLS from release:check),
 *   scaffolds the starter from the packed creator, installs it offline from
 *   the tarballs and builds it. Its production Nylorun dependencies are only
 *   @nylorun/agents and @nylorun/core; there is no Studio package.
 * - Builds (or reuses, see scripts/lib/stack.mjs) the Runtime and Studio
 *   images and runs `nylorun dev --no-open` under a temporary NYLORUN_HOME:
 *   dev starts the stack, creates and links the Project's Tenant, the starter
 *   registers `assistant` and its executor connects, and the printed Studio
 *   login lands on that Tenant (303 + cookie, /_studio/tenants, the Tenant
 *   proxy).
 * - A source edit re-registers the agent; stopping dev keeps the stack; a
 *   second dev reuses the link; the compiled `npm start` connects with the
 *   three Project variables.
 * - `nylorun dev --ephemeral` runs the starter on a temporary Tenant with the
 *   fixture model: one turn through Studio's proxy calls the starter's own
 *   `lookup_order` tool on its executor and answers with the result; Ctrl-C
 *   deletes the temporary Tenant and leaves the Project's Tenant and link.
 * - Without Docker on PATH, dev says so.
 *
 * The Project's own Tenant has no model (the starter seeds none), so it is
 * checked as not configured; the turn runs on the ephemeral Tenant only.
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
  withStack,
} from "../../scripts/lib/stack.mjs";

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
// Runtime runs in its image, so neither is installed into the starter.
const names = ["core", "agents", "admin", "cli", "create-agent"];

const bannerLine = (l) => l.includes("Ctrl-C stops this Project only");
const field = (lines, name) =>
  new RegExp(`^${name}\\s+(\\S+)`).exec(lines.find((l) => l.startsWith(name)) ?? "")?.[1];

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
  assert.equal(manifest.scripts.dev, "nylorun dev");
  assert.equal(manifest.scripts.start, "node dist/src/main.js");
  assert.ok(!JSON.stringify(manifest.scripts).includes("serve"));
  assert.equal(manifest.devDependencies["@nylorun/studio"], undefined);
  assert.equal(manifest.dependencies["@nylorun/runtime"], undefined);
  // Offline install: every @nylorun package from its tarball.
  manifest.dependencies["@nylorun/agents"] = `file:${tarballs.agents}`;
  manifest.dependencies["@nylorun/core"] = `file:${tarballs.core}`;
  manifest.devDependencies["@nylorun/cli"] = `file:${tarballs.cli}`;
  manifest.devDependencies["@nylorun/admin"] = `file:${tarballs.admin}`;
  await writeFile(join(project, "package.json"), JSON.stringify(manifest, null, 2));
  await run(process.execPath, [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: project,
  });
  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });

  const tree = JSON.parse(
    await run(process.execPath, [npmCli(), "ls", "--omit=dev", "--all", "--json"], {
      cwd: project,
      capture: true,
    }),
  );
  const production = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (name.startsWith("@nylorun/")) production.add(name);
      walk(child);
    }
  };
  walk(tree);
  assert.deepEqual(
    [...production].sort(),
    ["@nylorun/agents", "@nylorun/core"],
    "production Nylorun dependencies are agents and core",
  );

  const cliBin = join(project, "node_modules/@nylorun/cli/dist/cli.js");
  const images = await ensureImages();
  await withStack(
    { name: "nylorun-starter-smoke", cli: cliBin, images, start: false },
    async (stack) => {
      const { env } = stack;

      // 1. First `nylorun dev`: starts the stack, creates the Tenant, links the Project.
      const dev = group.start("dev", process.execPath, [cliBin, "dev", "--no-open"], {
        cwd: project,
        env,
      });
      await dev.line(bannerLine, 600_000);
      const first = { lines: output.get("dev") };
      const runtimeUrl = field(first.lines, "Runtime");
      const studioUrl = field(first.lines, "Studio");
      assert.match(runtimeUrl ?? "", /^http:\/\/localhost:\d+$/, first.lines.join("\n"));
      assert.ok(
        first.lines.some((l) => /^Runtime\s+\S+\s+\(started; stays running\)/.test(l)),
        "dev started the stack",
      );
      assert.ok(first.lines.some((l) => /^Tenant\s.*\(created\)/.test(l)), "dev created the Tenant");
      const { link, credentials } = await readProject(project);
      assert.equal(link.hostUrl, runtimeUrl);
      assert.equal((await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777, 0o600);
      const admin = await stack.admin(
        pathToFileURL(join(project, "node_modules/@nylorun/admin/dist/index.js")).href,
      );
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
          { message: `agent "assistant" named ${name}` },
        );
      const connected = () =>
        eventually(
          async () =>
            (await tenantGet(runtimeUrl, tenantId, key, "/v1/executors")).executors?.some(
              (executor) => executor.agentId === "assistant" && executor.connected,
            ),
          { message: "a connected assistant executor" },
        );
      await registered("Order assistant");
      await connected();

      // No model: the starter seeds none (the ephemeral run below uses the fixture model).
      const model = await tenantGet(runtimeUrl, tenantId, key, "/v1/tenant/model");
      assert.equal(model.configured, false, JSON.stringify(model));

      // 2. The Studio login from the banner lands on the Project's Tenant.
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

      // 3. A source edit restarts the application and re-registers the agent.
      const source = join(project, "agents/assistant/agent.ts");
      await writeFile(
        source,
        (await readFile(source, "utf8")).replace("Order assistant", "Updated order assistant"),
      );
      await registered("Updated order assistant");
      await connected();

      // 4. Ctrl-C stops the Project only.
      await dev.stop();
      assert.equal((await fetch(`${runtimeUrl}/ready`)).status, 200, "the stack keeps running");

      // 5. A second dev reuses the running stack and the Project link.
      const again = group.start("dev-again", process.execPath, [cliBin, "dev", "--no-studio"], {
        cwd: project,
        env,
      });
      await again.line(bannerLine, 120_000);
      const second = { lines: output.get("dev-again") };
      assert.ok(second.lines.some((l) => /^Runtime\s+\S+\s+\(already running\)/.test(l)));
      assert.ok(!second.lines.some((l) => /\(created\)/.test(l)), "the Tenant is reused");
      assert.ok(!second.lines.some((l) => l.startsWith("Studio")), "--no-studio prints no login");
      assert.equal((await readProject(project)).link.tenantId, tenantId);
      await again.stop();
      await eventually(
        async () =>
          !(await tenantGet(runtimeUrl, tenantId, key, "/v1/executors")).executors?.some(
            (executor) => executor.connected,
          ),
        { message: "the executor to disconnect after dev stops" },
      );

      // 6. The compiled application (built before the edit) connects with the
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

      // 7. `--ephemeral`: a temporary Tenant with the fixture model runs a turn
      // that calls the starter's tool, and is deleted when dev stops.
      const ephemeral = group.start(
        "dev-ephemeral",
        process.execPath,
        [cliBin, "dev", "--ephemeral", "--no-open"],
        { cwd: project, env },
      );
      await ephemeral.line(bannerLine, 120_000);
      const ephemeralLines = output.get("dev-ephemeral");
      assert.ok(
        ephemeralLines.some((l) => /^Tenant\s.*\(temporary, fixture model; deleted on exit\)/.test(l)),
        ephemeralLines.join("\n"),
      );
      const ephemeralLogin = field(ephemeralLines, "Studio");
      assert.match(ephemeralLogin ?? "", /^http:\/\/localhost:\d+\/login\?token=/);
      const temporaryId = /^\/tenants\/(.+)$/.exec(
        new URL(ephemeralLogin).searchParams.get("next") ?? "",
      )?.[1];
      assert.ok(temporaryId && temporaryId !== tenantId, "a new, temporary Tenant");
      assert.ok(
        (await admin.listTenants()).some((t) => t.id === temporaryId),
        "the Admin API lists the temporary Tenant",
      );
      assert.equal((await readProject(project)).link.tenantId, tenantId, "the link is untouched");

      const ephemeralStudio = await studioSession(ephemeralLogin);
      assert.equal(ephemeralStudio.location, `/tenants/${temporaryId}`);
      const tenantApi = (path, init = {}) =>
        ephemeralStudio.get(`/_studio/tenants/${temporaryId}/runtime${path}`, {
          ...init,
          headers: {
            ...(init.body ? { "content-type": "application/json", origin: ephemeralStudio.origin } : {}),
            ...init.headers,
          },
        });
      await eventually(
        async () =>
          (await (await tenantApi("/v1/agents")).json()).agents?.some(
            (agent) => agent.manifest?.id === "assistant",
          ),
        { message: "the assistant on the temporary Tenant" },
      );
      const sessionId = `smoke-${Date.now()}`;
      const created = await tenantApi(`/v1/sessions/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ requestId: `${sessionId}-create`, agentId: "assistant" }),
      });
      assert.ok(created.ok, `create session: ${created.status} ${await created.clone().text()}`);
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

      // Ctrl-C deletes the temporary Tenant, not the Project's.
      process.kill(ephemeral.child.pid, "SIGINT");
      const exitCode = await Promise.race([
        ephemeral.exit,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 60_000)),
      ]);
      await ephemeral.stop();
      assert.notEqual(exitCode, "timeout", "dev --ephemeral exits after Ctrl-C");
      assert.ok(
        ephemeralLines.some((l) => l.includes(`Deleted temporary Tenant ${temporaryId}.`)),
        ephemeralLines.join("\n"),
      );
      const remaining = await admin.listTenants();
      assert.ok(!remaining.some((t) => t.id === temporaryId), "the temporary Tenant is gone");
      assert.ok(remaining.some((t) => t.id === tenantId), "the Project's Tenant remains");

      // 8. Without Docker, dev says what to install and starts nothing.
      const noDocker = await run(process.execPath, [cliBin, "dev", "--no-open"], {
        cwd: project,
        capture: true,
        timeout: 60_000,
        env: { ...env, PATH: dirname(process.execPath) },
      }).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(noDocker, "nylorun dev fails without Docker");
      assert.match(`${noDocker.stderr}${noDocker.stdout}`, /Docker is required/);
    },
  );
  console.log(
    "PASS: packed starter (agents + core only) on the stack: dev starts the stack, creates and links the Tenant, registers and connects the executor, Studio login lands on the Tenant, source restart, stack outlives dev, link reuse, compiled npm start, an --ephemeral turn with the fixture model and its Tenant deleted, Docker missing.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(smokeDeadline);
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}
