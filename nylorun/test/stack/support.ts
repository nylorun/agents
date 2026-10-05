import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import type { StackDeps } from "../../src/stack/commands.js";
import type { DockerResult, DockerRunner } from "../../src/stack/docker.js";
import type { PortProbe } from "../../src/stack/ports.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * A Host root (`NYLORUN_HOME`) in a new temporary directory, which `testDeps` also uses as the
 * working directory (not a project) and, under `nylorun/`, as `~/.nylorun`.
 */
export async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-stack-"));
  roots.push(root);
  return join(root, "home-root");
}

/** A temporary directory removed after the test. */
export async function temporaryDir(prefix = "nylorun-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Ports probe: `busy` ports are taken; free picks count up from 50000. */
export function fakePorts(busy: number[] = []): PortProbe & { picks: number } {
  let next = 50000;
  const probe = {
    picks: 0,
    async isFree(port: number) {
      return !busy.includes(port);
    },
    async pickFree() {
      probe.picks += 1;
      return next++;
    },
  };
  return probe;
}

/** The Tenant id the fakes report. */
export const TEST_TENANT_ID = "tn_01TESTSTACK000000000000001";

/** A Tenant as `nylorun-operate status --json` reports it. */
export interface FakeTenant {
  id: string | null;
  name: string | null;
  state: "open" | "unavailable";
  cause?: string;
  message?: string;
}

/** The open Tenant `TEST_TENANT_ID` of Compose project `project` (named after it). */
export const openTenantOf = (project: string): FakeTenant => ({
  id: TEST_TENANT_ID,
  name: project.replace(/^nylorun-/, ""),
  state: "open",
});

/** `nylorun-operate status --json`'s answer: exit 0 when the Tenant is open, 2 when not. */
export function operateStatusResult(tenant: FakeTenant): DockerResult {
  return {
    code: tenant.state === "open" ? 0 : 2,
    stdout: `${JSON.stringify({ version: "0.10.0-beta", protocol: { min: 7, max: 8, features: [] }, tenant })}\n`,
    stderr: "",
  };
}

/** `GET /ready`: 200 while the Tenant is open (`checks.tenant`), else 503 with the same shape. */
export function readyResponse(tenant = true, harness = { mode: "remote", connected: 1 }): Response {
  return json(
    {
      status: tenant ? "ready" : "not_ready",
      service: "nylorun-runtime",
      checks: { listener: true, tenant },
      harness,
    },
    tenant ? 200 : 503,
  );
}

export interface FakeDocker extends DockerRunner {
  calls: string[][];
  streamed: string[][];
}

/**
 * Docker fake. `respond` answers captured runs; `streamCode` answers streamed
 * runs (compose up/stop/logs/down). Defaults: Docker and Compose present.
 */
export function fakeDocker(options: {
  respond?: (args: readonly string[]) => DockerResult | undefined;
  streamCode?: (args: readonly string[]) => number;
} = {}): FakeDocker {
  const calls: string[][] = [];
  const streamed: string[][] = [];
  return {
    calls,
    streamed,
    async run(args) {
      calls.push([...args]);
      const answer = options.respond?.(args);
      if (answer) return answer;
      if (args.includes("nylorun-operate") && args.includes("status"))
        return operateStatusResult(openTenantOf(args[args.indexOf("--project-name") + 1]!));
      if (args[0] === "version") return { code: 0, stdout: "29.0.0\n", stderr: "" };
      if (args[0] === "compose" && args[1] === "version")
        return { code: 0, stdout: "2.40.0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async stream(args) {
      streamed.push([...args]);
      return options.streamCode?.(args) ?? 0;
    },
  };
}

export type Route = (url: string, init?: RequestInit) => Response | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fakeFetch(route: Route): StackDeps["fetch"] & { requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    requests.push({ url, ...(init ? { init } : {}) });
    const response = route(url, init);
    if (!response) throw new TypeError("fetch failed");
    return response;
  };
  return Object.assign(fn, { requests });
}

export function testDeps(
  home: string,
  overrides: Partial<StackDeps> = {},
): StackDeps & { lines: string[]; errors: string[]; opened: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  return {
    env: { NYLORUN_HOME: home },
    docker: fakeDocker(),
    fetch: fakeFetch(() => undefined),
    ports: fakePorts(),
    uid: 1001,
    gid: 1002,
    runtimeVersion: "0.10.0-beta",
    studioVersion: "0.9.0-beta",
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    pidAlive: () => false,
    cwd: dirname(home),
    nylorunRoot: join(dirname(home), "nylorun"),
    pollMs: 1,
    healthTimeoutMs: 50,
    ...overrides,
    lines,
    errors,
    opened,
  };
}

/** The keys a fake `nylorun-operate` keeps, by id. */
export type FakeKeys = Map<string, { key: string; role: string; createdAt: string }>;

/**
 * A `respond` for `fakeDocker` that answers `docker compose … exec -T runtime nylorun-operate
 * keys … --json` as nylorun-operate does, from the keys of the Compose project (`keysOf`);
 * `studio` is refused (exit 1). `status --json` answers `tenantOf` the project. Other runs are
 * left to the caller.
 */
export function fakeOperate(
  keysOf: (project: string) => FakeKeys,
  tenantOf: (project: string) => FakeTenant = openTenantOf,
) {
  return (args: readonly string[]): DockerResult | undefined => {
    const at = args.indexOf("nylorun-operate");
    if (at < 0) return undefined;
    const project = args[args.indexOf("--project-name") + 1]!;
    const keys = keysOf(project);
    const [group, verb, id, flag, role] = args.slice(at + 1);
    if (group === "status") return operateStatusResult(tenantOf(project));
    const ok = (body: unknown) => ({ code: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
    if (group === "keys" && verb === "list")
      return ok({ keys: [...keys].map(([key, { role, createdAt }]) => ({ id: key, role, createdAt })) });
    if (group === "keys" && verb === "put" && id && flag === "--role") {
      if (id === "studio")
        return { code: 1, stdout: "", stderr: "The studio key is derived from the admin key\n" };
      const rotated = keys.has(id);
      const value = { key: randomBytes(32).toString("hex"), role: role!, createdAt: "2026-10-04T00:00:00.000Z" };
      keys.set(id, value);
      return ok({ id, ...value, rotated });
    }
    if (group === "keys" && verb === "rm" && id) return ok({ id, deleted: keys.delete(id) });
    return { code: 64, stdout: "", stderr: "Usage: nylorun-operate keys …\n" };
  };
}

/** Whether the request's bearer key is one of `keys` (a fake `GET /v1/me`). */
export function bearerIn(keys: Iterable<{ key: string }>, init?: RequestInit): boolean {
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
  return [...keys].some((value) => value.key === bearer);
}
