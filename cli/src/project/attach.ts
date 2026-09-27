import { createInterface } from "node:readline/promises";
import { createAdmin, type AdminTenant } from "@nylorun/admin";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import {
  readCredentials,
  removeCredentials,
  type ProjectCredentials,
} from "./credentials.js";
import { createProjectTenant } from "./create-tenant.js";
import {
  readLink,
  removeLink,
  writeLink,
  type ProjectLink,
} from "./link.js";

/** The running Host (the stack's Runtime) the Project attaches to. */
export interface AttachHost {
  /** The Host root; `@nylorun/admin` reads host.json and the admin key there. */
  home: string;
  /** Client-facing Runtime URL, e.g. `http://localhost:8787`. */
  url: string;
  hostId: string;
  /** The Host was started for this command. */
  started: boolean;
}

export interface AttachedProject {
  projectRoot: string;
  link: ProjectLink;
  credentials: ProjectCredentials;
  tenantName: string;
  /** True when the Tenant was created by this call. */
  created: boolean;
  hostStarted: boolean;
  home: string;
}

export interface AttachOptions {
  projectRoot: string;
  host: AttachHost;
  /** Interactive stdin; defaults to process.stdin when TTY. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
}

function tenantHeaders(
  key: string,
  tenantId: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

async function probeTenant(
  hostUrl: string,
  tenantId: string,
  applicationKey: string,
  fetchImpl: typeof fetch,
): Promise<"ok" | "rejected"> {
  try {
    const response = await fetchImpl(`${hostUrl}/v1/tenant`, {
      headers: tenantHeaders(applicationKey, tenantId),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "ok" : "rejected";
  } catch {
    return "rejected";
  }
}

async function healthHostId(
  hostUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${hostUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { hostId?: string };
    return typeof body.hostId === "string" ? body.hostId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure a Project link authenticates against the running Host, creating the
 * Project's Tenant on first run (D§12 step 2). The caller starts the stack.
 */
export async function attachProject(
  options: AttachOptions,
): Promise<AttachedProject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectRoot = options.projectRoot;
  const { home, hostId } = options.host;
  const host = { started: options.host.started };
  const hostUrl = options.host.url.replace(/\/$/, "");

  const admin = createAdmin({ home });
  let link = await readLink(projectRoot);
  let credentials = await readCredentials(projectRoot);

  if (!link || !credentials) {
    const created = await createProjectTenant({
      admin,
      hostId,
      hostUrl,
      projectRoot,
    });
    return {
      projectRoot,
      link: created.link,
      credentials: created.credentials,
      tenantName: created.envelope.name,
      created: true,
      hostStarted: host.started,
      home,
    };
  }

  if (link.hostUrl.replace(/\/$/, "") !== hostUrl) {
    const liveId = await healthHostId(hostUrl, fetchImpl);
    if (liveId && liveId === link.hostId) {
      link = { ...link, hostUrl, format: 1 };
      await writeLink(projectRoot, link);
    }
  }

  const liveId = await healthHostId(hostUrl, fetchImpl);
  if (liveId && liveId !== link.hostId) {
    throw new CliError(
      `Project link points at Host ${link.hostId}, but ${hostUrl} is ${liveId}. Relink: remove .nylorun/link.json and run nylorun dev.`,
      1,
    );
  }

  const auth = await probeTenant(
    hostUrl,
    link.tenantId,
    credentials.applicationKey,
    fetchImpl,
  );
  if (auth === "ok") {
    const tenants = await admin.listTenants();
    const match = tenants.find((t) => t.id === link!.tenantId);
    return {
      projectRoot,
      link: { ...link, hostUrl, hostId: liveId ?? link.hostId, format: 1 },
      credentials,
      tenantName: match?.name ?? match?.envelope?.name ?? link.tenantId,
      created: false,
      hostStarted: host.started,
      home,
    };
  }

  const tenants = await admin.listTenants();
  const known = tenants.some((t) => t.id === link!.tenantId);
  if (known) {
    throw new CliError(
      `Application credential rejected for Tenant ${link.tenantId} on Host ${link.hostId}. Relink: remove .nylorun/link.json and .nylorun/credentials.json, then run nylorun dev.`,
      1,
    );
  }

