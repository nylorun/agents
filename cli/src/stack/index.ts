import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { runtimeVersion } from "../runtime/version.js";
import { runStackCommand, type StackDeps } from "./commands.js";
import { spawnDocker } from "./docker.js";
import { STUDIO_VERSION } from "./images.js";
import { loopbackPorts } from "./ports.js";

export { isStackCommand, stackUsage, STACK_SERVICES } from "./commands.js";
export type { StackDeps } from "./commands.js";

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
    runtimeVersion: runtimeVersion(),
    studioVersion: STUDIO_VERSION,
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

/** Entry for `nylorun start|stop|status|reset` and `nylorun stack <command>`. */
export async function stackCommand(
  name: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  return await runStackCommand(name, args, defaultStackDeps(env));
}
