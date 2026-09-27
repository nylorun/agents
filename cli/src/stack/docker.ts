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

/** Fail with a clear message when Docker or Compose v2 is unavailable. */
export async function dockerPreflight(docker: DockerRunner): Promise<void> {
  const server = await docker.run(["version", "--format", "{{.Server.Version}}"]);
  if (server.missing)
    throw new CliError(
      "Docker is required for the Nylorun stack, and the docker command was not found. Install Docker Desktop, OrbStack, Colima or another Docker engine with Compose v2, then retry.",
      1,
    );
  if (server.code !== 0)
    throw new CliError(
      `Docker is installed but its engine is not reachable (${firstLine(server.stderr) || `exit ${server.code}`}). Start Docker Desktop or your Docker engine, then retry.`,
      1,
    );
  const compose = await docker.run(["compose", "version", "--short"]);
  if (compose.code !== 0 || !/^v?[2-9]\./.test(compose.stdout.trim()))
    throw new CliError(
      `Docker Compose v2 is required (the "docker compose" plugin); ${compose.code === 0 ? `found ${compose.stdout.trim()}` : firstLine(compose.stderr) || "it is not installed"}. Install or update Docker Compose, then retry.`,
      1,
    );
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
