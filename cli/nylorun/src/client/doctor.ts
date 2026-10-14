import { release } from "node:os";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import { connect, managementClient } from "./target.js";

export type SandboxReport = {
  preference: string;
  backend: string | null;
  isolation?: string;
  reason?: string;
  probes: {
    name: string;
    isolation: string;
    available: boolean;
    reason?: string;
    version?: string;
  }[];
  defaultImage?: string;
  /** The Tenant's Environment settings in force (`environments.config`, protocol 11). */
  config?: {
    limits?: { network?: readonly string[]; idle?: string; environments?: number };
  };
};

function platformLine(): string {
  const os =
    process.platform === "darwin"
      ? "macOS"
      : process.env.WSL_DISTRO_NAME
        ? `Linux (WSL: ${process.env.WSL_DISTRO_NAME})`
        : process.platform;
  return `${os} (kernel ${release()}) · ${process.arch}`;
}

/**
 * `nylorun doctor sandbox`: the Tenant's sandbox report (`GET /v1/tenant/sandbox`, Management API)
 * of the installation `target.ts` picks (F2-4).
 */
export async function doctorSandbox(
  deps: StackDeps,
  options: { json: boolean; tenant?: string },
): Promise<void> {
  const log = (line: string) => deps.out(line);
  let report: SandboxReport;
  try {
    const connection = await connect(deps, "management", options.tenant);
    report = (await managementClient(deps, connection).settings.sandbox.get()) as SandboxReport;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      error instanceof Error
        ? error.message
        : `Could not read Tenant sandbox status: ${String(error)}`,
      1,
    );
  }
  if (options.json) {
    log(
      JSON.stringify({ platform: platformLine(), ...report }, null, 2),
    );
    return;
  }
  const rows: [string, string][] = [["platform", platformLine()]];
  for (const probe of report.probes)
    rows.push([
      probe.name,
      `${probe.available ? "✓" : "✗"} ${probe.reason ?? ""}${probe.version ? ` · ${probe.version}` : ""}`,
    ]);
  rows.push([
    "preference",
    report.preference === "auto"
      ? "auto (npx nylorun start seeds the Tenant's sandbox.backend from .env NYLORUN_SANDBOX)"
      : report.preference,
  ]);
  rows.push([
    "sessions",
    "get a sandbox only on an Environment (createSession({ environment }) names one)",
  ]);
  const limits = report.config?.limits;
  if (limits)
    rows.push([
      "limits",
      [
        limits.idle ? `idle ${limits.idle}` : undefined,
        limits.environments === undefined ? undefined : `${limits.environments} environments`,
        limits.network ? `${limits.network.length} allowed hosts` : undefined,
      ]
        .filter((item) => item !== undefined)
        .join(", ") || "-",
    ]);
  rows.push([
    "selected",
    report.backend
      ? `${report.backend} (${report.isolation} isolation)`
      : `none: ${report.reason}`,
  ]);
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows)
    log(`  ${key.padEnd(width)}${value}`);
  if (report.backend === "virtual")
    log(
      "\n  The virtual shell emulates bash in the Runtime process; it is not a VM boundary.",
    );
}
