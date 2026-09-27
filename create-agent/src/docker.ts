import { execFile } from "node:child_process";
import type { DockerCheck } from "./contracts.js";

const INSTALL =
  "Install Docker with Compose v2: Docker Desktop (https://docs.docker.com/get-started/get-docker/), OrbStack (https://orbstack.dev) or Colima (https://github.com/abiosoft/colima)";

type Result = { code: number; stdout: string; stderr: string; missing: boolean };

function run(args: readonly string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      [...args],
      { timeout: 15_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as NodeJS.ErrnoException).code === "number"
              ? Number((error as NodeJS.ErrnoException).code)
              : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
        });
      },
    );
  });
}

const firstLine = (text: string) => text.trim().split(/\r?\n/u)[0] ?? "";

/**
 * The local Nylorun stack runs in Docker Compose. Report, never fix: a missing
 * docker command, an engine that does not answer, or Compose older than v2.
 */
export async function checkDocker(): Promise<DockerCheck> {
  const server = await run(["version", "--format", "{{.Server.Version}}"]);
  if (server.missing)
    return { ok: false, problem: `${INSTALL}. The docker command was not found.` };
  if (server.code !== 0)
    return {
      ok: false,
      problem: `Start Docker (Docker Desktop, OrbStack or Colima): its engine is not reachable (${firstLine(server.stderr) || `exit ${server.code}`}).`,
    };
  const compose = await run(["compose", "version", "--short"]);
  if (compose.code !== 0 || !/^v?[2-9]\./u.test(compose.stdout.trim()))
    return {
      ok: false,
      problem: `${INSTALL}. Docker Compose v2 (the "docker compose" plugin) is required; ${
        compose.code === 0
          ? `found ${compose.stdout.trim()}`
          : firstLine(compose.stderr) || "it is not installed"
      }.`,
    };
  return { ok: true };
}
