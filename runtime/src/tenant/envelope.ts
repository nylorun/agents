import {
  TenantEnvelopeSchema,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import { quarantine } from "./quarantine.js";

export function parseEnvelope(
  raw: unknown,
  expectedId?: string,
): TenantEnvelope {
  const parsed = TenantEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw quarantine(
      "envelope-invalid",
      "the Tenant envelope is missing or invalid",
      expectedId ? { tenantId: expectedId } : {},
    );
  }
  if (expectedId !== undefined && parsed.data.id !== expectedId) {
    throw quarantine(
      "envelope-invalid",
      `the Tenant envelope id ${parsed.data.id} does not match ${expectedId}`,
      { tenantId: expectedId },
    );
  }
  return parsed.data;
}

export function envelopeNow(
  input: { id: string; name: string; schemaVersion: number },
  now = new Date(),
): TenantEnvelope {
  const iso = now.toISOString();
  return {
    id: input.id,
    name: input.name,
    createdAt: iso,
    updatedAt: iso,
    schemaVersion: input.schemaVersion,
  };
}
