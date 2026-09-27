/**
 * Post-publication smoke: the public quickstart on the local Docker stack, as
 * a developer runs it on a machine with Node 24 and Docker.
 *
 * - `npm exec @nylorun/create-agent@<version> -- application --yes` from the
 *   public registry, with an empty npm config and cache and no publishing
 *   credentials in the environment. The creator installs the starter (only
 *   @nylorun/agents) and starts nothing.
 * - The published `nylorun` and `@nylorun/cli`, installed from the registry
 *   beside the project (what `npx` runs): `nylorun up` starts the stack on the
 *   images it pins (`ghcr.io/nylorun/{runtime,studio}:<pin>`, pulled from
 *   GHCR, never built here), `nylo tenant create` creates and links the
 *   Project's Tenant, and the project's `npm run dev` connects its executor.
 * - Checks: the stack runs exactly the pinned images; the Admin API lists the
 *   Tenant; `assistant` is registered and its executor connected; the login
 *   from `nylorun studio` lands on the Tenant and Studio proxies its API.
 *
 * Runs under `withStack` (scripts/lib/stack.mjs): a temporary NYLORUN_HOME and
 * a unique Compose project, always reset (containers and volumes) at the end.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { npmCli } from "../lib/repo.mjs";
import { ProcessGroup } from "../lib/processes.mjs";
import {
  eventually,
  studioSession,
  tenantGet,
  withStack,
} from "../lib/stack.mjs";

/** `npm exec` arguments that run the published creator non-interactively. */
export function publicCreatorArguments(version) {
  return [
    "exec",
    "--yes",
    `--package=@nylorun/create-agent@${version}`,
    "--",
    "create-agent",
    "application",
    "--yes",
  ];
}

/**
 * The environment the public creator (and the npm installs it runs) starts
 * from: no credentials, an empty npm user and global config, and no image
 * overrides, so the published nylorun runs the images it pins.
 */
export function publicCreatorEnvironment(environment, npmrc, extras = {}) {
  // Installation scripts must not inherit publishing credentials or OIDC access.
  const clean = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/token|secret|password|credential|api.?key/i.test(key) &&
        !/^npm_config_(?:userconfig|globalconfig|cache|.*auth.*)$/i.test(key) &&
        !/^NYLORUN_(?:RUNTIME|STUDIO)_IMAGE$/.test(key),
    ),
  );
  return {
    ...clean,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: npmrc + ".global",
    // No model provider setup: the smoke runs no turn.
    NYLORUN_DEV_MODEL: "fixture",
    ...extras,
  };
}

