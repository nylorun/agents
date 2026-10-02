import { expect, it, vi } from "vitest";
import { PROTOCOL_HEADER, TENANT_HEADER } from "@nylorun/core/compatibility";
import { ProtocolRejectedResponseSchema } from "@nylorun/core/contracts";
import {
  FAKE_TENANT_ID,
  adminHeaders,
  createFakeModule,
  getJson,
  startTestHost,
  tenantHeaders,
} from "./support.js";

it("C3: missing Nylorun-Protocol returns 426 before authentication", async () => {
  const tenantId = FAKE_TENANT_ID;
  const module = createFakeModule();
  const resolve = vi.spyOn(module, "resolve");
  const { url } = await startTestHost({ module });
  const { status, body } = await getJson(`${url}/v1/agents`, {
    headers: { [TENANT_HEADER]: tenantId, authorization: "Bearer x" },
  });
  expect(status).toBe(426);
  expect(ProtocolRejectedResponseSchema.parse(body).code).toBe(
    "protocol_unsupported",
  );
  expect(resolve).not.toHaveBeenCalled();
});

it("C3: unsupported Nylorun-Protocol returns 426 before resolve", async () => {
  const tenantId = FAKE_TENANT_ID;
  const module = createFakeModule();
  const resolve = vi.spyOn(module, "resolve");
  const { url } = await startTestHost({ module });
  const { status, body } = await getJson(`${url}/v1/agents`, {
    headers: {
      [TENANT_HEADER]: tenantId,
      [PROTOCOL_HEADER]: "1",
      authorization: "Bearer x",
    },
  });
  expect(status).toBe(426);
  expect(ProtocolRejectedResponseSchema.parse(body)).toMatchObject({
    status: "rejected",
    code: "protocol_unsupported",
  });
  expect(resolve).not.toHaveBeenCalled();
});

it("C3: admin routes require protocol before admin auth", async () => {
  const { url } = await startTestHost();
  const missing = await getJson(`${url}/v1/admin/host`, {
    headers: { authorization: `Bearer ${"0".repeat(64)}` },
  });
  expect(missing.status).toBe(426);
  const bad = await getJson(`${url}/v1/admin/host`, {
    headers: {
      [PROTOCOL_HEADER]: "99",
      authorization: adminHeaders().authorization!,
    },
  });
  expect(bad.status).toBe(426);
});

it("P13: the Host serves protocol 4 and 5 clients", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  for (const version of ["4", "5"]) {
    const { status } = await getJson(`${url}/v1/agents`, {
      headers: { ...tenantHeaders(), [PROTOCOL_HEADER]: version },
    });
    expect(status, `protocol ${version}`).toBe(200);
  }
  const six = await getJson(`${url}/v1/agents`, {
    headers: { ...tenantHeaders(), [PROTOCOL_HEADER]: "6" },
  });
  expect(six.status).toBe(426);
});
