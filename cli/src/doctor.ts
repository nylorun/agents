import { release } from "node:os";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  createClient,
  resolveConnection,
  type AgentManifest,
} from "@nylorun/agents";
import { CliError } from "./errors.js";
import { launcher, resolveHome, runtimeInstallCommand } from "./runtime/launcher.js";

/** Oldest Node the Runtime runs on (it needs node:sqlite). */
const MIN_NODE_MAJOR = 24;

const LABEL: Record<string, string> = {
  virtual: "virtual shell",
};

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

/**
 * `nylorun doctor runtime`: check the two prerequisites (Node 24+ and an
 * installed `@nylorun/runtime`) and print the fix for each one that fails.
 * Exits 1 when a prerequisite is missing; installs nothing.
 */
export async function doctorRuntime(options: { json: boolean }): Promise<void> {
  const nodeOk = Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR;
  let runtime:
    | { ok: true; version: string; bin: string; node: string }
    | { ok: false; problem: string };
  try {
    const handle = await launcher(resolveHome());
    runtime = { ok: true, ...handle.runtime };
  } catch (error) {
    runtime = {
      ok: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          node: { version: process.versions.node, ok: nodeOk },
          runtime,
          install: runtimeInstallCommand(),
        },
        null,
        2,
      ),
    );
  } else {
    const rows: [string, string][] = [
      [
        "node",
        nodeOk
          ? `✓ ${process.versions.node}`
          : `✗ ${process.versions.node}: install Node ${MIN_NODE_MAJOR} or newer`,
      ],
      [
        "runtime",
        runtime.ok
          ? `✓ ${runtime.version} · ${runtime.bin}`
          : `✗ ${runtime.problem.split("\n")[0]}\n    ${runtimeInstallCommand()}`,
      ],
    ];
    const width = Math.max(...rows.map(([key]) => key.length)) + 2;
    for (const [key, value] of rows)
      console.log(`  ${key.padEnd(width)}${value}`);
  }
  if (!nodeOk || !runtime.ok) process.exitCode = 1;
}

/** `nylorun doctor sandbox`: Tenant sandbox report via the Tenant API (F2-4). */
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
      ? "auto (seed Tenant sandbox.backend via nylorun dev / .env NYLORUN_SANDBOX)"
      : report.preference,
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

/** One line for the dev banner, or undefined when no connected agent declares a sandbox. */
export async function sandboxBanner(
  runtimeUrl: string,
  serverKey: string,
  manifests: readonly AgentManifest[],
  tenantId: string,
): Promise<string | undefined> {
  const capability = manifests
    .flatMap((manifest) => manifest.capabilities)
    .find((item) => item.sandbox);
  if (!capability) return undefined;
  let report: SandboxReport | undefined;
  try {
    const response = await fetch(`${runtimeUrl}/v1/tenant/sandbox`, {
      headers: {
        authorization: `Bearer ${serverKey}`,
        [TENANT_HEADER]: tenantId,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) report = (await response.json()) as SandboxReport;
  } catch {
    /* ignore */
  }
  if (!report) return undefined;
  const doctor = "run `npx nylorun doctor sandbox` for options";
  if (!report.backend)
    return `sandbox: unavailable (${report.reason}) · ${doctor}`;
  const network = capability.sandbox?.network?.preset ?? "dev";
  return `sandbox: ${LABEL[report.backend] ?? report.backend} · network: ${network}`;
}
