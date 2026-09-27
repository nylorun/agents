import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { createAdmin, type AdminTenant } from "@nylorun/admin";
import { createClient, isTenantId } from "@nylorun/agents";
import { CliError } from "../errors.js";
import { resolveHome } from "../home.js";
import {
  readCredentials,
  removeCredentials,
} from "../project/credentials.js";
import {
  readLink,
  removeLink,
  writeLink,
} from "../project/link.js";
import { requireProjectRoot } from "../project/root.js";

/** Exact-and-unique name or id match. */
export function matchTenant(
  tenants: readonly AdminTenant[],
  nameOrId: string,
): AdminTenant {
  if (isTenantId(nameOrId)) {
    const byId = tenants.find((t) => t.id === nameOrId);
    if (!byId) throw new CliError(`No Tenant with id ${nameOrId}.`, 1);
    return byId;
  }
  const matches = tenants.filter((t) => t.name === nameOrId);
  if (matches.length === 0) {
    throw new CliError(`No Tenant named ${JSON.stringify(nameOrId)}.`, 1);
  }
  if (matches.length > 1) {
    throw new CliError(
      `Tenant name ${JSON.stringify(nameOrId)} is not unique (${matches.length} matches). Use the Tenant id.`,
      1,
    );
  }
  return matches[0]!;
}

function localAdmin(home?: string) {
  return createAdmin(home ? { home } : undefined);
}

