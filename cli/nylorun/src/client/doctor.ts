import { release } from "node:os";
import { findProjectRoot } from "@nylorun/core/project";
import { CliError } from "../errors.js";
import { linkedConnection, managementClient } from "./project/connection.js";

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

/** The Tenant's sandbox report (`GET /v1/tenant/sandbox`, Management API). */
async function fetchSandboxReport(): Promise<SandboxReport> {
  const connection = await linkedConnection(findProjectRoot() ?? process.cwd());
  return (await managementClient(connection).settings.sandbox.get()) as SandboxReport;
}

/** `nylo doctor sandbox`: Tenant sandbox report via the Management API (F2-4). */
export async function doctorSandbox(options: { json: boolean }): Promise<void> {
  let report: SandboxReport;
  try {
    report = await fetchSandboxReport();
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? error.message
        : `Could not read Tenant sandbox status: ${String(error)}`,
      1,
    );
  }
  if (options.json) {
    console.log(
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
    console.log(`  ${key.padEnd(width)}${value}`);
  if (report.backend === "virtual")
    console.log(
      "\n  The virtual shell emulates bash in the Runtime process; it is not a VM boundary.",
    );
}
