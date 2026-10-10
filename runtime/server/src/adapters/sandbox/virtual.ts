/**
 * Virtual backend: an emulated bash with a virtual filesystem, running in the Runtime process.
 * `/workspace` is backed by a host directory so files survive stop and Runtime restarts.
 * It is not a VM boundary; it exists so the first run and CI work on any machine.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import type {
  ExecRequest,
  ExecResult,
  SandboxBackend,
  SandboxHandle,
  SandboxProbe,
  SandboxSpec,
} from "../../sandbox/types.js";
import { SandboxFileTooLargeError } from "../../sandbox/types.js";

const ENV = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: SANDBOX_WORKSPACE,
  LANG: "C.UTF-8",
  TERM: "dumb",
});
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;

export function virtualBackend(options: { readonly root: string }): SandboxBackend {
  let sdk: Promise<typeof import("just-bash")> | undefined;
  const load = () => (sdk ??= import("just-bash"));
  const directory = (key: string) => join(options.root, key, "workspace");

  return {
    name: "virtual",
    isolation: "process",
    async probe(): Promise<SandboxProbe> {
      const base = { name: "virtual" as const, isolation: "process" as const };
      try {
        await load();
        return { ...base, available: true, reason: "emulated shell in the Runtime process (not a VM)" };
      } catch (error) {
        return {
          ...base,
          available: false,
          reason: `could not load just-bash: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    unmet(spec: SandboxSpec) {
      if (spec.network.suffixes.length > 0)
        return "the virtual backend cannot allow wildcard hosts; list exact host names in network.allow";
      return undefined;
    },
    async open(spec: SandboxSpec): Promise<SandboxHandle> {
      const { Bash, InMemoryFs, MountableFs, ReadWriteFs } = await load();
      const root = directory(spec.key);
      mkdirSync(root, { recursive: true });
      const base = new InMemoryFs();
      await base.mkdir("/tmp", { recursive: true });
      const fs = new MountableFs({
        base,
        mounts: [{ mountPoint: SANDBOX_WORKSPACE, filesystem: new ReadWriteFs({ root }) }],
      });
      const network =
        spec.network.preset === "open"
          ? { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: true }
          : spec.network.hosts.length > 0
            ? {
                allowedUrlPrefixes: spec.network.hosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
                allowedMethods: [...METHODS],
                denyPrivateRanges: true,
              }
            : undefined;
      const bash = new Bash({
        fs,
        cwd: SANDBOX_WORKSPACE,
        env: { ...ENV },
        python: true,
        ...(network ? { network } : {}),
      });
      return {
        async exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
          const controller = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, request.timeoutMs);
          const onAbort = () => controller.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) controller.abort();
          try {
            const result = await bash.exec(request.command, {
              cwd: request.cwd,
              env: { ...(request.env ?? {}), ...ENV },
              replaceEnv: true,
              rawScript: true,
              signal: controller.signal,
            });
            const killed = controller.signal.aborted;
            return {
              exitCode: killed ? (timedOut ? 124 : 130) : result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              killed,
              timedOut,
            };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        },
        async readFile(path) {
          if (!(await fs.exists(path))) return undefined;
          return fs.readFile(path, "utf8");
        },
        async readBytes(path, maxBytes) {
          if (!(await fs.exists(path))) return undefined;
          const stat = await fs.stat(path);
          if (stat.size > maxBytes) throw new SandboxFileTooLargeError(path, stat.size, maxBytes);
          return fs.readFileBuffer(path);
        },
        async listFiles(dir, maxEntries) {
          if (!(await fs.exists(dir)) || !(await fs.lstat(dir)).isDirectory) return undefined;
          const entries: { path: string; size: number }[] = [];
          const walk = async (absolute: string, relative: string): Promise<boolean> => {
            for (const name of (await fs.readdir(absolute)).sort()) {
              const path = posix.join(absolute, name);
              const inFolder = relative === "" ? name : `${relative}/${name}`;
              const stat = await fs.lstat(path);
              if (stat.isSymbolicLink) continue;
              if (stat.isDirectory) {
                if (!(await walk(path, inFolder))) return false;
              } else if (stat.isFile) {
                entries.push({ path: inFolder, size: stat.size });
                if (entries.length > maxEntries) return false;
              }
            }
            return true;
          };
          const complete = await walk(dir, "");
          return { entries, truncated: !complete };
        },
        async writeFile(path, content) {
          await (typeof content === "string" ? fs.writeFile(path, content, "utf8") : fs.writeFile(path, content));
        },
        async stop() {},
      };
    },
    async remove(key: string) {
      rmSync(join(options.root, key), { recursive: true, force: true });
    },
    async list(prefix: string) {
      try {
        return readdirSync(options.root).filter((name) => name.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}
