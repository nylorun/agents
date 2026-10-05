/**
 * Why the Host's Tenant could not be opened (tenancy.md §5). A cause is about the Tenant's
 * own data or files (its database is newer than this Runtime, its vault key is missing, the
 * database has an old layout): the Host fails readiness, names the cause in the logs (and
 * `nylorun-operate status` reads it from the database), and answers Tenant requests with the opaque 404 until it is
 * repaired and the Host restarted. A failure outside the Tenant (Postgres unreachable) is not
 * a cause: it is `TenantUnavailableError`, and the next request tries again.
 */
import type { TenantCause, TenantEnvelope } from "@nylorun/core/contracts";

export type { TenantCause };

/** Thrown by migrations, the Tenant bootstrap and the Tenant Runtime when the Tenant cannot open. */
export class TenantOpenError extends Error {
  readonly code: TenantCause["code"];
  readonly repair: string;
  /** The Tenant, when it was read before opening failed. */
  envelope?: TenantEnvelope;

  constructor(fields: TenantCause) {
    super(fields.message);
    this.name = "TenantOpenError";
    this.code = fields.code;
    this.repair = fields.repair;
  }

  toCause(): TenantCause {
    return { code: this.code, message: this.message, repair: this.repair };
  }
}

/** A `TenantOpenError` with the standard repair for `code`. */
export function openError(code: TenantCause["code"], message: string): TenantOpenError {
  return new TenantOpenError({ code, message, repair: repairFor(code) });
}

/** The cause an error carries, when it is a `TenantOpenError`. */
export function causeOf(error: unknown): TenantCause | undefined {
  return error instanceof TenantOpenError ? error.toCause() : undefined;
}

/** What an operator does about each cause. */
export function repairFor(code: TenantCause["code"]): string {
  switch (code) {
    case "kek-missing":
      return "restore the vault key (vault-kek in the Host root's keys/ directory) from a backup, then restart the Runtime and its gateway: the Tenant's ciphertext cannot be opened without it";
    case "corrupt":
      return "restore the database from a backup, then restart the Runtime";
    case "schema-too-new":
      return "the database was migrated by a newer Runtime: run that version or newer";
    case "migration-failed":
      return "inspect the Runtime log for the failed migration, fix it, then restart the Runtime";
    case "envelope-invalid":
      return "the nylorun.tenant row is missing or invalid: restore the database from a backup";
    case "open-timeout":
      return "opening the Tenant timed out: inspect the Runtime log and Postgres, then restart the Runtime";
    case "open-failed":
      return "inspect the Runtime log, repair what it names, then restart the Runtime";
    case "database-layout-old":
      return "this release starts fresh: point the Runtime at a new database (locally, a new Tenant: `nylorun start --tenant <new name>`); the old database is left as it is";
  }
}
