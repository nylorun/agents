import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTenantKey } from "@nylorun/admin";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { credentialsPath, readLink, writeLink } from "../../src/project/link.js";
import { readCredentials, writeCredentials } from "../../src/project/credentials.js";

const HOST_ID = "host_01habcdefghijklmnopqrstuv";
const ADMIN_KEY = "a".repeat(64);
/** Created in Studio: registers the derived principal `project`. */
const STUDIO_TENANT = "tn_00000000000000000000000001";
/** Created by `nylo tenant create` elsewhere: only its one-time application key works. */
const CLI_TENANT = "tn_00000000000000000000000002";
const CLI_KEY = "c".repeat(64);

const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A Runtime whose Tenants accept the keys a real Host would have registered. */
async function runtime() {
  const accepted: Record<string, string[]> = {
    [STUDIO_TENANT]: [deriveTenantKey(ADMIN_KEY, STUDIO_TENANT, "project")],
    [CLI_TENANT]: [CLI_KEY],
  };
  const server = createServer((request, response) => {
    request.resume();
    const url = request.url ?? "/";
    response.setHeader("content-type", "application/json");
    const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };
    if (url === "/health") return void response.end(JSON.stringify({ status: "ok", hostId: HOST_ID, protocol }));
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
    if (url === "/v1/admin/tenants")
      return void response.end(
        JSON.stringify([
          { id: STUDIO_TENANT, name: "my-agents", state: "open", envelope: null },
          { id: CLI_TENANT, name: "other-project", state: "open", envelope: null },
        ]),
      );
    if (url === "/v1/tenant") {
      const tenant = String(request.headers["nylorun-tenant"] ?? "");
      const key = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (accepted[tenant]?.includes(key)) return void response.end(JSON.stringify({ id: tenant }));
      response.statusCode = 401;
      return void response.end(JSON.stringify({ code: "unauthorized", message: "no" }));
    }
    response.statusCode = 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function nylo(cwd: string, adminUrl: string, ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
      cwd,
      env: {
        ...process.env,
        NYLORUN_HOME: join(cwd, ".no-host"),
        NYLORUN_ADMIN_URL: adminUrl,
        NYLORUN_ADMIN_KEY: ADMIN_KEY,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-use-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"use-demo"}');
  return root;
}

describe("nylo tenant use", () => {
  it("links a fresh Project to a Tenant created in Studio with the derived project key", async () => {
    const url = await runtime();
    const root = await project();
    const result = await nylo(root, url, "tenant", "use", STUDIO_TENANT);
    expect(result.stderr).not.toMatch(/Error|No key/);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Linked to my-agents  ${STUDIO_TENANT}$`, "m"));
    expect(await readLink(root)).toMatchObject({ format: 1, hostId: HOST_ID, tenantId: STUDIO_TENANT });
    expect(await readCredentials(root)).toEqual({
      format: 1,
      applicationKey: deriveTenantKey(ADMIN_KEY, STUDIO_TENANT, "project"),
      principalId: "project",
    });
    expect(result.stdout + result.stderr).not.toContain(ADMIN_KEY);
  });

  it("keeps the one-time key it replaces, and switches back with it", async () => {
    const url = await runtime();
    const root = await project();
    await writeCredentials(root, { applicationKey: CLI_KEY, principalId: "pr_cli" });
    await writeLink(root, { format: 1, hostUrl: url, hostId: HOST_ID, tenantId: CLI_TENANT });

    const away = await nylo(root, url, "tenant", "use", "my-agents");
    expect(away.code).toBe(0);
    expect(away.stderr).toContain(`Kept the key for Tenant ${CLI_TENANT} in .nylorun/credentials.${CLI_TENANT}.json`);
    expect((await readLink(root))?.tenantId).toBe(STUDIO_TENANT);
    expect((await readCredentials(root))?.principalId).toBe("project");
    expect((await readCredentials(root, CLI_TENANT))?.applicationKey).toBe(CLI_KEY);

    const back = await nylo(root, url, "tenant", "use", CLI_TENANT);
    expect(back.code).toBe(0);
    expect((await readLink(root))?.tenantId).toBe(CLI_TENANT);
    expect(await readCredentials(root)).toMatchObject({ applicationKey: CLI_KEY, principalId: "pr_cli" });
    expect(existsSync(credentialsPath(root, CLI_TENANT))).toBe(false);
  });

  it("refuses a Tenant that no key of this Project reaches, and writes nothing", async () => {
    const url = await runtime();
    const root = await project();
    const result = await nylo(root, url, "tenant", "use", CLI_TENANT);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/has no derived "project" principal \(Tenants created in Studio have one\)/);
    expect(await readLink(root)).toBeUndefined();
    expect(await readCredentials(root)).toBeUndefined();
  });
});
