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

it("C3: the Admin API's old paths require the protocol first, as any route does", async () => {
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

it("P13: the Host serves protocol 4 to 9 clients", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  for (const version of ["4", "5", "6", "7", "8", "9"]) {
    const { status } = await getJson(`${url}/v1/agents`, {
      headers: { ...tenantHeaders(), [PROTOCOL_HEADER]: version },
    });
    expect(status, `protocol ${version}`).toBe(200);
  }
  const ten = await getJson(`${url}/v1/agents`, {
    headers: { ...tenantHeaders(), [PROTOCOL_HEADER]: "10" },
  });
  expect(ten.status).toBe(426);
  // Only a capability link is served without the header (protocol 6), and the OAuth callback.
  const { [PROTOCOL_HEADER]: _protocol, ...unversioned } = tenantHeaders();
  const link = await getJson(`${url}/v1/artifact-links/not-a-token`, { headers: unversioned });
  expect(link.status).not.toBe(426);
  // Nor the MCP OAuth callback a browser is sent back to (F9 C2), with no credential either.
  const callback = await getJson(`${url}/v1/oauth/callback?state=s&code=c`, { headers: {} });
  expect(callback.status).not.toBe(426);
  const noProtocol = await getJson(`${url}/v1/agents`, { headers: unversioned });
  expect(noProtocol.status).toBe(426);
});

it("lets only an artifact upload carry a body that is not JSON", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  const send = (path: string) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { ...tenantHeaders(), "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
  expect((await send("/v1/sessions/s1/commands")).status).toBe(415);
  expect((await send("/v1/artifacts?name=a.png")).status).not.toBe(415);
  expect((await send(`/v1/artifacts/af_${"0".repeat(26)}/versions`)).status).not.toBe(415);
});
