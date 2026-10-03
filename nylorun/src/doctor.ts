import { CliError } from "./errors.js";
import {
  checkDocker,
  defaultStackDeps,
  readStackStatus,
  type Check,
  type StackDeps,
  type StackStatus,
} from "./stack/index.js";

/** Oldest Node nylorun and the developer's application run on. */
const MIN_NODE_MAJOR = 24;

export interface StackDoctorReport {
  node: { version: string; ok: boolean };
  docker: Check;
  compose?: Check;
  tenant?: Pick<
    StackStatus,
    "name" | "project" | "home" | "state" | "runtime" | "tenant" | "studio" | "gateway" | "harness"
  >;
  /** Why no Tenant was checked: none is selected here (a project without a link). */
  noTenant?: string;
}

/**
 * `nylorun doctor`: check the prerequisites of a local Tenant (Node 24+,
 * Docker, Compose v2) and, when they pass, the Tenant's health. Prints the fix
 * for each problem and returns 1 when a prerequisite is missing or a running
 * Tenant is unhealthy; installs and starts nothing.
 */
export async function doctorStack(options: {
  json: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  /** Command dependencies (tests). */
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
    try {
      const status = await readStackStatus(deps);
      report.tenant = {
        name: status.name,
        project: status.project,
        home: status.home,
        state: status.state,
        runtime: status.runtime,
        ...(status.tenant ? { tenant: status.tenant } : {}),
        studio: status.studio,
        gateway: status.gateway,
        harness: status.harness,
      };
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode !== 2) throw error;
      report.noTenant = error.message;
    }
  }
  const broken =
    report.tenant?.state === "running" &&
    (!report.tenant.runtime.healthy ||
      !report.tenant.gateway.healthy ||
      (report.tenant.harness.mode === "remote" && !report.tenant.harness.healthy) ||
      report.tenant.tenant?.cause !== undefined);
  const failed =
    !nodeOk || !checks.docker.ok || checks.compose?.ok === false || broken;
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
  const local = report.tenant;
  if (report.noTenant) rows.push(["tenant", `- ${report.noTenant}`]);
  if (local) {
    rows.push([
      "tenant",
      local.state === "absent"
        ? `- ${local.name} not created under ${local.home}: run nylorun up`
        : local.state === "stopped"
          ? `- ${local.name} stopped (Compose project ${local.project}): run nylorun up`
          : local.runtime.healthy
            ? `✓ ${local.name} running (Compose project ${local.project})`
            : `✗ ${local.name} running, but the Runtime does not answer: see nylorun status and nylorun logs runtime`,
    ]);
    if (local.state === "running") {
      rows.push([
        "runtime",
        local.runtime.healthy
          ? `✓ ${local.runtime.url ?? "?"} · ${local.runtime.version ?? "?"}`
          : `✗ ${local.runtime.url ?? "?"} not answering`,
      ]);
      rows.push([
        "gateway",
        local.gateway.healthy
          ? `✓ ${local.gateway.state} · combined packing (runtime: core,loop; gateway: gates)`
          : `✗ ${local.gateway.state}: model calls fail; see nylorun logs gateway`,
      ]);
      rows.push([
        "harness",
        local.harness.mode === "in-process"
          ? "- in-process (NYLORUN_HARNESS=in-process in .env)"
          : local.harness.healthy
            ? `✓ ${local.harness.state} · remote (agent turns, MCP servers, workspaces)`
            : `✗ ${local.harness.state}: turns do not run; see nylorun logs harness`,
      ]);
      if (local.tenant)
        rows.push([
          "tenant id",
          local.tenant.state === "open"
            ? `✓ ${local.tenant.id ?? "?"} open`
            : `✗ ${local.tenant.id ?? "?"} unavailable${local.tenant.cause ? `: ${local.tenant.cause.code}: ${local.tenant.cause.repair}` : " (opening)"}`,
        ]);
      rows.push(["studio", `${local.studio.url ?? "?"} · ${local.studio.state}`]);
    }
  }
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows) log(`  ${key.padEnd(width)}${value}`);
  return failed ? 1 : 0;
}
