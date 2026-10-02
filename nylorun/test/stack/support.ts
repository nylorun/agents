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
