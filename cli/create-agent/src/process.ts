import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Process } from "./contracts.js";

export class CreationCancelled extends Error {
  readonly exitCode: number;
  constructor(readonly signal: NodeJS.Signals) {
    super(`Creation cancelled (${signal}).`);
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

/** Run the npm that launched this creator (`npm create` sets npm_execpath). */
function npmInvocation(args: readonly string[]): {
  command: string;
  args: string[];
} {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/u.test(execPath))
    return { command: process.execPath, args: [execPath, ...args] };
  return { command: "npm", args: [...args] };
}

/** Own npm and its descendants, including authentication started by a script. */
export async function runCommand(
  command: string,
  args: readonly string[],
  directory: string,
  signal: AbortSignal,
): Promise<Process> {
  signal.throwIfAborted();
  const invocation =
    command === "npm" ? npmInvocation(args) : { command, args: [...args] };
  const child = spawn(invocation.command, invocation.args, {
    cwd: directory,
    stdio: "inherit",
    detached: true,
  });
  let shutdown: Promise<void> | undefined;
  const stop = (requested: NodeJS.Signals) => {
    shutdown ??= stopTree(requested);
    // Await cleanup below, but observe early failures while npm is still exiting.
    void shutdown.catch(() => undefined);
  };
  const onAbort = () =>
    stop(
      signal.reason instanceof CreationCancelled
        ? signal.reason.signal
        : "SIGTERM",
    );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const result = await new Promise<Process>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, endedBy) =>
        resolve({ status, signal: endedBy }),
      );
    });
    if (result.signal || result.status === 130 || result.status === 143)
      stop(result.signal ?? (result.status === 130 ? "SIGINT" : "SIGTERM"));
    await shutdown;
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await shutdown;
  }

  async function stopTree(requested: NodeJS.Signals): Promise<void> {
    if (!child.pid) return;
    const send = (value: NodeJS.Signals | 0) => {
      try {
        process.kill(-child.pid!, value);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        // EPERM on a liveness probe means the group still exists. Recheck while
        // exiting descendants are reaped; actual signal failures still propagate.
        if (value === 0 && (error as NodeJS.ErrnoException).code === "EPERM")
          return true;
        throw error;
      }
    };
    if (!send(requested)) return;
    const deadline = Date.now() + 5000;
    while (send(0) && Date.now() < deadline) await delay(25);
    if (send(0)) send("SIGKILL");
  }
}
