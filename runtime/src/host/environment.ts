import type { HostConfigFile } from "./config.js";
import type { HostPaths } from "../tenant/paths.js";

const BASELINE_KEYS = new Set(["PATH", "LANG", "TZ"]);

function isBaselineKey(key: string): boolean {
  return BASELINE_KEYS.has(key) || key.startsWith("LC_");
}

/**
 * Allowlisted ambient keys for Host and Tenant child processes.
 * `NODE_OPTIONS` is never copied.
 */
export function baselineEnvironment(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS") continue;
    if (!isBaselineKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function proxyEnv(
  hostConfig: HostConfigFile,
): Record<string, string> {
  const out: Record<string, string> = {};
  const proxy = hostConfig.proxy;
  if (!proxy) return out;
  if (proxy.httpsProxy) out.HTTPS_PROXY = proxy.httpsProxy;
  if (proxy.noProxy) out.NO_PROXY = proxy.noProxy;
  if (proxy.nodeExtraCaCerts) out.NODE_EXTRA_CA_CERTS = proxy.nodeExtraCaCerts;
  return out;
}

export type HostProcessPathInputs = Pick<HostPaths, "root" | "home" | "tmp">;

/** Environment for the Runtime Host process itself (CLI spawn / `runtime run`). */
export function hostProcessEnvironment(
  baseline: Readonly<Record<string, string>>,
  hostConfig: HostConfigFile,
  paths: HostProcessPathInputs,
): Record<string, string> {
  return {
    ...baseline,
    ...proxyEnv(hostConfig),
    HOME: paths.home,
    TMPDIR: paths.tmp,
    NYLORUN_HOME: paths.root,
  };
}