  const choice = await chooseUnknownTenantRecovery({
    tenantId: link.tenantId,
    tenants,
    input: options.input,
    output: options.output,
  });
  if (choice === "remove") {
    await removeLink(projectRoot);
    await removeCredentials(projectRoot);
    throw new CliError(
      "Removed Project link. Run nylorun dev again to create a new Tenant.",
      1,
    );
  }
  if (choice === "create") {
    await removeLink(projectRoot);
    await removeCredentials(projectRoot);
    const created = await createProjectTenant({
      admin,
      hostId: liveId ?? hostId,
      hostUrl,
      projectRoot,
    });
    return {
      projectRoot,
      link: created.link,
      credentials: created.credentials,
      tenantName: created.envelope.name,
      created: true,
      hostStarted: host.started,
      home,
    };
  }
  const selected = choice.tenant;
  await writeLink(projectRoot, {
    format: 1,
    hostUrl,
    hostId: liveId ?? hostId,
    tenantId: selected.id,
  });
  const retry = await probeTenant(
    hostUrl,
    selected.id,
    credentials.applicationKey,
    fetchImpl,
  );
  if (retry !== "ok") {
    throw new CliError(
      `Credentials do not authorize Tenant ${selected.id}. Remove .nylorun/credentials.json and create a new Tenant with nylorun dev.`,
      1,
    );
  }
  return {
    projectRoot,
    link: {
      format: 1,
      hostUrl,
      hostId: liveId ?? hostId,
      tenantId: selected.id,
    },
    credentials,
    tenantName: selected.name ?? selected.envelope?.name ?? selected.id,
    created: false,
    hostStarted: host.started,
    home,
  };
}

type RecoveryChoice = "create" | "remove" | { tenant: AdminTenant };

async function chooseUnknownTenantRecovery(options: {
  tenantId: string;
  tenants: readonly AdminTenant[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<RecoveryChoice> {
  const message = `Linked Tenant ${options.tenantId} is unknown on this Host.`;
  const tty =
    options.input === undefined
      ? Boolean(process.stdin.isTTY && process.stdout.isTTY)
      : true;
  if (!tty) {
    throw new CliError(
      `${message} Create a new Tenant (remove .nylorun/link.json), choose another with "nylorun tenant use", or remove the link.`,
      1,
    );
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    output.write(`${message}\n`);
    output.write("  1) Create a new Tenant\n");
    output.write("  2) Choose another Tenant on this Host\n");
    output.write("  3) Remove the Project link\n");
    const answer = (await rl.question("Choose [1/2/3]: ")).trim();
    if (answer === "1") return "create";
    if (answer === "3") return "remove";
    if (answer === "2") {
      const open = options.tenants.filter((t) => t.state === "open" && t.name);
      if (open.length === 0) {
        throw new CliError(
          "No open Tenants on this Host to choose. Create a new one instead.",
          1,
        );
      }
      for (let i = 0; i < open.length; i += 1) {
        const t = open[i]!;
        output.write(`  ${i + 1}) ${t.name ?? "(unnamed)"}  ${t.id}\n`);
      }
      const pick = Number(
        (await rl.question(`Choose Tenant [1-${open.length}]: `)).trim(),
      );
      if (!Number.isInteger(pick) || pick < 1 || pick > open.length) {
        throw new CliError("Invalid Tenant choice.", 2);
      }
      return { tenant: open[pick - 1]! };
    }
    throw new CliError("Invalid choice.", 2);
  } finally {
    rl.close();
  }
}

/** Three `export` lines for `nylorun status --env` (F2-7). */
export async function printLinkedEnvExports(
  projectRoot = process.cwd(),
): Promise<void> {
  const { findProjectRoot } = await import("./root.js");
  const root = findProjectRoot(projectRoot) ?? projectRoot;
  const link = await readLink(root);
  const credentials = await readCredentials(root);
  if (!link || !credentials) {
    console.log(
      "# No Project link in this directory. Run nylorun dev to create one.",
    );
    return;
  }
  console.log(`export NYLORUN_RUNTIME_URL=${shellQuote(link.hostUrl)}`);
  console.log(
    `export NYLORUN_SERVER_KEY=${shellQuote(credentials.applicationKey)}`,
  );
  console.log(`export NYLORUN_TENANT=${shellQuote(link.tenantId)}`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
