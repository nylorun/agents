import assert from "node:assert/strict";
import test from "node:test";
import { AUDIT_VIEWS, auditSummary, auditWho } from "../web/src/tenant-audit.ts";

const event = (type, payload) => ({ type, payload });

test("each Tenant event reads as one line, naming what changed and never more", () => {
  assert.equal(auditSummary(event("key.created", { keyId: "backend", role: "application", rotated: false })), "Created application key backend");
  assert.equal(auditSummary(event("key.created", { keyId: "backend", role: "application", rotated: true })), "Rotated application key backend");
  assert.equal(auditSummary(event("key.revoked", { keyId: "ops", role: "management" })), "Deleted management key ops");
  assert.equal(
    auditSummary(event("signing_key.rotated", { current: "k2", standby: "k3", previous: "k1", revoked: "k0", force: true })),
    "Rotated signing keys: k2 signs, k0 revoked (forced)",
  );
  assert.equal(auditSummary(event("signing_key.revoked", { keyId: "k3", state: "standby" })), "Revoked standby signing key k3");
  assert.equal(auditSummary(event("policy.changed", { rules: 1, updatedAt: "t" })), "Set the tool policy: 1 rule");
  assert.equal(auditSummary(event("policy.changed", { rules: 0, updatedAt: "t" })), "Set the tool policy: 0 rules");
  assert.equal(auditSummary(event("settings.changed", { key: "limits.config" })), "Changed limits.config");
  assert.equal(
    auditSummary(event("settings.changed", { key: "model", provider: "anthropic", model: "claude" })),
    "Changed model (anthropic claude)",
  );
  assert.equal(
    auditSummary(event("credential.created", { vaultId: "v", credentialId: "c1", outcome: "created" })),
    "Wrote credential c1: created",
  );
  assert.equal(
    auditSummary(event("credential.used", { vaultId: "v", credentialId: "c1", sessionId: "s-1", target: "https://mcp.example.com/a", outcome: "approved" })),
    "Used credential c1 for s-1 at https://mcp.example.com/a: approved",
  );
  assert.equal(
    auditSummary(event("credential.used", { sessionId: "s-1", target: "https://x", outcome: "refused" })),
    "Used no credential for s-1 at https://x: refused",
  );
  assert.equal(auditSummary(event("studio.signed_in", { method: "loopback" })), "Signed in to Studio on this machine");
  assert.equal(
    auditSummary(event("studio.signed_in", { method: "forwarded", subject: "u:ann" })),
    "Signed in to Studio through the sign-in proxy as u:ann",
  );
  assert.equal(auditSummary(event("tenant.unknown", {})), "—");
});

test("who acted: the principal, the Runtime and the Tenant's machine in words", () => {
  assert.equal(auditWho({ principal: "ops", source: "api" }), "ops");
  assert.equal(auditWho({ principal: "backend:u:ann", source: "api" }), "backend:u:ann");
  assert.equal(auditWho({ principal: "host", source: "runtime" }), "Runtime");
  assert.equal(auditWho({ principal: "sweep", source: "runtime" }), "Runtime (sweep)");
  assert.equal(auditWho({ principal: "operate", source: "operate" }), "nylorun-operate");
});

test("the Type filter covers every Tenant event type once", () => {
  const types = Object.values(AUDIT_VIEWS).flatMap((view) => view.types ?? []);
  assert.equal(new Set(types).size, types.length);
  assert.deepEqual(
    [...types].sort(),
    [
      "credential.created",
      "credential.deleted",
      "credential.rotated",
      "credential.used",
      "key.created",
      "key.revoked",
      "policy.changed",
      "settings.changed",
      "signing_key.revoked",
      "signing_key.rotated",
      "studio.signed_in",
    ],
  );
});
