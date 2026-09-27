import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newTenantId } from "@nylorun/agents";
import { seedTenantFromProject } from "../../src/project/seed.js";
import { loadProjectEnvironment } from "../../src/environment.js";

const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("F3: loadProjectEnvironment returns a map and does not mutate process.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-seed-env-"));
  roots.push(root);
  await writeFile(
    join(root, ".env"),
    "MODEL=from-file\nMODEL_PROVIDER=openai\nNYLORUN_SANDBOX=virtual\n",
  );
  const before = process.env.MODEL;
  const map = loadProjectEnvironment(root);
  expect(map.MODEL).toBe("from-file");
  expect(map.NYLORUN_SANDBOX).toBe("virtual");
  expect(process.env.MODEL).toBe(before);
});

it("F3: seeds sandbox via config/seed and does not overwrite on second call", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-seed-"));
  roots.push(root);
  const tenantId = newTenantId();
  let seedCalls = 0;
  let modelPuts = 0;
  const backends: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/tenant/config/seed" && request.method === "PUT") {
      seedCalls += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      backends.push(body.sandbox.backend);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          seedCalls === 1
            ? { applied: ["sandbox.backend"], kept: [] }
            : { applied: [], kept: ["sandbox.backend"] },
        ),
      );
      return;
    }
    if (request.url === "/v1/tenant/model" && request.method === "PUT") {
      modelPuts += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          configured: true,
          provider: "openai",
          model: "gpt",
          authType: "api_key",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const env = {
    NYLORUN_SANDBOX: "virtual",
    MODEL_PROVIDER: "openai",
    MODEL: "gpt",
    MODEL_PROVIDER_API_KEY: "sk-test",
  };
  const first = await seedTenantFromProject({
    hostUrl: url,
    tenantId,
    applicationKey: "k".repeat(64),
    projectRoot: root,
    env,
  });
  expect(first.applied).toContain("sandbox.backend");
  expect(modelPuts).toBe(1);
  const second = await seedTenantFromProject({
    hostUrl: url,
    tenantId,
    applicationKey: "k".repeat(64),
    projectRoot: root,
    env: { ...env, NYLORUN_SANDBOX: "auto" },
  });
  expect(second.kept).toContain("sandbox.backend");
  expect(seedCalls).toBe(2);
  expect(backends).toEqual(["virtual", "auto"]);
});

it("seeds the Tenant fixture model and keeps the model credential out of it", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-seed-fixture-"));
  roots.push(root);
  const bodies: unknown[] = [];
  let modelPuts = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/tenant/config/seed" && request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ applied: ["model.fixture"], kept: [] }));
      return;
    }
    if (request.url === "/v1/tenant/model") modelPuts += 1;
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const seeded = await seedTenantFromProject({
    hostUrl: `http://127.0.0.1:${port}`,
    tenantId: newTenantId(),
    applicationKey: "k".repeat(64),
    projectRoot: root,
    env: { MODEL_PROVIDER: "openai", MODEL: "gpt", MODEL_PROVIDER_API_KEY: "sk-test" },
    fixtureModel: true,
  });
  expect(seeded.applied).toEqual(["model.fixture"]);
  expect(bodies).toEqual([{ requestId: expect.any(String), fixtureModel: true }]);
  expect(modelPuts).toBe(0);
});