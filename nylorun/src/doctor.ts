import { CliError } from "./errors.js";
import {
  checkDocker,
  defaultStackDeps,
  readStackStatus,
  type Check,
  type StackDeps,
  type StackStatus,
} from "./stack/index.js";

/** Oldest Node the stack's tooling and the developer's application run on. */
const MIN_NODE_MAJOR = 24;

export interface StackDoctorReport {
  node: { version: string; ok: boolean };
  docker: Check;
  compose?: Check;
  stack?: Pick<
    StackStatus,
    "name" | "project" | "home" | "state" | "runtime" | "tenant" | "studio" | "gateway"
  >;
  /** Why no stack was checked: none is selected here (no link, NYLORUN_STACK or NYLORUN_HOME). */
  noStack?: string;
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
    try {
      const status = await readStackStatus(deps);
      report.stack = {
        name: status.name,
        project: status.project,
        home: status.home,
        state: status.state,
        runtime: status.runtime,
        ...(status.tenant ? { tenant: status.tenant } : {}),
        studio: status.studio,
        gateway: status.gateway,
      };
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode !== 2) throw error;
      report.noStack = error.message;
    }
  }
  const stackBroken =
    report.stack?.state === "running" &&
    (!report.stack.runtime.healthy ||
      !report.stack.gateway.healthy ||
      report.stack.tenant?.cause !== undefined);
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
  if (report.noStack) rows.push(["stack", `- ${report.noStack}`]);
  if (stack) {
    rows.push([
      "stack",
      stack.state === "absent"
        ? `- ${stack.name} not created under ${stack.home}: run nylorun up`
        : stack.state === "stopped"
          ? `- ${stack.name} stopped (Compose project ${stack.project}): run nylorun up`
          : stack.runtime.healthy
            ? `✓ ${stack.name} running (Compose project ${stack.project})`
            : `✗ ${stack.name} running, but the Runtime does not answer: see nylorun status and nylorun logs runtime`,
    ]);
    if (stack.state === "running") {
      rows.push([
        "runtime",
        stack.runtime.healthy
          ? `✓ ${stack.runtime.url ?? "?"} · ${stack.runtime.version ?? "?"}`
          : `✗ ${stack.runtime.url ?? "?"} not answering`,
      ]);
      rows.push([
        "gateway",
        stack.gateway.healthy
          ? `✓ ${stack.gateway.state} · combined packing (runtime: core,loop; gateway: gates)`
          : `✗ ${stack.gateway.state}: model calls fail; see nylorun logs gateway`,
      ]);
      if (stack.tenant)
        rows.push([
          "tenant",
          stack.tenant.state === "open"
            ? `✓ ${stack.tenant.id ?? "?"} open`
            : `✗ ${stack.tenant.id ?? "?"} unavailable${stack.tenant.cause ? `: ${stack.tenant.cause.code}: ${stack.tenant.cause.repair}` : " (opening)"}`,
        ]);
      rows.push(["studio", `${stack.studio.url ?? "?"} · ${stack.studio.state}`]);
    }
  }
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows) log(`  ${key.padEnd(width)}${value}`);
  return failed ? 1 : 0;
}
