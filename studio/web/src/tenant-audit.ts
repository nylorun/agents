/**
 * Tenant › Audit: the Tenant's stream (GET /v1/tenant/audit, ADR-159) in words. Facts only: who
 * acted, what changed, which credential was used for which session. No event carries a secret,
 * so nothing here hides one.
 */
import type { TenantEvent, TenantEventType } from "@nylorun/admin/client";

/** The Type filter: every event, or one kind of change. */
export const AUDIT_VIEWS = {
  any: { label: "Any", types: undefined },
  keys: { label: "Keys", types: ["key.created", "key.revoked", "signing_key.rotated", "signing_key.revoked"] },
  settings: { label: "Policy and settings", types: ["policy.changed", "settings.changed"] },
  credentials: {
    label: "Credential changes",
    types: ["credential.created", "credential.rotated", "credential.deleted"],
  },
  uses: { label: "Credential uses", types: ["credential.used"] },
  signIns: { label: "Studio sign-ins", types: ["studio.signed_in"] },
} as const satisfies Record<string, { label: string; types: readonly TenantEventType[] | undefined }>;
export type AuditView = keyof typeof AUDIT_VIEWS;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** What an event says, on one line: "Created application key backend", "Used token for s-1 at https://…: approved". */
export function auditSummary(event: Pick<TenantEvent, "type" | "payload">): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "key.created":
      return `${p.rotated === true ? "Rotated" : "Created"} ${String(p.role)} key ${String(p.keyId)}`;
    case "key.revoked":
      return `Deleted ${String(p.role)} key ${String(p.keyId)}`;
    case "signing_key.rotated":
      return `Rotated signing keys: ${String(p.current)} signs${text(p.revoked) ? `, ${String(p.revoked)} revoked` : ""}${p.force === true ? " (forced)" : ""}`;
    case "signing_key.revoked":
      return `Revoked ${String(p.state)} signing key ${String(p.keyId)}`;
    case "policy.changed":
      return `Set the tool policy: ${p.rules === 1 ? "1 rule" : `${String(p.rules)} rules`}`;
    case "settings.changed": {
      const model = [text(p.provider), text(p.model)].filter(Boolean).join(" ");
      return `Changed ${String(p.key)}${model ? ` (${model})` : ""}`;
    }
    case "credential.created":
    case "credential.rotated":
    case "credential.deleted": {
      const verb = { "credential.created": "Wrote", "credential.rotated": "Replaced", "credential.deleted": "Deleted" }[event.type];
      return `${verb} credential ${text(p.credentialId) ?? "—"}${text(p.target) ? ` (${String(p.target)})` : ""}: ${String(p.outcome)}`;
    }
    case "credential.used":
      return `Used ${text(p.credentialId) ? `credential ${String(p.credentialId)}` : "no credential"}${text(p.sessionId) ? ` for ${String(p.sessionId)}` : ""}${text(p.target) ? ` at ${String(p.target)}` : ""}: ${String(p.outcome)}`;
    case "studio.signed_in":
      return `Signed in to Studio ${{ loopback: "on this machine", token: "with a login link", forwarded: "through the sign-in proxy" }[String(p.method)] ?? String(p.method)}${text(p.subject) ? ` as ${String(p.subject)}` : ""}`;
    default:
      return "—";
  }
}

/** Who acted: the principal, with the Runtime and the Tenant's machine in words. */
export function auditWho(event: Pick<TenantEvent, "principal" | "source">): string {
  if (event.source === "runtime") return event.principal === "host" ? "Runtime" : `Runtime (${event.principal})`;
  if (event.source === "operate") return "nylorun-operate";
  return event.principal;
}
