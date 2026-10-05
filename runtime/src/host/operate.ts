/**
 * `nylorun-operate`: the Host's one-shot operator command, run inside the runtime container
 * (`docker compose exec runtime nylorun-operate …`, `kubectl exec … -- nylorun-operate …`). It
 * reads the Tenant's database from `NYLORUN_DATABASE_URL`, as the Host does, does one job and
 * exits. Being able to run it is the authorization: whoever can exec into the container holds
 * the installation. It never migrates or creates the Tenant: the Host does that.
 *
 *   nylorun-operate status [--json]
 *   nylorun-operate keys list [--json]
 *   nylorun-operate keys put <id> [--role application|management] [--json]
 *   nylorun-operate keys rm <id> [--json]
 *
 * `status` says whether the Tenant is open and, when it is not, why: from the database (no
 * Tenant yet, an old layout, a schema newer or older than this Runtime) and from the running
 * Host's `/ready` on this container's listen port. It needs no key, so it works when the Tenant
 * cannot open. `keys put` prints the new key once on stdout (with `--json`, the whole
 * response). Exit codes: 0 done (`status`: the Tenant is open), 1 refused (an id, a role),
 * 2 the Tenant cannot be opened (`status` still prints it), 64 usage.
 */
import { pathToFileURL } from "node:url";
import { HOST_PROTOCOL, type KeyRole } from "@nylorun/core/compatibility";
import type { TenantCause } from "@nylorun/core/contracts";
import { createPostgresClient, type PostgresClient } from "../store/postgres/connect.js";
import { database } from "../store/postgres/db.js";
import {
  assertCurrentLayout,
  expectedSchemaVersion,
  readSchemaVersion,
} from "../store/postgres/migrate.js";
import { createPostgresSessionStore } from "../store/postgres/store.js";
import { readTenantEnvelope } from "../store/postgres/tenant.js";
import { openError, TenantOpenError } from "../tenant/cause.js";
import { operatorKeys, type OperatorKeys } from "../tenant/operator-keys.js";
import { RUNTIME_VERSION } from "../version.js";
import { DEFAULT_CONTAINER_LISTEN_PORT } from "./stack-config.js";

export const EXIT_REFUSED = 1;
export const EXIT_TENANT = 2;
export const EXIT_USAGE = 64;

const USAGE = `Usage:
  nylorun-operate status [--json]
  nylorun-operate keys list [--json]
  nylorun-operate keys put <id> [--role application|management] [--json]
  nylorun-operate keys rm <id> [--json]`;

