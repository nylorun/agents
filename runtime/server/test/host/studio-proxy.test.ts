import { expect, it } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import {
  FAKE_TENANT_ID,
  createFakeModule,
  getJson,
  startTestHost,
} from "./support.js";

/**
 * A8: Studio's trusted proxy builds upstream headers without Origin
 * (studio/src/proxy.ts). A proxy-shaped request must succeed; an Origin
 * would be rejected (covered in loopback tests).
 */
it("A8: Studio proxy-shaped upstream request has no Origin and is accepted", async () => {
  const tenantId = FAKE_TENANT_ID;
  const module = createFakeModule();
  const { url } = await startTestHost({ module });

  const proxyShapedHeaders: Record<string, string> = {
    authorization: "Bearer application-key-value-16",
    // Studio still sends the header in the protocol 4 window; it names this Host's Tenant.
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    accept: "application/json",
  };
  expect(proxyShapedHeaders).not.toHaveProperty("origin");
  expect(proxyShapedHeaders).not.toHaveProperty("Origin");

  const health = await getJson(`${url}/health`, {
    headers: { ...proxyShapedHeaders },
  });
  expect(health.status).toBe(200);
  const cors = [...health.headers.keys()].filter((h) =>
    h.toLowerCase().startsWith("access-control-"),
  );
  expect(cors).toEqual([]);

  const agents = await getJson(`${url}/v1/agents`, {
    headers: proxyShapedHeaders,
  });
  expect(agents.status).toBe(200);
  expect(agents.body).toEqual({ ok: true, tenantId });
});
