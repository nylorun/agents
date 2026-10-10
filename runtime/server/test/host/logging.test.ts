import { expect, it } from "vitest";
import {
  FAKE_TENANT_ID,
  createFakeModule,
  getJson,
  startTestHost,
  tenantHeaders,
} from "./support.js";

it("C9: Host logger records routing outcome without bearer or session ids", async () => {
  const lines: string[] = [];
  const sessionId = "sess_secret_should_not_appear";
  const module = createFakeModule();
  const { url } = await startTestHost({ module, logLines: lines });
  await getJson(`${url}/v1/sessions/${sessionId}`, {
    headers: tenantHeaders("super-secret-bearer-token"),
  });
  // Allow log flush (sync write)
  const requestLogs = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.message === "request");
  expect(requestLogs.length).toBeGreaterThanOrEqual(1);
  const row = requestLogs.at(-1)!;
  expect(row.tenantId).toBe(FAKE_TENANT_ID);
  expect(row.status).toBe(200);
  expect(row.path).toBe("/v1/sessions/:id");
  const joined = lines.join("\n");
  expect(joined).not.toContain("super-secret-bearer-token");
  expect(joined).not.toContain(sessionId);
});
