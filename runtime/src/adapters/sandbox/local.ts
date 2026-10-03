/**
 * Local backend (F7.2): the workspace of the pod sandbox the engine runs in. The pod is the
 * boundary (its own user, no capabilities, a read-only root, a NetworkPolicy that lets it reach
 * only the Harness API, the gates and egress-gate), so commands run as plain child processes:
 * `/bin/sh -c <command>` in `/workspace`, its own process group, killed whole on a timeout or a
 * cancel. Files are read and written with `fs`. Egress goes through egress-gate: every command
 * gets `HTTPS_PROXY`/`HTTP_PROXY` with the sandbox's current egress token as the proxy password
 * (`proxyEnv`), and nothing of the engine's own environment (`NYLORUN_*`).
 *
 * One pod holds one sandbox: every key opens the same `/workspace`. Removing a workspace is the
 * sandbox's reset or delete (a new volume), so `remove` and `list` do nothing here.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import type {
  ExecRequest,
  ExecResult,
  SandboxBackend,
  SandboxHandle,
  SandboxListing,
  SandboxProbe,
} from "../../sandbox/types.js";
import { SandboxFileTooLargeError } from "../../sandbox/types.js";

/** The most of each stream kept from one command (the tools keep 30 000 characters of it). */
const STREAM_LIMIT = 4 * 1024 * 1024;

export interface LocalBackendOptions {
  /** Default `/workspace`. */
  readonly workspace?: string;
  /** The proxy variables of the moment (the egress token rotates); default none. */
  readonly proxyEnv?: () => Readonly<Record<string, string>>;
  /** The base environment of commands (the engine's allowlisted one); `NYLORUN_*` is dropped. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** This process's environment without the engine's own variables. */
function baseEnv(env: Readonly<Record<string, string | undefined>>, workspace: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !name.startsWith("NYLORUN_") && !/_PROXY$/i.test(name)) out[name] = value;
  return { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb", ...out, HOME: workspace };
}

/** Collects a stream, keeping at most `STREAM_LIMIT` bytes (head first). */
function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = 0;
  return {
    push(chunk: Buffer) {
      if (size >= STREAM_LIMIT) {
        dropped += chunk.length;
        return;
      }
      const room = STREAM_LIMIT - size;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      size += kept.length;
      dropped += chunk.length - kept.length;
    },
    text() {
      const text = Buffer.concat(chunks).toString("utf8");
      return dropped > 0 ? `${text}\n… [${dropped} bytes dropped]` : text;
    },
  };
}

export function localBackend(options: LocalBackendOptions): SandboxBackend {
  const workspace = options.workspace ?? SANDBOX_WORKSPACE;
  const env = baseEnv(options.env, workspace);

  const exec = (request: ExecRequest, signal: AbortSignal): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new Error("Turn cancelled"));
      const child = spawn("/bin/sh", ["-c", request.command], {
        cwd: request.cwd,
        env: { ...env, ...(options.proxyEnv?.() ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a timeout or a cancel kills everything it started.
        detached: true,
      });
      const stdout = collector();
      const stderr = collector();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      let killed = false;
      let timedOut = false;
      const kill = () => {
        if (killed || child.pid === undefined) return;
        killed = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (code, by) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({
          exitCode: killed ? (timedOut ? 124 : 130) : (code ?? (by ? 128 : 1)),
          stdout: stdout.text(),
          stderr: stderr.text(),
          killed,
          timedOut,
        });
      });
    });

  const missing = (error: unknown) =>
    (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ENOTDIR";

  const handle: SandboxHandle = {
    workspace,
    exec,
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async readBytes(path, maxBytes) {
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
      if (size > maxBytes) throw new SandboxFileTooLargeError(path, size, maxBytes);
      return new Uint8Array(await readFile(path));
    },
    async listFiles(dir, maxEntries): Promise<SandboxListing | undefined> {
      try {
        if (!(await lstat(dir)).isDirectory()) return undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
      const entries: { path: string; size: number }[] = [];
      const walk = async (absolute: string, relative: string): Promise<boolean> => {
        for (const name of (await readdir(absolute)).sort()) {
          const path = posix.join(absolute, name);
          const inFolder = relative === "" ? name : `${relative}/${name}`;
          const info = await lstat(path);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            if (!(await walk(path, inFolder))) return false;
          } else if (info.isFile()) {
            entries.push({ path: inFolder, size: info.size });
            if (entries.length > maxEntries) return false;
          }
        }
        return true;
      };
      const complete = await walk(dir, "");
      return { entries, truncated: !complete };
    },
    async writeFile(path, content) {
      await writeFile(path, content, "utf8");
    },
    async stop() {},
  };

  return {
    name: "local",
    isolation: "container",
    async probe(): Promise<SandboxProbe> {
      const base = { name: "local" as const, isolation: "container" as const };
      try {
        accessSync(workspace, constants.W_OK);
        return { ...base, available: true, reason: `the pod sandbox's ${workspace}` };
      } catch (error) {
        return {
          ...base,
          available: false,
          reason: `${workspace} is not writable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    unmet: () => undefined,
    open: async () => handle,
    async remove() {},
    async list() {
      return [];
    },
  };
}
