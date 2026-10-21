/**
 * ADR-71 at the Tenant's routes: `PUT /v1/tenant/model` takes a `host_identity` credential for
 * `google-vertex` only while the Host lends its identity, keeps no secret, and reports it as the
 * model's auth type. The Model Gate's side is in `host-identity.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useHostIdentity } from "../src/vault/host-identity.js";
import { startTestTenant } from "./support/tenant.js";

afterEach(() => useHostIdentity([]));

describe("a host_identity model credential", () => {
  it("is refused until the Host lends its identity, then kept with its project and location", async () => {
    const runtime = await startTestTenant({ useHostModel: true });
    try {
      const put = (body: Record<string, unknown>) =>
        fetch(`${runtime.url}/v1/tenant/model`, {
          method: "PUT",
          headers: runtime.managementHeaders(),
          body: JSON.stringify({ requestId: "m", idempotencyKey: JSON.stringify(body), ...body }),
        });
      const vertex = {
        provider: "google-vertex",
        model: "gemini-4-argon",
        auth: { type: "host_identity", project: "nylorun-bot-beta", location: "global" },
      };
      const refused = await put(vertex);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toMatch(/NYLORUN_MODEL_HOST_IDENTITY=google-vertex/);

      useHostIdentity(["google-vertex"]);
      expect((await put({ ...vertex, provider: "anthropic", model: "claude-opus-5-5" })).status).toBe(400);
      expect((await put({ ...vertex, auth: { ...vertex.auth, project: "Not A Project" } })).status).toBe(400);
      expect((await put({ ...vertex, auth: { ...vertex.auth, key: "a key" } })).status).toBe(400);
      expect((await put(vertex)).status).toBe(200);

      const view = (await fetch(`${runtime.url}/v1/tenant/model`, { headers: runtime.managementHeaders() }).then((response) =>
        response.json(),
      )) as Record<string, unknown>;
      expect(view).toMatchObject({ configured: true, provider: "google-vertex", model: "gemini-4-argon", authType: "host_identity" });
      expect(JSON.stringify(view)).not.toMatch(/nylorun-bot-beta/);
    } finally {
      await runtime.close();
    }
  });
});
