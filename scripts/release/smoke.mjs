/**
 * Post-publication smoke: the public quickstart on a local Tenant, as
 * a developer runs it on a machine with Node 24 and Docker.
 *
 * - `npm exec @nylorun/create-agent@<version> -- application --yes` from the
 *   public registry, with an empty npm config and cache and no publishing
 *   credentials in the environment. The creator installs the starter (only
 *   @nylorun/agents) and starts nothing.
 * - The published `nylorun` (with `nylo`) and `@nylorun/cli` (nylorun under another name),
 *   installed from the registry beside the project (what `npx` runs):
 *   `nylorun start` in the project
 *   creates and starts its Tenant on the images it pins
 *   (`ghcr.io/nylorun/{runtime,studio}:<pin>`, pulled from GHCR, never built
 *   here), and links the project to it;
 *   the project's `npm run dev` saves its agent.
 * - Checks: the Tenant runs exactly the pinned images; `nylorun status` reports
 *   the linked Tenant open, and `nylorun status` (also through `@nylorun/cli`)
 *   reads it; `assistant` is saved; the login from
 *   `nylorun studio` lands on the Tenant and Studio proxies its API.
 *
 * Runs under `withStack` (scripts/lib/stack.mjs): a temporary NYLORUN_HOME and
 * a unique Tenant name (NYLORUN_TENANT), always reset (containers and volumes)
 * at the end.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCli } from "../lib/repo.mjs";
import { ProcessGroup } from "../lib/processes.mjs";
import {
  eventually,
  runtimeGet,
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

/** npm's answer for a version its registry CDN does not serve yet. */
const NOT_SERVED = /\bETARGET\b|\bnotarget\b/;

/**
 * Runs `attempt` until it exits 0. Only a version npm says it cannot find yet
 * (ETARGET) is retried, every `delayMs` for up to `windowMs`: CDN edges can
 * serve a fresh publish minutes after waitForInstall saw it (run 38868179065:
 * still ETARGET 45 seconds later, installable a few minutes after). Any other
 * failure returns its exit code at once.
 */
export async function retryUntilServed(
  attempt,
  { windowMs = 300_000, delayMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  const deadline = now() + windowMs;
  for (;;) {
    const { code, output } = await attempt();
    if (code === 0 || !NOT_SERVED.test(output) || now() + delayMs > deadline) return code;
    await sleep(delayMs);
  }
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
 * (cli/nylorun/package.json `nylorun`); the published nylorun must pin the same.
 */
export async function publicCreatorSmoke(versions, pins) {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-published-"));
  const project = join(temporary, "application");
  const tools = join(temporary, "tools");
  const nylorun = join(tools, "node_modules/nylorun/dist/cli.js");
  const mirror = join(tools, "node_modules/@nylorun/cli/dist/cli.js");
  const npmrc = join(temporary, ".npmrc");
  try {
    await writeFile(npmrc, "");
    await writeFile(npmrc + ".global", "");
    const baseEnv = publicCreatorEnvironment(process.env, npmrc, {
      NPM_CONFIG_CACHE: join(temporary, "npm-cache"),
    });
    await withStack(
      { name: "nylorun-release-smoke", cli: nylorun, baseEnv, start: false },
      async (stack) => {
        const lines = [];
        const group = new ProcessGroup({
          log(line) {
            console.log(line);
            lines.push(line.replace(/^\[[^\]]+\] /, ""));
          },
        });
        // Both installs read this release's versions, which the CDN may not serve yet.
        const npm = async (label, args, cwd) => {
          const code = await retryUntilServed(async () => {
            const from = lines.length;
            const child = group.start(label, process.execPath, [npmCli(), ...args], {
              cwd,
              env: stack.env,
            });
            // exit settles once the child's output is drained into lines.
            const code = await child.exit;
            return { code, output: lines.slice(from).join("\n") };
          });
          assert.equal(code, 0, `${label} failed`);
        };
        try {
          await npm(
            "public-creator",
            publicCreatorArguments(versions.creator),
            temporary,
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

          // Registry install is done; image pulls, the Tenant's first start and the link.
          const up = (await stack.nylorun(["start"], { cwd: project, timeout: 900_000 })).stdout;
          const running = composeServices(await stack.compose(["ps", "--format", "json"]));
          for (const name of ["runtime", "studio"])
            assert.equal(
              running.find((service) => service.Service === name)?.Image,
              `ghcr.io/nylorun/${name}:${pins[name]}`,
              `the Tenant runs the published ${name} image`,
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
          // The published nylorun reaches the Management API through the link.
          await stack.nylorun(["tenant", "signing-keys", "list"], { cwd: project, echo: false });

          // The published nylorun reports the Tenant (nylorun-operate status in the runtime
          // container), and so does @nylorun/cli, which runs it under another name.
          for (const entry of [undefined, mirror]) {
            const { tenant } = JSON.parse(
              (await stack.nylorun(["status", "--json"], { cwd: project, echo: false, entry })).stdout,
            );
            assert.deepEqual(
              { id: tenant?.id, state: tenant?.state },
              { id: tenantId, state: "open" },
              `${entry ? "@nylorun/cli" : "nylorun"} status reports the Project's Tenant open`,
            );
          }
          group.start("dev", process.execPath, [npmCli(), "run", "dev"], {
            cwd: project,
            env: stack.env,
          });
          await eventually(
            async () =>
              (await runtimeGet(runtimeUrl, key, "/v1/agent-manifests")).manifests?.some(
                (manifest) => manifest.name === "assistant",
              ) &&
              (await runtimeGet(runtimeUrl, key, "/v1/agents")).agents?.some(
                (agent) => agent.id === "assistant" && agent.manifest === "assistant",
              ),
            { timeout: 120_000, message: 'the saved agent manifest "assistant" and its Agent' },
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
            `PASS: @nylorun/create-agent@${versions.creator}, nylorun@${versions.nylorun} and @nylorun/cli@${versions.cli} on ghcr.io/nylorun/runtime:${pins.runtime} and studio:${pins.studio}: project linked to its Tenant, agent manifest saved and its Agent made, Studio login works.`,
          );
        } finally {
          // Stop the Project before the Tenant is reset.
          await group.close();
        }
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
