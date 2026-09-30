import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { createProjectTenant } from "../../src/project/create-tenant.js";
import { readCredentials } from "../../src/project/credentials.js";
import { readLink } from "../../src/project/link.js";

const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("F2-2: createProjectTenant uses admin.createTenant and writes format 1 files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-create-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"create-demo"}');

  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          hostId: "host_01habcdefghijklmnopqrstuv",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
        }),
      );
      return;
    }
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/admin/tenants");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(body.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.studioCredentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.name).toBe("create-demo");
    response.statusCode = 201;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: body.tenantId,
        name: body.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  const { createAdmin } = await import("@nylorun/admin");
  const admin = createAdmin({
    url: `http://127.0.0.1:${port}`,
    key: "a".repeat(64),
  });
  const result = await createProjectTenant({
    admin,
    hostId: "host_01habcdefghijklmnopqrstuv",
    projectRoot: root,
  });
  expect(result.envelope.name).toBe("create-demo");
  expect(await readLink(root)).toMatchObject({
    format: 1,
    tenantId: result.link.tenantId,
    hostId: "host_01habcdefghijklmnopqrstuv",
  });
  const credentials = await readCredentials(root);
  expect(credentials).toMatchObject({
    format: 1,
    applicationKey: result.credentials.applicationKey,
  });
  expect(credentials).not.toHaveProperty("executors");
  const onDisk = JSON.parse(
    await readFile(join(root, ".nylorun/credentials.json"), "utf8"),
  );
  expect(onDisk).not.toHaveProperty("executors");
  expect(onDisk.format).toBe(1);
});
