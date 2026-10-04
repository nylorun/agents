/**
 * Operator keys (F9 I1, Host feature `operator-keys`): the Admin API creates, rotates, lists
 * and deletes the Tenant's application keys by name. A rotated or deleted key stops
 * authenticating on its next request (the opaque 404 of an unknown key); `studio` is not
 * managed there. `@nylorun/admin`'s `keys` methods answer the same.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmin, deriveStudioToken } from "@nylorun/admin";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import {
  ListOperatorKeysResponseSchema,
  PutOperatorKeyResponseSchema,
  RejectedResponseSchema,
} from "@nylorun/core/contracts";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-operator-keys-"));
  roots.push(hostRoot);
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({
    hostRoot,
    retainRoot: true,
    operatorListener: true,
    database: database.sql,
  });
  closers.push(runtime, { close: database.drop });
  const headers = {
    authorization: `Bearer ${runtime.adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
  const admin = async (method: string, path: string) => {
    const response = await fetch(`${runtime.adminUrl}${path}`, { method, headers });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  /** A Tenant API read with `key`: 200, or the opaque 404 of an unknown key. */
  const reads = async (key: string) =>
    (
      await fetch(`${runtime.url}/v1/tenant`, {
        headers: { authorization: `Bearer ${key}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
      })
    ).status;
  return { ...runtime, admin, reads };
}

describe("operator keys", () => {
  it("creates a key that reaches the Tenant API, and lists it without the key", async () => {
    const host = await startHost();
    const health = (await (await fetch(`${host.url}/health`)).json()) as {
      protocol: { features: string[] };
    };
    expect(health.protocol.features).toContain("operator-keys");

    const created = await host.admin("PUT", "/v1/admin/keys/babai");
    expect(created.status).toBe(200);
    const put = PutOperatorKeyResponseSchema.parse(created.body);
    expect(put).toMatchObject({ id: "babai", role: "application", rotated: false });
    expect(put.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await host.reads(put.key)).toBe(200);

    const listed = await host.admin("GET", "/v1/admin/keys");
    expect(listed.status).toBe(200);
    const { keys } = ListOperatorKeysResponseSchema.parse(listed.body);
    expect(keys.map((key) => key.id)).toEqual(
      [...keys.map((key) => key.id)].sort(),
    );
    expect(keys).toContainEqual({ id: "babai", role: "application", createdAt: put.createdAt });
    expect(keys.map((key) => key.id)).toEqual(
      expect.arrayContaining(["babai", "studio", host.principalId]),
    );
    expect(JSON.stringify(listed.body)).not.toContain(put.key);
    // The ephemeral Runtime registers no derived `project` principal any more.
    expect(keys.map((key) => key.id)).not.toContain("project");
  });

  it("rotating a key stops the old one at once; deleting it stops the new one", async () => {
    const host = await startHost();
    const first = PutOperatorKeyResponseSchema.parse((await host.admin("PUT", "/v1/admin/keys/ci")).body);
    expect(await host.reads(first.key)).toBe(200);

    const second = PutOperatorKeyResponseSchema.parse((await host.admin("PUT", "/v1/admin/keys/ci")).body);
    expect(second).toMatchObject({ id: "ci", rotated: true });
    expect(second.key).not.toBe(first.key);
    expect(await host.reads(first.key)).toBe(404);
    expect(await host.reads(second.key)).toBe(200);

    const deleted = await host.admin("DELETE", "/v1/admin/keys/ci");
    expect(deleted).toEqual({ status: 200, body: { id: "ci", deleted: true } });
    expect(await host.reads(second.key)).toBe(404);
    const again = await host.admin("DELETE", "/v1/admin/keys/ci");
    expect(again.status).toBe(404);
    expect(RejectedResponseSchema.parse(again.body)).toMatchObject({
      code: "not_found",
      message: "No key ci",
    });
    // The application key the Runtime was started with is untouched.
    expect(await host.reads(host.applicationKey)).toBe(200);
  });

  it("refuses studio and malformed names, and leaves the Studio key working", async () => {
    const host = await startHost();
    for (const method of ["PUT", "DELETE"]) {
      const studio = await host.admin(method, "/v1/admin/keys/studio");
      expect(studio.status, method).toBe(400);
      expect(RejectedResponseSchema.parse(studio.body).code).toBe("request_rejected");
      const malformed = await host.admin(method, "/v1/admin/keys/Not_A_Key");
      expect(malformed.status, method).toBe(400);
      expect(RejectedResponseSchema.parse(malformed.body).code).toBe("invalid_request");
    }
    expect(await host.reads(deriveStudioToken(host.adminKey, host.tenantId))).toBe(200);
  });

  it("is reached through @nylorun/admin's keys methods", async () => {
    const host = await startHost();
    const admin = createAdmin({ url: host.adminUrl, key: host.adminKey });
    const put = await admin.keys.put("app-server");
    expect(put).toMatchObject({ id: "app-server", role: "application", rotated: false });
    expect(await host.reads(put.key)).toBe(200);
    expect((await admin.keys.list()).map((key) => key.id)).toContain("app-server");
    const rotated = await admin.keys.put("app-server");
    expect(rotated.rotated).toBe(true);
    expect(await host.reads(put.key)).toBe(404);
    expect(await admin.keys.delete("app-server")).toBe(true);
    expect(await admin.keys.delete("app-server")).toBe(false);
    expect(await host.reads(rotated.key)).toBe(404);
    await expect(admin.keys.put("studio")).rejects.toMatchObject({
      name: "AdminError",
      code: "request_rejected",
      status: 400,
    });
  });
});
