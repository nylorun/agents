import { expect, it } from "vitest";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import {
  FAKE_TENANT_ID,
  adminHeaders,
  createFakeModule,
  getJson,
  startTestHost,
} from "./support.js";

it("A1: GET /v1/admin/status returns AdminStatusSchema with host", async () => {
  const module = createFakeModule({
    tenant: {
      name: "demo",
      summary: {
        ready: true,
        runningSessions: 1,
        inFlightDeliveries: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      },
    },
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
  expect(parsed.tenant).toEqual({
    id: FAKE_TENANT_ID,
    name: "demo",
    state: "open",
    envelope: expect.objectContaining({ id: FAKE_TENANT_ID, name: "demo" }),
  });
  expect(parsed.aggregate.runningSessions).toBe(1);
});

it("A1: GET /v1/admin/host returns the identical body as /status", async () => {
  const module = createFakeModule();
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

it("A2: /health advertises admin-status, and runtime-tenants for protocol 4 clients", async () => {
  const { url } = await startTestHost();
  const { status, body } = await getJson(`${url}/health`);
  expect(status).toBe(200);
  expect(body).toMatchObject({
    protocol: {
      min: 4,
      max: 5,
      features: expect.arrayContaining(["admin-status", "runtime-tenants"]),
    },
  });
});
