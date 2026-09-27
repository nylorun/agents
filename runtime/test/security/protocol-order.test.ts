/**
 * G9 — 426 precedes authentication and mutation.
 */
import { expect, it } from "vitest";
import { TENANT_HEADER } from "@nylorun/core/compatibility";
import { ProtocolRejectedResponseSchema } from "@nylorun/core/contracts";
import {
  countTenantRows,
  getJson,
  readTenantLog,
  startSecurityHost,
} from "./support.js";

it("G9: unsupported protocol returns 426 with no Tenant log or row mutation", async () => {
  const host = await startSecurityHost({
    sandboxBackend: "virtual",
    model: { kind: "scripted", output: "ok" },
  });
  const [a] = host.tenants;

  const logBefore = readTenantLog(a);
  const definitionsBefore = await countTenantRows(host, a.id, "definitions");
  const sessionsBefore = await countTenantRows(host, a.id, "sessions");

  const missing = await getJson(`${host.url}/v1/agents`, {
    method: "PUT",
    headers: {
      [TENANT_HEADER]: a.id,
      authorization: `Bearer ${a.applicationKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "should-not-apply",
      implementationVersion: "dev",
      manifest: { id: "nope", name: "Nope", tools: [] },
    }),
  });
  expect(missing.status).toBe(426);
  expect(ProtocolRejectedResponseSchema.parse(missing.body).code).toBe(
    "protocol_unsupported",
  );

  const wrong = await getJson(`${host.url}/v1/sessions/sess-proto`, {
    method: "PUT",
    headers: {
      [TENANT_HEADER]: a.id,
      "Nylorun-Protocol": "1",
      authorization: `Bearer ${a.applicationKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "should-not-create",
      agentId: "nope",
      ownerUserId: "user-1",
    }),
  });
  expect(wrong.status).toBe(426);

  expect(readTenantLog(a)).toBe(logBefore);
  expect(await countTenantRows(host, a.id, "definitions")).toBe(
    definitionsBefore,
  );
  expect(await countTenantRows(host, a.id, "sessions")).toBe(sessionsBefore);
});
