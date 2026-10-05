/**
 * `nylorun-operate`: the Host's one-shot operator command, run inside the runtime container
 * (`docker compose exec runtime nylorun-operate …`, `kubectl exec … -- nylorun-operate …`). It
 * reads the Tenant's database from `NYLORUN_DATABASE_URL`, as the Host does, does one job and
 * exits. Being able to run it is the authorization: whoever can exec into the container holds
 * the installation. It never migrates or creates the Tenant: the Host does that.
 *
 *   nylorun-operate keys list [--json]
 *   nylorun-operate keys put <id> [--role application|management] [--json]
 *   nylorun-operate keys rm <id> [--json]
 *
 * `keys put` prints the new key once on stdout (with `--json`, the whole response). Exit codes:
 * 0 done, 1 refused (an id, a role), 2 the Tenant cannot be opened, 64 usage.
 */
import { pathToFileURL } from "node:url";
import type { KeyRole } from "@nylorun/core/compatibility";
import { createPostgresClient, type PostgresClient } from "../store/postgres/connect.js";
import { database } from "../store/postgres/db.js";
import { expectedSchemaVersion, readSchemaVersion } from "../store/postgres/migrate.js";
import { createPostgresSessionStore } from "../store/postgres/store.js";
import { readTenantEnvelope } from "../store/postgres/tenant.js";
import { operatorKeys, type OperatorKeys } from "../tenant/operator-keys.js";

export const EXIT_REFUSED = 1;
export const EXIT_TENANT = 2;
export const EXIT_USAGE = 64;

const USAGE = `Usage:
  nylorun-operate keys list [--json]
  nylorun-operate keys put <id> [--role application|management] [--json]
  nylorun-operate keys rm <id> [--json]`;

export interface OperateIo {
  env: Readonly<Record<string, string | undefined>>;
  out(line: string): void;
  err(line: string): void;
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
