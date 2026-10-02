/**
 * Post-publication smoke: the public quickstart on the local Docker stack, as
 * a developer runs it on a machine with Node 24 and Docker.
 *
 * - `npm exec @nylorun/create-agent@<version> -- application --yes` from the
 *   public registry, with an empty npm config and cache and no publishing
 *   credentials in the environment. The creator installs the starter (only
 *   @nylorun/agents) and starts nothing.
 * - The published `nylorun` and `@nylorun/cli`, installed from the registry
 *   beside the project (what `npx` runs): `nylorun start` in the project
 *   creates and starts its stack on the images it pins
 *   (`ghcr.io/nylorun/{runtime,studio}:<pin>`, pulled from GHCR, never built
 *   here), whose Runtime creates its one Tenant, and links the project to it;
 *   the project's `npm run dev` serves and registers its Action endpoint.
 * - Checks: the stack runs exactly the pinned images; the Admin API reports
 *   the linked Tenant open; `assistant` is registered and the Runtime reaches
 *   its Action endpoint (a ping through the Runtime answers 200); the login
 *   from `nylorun studio` lands on the Tenant and Studio proxies its API.
 *
 * Runs under `withStack` (scripts/lib/stack.mjs): a temporary NYLORUN_HOME and
 * a unique stack name (NYLORUN_STACK), always reset (containers and volumes)
 * at the end.
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
  runtimeGet,
  runtimeHeaders,
  studioSession,
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

/** The value of a printed field (`Runtime`, `Studio`). */
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
        const npm = async (label, args, cwd, { attempts = 1 } = {}) => {
          let last = 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            const child = group.start(label, process.execPath, [npmCli(), ...args], {
              cwd,
              env: stack.env,
            });
            last = await child.exit;
            if (last === 0) return;
            // Fresh publish: CDN edges can still ETARGET after waitForInstall.
            if (attempt < attempts) await new Promise((r) => setTimeout(r, 15_000));
          }
          assert.equal(last, 0, `${label} failed`);
        };
        try {
          await npm(
            "public-creator",
            publicCreatorArguments(versions.creator),
            temporary,
            { attempts: 4 },
          );
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

          // Registry install is done; image pulls, the first stack start and the link.
          const up = (await stack.nylorun(["start"], { cwd: project, timeout: 900_000 })).stdout;
          const running = composeServices(await stack.compose(["ps", "--format", "json"]));
          for (const name of ["runtime", "studio"])
            assert.equal(
              running.find((service) => service.Service === name)?.Image,
              `ghcr.io/nylorun/${name}:${pins[name]}`,
              `the stack runs the published ${name} image`,
            );
          const runtimeUrl = bannerField(up.split("\n"), "Runtime");
          assert.match(runtimeUrl ?? "", /^http:\/\/localhost:\d+$/, up);

          const [link, credentials] = await Promise.all(
            ["link.json", "credentials.json"].map(async (file) =>
              JSON.parse(await readFile(join(project, ".nylorun", file), "utf8")),
            ),
          );
          assert.equal(link.hostUrl, runtimeUrl);
          const { tenantId } = link;
          const key = credentials.applicationKey;
          // The published nylo works on the link.
          await stack.nylo(["status"], { cwd: project });

          const admin = await stack.admin(
            pathToFileURL(join(tools, "node_modules/@nylorun/admin/dist/index.js")).href,
          );
          const { tenant } = await admin.status();
          assert.deepEqual(
            { id: tenant.id, state: tenant.state },
            { id: tenantId, state: "open" },
            "the Admin API reports the Project's Tenant open",
          );
          group.start("dev", process.execPath, [npmCli(), "run", "dev"], {
            cwd: project,
            env: stack.env,
          });
          await eventually(
            async () =>
              (await runtimeGet(runtimeUrl, key, "/v1/agents")).agents?.some(
                (agent) => agent.manifest?.id === "assistant",
              ),
            { timeout: 120_000, message: 'the seed agent "assistant"' },
          );
          // The Runtime (in Docker) reaches the app's Action endpoint on this machine.
          await eventually(
            async () =>
              (
                await fetch(`${runtimeUrl}/v1/endpoints/assistant/ping`, {
                  method: "POST",
                  headers: runtimeHeaders(key),
                  signal: AbortSignal.timeout(15_000),
                })
              ).status === 200,
            { message: "the Runtime to reach the assistant's Action endpoint" },
          );

          const studioUrl = bannerField(
            (await stack.nylorun(["studio", "--no-open"], { cwd: project, echo: false })).stdout.split("\n"),
            "Studio",
          );
          assert.match(studioUrl ?? "", /^http:\/\/localhost:\d+\/login\?token=/);
          const studio = await studioSession(studioUrl);
          assert.equal(studio.location, `/tenants/${tenantId}`);
          const hello = await (await studio.get("/_studio/hello")).json();
          assert.equal(hello.tenant?.id, tenantId, "Studio serves the Tenant");
          const proxied = await studio.get(
            `/_studio/tenants/${tenantId}/runtime/v1/agents`,
          );
          assert.equal(proxied.status, 200, await proxied.clone().text());
          console.log(
            `PASS: @nylorun/create-agent@${versions.creator}, nylorun@${versions.nylorun} and @nylorun/cli@${versions.cli} on ghcr.io/nylorun/runtime:${pins.runtime} and studio:${pins.studio}: project linked to its stack's Tenant, Action endpoint reachable, Studio login works.`,
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
