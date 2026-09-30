import { expect, it } from "vitest";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import {
  adminHeaders,
  createFakeModule,
  getJson,
  newTenantId,
  startTestHost,
} from "./support.js";

it("A1: GET /v1/admin/status returns AdminStatusSchema with host", async () => {
  const module = createFakeModule({
    tenants: [
      {
        id: newTenantId(),
        name: "demo",
        state: "open",
        summary: {
          ready: true,
          runningSessions: 1,
          inFlightDeliveries: 0,
          pendingActions: 0,
          uncertainEffects: 0,
        },
      },
    ],
  });
  const { url, config } = await startTestHost({ module });
  const { status, body } = await getJson(`${url}/v1/admin/status`, {
    headers: adminHeaders(),
  });
  expect(status).toBe(200);
  const parsed = AdminStatusSchema.parse(body);
  expect(parsed.service).toBe("nylorun-runtime");
  expect(parsed.protocol).toEqual({
    min: HOST_PROTOCOL.min,
    max: HOST_PROTOCOL.max,
    features: [...HOST_PROTOCOL.features],
  });
  expect(parsed.host).toEqual({
    hostId: config.hostId,
    url,
    pid: process.pid,
  });
  expect(parsed.tenants).toHaveLength(1);
  expect(parsed.aggregate.runningSessions).toBe(1);
});

it("A1: GET /v1/admin/host returns the identical body as /status", async () => {
  const module = createFakeModule({
    tenants: [{ id: newTenantId(), name: "a", state: "open" }],
  });
  const { url } = await startTestHost({ module });
  const status = await getJson(`${url}/v1/admin/status`, {
    headers: adminHeaders(),
  });
  const host = await getJson(`${url}/v1/admin/host`, {
    headers: adminHeaders(),
  });
  expect(status.status).toBe(200);
  expect(host.status).toBe(200);
  expect(host.body).toEqual(status.body);
  AdminStatusSchema.parse(host.body);
});

it("A2: /health advertises admin-status", async () => {
  const { url } = await startTestHost();
  const { status, body } = await getJson(`${url}/health`);
  expect(status).toBe(200);
  expect(body).toMatchObject({
    protocol: {
      features: expect.arrayContaining(["admin-status"]),
    },
  });
});
