/**
 * G8 — Host log contains no Tenant log record, bearer, API key, or KEK.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import { readFileSync } from "node:fs";
import {
  HOSTILE_MODEL_KEY,
  getJson,
  readTenantLog,
  startSecurityHost,
} from "./support.js";

const agent = Agent({ id: "log-bot", name: "Log Bot" }).build();

it("G8: Host log omits Tenant records, bearer, API keys, and KEK material", async () => {
  const host = await startSecurityHost({
    sandboxBackend: "virtual",
    model: { kind: "scripted", output: "ok" },
  });
  const a = host.tenant;
  const bearer = a.applicationKey;
  const kek = readFileSync(a.paths.kek, "utf8").trim();

  await getJson(`${host.url}/v1/agents/${agent.manifest.id}`, {
    method: "PUT",
    headers: a.headers(),
    body: JSON.stringify({
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: agent.manifest,
    }),
  });
  await getJson(`${host.url}/v1/sessions/sess-log`, {
    method: "PUT",
    headers: a.headers(),
    body: JSON.stringify({
      requestId: randomUUID(),
      agentId: agent.manifest.id,
      ownerUserId: "user-1",
    }),
  });
  await getJson(`${host.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: a.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        auth: { type: "api_key", key: HOSTILE_MODEL_KEY },
      },
    }),
  });
  await getJson(`${host.url}/v1/sessions/sess-log`, {
    headers: a.headers(),
  });

  // Force a Tenant log record (credential rejection warn).
  await getJson(`${host.url}/v1/agents`, {
    headers: {
      ...a.headers(),
      authorization: "Bearer definitely-not-a-valid-token",
    },
  });

  const tenantLog = readTenantLog(a);
  expect(tenantLog.length).toBeGreaterThan(0);
  // Tenant log carries tenantId-bound records.
  expect(tenantLog).toContain(a.id);

  const hostJoined = host.hostLogLines.join("\n");
  expect(hostJoined.length).toBeGreaterThan(0);

  // No Tenant log lines copied into Host log.
  for (const line of tenantLog.split("\n").filter(Boolean)) {
    expect(hostJoined).not.toContain(line);
  }
  expect(hostJoined).not.toContain(bearer);
  expect(hostJoined).not.toContain(a.managementKey);
  expect(hostJoined).not.toContain(HOSTILE_MODEL_KEY);
  expect(hostJoined).not.toContain(kek);
  expect(hostJoined).not.toContain("sess-log");
});
