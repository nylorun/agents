import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { readCredentials } from "../../src/project/credentials.js";
import { readLink } from "../../src/project/link.js";

const HOST_ID = "host_01habcdefghijklmnopqrstuv";
const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** A Runtime that answers the Admin API and the Tenant model route. */
async function runtime() {
  const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    const received = { method: request.method ?? "GET", url, body: await body(request) };
    requests.push(received);
    response.setHeader("content-type", "application/json");
    const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };
    if (url === "/health") return void response.end(JSON.stringify({ hostId: HOST_ID, protocol }));
    if (url === "/v1/admin/status")
      return void response.end(
        JSON.stringify({
          service: "nylorun-runtime",
          version: "0.10.0-beta",
          protocol,
          tenants: [],
          aggregate: { runningSessions: 0, inFlightDeliveries: 0, pendingActions: 0, uncertainEffects: 0 },
          host: { hostId: HOST_ID, url: "http://localhost", pid: 1 },
        }),
      );
    if (url === "/v1/admin/tenants" && request.method === "POST") {
      response.statusCode = 201;
      const now = new Date().toISOString();
      return void response.end(
        JSON.stringify({ id: received.body.tenantId, name: received.body.name, createdAt: now, updatedAt: now, schemaVersion: 1 }),
      );
    }
    if (url === "/v1/tenant/model" && request.method === "PUT")
      return void response.end(JSON.stringify({ provider: "openai", model: "gpt-test", configured: true }));
    response.statusCode = 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

function nylo(cwd: string, adminUrl: string, ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
      cwd,
      env: {
        ...process.env,
        NYLORUN_HOME: join(cwd, ".no-host"),
        NYLORUN_ADMIN_URL: adminUrl,
        NYLORUN_ADMIN_KEY: "a".repeat(64),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function directory(project: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-create-"));
  roots.push(root);
  if (project) await writeFile(join(root, "package.json"), '{"name":"create-demo"}');
  return root;
}

describe("nylo tenant create", () => {
  it("in a Project: creates the Tenant, links it and seeds the model from .env", async () => {
    const { url, requests } = await runtime();
    const root = await directory(true);
    await writeFile(join(root, ".env"), "MODEL_PROVIDER=openai\nMODEL=gpt-test\nMODEL_PROVIDER_API_KEY=sk-test\n");
    const result = await nylo(root, url, "tenant", "create");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Tenant\s+create-demo\s+tn_\w+\s+\(created\)$/m);
    expect(result.stdout).toMatch(/^Model\s+openai\/gpt-test \(from \.env\)$/m);
    const link = await readLink(root);
    expect(link).toMatchObject({ format: 1, hostId: HOST_ID, hostUrl: url });
    const credentials = await readCredentials(root);
    const model = requests.find((request) => request.url === "/v1/tenant/model");
    expect(model?.body).toMatchObject({ provider: "openai", model: "gpt-test", auth: { type: "api_key", key: "sk-test" } });
    expect(credentials?.applicationKey).toBeDefined();
    expect(result.stdout).not.toContain(credentials!.applicationKey);
  });

  it("without a model in .env, points to Studio and nylo configure", async () => {
    const { url, requests } = await runtime();
    const root = await directory(true);
    const result = await nylo(root, url, "tenant", "create", "my-tenant");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Tenant\s+my-tenant\s/m);
    expect(result.stdout).toMatch(/Model\s+not configured: set it in Studio, or run nylo configure/);
    expect(requests.some((request) => request.url === "/v1/tenant/model")).toBe(false);
  });

  it("refuses a Project that is already linked", async () => {
    const { url } = await runtime();
    const root = await directory(true);
    expect((await nylo(root, url, "tenant", "create")).code).toBe(0);
    const again = await nylo(root, url, "tenant", "create");
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already linked to Tenant tn_\w+\. Use "nylo tenant use/);
  });

  it("outside a Project: prints the connection variables once and writes nothing", async () => {
    const { url } = await runtime();
    const root = await directory(false);
    const result = await nylo(root, url, "tenant", "create", "scratch");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^export NYLORUN_RUNTIME_URL=/m);
    expect(result.stdout).toMatch(/^export NYLORUN_SERVER_KEY=\S+/m);
    expect(result.stdout).toMatch(/^export NYLORUN_TENANT=tn_\w+$/m);
    expect(existsSync(join(root, ".nylorun"))).toBe(false);
  });

  it("names npx nylorun up when no Runtime answers", async () => {
    const root = await directory(true);
    const result = await nylo(root, "http://127.0.0.1:9", "tenant", "create");
    expect(result.code).toBe(6);
    expect(result.stderr).toMatch(/npx nylorun up/);
    expect(existsSync(join(root, ".nylorun"))).toBe(false);
  });
});

describe("nylo command names", () => {
  it.each([["up"], ["start"], ["stop"], ["status"], ["studio"]])(
    "%s points to the nylorun package (exit 2)",
    async (command) => {
      const root = await directory(false);
      const result = await nylo(root, "http://127.0.0.1:9", command);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`npx nylorun ${command}`);
    },
  );

  it("dev names its replacement", async () => {
    const root = await directory(true);
    const result = await nylo(root, "http://127.0.0.1:9", "dev");
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/nylo tenant create .* npm run dev/);
  });
});
