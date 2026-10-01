import { release } from "node:os";
import { createClient, resolveConnection } from "@nylorun/agents";
import { CliError } from "./errors.js";

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
  /** The Tenant's sandbox configuration (Runtimes with Sandboxes v3). */
  config?: {
    default: "none" | "virtual" | Record<string, unknown>;
    limits?: { network?: readonly string[] };
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

async function fetchSandboxReport(options?: {
  url?: string;
  key?: string;
  tenant?: string;
}): Promise<SandboxReport> {
  const connection = await resolveConnection(options);
  const client = createClient({
    url: connection.url,
    key: connection.key,
    tenant: connection.tenant,
  });
  return client.transport.json<SandboxReport>(
    "/v1/tenant/sandbox",
    "GET",
    undefined,
  );
}

/** `nylo doctor sandbox`: Tenant sandbox report via the Tenant API (F2-4). */
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
      ? "auto (seed Tenant sandbox.backend via nylo tenant create / .env NYLORUN_SANDBOX)"
      : report.preference,
  ]);
  if (report.config)
    rows.push([
      "default",
      report.config.default === "none"
        ? "none: sessions get a sandbox only when opened with one (set a default with PUT /v1/tenant/sandbox)"
        : report.config.default === "virtual"
          ? "virtual: sessions that name no sandbox get one"
          : "a Tenant sandbox: sessions that name no sandbox get it",
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
