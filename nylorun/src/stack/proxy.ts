import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerRunner } from "./docker.js";
import { parseEnvLines } from "./env-file.js";
import { PINNED_IMAGES } from "./images.js";
import { choosePort, DEFAULT_PORTS, type PortProbe } from "./ports.js";

/**
 * The Studio proxy: one small Caddy container per machine that gives each local Tenant's
 * Studio the address `http://<name>.localhost:<port>`. Browsers keep cookies per host, not
 * per port, so separate hosts keep the Studios' sessions apart. It routes browsers to Studio
 * only (programs keep the Runtime's `http://localhost:<port>`: Node's resolver need not
 * resolve `*.localhost`) and holds no Tenant data: its files are `~/.nylorun/proxy/`
 * (`compose.yaml`, `Caddyfile`, `.env`), and Caddy's own state is tmpfs.
 *
 * The proxy joins each Tenant's network (named after its Compose project) and reaches Studio
 * by container name, `<project>-studio:3000`. Docker cannot remove a network the proxy is
 * attached to, so `reset` and `delete` disconnect it first.
 */

export const PROXY_PROJECT = "nylorun-proxy";
export const PROXY_CONTAINER = "nylorun-proxy";

export interface ProxyPaths {
  dir: string;
  compose: string;
  caddyfile: string;
  /** The port, and whether Docker took the `::1` binding. */
  env: string;
}

export function proxyPaths(base: string): ProxyPaths {
  const dir = join(base, "proxy");
  return {
    dir,
    compose: join(dir, "compose.yaml"),
    caddyfile: join(dir, "Caddyfile"),
    env: join(dir, ".env"),
  };
}

/** `NYLORUN_PROXY_DISABLED=1`: no proxy; Studio is `http://localhost:<port>`. */
export function proxyDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return /^(1|true)$/i.test(env.NYLORUN_PROXY_DISABLED?.trim() ?? "");
}

export function proxyOrigin(name: string, port: number): string {
  return `http://${name}.localhost:${port}`;
}

export interface ProxySettings {
  port: number;
  /** Also published on `[::1]` (false once Docker refused it). */
  ipv6: boolean;
}

