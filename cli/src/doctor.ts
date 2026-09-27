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
import {
  checkDocker,
  defaultStackDeps,
  readStackStatus,
  type Check,
  type StackDeps,
  type StackStatus,
} from "./stack/index.js";

/** Oldest Node the CLI and the developer's application run on. */
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

export interface StackDoctorReport {
  node: { version: string; ok: boolean };
  docker: Check;
  compose?: Check;
  stack?: Pick<StackStatus, "project" | "home" | "state" | "runtime" | "studio">;
}

/**
 * `nylorun doctor`: check the prerequisites of the local stack (Node 24+,
 * Docker, Compose v2) and, when they pass, the stack's health. Prints the fix
 * for each problem and returns 1 when a prerequisite is missing or a running
 * stack is unhealthy; installs and starts nothing.
 */
export async function doctorStack(options: {
  json: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  /** Stack dependencies (tests). */
  deps?: StackDeps;
  log?: (line: string) => void;
}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const deps = options.deps ?? defaultStackDeps(options.env ?? process.env);
  const nodeOk = Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR;
  const checks = await checkDocker(deps.docker);
  const report: StackDoctorReport = {
    node: { version: process.versions.node, ok: nodeOk },
    ...checks,
  };
  if (checks.docker.ok && checks.compose?.ok) {
    const status = await readStackStatus(deps);
    report.stack = {
      project: status.project,
      home: status.home,
      state: status.state,
      runtime: status.runtime,
      studio: status.studio,
    };
  }
  const stackBroken =
    report.stack?.state === "running" && !report.stack.runtime.healthy;
  const failed =
    !nodeOk || !checks.docker.ok || checks.compose?.ok === false || stackBroken;
  if (options.json) {
    log(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }
  const line = (check: Check | undefined) =>
    check === undefined
      ? "- not checked"
      : check.ok
        ? `✓ ${check.version}`
        : `✗ ${check.problem}`;
  const rows: [string, string][] = [
    [
      "node",
      nodeOk
        ? `✓ ${process.versions.node}`
        : `✗ ${process.versions.node}: install Node ${MIN_NODE_MAJOR} or newer`,
    ],
    ["docker", line(checks.docker)],
    ["compose", line(checks.compose)],
  ];
  const stack = report.stack;
  if (stack) {
    rows.push([
      "stack",
      stack.state === "absent"
        ? `- not created under ${stack.home}: run nylorun start (or nylorun dev)`
        : stack.state === "stopped"
          ? `- stopped (project ${stack.project}): run nylorun start`
          : stack.runtime.healthy
            ? `✓ running (project ${stack.project})`
            : `✗ running, but the Runtime does not answer: see nylorun status and nylorun logs runtime`,
    ]);
    if (stack.state === "running") {
      rows.push([
        "runtime",
        stack.runtime.healthy
          ? `✓ ${stack.runtime.url ?? "?"} · ${stack.runtime.version ?? "?"}`
          : `✗ ${stack.runtime.url ?? "?"} not answering`,
      ]);
      rows.push(["studio", `${stack.studio.url ?? "?"} · ${stack.studio.state}`]);
    }
  }
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows) log(`  ${key.padEnd(width)}${value}`);
  return failed ? 1 : 0;
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
