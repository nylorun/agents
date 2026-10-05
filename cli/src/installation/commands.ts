/**
 * `nylo status` and `nylo reset`: the linked installation's one Tenant, through the Management
 * API (the Project's management key).
 */
import { createInterface } from "node:readline/promises";
import { CliError } from "../errors.js";
import { linkedConnection, managementClient } from "../project/connection.js";
import { findProjectRoot } from "../project/root.js";

const projectRoot = () => findProjectRoot() ?? process.cwd();

/**
 * `nylo status [--json]`: the Tenant, its checks and counts. A Tenant that is not open does not
 * answer: `npx nylorun status` reports why.
 */
export async function statusCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json"))
    throw new CliError("Usage: nylo status [--json]", 2);
  const root = projectRoot();
  const connection = await linkedConnection(root);
  const admin = managementClient(connection);
  let body: Awaited<ReturnType<typeof admin.tenant.status>>;
  try {
    body = await admin.tenant.status();
  } catch (error) {
    throw new CliError(
      `${(error instanceof Error ? error.message : `The Tenant at ${connection.url} is not reachable`).replace(/\.?$/, ".")} Run "npx nylorun status" to see the Tenant's state and why it is not open.`,
      1,
    );
  }
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`${body.tenant.name}  ${body.tenant.id}`);
  console.log(`runtime  ${connection.url}`);
  console.log(`path     ${body.path}`);
  console.log(
    `checks   ${Object.entries(body.checks)
      .map(([k, v]) => `${k}=${v ? "ok" : "fail"}`)
      .join(" ")}`,
  );
  console.log(
    `counts   sessions=${body.counts.sessions} running=${body.counts.runningSessions} uncertain=${body.counts.uncertainEffects}`,
  );
  console.log(`sandbox  ${body.sandbox.backend ?? "none"}`);
}

const RESET_USAGE = "Usage: nylo reset [--sessions|--sandboxes|--all] [--yes]";
const SCOPES = { "--sessions": "sessions", "--sandboxes": "sandboxes", "--all": "all" } as const;

/** `nylo reset [--sessions|--sandboxes|--all] [--yes]`; `--all` asks first. */
export async function resetCommand(args: readonly string[]): Promise<void> {
  const yes = args.includes("--yes");
  const flags = args.filter((a) => a !== "--yes");
  if (flags.some((f) => !(f in SCOPES)) || args.filter((a) => a === "--yes").length > 1)
    throw new CliError(RESET_USAGE, 2);
  if (flags.length > 1)
    throw new CliError("Pass only one of --sessions, --sandboxes, --all.", 2);
  const scope = flags.length ? SCOPES[flags[0] as keyof typeof SCOPES] : "sessions";
  const connection = await linkedConnection(projectRoot());
  const tenant = connection.link?.tenant;
  const target = tenant ? `Tenant ${tenant} (${connection.url})` : `the Tenant on ${connection.url}`;
  const admin = managementClient(connection);
  if (scope === "all" && !yes)
    await confirmOrThrow(
      `Reset ALL data of ${target}? The Project link and credentials are kept. [y/N] `,
    );
  try {
    await admin.tenant.reset({ scope, activeWork: "drain" });
  } catch (error) {
    throw new CliError(
      error instanceof Error ? error.message : `Tenant reset failed: ${String(error)}`,
      1,
    );
  }
  console.log(`Reset ${target} (${scope}).`);
}

async function confirmOrThrow(prompt: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "Confirmation required; pass --yes for non-interactive use.",
      2,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliError("Cancelled.", 1);
    }
  } finally {
    rl.close();
  }
}