export async function readProxySettings(base: string): Promise<ProxySettings | undefined> {
  let text: string;
  try {
    text = await readFile(proxyPaths(base).env, "utf8");
  } catch {
    return undefined;
  }
  const values = parseEnvLines(text);
  const port = Number(values.get("NYLORUN_PROXY_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { port, ipv6: values.get("NYLORUN_PROXY_IPV6") !== "false" };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, path);
}

async function writeProxySettings(base: string, settings: ProxySettings): Promise<void> {
  const paths = proxyPaths(base);
  await mkdir(paths.dir, { recursive: true, mode: 0o755 });
  await writeAtomic(
    paths.env,
    [
      "# Written by `nylorun start`: the Studio proxy's port, kept from its first start,",
      "# and whether it is also published on [::1].",
      `NYLORUN_PROXY_PORT=${settings.port}`,
      `NYLORUN_PROXY_IPV6=${settings.ipv6}`,
      "",
    ].join("\n"),
  );
}

/**
 * The proxy's settings. On first use its port is 4160 when free, else a free one outside
 * `taken`; it is kept after that.
 */
export async function ensureProxySettings(
  base: string,
  ports: PortProbe,
  taken: ReadonlySet<number>,
): Promise<ProxySettings> {
  const existing = await readProxySettings(base);
  if (existing) return existing;
  const settings = { port: await choosePort(ports, DEFAULT_PORTS.proxy, undefined, taken), ipv6: true };
  await writeProxySettings(base, settings);
  return settings;
}

/** A Tenant the proxy routes to: its name and Compose project (also its network's name). */
export interface ProxyRoute {
  name: string;
  project: string;
}

/**
 * One site per Tenant. Site addresses carry no port: Caddy listens on 80 in the container,
 * and its host match ignores the published port in the browser's Host. The browser's Host
 * (`<name>.localhost:<port>`) reaches Studio unchanged, which Studio checks; a Tenant that is
 * not running answers 502, and an unknown host 404.
 */
export function renderCaddyfile(routes: readonly ProxyRoute[]): string {
  const sites = routes.map(
    ({ name, project }) => `http://${name}.localhost {
	reverse_proxy ${project}-studio:3000
	handle_errors {
		respond \`Tenant ${name} is not running. Run "nylorun start --tenant ${name}".\` 502
	}
}
`,
  );
  return [
    `# Written by \`nylorun start\`: a site per Tenant under ~/.nylorun/tenants. Rewritten on every start.
{
	auto_https off
	admin localhost:2019 # inside the container only; \`caddy reload\` uses it
}
`,
    ...sites,
    `:80 {
	respond \`No Tenant at {host}. "nylorun ls" lists the Tenants on this machine.\` 404
}
`,
  ].join("\n");
}

export function renderProxyCompose(ipv6: boolean): string {
  return `# Written by \`nylorun start\`; rewritten on every start. The port lives in .env.
name: ${PROXY_PROJECT}

services:
  proxy: # http://<tenant>.localhost:<port>: every local Tenant's Studio
    image: ${PINNED_IMAGES.proxy}
    container_name: ${PROXY_CONTAINER}
    labels:
      dev.nylorun.proxy: "true"
    volumes:
      - .:/etc/caddy:ro # this directory: the Caddyfile, reloaded with \`caddy reload\`
    tmpfs: [/config, /data] # Caddy's own state; nothing to keep
    ports:
      - "127.0.0.1:\${NYLORUN_PROXY_PORT:?run nylorun start}:80"${
        ipv6
          ? `
      - "[::1]:\${NYLORUN_PROXY_PORT:?run nylorun start}:80" # macOS resolves <name>.localhost to ::1 only`
          : ""
      }
    restart: unless-stopped

networks:
  default:
    name: ${PROXY_PROJECT}
    labels:
      dev.nylorun.proxy: "true"
`;
}

function proxyCompose(paths: ProxyPaths, ...args: string[]): string[] {
  return ["compose", "--project-name", PROXY_PROJECT, "--file", paths.compose, "--env-file", paths.env, ...args];
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1) ?? "";
}

/** Attach the proxy to a Tenant's network; "already attached" and "no such network" are fine. */
async function connectProxy(docker: DockerRunner, network: string): Promise<string | undefined> {
  const result = await docker.run(["network", "connect", network, PROXY_CONTAINER]);
  if (result.code === 0 || /already exists|not found|no such network/i.test(result.stderr)) return undefined;
  return lastLine(result.stderr) || `exit ${result.code}`;
}

/** Detach the proxy from a Tenant's network, so Compose can remove it; never fails. */
export async function disconnectProxy(docker: DockerRunner, network: string): Promise<void> {
  await docker.run(["network", "disconnect", "--force", network, PROXY_CONTAINER]);
}

async function reloadProxy(docker: DockerRunner): Promise<{ code: number; stderr: string }> {
  return await docker.run(["exec", PROXY_CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
}

/**
 * Write the routes, bring the proxy up (Compose recreates it when its file changed), attach
 * it to every routed Tenant's network and reload Caddy. Never throws: a problem is warned
 * once and the caller shows Studio's own port. When Docker refuses `[::1]` (IPv6 off), the
 * proxy listens on 127.0.0.1 only, and says so once.
 */
export async function startProxy(input: {
  docker: DockerRunner;
  base: string;
  settings: ProxySettings;
  routes: readonly ProxyRoute[];
  err(line: string): void;
  pollMs?: number;
}): Promise<boolean> {
  const { docker, base, err } = input;
  const paths = proxyPaths(base);
  const warn = (problem: string) =>
    err(`Warning: the Studio proxy is not available (${problem}); Studio is on its own port. See "nylorun doctor".`);
  try {
    await writeAtomic(paths.caddyfile, renderCaddyfile(input.routes));
    await writeAtomic(paths.compose, renderProxyCompose(input.settings.ipv6));
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return false;
  }
  let up = await docker.run(proxyCompose(paths, "up", "--detach"));
  if (up.code !== 0 && input.settings.ipv6) {
    await writeAtomic(paths.compose, renderProxyCompose(false));
    const ipv4 = await docker.run(proxyCompose(paths, "up", "--detach"));
    if (ipv4.code === 0) {
      await writeProxySettings(base, { ...input.settings, ipv6: false });
      err(
        `Docker refused the Studio proxy on [::1]:${input.settings.port} (${lastLine(up.stderr)}); it listens on 127.0.0.1 only, so a browser that resolves *.localhost to ::1 alone does not reach it.`,
      );
    }
    up = ipv4;
  }
  if (up.code !== 0) {
    warn(`docker compose up: ${lastLine(up.stderr) || `exit ${up.code}`}`);
    return false;
  }
  for (const route of input.routes) {
    const problem = await connectProxy(docker, route.project);
    if (problem) err(`Warning: the Studio proxy could not join ${route.project} (${problem}).`);
  }
  // A container Compose just created may not take the reload yet.
  for (let attempt = 1; ; attempt += 1) {
    const reload = await reloadProxy(docker);
    if (reload.code === 0) return true;
    if (attempt === 10) {
      warn(`caddy reload: ${lastLine(reload.stderr) || `exit ${reload.code}`}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500));
  }
}

/** Rewrite the routes of an existing proxy and reload it (`delete`); never fails. */
export async function refreshProxyRoutes(
  docker: DockerRunner,
  base: string,
  routes: readonly ProxyRoute[],
): Promise<void> {
  const paths = proxyPaths(base);
  if (!existsSync(paths.caddyfile)) return;
  await writeAtomic(paths.caddyfile, renderCaddyfile(routes));
  await reloadProxy(docker);
}

/** Stop the proxy (`stop --all`); true when it stopped. */
export async function stopProxy(docker: DockerRunner): Promise<boolean> {
  return (await docker.run(["compose", "--project-name", PROXY_PROJECT, "stop"])).code === 0;
}

export interface ProxyStatus {
  state: "running" | "stopped" | "absent" | "disabled";
  port?: number;
  ipv6?: boolean;
}

/** The proxy as `nylorun doctor` reports it. */
export async function readProxyStatus(
  docker: DockerRunner,
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProxyStatus> {
  if (proxyDisabled(env)) return { state: "disabled" };
  const settings = await readProxySettings(base);
  const inspect = await docker.run(["inspect", "--format", "{{.State.Status}}", PROXY_CONTAINER]);
  const state = inspect.code !== 0 ? "absent" : inspect.stdout.trim() === "running" ? "running" : "stopped";
  return { state, ...(settings ? { port: settings.port, ipv6: settings.ipv6 } : {}) };
}