export async function tenantCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (!verb || verb === "--help" || verb === "-h") {
    console.log(
      `nylorun tenant current|list [--json]|use <name-or-id>|status [--json]|reset [--sessions|--sandboxes|--all] [--yes]|delete <name-or-id> [--yes]`,
    );
    return;
  }

  const home = resolveHome();

  if (verb === "current") {
    const root = requireProjectRoot();
    const link = await readLink(root);
    if (!link) {
      console.log("No Project link. Run nylorun dev to create one.");
      return;
    }
    const admin = localAdmin(home);
    const tenants = await admin.listTenants();
    const match = tenants.find((t) => t.id === link.tenantId);
    const name = match?.name ?? match?.envelope?.name ?? "(unknown)";
    console.log(`${name}  ${link.tenantId}`);
    console.log(`Host  ${link.hostUrl}  ${link.hostId}`);
    return;
  }

  if (verb === "list") {
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) {
      throw new CliError("Usage: nylorun tenant list [--json]", 2);
    }
    const admin = localAdmin(home);
    const tenants = await admin.listTenants();
    if (json) {
      console.log(JSON.stringify(tenants, null, 2));
      return;
    }
    if (tenants.length === 0) {
      console.log("No Tenants on this Host.");
      return;
    }
    for (const tenant of tenants) {
      const name = tenant.name ?? "(unreadable)";
      console.log(`${name}  ${tenant.id}  ${tenant.state}`);
    }
    return;
  }

  if (verb === "use") {
    const nameOrId = rest[0];
    if (!nameOrId || rest.length > 1) {
      throw new CliError("Usage: nylorun tenant use <name-or-id>", 2);
    }
    const root = requireProjectRoot();
    const admin = localAdmin(home);
    const status = await admin.status();
    const hostId = status.host?.hostId;
    if (!hostId) {
      throw new CliError(
        `Host at ${admin.url} did not report hostId in admin status.`,
        1,
      );
    }
    const tenants = await admin.listTenants();
    const selected = matchTenant(tenants, nameOrId);
    console.warn(
      "Sharing a Tenant shares executor registrations across Projects that link to it.",
    );
    const credentials = await readCredentials(root);
    if (!credentials) {
      throw new CliError(
        "No Project credentials. Run nylorun dev to create a Tenant first, or copy credentials for the target Tenant.",
        1,
      );
    }
    const client = createClient({
      url: admin.url,
      key: credentials.applicationKey,
      tenant: selected.id,
    });
    try {
      await client.transport.json("/v1/tenant", "GET");
    } catch {
      throw new CliError(
        `Credentials do not authorize Tenant ${selected.id}. Create a new Tenant with nylorun dev instead of reusing another Project's Tenant without its key.`,
        1,
      );
    }
    await writeLink(root, {
      format: 1,
      hostUrl: admin.url,
      hostId,
      tenantId: selected.id,
    });
    console.log(
      `Linked to ${selected.name ?? selected.id}  ${selected.id}`,
    );
    return;
  }

  if (verb === "status") {
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) {
      throw new CliError("Usage: nylorun tenant status [--json]", 2);
    }
    const root = requireProjectRoot();
    const link = await readLink(root);
    const credentials = await readCredentials(root);
    if (!link || !credentials) {
      throw new CliError(
        "No Project link. Run nylorun dev to create one.",
        1,
      );
    }
    const client = createClient({
      url: link.hostUrl,
      key: credentials.applicationKey,
      tenant: link.tenantId,
    });
    try {
      const body = await client.transport.json<{
        tenant: { name: string; id: string };
        path: string;
        checks: Record<string, boolean>;
        counts: Record<string, number>;
        sandbox: { backend: string | null };
      }>("/v1/tenant", "GET");
      if (json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      console.log(`${body.tenant.name}  ${body.tenant.id}`);
      console.log(`path     ${body.path}`);
      console.log(
        `checks   ${Object.entries(body.checks)
          .map(([k, v]) => `${k}=${v ? "ok" : "fail"}`)
          .join(" ")}`,
      );
      console.log(
        `counts   sessions=${body.counts.sessions} running=${body.counts.runningSessions} pending=${body.counts.pendingActions}`,
      );
      console.log(`sandbox  ${body.sandbox.backend ?? "none"}`);
      return;
    } catch {
      // Quarantined / opaque — fall back to admin status.
    }
    const admin = localAdmin(home);
    try {
      const body = await admin.getTenant(link.tenantId);
      if (json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      console.log(`${body.name ?? "(unreadable)"}  ${body.id}  ${body.state}`);
      if (body.quarantine) {
        console.log(
          `reason   ${body.quarantine.code}: ${body.quarantine.message}`,
        );
        console.log(`repair   ${body.quarantine.repair}`);
      }
      return;
    } catch (error) {
      throw new CliError(
        error instanceof Error
          ? error.message
          : `Tenant ${link.tenantId} is not reachable.`,
        1,
      );
    }
  }

  if (verb === "reset") {
    const yes = rest.includes("--yes");
    const flags = rest.filter((a) => a !== "--yes");
    let scope: "sessions" | "sandboxes" | "all" = "sessions";
    if (flags.includes("--all")) scope = "all";
    else if (flags.includes("--sandboxes")) scope = "sandboxes";
    else if (flags.includes("--sessions") || flags.length === 0)
      scope = "sessions";
    else
      throw new CliError(
        "Usage: nylorun tenant reset [--sessions|--sandboxes|--all] [--yes]",
        2,
      );
    if (
      flags.filter((f) =>
        ["--sessions", "--sandboxes", "--all"].includes(f),
      ).length > 1
    ) {
      throw new CliError("Pass only one of --sessions, --sandboxes, --all.", 2);
    }
    const root = requireProjectRoot();
    const link = await readLink(root);
    const credentials = await readCredentials(root);
    if (!link || !credentials) {
      throw new CliError("No Project link. Run nylorun dev first.", 1);
    }
    const admin = localAdmin(home);
    const tenants = await admin.listTenants();
    const match = tenants.find((t) => t.id === link.tenantId);
    const name = match?.name ?? link.tenantId;
    if (scope === "all" && !yes) {
      await confirmOrThrow(
        `Reset ALL data for Tenant ${name} (${link.tenantId})? Link and credentials are kept. [y/N] `,
      );
    }
    const client = createClient({
      url: link.hostUrl,
      key: credentials.applicationKey,
      tenant: link.tenantId,
    });
    try {
      await client.transport.json("/v1/tenant/reset", "POST", {
        requestId: randomUUID(),
        scope,
        activeWork: "drain",
      });
    } catch (error) {
      throw new CliError(
        error instanceof Error
          ? error.message
          : `Tenant reset failed: ${String(error)}`,
        1,
      );
    }
    console.log(`Reset Tenant ${name} (${scope}).`);
    return;
  }

  if (verb === "delete") {
    const yes = rest.includes("--yes");
    const nameOrId = rest.find((a) => a !== "--yes");
    if (!nameOrId || rest.filter((a) => a !== "--yes").length !== 1) {
      throw new CliError("Usage: nylorun tenant delete <name-or-id> [--yes]", 2);
    }
    const root = requireProjectRoot();
    const admin = localAdmin(home);
    const tenants = await admin.listTenants();
    const selected = matchTenant(tenants, nameOrId);
    if (!yes) {
      await confirmOrThrow(
        `Delete Tenant ${selected.name ?? selected.id} (${selected.id})?\nThe KEK moves to trash with the Tenant directory. [y/N] `,
      );
    }
    try {
      await admin.deleteTenant(selected.id, { activeWork: "refuse" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active_work|409|live work/i.test(message)) {
        throw new CliError(
          `Tenant ${selected.id} has live work. Retry with the Host idle, or drain sessions first.`,
          1,
        );
      }
      throw new CliError(message, 1);
    }
    const link = await readLink(root);
    if (link?.tenantId === selected.id) {
      await removeLink(root);
      await removeCredentials(root);
      console.log("Removed Project link and credentials for the deleted Tenant.");
    }
    console.log(`Deleted Tenant ${selected.name ?? selected.id}.`);
    return;
  }

  throw new CliError(
    `Unknown tenant command ${verb}.\nUsage: nylorun tenant current|list|use|status|reset|delete`,
    2,
  );
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
