/**
 * An unexpected error in a Tenant route: the client sees only `500 internal_error`, and the
 * Tenant's logger gets one entry with the method, the route's pattern and the error's message
 * and stack, never the request's body.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { tenantApi } from "../../src/api/http/app.js";
import type { TenantContext } from "../../src/tenant/context.js";
import type { NodeBindings } from "../../src/tenant/types.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it("logs a route's unexpected error once, without the body", async () => {
  const entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const log =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, ...(fields ? { fields } : {}) });
    };
  // Authenticating a bearer asks the trusted issuers first: here, that throws.
  const tenant = {
    config: {
      logger: { info: log("info"), warn: log("warn"), error: log("error") },
      issuers: {
        issuers: [],
        claimed() {
          throw new Error("issuers unreachable");
        },
      },
    },
  } as unknown as TenantContext;
  const server = createServer(
    getRequestListener(
      (request, env) => tenantApi().fetch(request, { ...(env as NodeBindings), tenant }),
      { overrideGlobalObjects: false },
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/s_1/commands`, {
    method: "POST",
    headers: { authorization: "Bearer key", "content-type": "application/json" },
    body: JSON.stringify({ secret: "body-secret-value" }),
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    status: "rejected",
    code: "internal_error",
    message: "Runtime request failed",
  });
  const errors = entries.filter((entry) => entry.level === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    message: "request_failed",
    fields: {
      method: "POST",
      route: "/v1/sessions/:sessionId/commands",
      error: "issuers unreachable",
      stack: expect.stringContaining("issuers unreachable"),
    },
  });
  expect(JSON.stringify(entries)).not.toContain("body-secret-value");
  expect(JSON.stringify(entries)).not.toContain("Bearer key");
});