/** The value of a printed field (`Runtime`, `Studio`, `Tenant`). */
export function bannerField(lines, name) {
  for (const line of lines) {
    const match = new RegExp(`^${name}\\s+(\\S+)`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** `docker compose ps --format json`: JSON lines, or one array (older Compose). */
export function composeServices(output) {
  const text = output.trim();
  if (text.startsWith("[")) return JSON.parse(text);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Create and start a project with the published creator, nylorun and CLI
 * `versions`. `pins` are the image versions this release ships
 * (nylorun/package.json `nylorun`); the published nylorun must pin the same.
 */
export async function publicCreatorSmoke(versions, pins) {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-published-"));
  const project = join(temporary, "application");
  const tools = join(temporary, "tools");
  const nylorun = join(tools, "node_modules/nylorun/dist/cli.js");
  const nylo = join(tools, "node_modules/@nylorun/cli/dist/cli.js");
  const npmrc = join(temporary, ".npmrc");
  try {
    await writeFile(npmrc, "");
    await writeFile(npmrc + ".global", "");
    const baseEnv = publicCreatorEnvironment(process.env, npmrc, {
      NPM_CONFIG_CACHE: join(temporary, "npm-cache"),
    });
    await withStack(
      { name: "nylorun-release-smoke", cli: nylorun, nylo, baseEnv, start: false },
      async (stack) => {
        const lines = [];
        const group = new ProcessGroup({
          log(line) {
            console.log(line);
            lines.push(line.replace(/^\[[^\]]+\] /, ""));
          },
        });
        const npm = async (label, args, cwd) => {
          const child = group.start(label, process.execPath, [npmCli(), ...args], {
            cwd,
            env: stack.env,
          });
          assert.equal(await child.exit, 0, `${label} failed`);
        };
        try {
          await npm("public-creator", publicCreatorArguments(versions.creator), temporary);
          await mkdir(tools);
          await writeFile(join(tools, "package.json"), JSON.stringify({ private: true }));
          await npm(
            "public-tools",
            ["install", "--no-audit", "--no-fund", `nylorun@${versions.nylorun}`, `@nylorun/cli@${versions.cli}`],
            tools,
          );
          const installed = JSON.parse(
            await readFile(join(tools, "node_modules/nylorun/package.json"), "utf8"),
          ).nylorun;
          assert.deepEqual(
            { runtime: installed?.runtime, studio: installed?.studio },
            pins,
            "the published nylorun pins this release's images",
          );

          // Registry install is done; image pulls and the first stack start.
          const up = (await stack.nylorun(["up"], { cwd: project, timeout: 900_000 })).stdout;
          const running = composeServices(await stack.compose(["ps", "--format", "json"]));
          for (const name of ["runtime", "studio"])
            assert.equal(
              running.find((service) => service.Service === name)?.Image,
              `ghcr.io/nylorun/${name}:${pins[name]}`,
              `the stack runs the published ${name} image`,
            );
          const runtimeUrl = bannerField(up.split("\n"), "Runtime");
          assert.match(runtimeUrl ?? "", /^http:\/\/localhost:\d+$/, up);

          const created = (await stack.nylo(["tenant", "create"], { cwd: project })).stdout;
          assert.match(created, /^Tenant\s.*\(created\)$/m, created);
          const [link, credentials] = await Promise.all(
            ["link.json", "credentials.json"].map(async (file) =>
              JSON.parse(await readFile(join(project, ".nylorun", file), "utf8")),
            ),
          );
          assert.equal(link.hostUrl, runtimeUrl);
          const { tenantId } = link;
          const key = credentials.applicationKey;

          const admin = await stack.admin(
            pathToFileURL(join(tools, "node_modules/@nylorun/admin/dist/index.js")).href,
          );
          assert.ok(
            (await admin.listTenants()).some(
              (tenant) => tenant.id === tenantId && tenant.state === "open",
            ),
            "the Admin API lists the Project's Tenant",
          );
          group.start("dev", process.execPath, [npmCli(), "run", "dev"], {
            cwd: project,
            env: stack.env,
          });
          await eventually(
            async () =>
              (await tenantGet(runtimeUrl, tenantId, key, "/v1/agents")).agents?.some(
                (agent) => agent.manifest?.id === "assistant",
              ),
            { timeout: 120_000, message: 'the seed agent "assistant"' },
          );
          await eventually(
            async () =>
              (await tenantGet(runtimeUrl, tenantId, key, "/v1/executors")).executors?.some(
                (executor) => executor.agentId === "assistant" && executor.connected,
              ),
            { message: "a connected assistant executor" },
          );

          const studioUrl = bannerField(
            (await stack.nylorun(["studio", "--no-open"], { cwd: project, echo: false })).stdout.split("\n"),
            "Studio",
          );
          assert.match(studioUrl ?? "", /^http:\/\/localhost:\d+\/login\?token=/);
          const studio = await studioSession(studioUrl);
          assert.equal(studio.location, `/tenants/${tenantId}`);
          const listed = await (await studio.get("/_studio/tenants")).json();
          assert.ok(
            listed.tenants?.some((tenant) => tenant.id === tenantId),
            "Studio lists the Tenant",
          );
          const proxied = await studio.get(
            `/_studio/tenants/${tenantId}/runtime/v1/agents`,
          );
          assert.equal(proxied.status, 200, await proxied.clone().text());
          console.log(
            `PASS: @nylorun/create-agent@${versions.creator}, nylorun@${versions.nylorun} and @nylorun/cli@${versions.cli} on ghcr.io/nylorun/runtime:${pins.runtime} and studio:${pins.studio}: Tenant created, executor connected, Studio login works.`,
          );
        } finally {
          // Stop the Project before the stack is reset.
          await group.close();
        }
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