export interface OperateIo {
  env: Readonly<Record<string, string | undefined>>;
  out(line: string): void;
  err(line: string): void;
  /** For the Host's `/ready`. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** `nylorun-operate status --json`. */
export interface OperateStatus {
  version: string;
  protocol: { min: number; max: number; features: string[] };
  tenant: {
    id: string | null;
    name: string | null;
    state: "open" | "unavailable";
    cause?: TenantCause["code"];
    message?: string;
  };
}

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Runs one command; resolves to the exit code. */
export async function runOperate(argv: readonly string[], io: OperateIo): Promise<number> {
  try {
    if (argv[0] === "status") {
      const json = argv[1] === "--json";
      if (argv.length > (json ? 2 : 1)) throw new Exit(EXIT_USAGE, USAGE);
      return await status(io, json);
    }
    const command = parse(argv);
    const url = io.env.NYLORUN_DATABASE_URL;
    if (!url) throw new Exit(EXIT_TENANT, "NYLORUN_DATABASE_URL is not set: run this inside the runtime container");
    const sql = createPostgresClient(url, { max: 1 });
    try {
      const keys = operatorKeys(await openStore(sql));
      return await command(keys, io);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (error) {
    if (error instanceof Exit) {
      io.err(error.message);
      return error.code;
    }
    io.err(`nylorun-operate failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_TENANT;
  }
}

type Command = (keys: OperatorKeys, io: OperateIo) => Promise<number>;

function parse(argv: readonly string[]): Command {
  const [group, verb, ...rest] = argv;
  if (group !== "keys") throw new Exit(EXIT_USAGE, USAGE);
  const json = rest.includes("--json");
  const args = rest.filter((arg) => arg !== "--json");
  switch (verb) {
    case "list":
      if (args.length > 0) throw new Exit(EXIT_USAGE, USAGE);
      return async (keys, io) => {
        const list = await keys.list();
        if (json) io.out(JSON.stringify({ keys: list }));
        else for (const key of list) io.out(`${key.id}\t${key.role}\t${key.createdAt}`);
        return 0;
      };
    case "put": {
      const [id, ...flags] = args;
      if (!id || id.startsWith("-")) throw new Exit(EXIT_USAGE, USAGE);
      let role: Exclude<KeyRole, "studio"> = "application";
      if (flags.length > 0) {
        const value = flags[0] === "--role" ? flags[1] : undefined;
        if (flags.length !== 2 || (value !== "application" && value !== "management"))
          throw new Exit(EXIT_USAGE, USAGE);
        role = value;
      }
      return async (keys, io) => {
        const put = await keys.put(id, role);
        if ("reason" in put) throw new Exit(EXIT_REFUSED, put.message);
        if (json) io.out(JSON.stringify(put));
        else {
          io.out(put.key);
          io.err(`${put.rotated ? "Rotated" : "Created"} ${put.role} key ${put.id}. It is shown this once.`);
        }
        return 0;
      };
    }
    case "rm": {
      const [id] = args;
      if (!id || args.length !== 1) throw new Exit(EXIT_USAGE, USAGE);
      return async (keys, io) => {
        const deleted = await keys.delete(id);
        if (typeof deleted !== "boolean") throw new Exit(EXIT_REFUSED, deleted.message);
        if (json) io.out(JSON.stringify({ id, deleted }));
        else io.err(deleted ? `Deleted key ${id}.` : `There is no key ${id}.`);
        return 0;
      };
    }
    default:
      throw new Exit(EXIT_USAGE, USAGE);
  }
}

async function status(io: OperateIo, json: boolean): Promise<number> {
  const tenant = await tenantStatus(io);
  const report: OperateStatus = {
    version: RUNTIME_VERSION,
    protocol: { min: HOST_PROTOCOL.min, max: HOST_PROTOCOL.max, features: [...HOST_PROTOCOL.features] },
    tenant,
  };
  if (json) io.out(JSON.stringify(report));
  else {
    io.out(`Runtime ${report.version}, protocol ${report.protocol.min}–${report.protocol.max}`);
    const named = tenant.name ? `${tenant.name} (${tenant.id})` : "none";
    io.out(`Tenant  ${named}: ${tenant.state}${tenant.cause ? ` (${tenant.cause})` : ""}`);
    if (tenant.message) io.out(tenant.message);
  }
  return tenant.state === "open" ? 0 : EXIT_TENANT;
}

/** The Tenant from its database, then from the running Host's `/ready`. */
async function tenantStatus(io: OperateIo): Promise<OperateStatus["tenant"]> {
  const url = io.env.NYLORUN_DATABASE_URL;
  if (!url)
    return unavailable(null, "NYLORUN_DATABASE_URL is not set: run this inside the runtime container");
  const sql = createPostgresClient(url, { max: 1 });
  let envelope: { id: string; name: string } | undefined;
  try {
    const db = database(sql);
    await assertCurrentLayout(db);
    envelope = await readTenantEnvelope(db);
    if (!envelope)
      return unavailable(null, "The database holds no Tenant yet: the Runtime creates it when it starts");
    const version = (await readSchemaVersion(db)) ?? 0;
    const expected = expectedSchemaVersion();
    if (version > expected)
      throw openError(
        "schema-too-new",
        `The Tenant's schema is at version ${version}, this Runtime's is ${expected}: it was migrated by a newer Runtime`,
      );
    if (version < expected)
      return unavailable(
        envelope,
        `The Tenant's schema is at version ${version}, this Runtime's is ${expected}: the Runtime migrates it when it starts; if it is running, its log says why it did not`,
      );
  } catch (error) {
    if (error instanceof TenantOpenError)
      return { ...unavailable(envelope ?? null, `${error.message}. Repair: ${error.repair}`), cause: error.code };
    return unavailable(
      envelope ?? null,
      `The database cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  const port = io.env.NYLORUN_LISTEN_PORT ?? String(DEFAULT_CONTAINER_LISTEN_PORT);
  const ready = `http://127.0.0.1:${port}/ready`;
  let answer: { checks?: { tenant?: boolean } };
  try {
    const response = await (io.fetch ?? fetch)(ready, { signal: AbortSignal.timeout(5000) });
    answer = (await response.json()) as typeof answer;
  } catch {
    return unavailable(envelope, `The Runtime is not answering at ${ready}: it is stopped or still starting`);
  }
  if (answer.checks?.tenant !== true)
    return unavailable(envelope, "The Runtime is running but has not opened the Tenant: its log names the cause");
  return { id: envelope.id, name: envelope.name, state: "open" };
}

function unavailable(
  envelope: { id: string; name: string } | null,
  message: string,
): OperateStatus["tenant"] {
  return { id: envelope?.id ?? null, name: envelope?.name ?? null, state: "unavailable", message };
}

/** The Tenant's store, when the Host has created and migrated it to this Runtime's schema. */
async function openStore(sql: PostgresClient) {
  const db = database(sql);
  const envelope = await readTenantEnvelope(db).catch(() => undefined);
  if (!envelope)
    throw new Exit(EXIT_TENANT, "The database holds no Tenant yet: start the Runtime first");
  const version = await readSchemaVersion(db);
  const expected = expectedSchemaVersion();
  if (version !== expected)
    throw new Exit(
      EXIT_TENANT,
      `The Tenant's schema is at version ${version ?? "none"}, this Runtime's is ${expected}: start the Runtime to migrate it, or run the Runtime's own image`,
    );
  return createPostgresSessionStore({ sql, tenantId: envelope.id, schemaVersion: expected });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await runOperate(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
