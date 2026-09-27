import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { runStackCommand, runStudioCommand, type StackDeps } from "./commands.js";
import { spawnDocker } from "./docker.js";
import { pinnedVersion } from "./versions.js";
import { loopbackPorts } from "./ports.js";

export {
  ensureStack,
  isStackCommand,
  readStackStatus,
  stackUsage,
  studioLoginUrl,
  tenantStudioPath,
  STACK_SERVICES,
} from "./commands.js";
export type { StackDeps, StackEndpoints, StackStatus } from "./commands.js";
export { checkDocker } from "./docker.js";
export type { Check, DockerChecks } from "./docker.js";

function browserCommand(env: Readonly<Record<string, string | undefined>>): string {
  if (process.platform === "darwin") return "open";
  if (env.WSL_DISTRO_NAME) return "wslview";
  return "xdg-open";
}

/** Real dependencies: docker on PATH, global fetch, the terminal. */
export function defaultStackDeps(
  env: Readonly<Record<string, string | undefined>>,
): StackDeps {
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  return {
    env,
    docker: spawnDocker(env),
    fetch: (input, init) => fetch(input, init),
    ports: loopbackPorts,
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" ? process.getgid() : 1000,
    runtimeVersion: pinnedVersion("runtime"),
    studioVersion: pinnedVersion("studio"),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ...(interactive
      ? {
          confirm: async (question: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return /^y(es)?$/i.test((await rl.question(question)).trim());
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    openBrowser: async (url) => {
      const command = browserCommand(env);
      await new Promise<void>((resolve) => {
        const child = spawn(command, [url], { detached: true, stdio: "ignore" });
        child.once("error", () => {
          console.error(`Could not start ${command} to open a browser; open the Studio URL above.`);
          resolve();
        });
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

/** Entry for `nylorun start|stop|status|logs|reset|studio`. */
export async function stackCommand(
  name: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  return await runStackCommand(name, args, defaultStackDeps(env));
}

/** `nylorun studio`, landing on `next` (a Tenant page) when given. */
export async function studioCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: { next?: string } = {},
): Promise<number> {
  return await runStudioCommand(args, defaultStackDeps(env), options);
}
