import type { Quarantine } from "./types.js";

/** Typed quarantine failure thrown by stores and migration. */
export class QuarantineError extends Error implements Quarantine {
  readonly code: Quarantine["code"];
  readonly repair: string;

  constructor(fields: Quarantine) {
    super(fields.message);
    this.name = "QuarantineError";
    this.code = fields.code;
    this.repair = fields.repair;
  }

  toQuarantine(): Quarantine {
    return { code: this.code, message: this.message, repair: this.repair };
  }
}

export function isQuarantineError(error: unknown): error is QuarantineError {
  return error instanceof QuarantineError;
}

export function asQuarantine(error: unknown): Quarantine | undefined {
  if (isQuarantineError(error)) return error.toQuarantine();
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "repair" in error
  ) {
    return error as Quarantine;
  }
  return undefined;
}

/** CLI-facing repair strings for every quarantine code (B9). */
export function repairFor(
  code: Quarantine["code"],
  detail: { tenantId?: string } = {},
): string {
  const id = detail.tenantId ? ` ${detail.tenantId}` : "";
  switch (code) {
    case "kek-missing":
      return `nylorun tenant status${id} — restore vault-kek for this Tenant (ciphertext cannot be opened without it)`;
    case "corrupt":
      return `nylorun tenant status${id} — restore the Tenant from backup`;
    case "schema-too-new":
      return `nylorun tenant status${id} — the Tenant was migrated by a newer Runtime; run that version or newer`;
    case "migration-failed":
      return `nylorun tenant status${id} — inspect the Runtime log for the failed migration, fix it, then restart the Runtime`;
    case "envelope-invalid":
      return `nylorun tenant status${id} — the Tenant envelope is missing or invalid; restore the Tenant from backup`;
    case "open-timeout":
      return `nylorun tenant status${id} — open timed out; inspect the Runtime log and Postgres, then retry`;
    case "open-failed":
      return `nylorun tenant status${id} — inspect Tenant logs and repair before the Host retries open`;
  }
}

export function quarantine(
  code: Quarantine["code"],
  message: string,
  detail: { tenantId?: string } = {},
): QuarantineError {
  return new QuarantineError({
    code,
    message,
    repair: repairFor(code, detail),
  });
}

/** Conflict when create bootstrap material does not match an existing Tenant (HTTP 409). */
export class TenantConflictError extends Error {
  readonly statusCode = 409 as const;
  constructor(message = "Tenant already exists with different bootstrap material") {
    super(message);
    this.name = "TenantConflictError";
  }
}

/** Delete refused because the Tenant still has live work (HTTP 409). */
export class TenantBusyError extends Error {
  readonly statusCode = 409 as const;
  constructor(message = "Tenant has live work; pass activeWork=drain|cancel or retry later") {
    super(message);
    this.name = "TenantBusyError";
  }
}
