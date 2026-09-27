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
        ? `- not created under ${stack.home}: run nylorun up`
        : stack.state === "stopped"
          ? `- stopped (project ${stack.project}): run nylorun up`
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
