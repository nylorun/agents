import { spawn } from "node:child_process";
import { CliError } from "../errors.js";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The docker binary was not found. */
  missing?: boolean;
}

/** Runs `docker`; replaced by a fake in tests. */
export interface DockerRunner {
  /** Run and capture output. */
  run(args: readonly string[]): Promise<DockerResult>;
  /** Run with the terminal attached (progress, logs); resolves to the exit code. */
  stream(args: readonly string[]): Promise<number>;
}

export function spawnDocker(
  env: Readonly<Record<string, string | undefined>>,
  binary = "docker",
): DockerRunner {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    run(args) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(binary, [...args], {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error: NodeJS.ErrnoException) =>
          resolve({
            code: 127,
            stdout,
            stderr: error.message,
            ...(error.code === "ENOENT" ? { missing: true } : {}),
          }),
        );
        child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
    stream(args) {
      return new Promise((resolve) => {
        // Compose writes progress to stderr and logs to stdout.
        const child = spawn(binary, [...args], {
          env: childEnv,
          stdio: ["inherit", "inherit", "inherit"],
        });
        child.once("error", () => resolve(127));
        child.once("close", (code) => resolve(code ?? 1));
      });
    },
  };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

export type Check =
  | { ok: true; version: string }
  | { ok: false; problem: string };

export interface DockerChecks {
  docker: Check;
  /** Absent when Docker itself failed (Compose was not asked). */
  compose?: Check;
}

/** Check the Docker engine and Compose v2; never throws. */
export async function checkDocker(docker: DockerRunner): Promise<DockerChecks> {
  const server = await docker.run(["version", "--format", "{{.Server.Version}}"]);
  if (server.missing)
    return {
      docker: {
        ok: false,
        problem:
          "Docker is required for local Nylorun Tenants, and the docker command was not found. Install Docker Desktop, OrbStack, Colima or another Docker engine with Compose v2, then retry.",
      },
    };
  if (server.code !== 0)
    return {
      docker: {
        ok: false,
        problem: `Docker is installed but its engine is not reachable (${firstLine(server.stderr) || `exit ${server.code}`}). Start Docker Desktop, OrbStack, Colima or your Docker engine, then retry.`,
      },
    };
  const engine: Check = { ok: true, version: server.stdout.trim() };
  const compose = await docker.run(["compose", "version", "--short"]);
  if (compose.code !== 0 || !/^v?[2-9]\./.test(compose.stdout.trim()))
    return {
      docker: engine,
      compose: {
        ok: false,
        problem: `Docker Compose v2 is required (the "docker compose" plugin); ${compose.code === 0 ? `found ${compose.stdout.trim()}` : firstLine(compose.stderr) || "it is not installed"}. Install or update Docker Compose, then retry.`,
      },
    };
  return { docker: engine, compose: { ok: true, version: compose.stdout.trim() } };
}

/** Fail with a clear message when Docker or Compose v2 is unavailable. */
export async function dockerPreflight(docker: DockerRunner): Promise<void> {
  const checks = await checkDocker(docker);
  if (!checks.docker.ok) throw new CliError(checks.docker.problem, 1);
  if (checks.compose && !checks.compose.ok) throw new CliError(checks.compose.problem, 1);
}

export interface ComposeService {
  service: string;
  state: string;
  health: string;
}

/** Parse `docker compose ps --format json` (a JSON array, or one object per line). */
export function parseComposePs(stdout: string): ComposeService[] {
  const text = stdout.trim();
  if (text === "") return [];
  let rows: unknown[];
  if (text.startsWith("[")) {
    rows = JSON.parse(text) as unknown[];
  } else {
    rows = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown);
  }
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      service: String(record.Service ?? record.Name ?? ""),
      state: String(record.State ?? ""),
      health: String(record.Health ?? ""),
    };
  });
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

/** `123.4MiB` (from `docker stats` MemUsage) in bytes; undefined when unreadable. */
export function parseByteSize(text: string): number | undefined {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim());
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  return match && unit ? Number(match[1]) * unit : undefined;
}

/** `812 MB`, `2.1 GB`. */
export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Memory in use per Tenant: the sum over its running containers, found by the label
 * `dev.nylorun.tenant`, from one `docker stats --no-stream`. Undefined when Docker does not
 * answer; a Tenant with no running container is absent.
 */
export async function tenantMemory(docker: DockerRunner): Promise<Map<string, number> | undefined> {
  const ps = await docker.run([
    "ps",
    "--filter",
    "label=dev.nylorun.tenant",
    "--format",
    '{{.Names}}\t{{.Label "dev.nylorun.tenant"}}',
  ]);
  if (ps.code !== 0) return undefined;
  const owners = new Map(
    ps.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split("\t"))
      .filter((cells): cells is [string, string] => cells.length === 2 && cells[1] !== ""),
  );
  const memory = new Map<string, number>();
  if (owners.size === 0) return memory;
  const stats = await docker.run([
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.MemUsage}}",
    ...owners.keys(),
  ]);
  if (stats.code !== 0) return undefined;
  for (const line of stats.stdout.split(/\r?\n/)) {
    const [name, usage] = line.trim().split("\t");
    const tenant = name ? owners.get(name) : undefined;
    const bytes = usage ? parseByteSize(usage.split("/")[0]!) : undefined;
    if (tenant && bytes !== undefined) memory.set(tenant, (memory.get(tenant) ?? 0) + bytes);
  }
  for (const [tenant, bytes] of memory) memory.set(tenant, Math.round(bytes));
  return memory;
}
