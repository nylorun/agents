import { spawn } from "node:child_process";
import { CliError } from "../errors.js";

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The kubectl binary was not found. */
  missing?: boolean;
}

/** Runs `kubectl`; replaced by a fake in tests. */
export interface KubectlRunner {
  run(args: readonly string[], options?: { input?: string; timeoutMs?: number }): Promise<KubectlResult>;
}

/** The real `kubectl` on PATH. */
export function spawnKubectl(
  env: Readonly<Record<string, string | undefined>>,
  binary = "kubectl",
): KubectlRunner {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(binary, [...args], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 300_000);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve({
            code: 127,
            stdout,
            stderr: error.message,
            ...(error.code === "ENOENT" ? { missing: true } : {}),
          });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(options.input ?? "");
      });
    },
  };
}

/**
 * kubectl bound to one context: every call passes `--context`, so the current context is
 * never used.
 */
export interface Kube {
  context: string;
  run(args: readonly string[], options?: { input?: string; timeoutMs?: number }): Promise<KubectlResult>;
  /** Run and fail with a CliError naming `what` on a non-zero exit. */
  check(what: string, args: readonly string[], options?: { input?: string; timeoutMs?: number }): Promise<string>;
  /** `get -o json`; undefined when the object does not exist. */
  getJson<T = unknown>(args: readonly string[]): Promise<T | undefined>;
  /** `apply --server-side` of manifests. */
  apply(what: string, manifests: readonly object[]): Promise<void>;
}

export function kube(runner: KubectlRunner, context: string): Kube {
  const run: Kube["run"] = (args, options) => runner.run(["--context", context, ...args], options);
  const check: Kube["check"] = async (what, args, options) => {
    const result = await run(args, options);
    if (result.missing)
      throw new CliError("kubectl is not installed or not on PATH. Install it (https://kubernetes.io/docs/tasks/tools/).", 1);
    if (result.code !== 0)
      throw new CliError(`${what} failed (kubectl --context ${context} ${args.join(" ")}): ${result.stderr.trim() || result.stdout.trim()}`, 1);
    return result.stdout;
  };
  return {
    context,
    run,
    check,
    async getJson<T>(args: readonly string[]) {
      const result = await run(["get", ...args, "-o", "json"]);
      if (result.code !== 0) {
        if (/NotFound|not found/i.test(result.stderr)) return undefined;
        throw new CliError(`kubectl --context ${context} get ${args.join(" ")}: ${result.stderr.trim()}`, 1);
      }
      return JSON.parse(result.stdout) as T;
    },
    async apply(what, manifests) {
      await check(
        what,
        ["apply", "--server-side", "--field-manager", "nylorun", "--force-conflicts", "-f", "-"],
        { input: JSON.stringify({ apiVersion: "v1", kind: "List", items: manifests }) },
      );
    },
  };
}

/** The kubeconfig's contexts (`kubectl config get-contexts -o name`). */
export async function contexts(runner: KubectlRunner): Promise<string[]> {
  const result = await runner.run(["config", "get-contexts", "-o", "name"]);
  if (result.missing)
    throw new CliError("kubectl is not installed or not on PATH. Install it (https://kubernetes.io/docs/tasks/tools/).", 1);
  if (result.code !== 0) throw new CliError(`kubectl config get-contexts failed: ${result.stderr.trim()}`, 1);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
