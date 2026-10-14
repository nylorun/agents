/**
 * The installation a client command acts on. `--tenant <name>` names a local Tenant. Without it,
 * `NYLORUN_RUNTIME_URL` with the key the API needs names a remote installation:
 * `NYLORUN_MANAGEMENT_KEY` for the Management API (`nylorun tenant`), `NYLORUN_SERVER_KEY` or an
 * identity provider's token in `NYLORUN_TOKEN` for the Runtime API (`NYLORUN_RUNTIME_URL` alone is
 * an app's, as for `createAdmin`). Otherwise the local
 * Tenant the Project link names, else the default one, while it runs (`runningTenantApi`: the
 * Project's keys while they authenticate, else the Host root's own).
 */
import { createManagementClient, type ManagementClient } from "@nylorun/admin";
import { CliError } from "../errors.js";
import { runningTenantApi, type StackDeps } from "../stack/commands.js";

export type Api = "management" | "runtime";

export interface Connection {
  /** How messages name it: `Tenant <name>`, or the remote URL. */
  label: string;
  url: string;
  /** A local Tenant (Docker on this machine), else a remote installation. */
  local: boolean;
  /** The local Tenant's name. */
  tenant?: string;
  applicationKey?: string;
  managementKey?: string;
  /** A trusted issuer's token (`NYLORUN_TOKEN`), sent in place of the application key. */
  token?: string;
}

function variable(env: StackDeps["env"], name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The remote installation the environment names for `api`, if it names one. */
export function remoteConnection(env: StackDeps["env"], api: Api): Connection | undefined {
  const url = variable(env, "NYLORUN_RUNTIME_URL");
  const managementKey = variable(env, "NYLORUN_MANAGEMENT_KEY");
  const applicationKey = variable(env, "NYLORUN_SERVER_KEY");
  const token = variable(env, "NYLORUN_TOKEN");
  if (!url || (api === "management" ? !managementKey : !applicationKey && !token)) return undefined;
  return {
    label: url,
    url: url.replace(/\/$/, ""),
    local: false,
    ...(applicationKey ? { applicationKey } : {}),
    ...(managementKey ? { managementKey } : {}),
    // A token is a person's: it wins over the key for the Runtime API.
    ...(token && api === "runtime" ? { token } : {}),
  };
}

/** The installation to act on for `api` (module comment). */
export async function connect(
  deps: StackDeps,
  api: Api,
  tenant?: string,
): Promise<Connection> {
  if (tenant === undefined) {
    const remote = remoteConnection(deps.env, api);
    if (remote) return remote;
  }
  const local = await runningTenantApi(deps, tenant === undefined ? {} : { name: tenant });
  return {
    label: `Tenant ${local.name}`,
    url: local.runtimeUrl,
    local: true,
    tenant: local.name,
    applicationKey: local.applicationKey,
    managementKey: local.managementKey,
  };
}

/** The Management API client of `connection`, through `deps.fetch`. */
export function managementClient(deps: StackDeps, connection: Connection): ManagementClient {
  if (!connection.managementKey)
    throw new CliError(
      `No management key for ${connection.label}: set NYLORUN_MANAGEMENT_KEY, or on the Runtime's machine run "nylorun tenant keys put <id> --management".`,
      1,
    );
  return createManagementClient({
    url: connection.url,
    key: connection.managementKey,
    fetch: (input, init) =>
      deps.fetch(input instanceof Request ? input.url : String(input), init),
  });
}

/** `error`'s message, ending in one full stop. */
export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.?$/, ".");
}
