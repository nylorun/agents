import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import {
  APPLICATION_KEY,
  HOST_ID,
  link3,
  MANAGEMENT_KEY,
  project,
  writeProjectLink,
} from "./helpers/project.js";

const cli = fileURLToPath(new URL("../../dist/nylo.js", import.meta.url));
const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TENANT_ID = "tn_00000000000000000000000000";
const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

type Received = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

/** A Runtime that answers the Runtime and Management API routes `nylo` calls. */
async function runtime(options: { tenantOpen?: boolean } = {}) {
  const requests: Received[] = [];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "application/json");
    if (url === "/health") return void response.end(JSON.stringify({ status: "ok", hostId: HOST_ID, protocol }));
    requests.push({ method: request.method ?? "GET", url, headers: request.headers, body: await body(request) });
    if (url === "/v1/tenant" && request.method === "GET") {
      if (options.tenantOpen === false) {
        response.statusCode = 503;
        return void response.end(JSON.stringify({ code: "tenant_unavailable", message: "The Tenant is not open." }));
      }
      return void response.end(
        JSON.stringify({
          tenant: { id: TENANT_ID, name: "demo" },
          path: "/nylorun/tenant",
          checks: { store: true, scheduler: true, model: false, schema: true },
          counts: { sessions: 3, runningSessions: 1, uncertainEffects: 0 },
          sandbox: { backend: "virtual", retained: 0 },
        }),
      );
    }
    if (url === "/v1/tenant/reset" && request.method === "POST")
      return void response.end(JSON.stringify({ scope: "sessions" }));
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

async function linkedProject(
  hostUrl: string,
  credentials?: Record<string, unknown>,
): Promise<string> {
  const root = await project("nylo-installation-");
  roots.push(root);
  await writeProjectLink(root, link3(hostUrl), credentials);
  return root;
}

/** Run the built `nylo` with no inherited connection variables. */
function nylo(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NYLORUN_RUNTIME_URL: "",
      NYLORUN_SERVER_KEY: "",
      NYLORUN_MANAGEMENT_KEY: "",
      NYLORUN_TENANT: "",
      NYLORUN_HOME: "",
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => (stdout += data));
  child.stderr!.on("data", (data) => (stderr += data));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("nylo status|reset on the linked installation", { timeout: 20_000 }, () => {
  it("status shows the Tenant", async () => {
    const host = await runtime();
    const root = await linkedProject(host.url);
    const text = await nylo(["status"], root);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`demo  ${TENANT_ID}`);
    expect(text.stdout).not.toContain("stack");
    expect(text.stdout).toContain(`runtime  ${host.url}`);
    expect(text.stdout).toContain("counts   sessions=3 running=1 uncertain=0");
    const json = await nylo(["status", "--json"], root);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ tenant: { id: TENANT_ID } });
    expect(JSON.parse(json.stdout)).not.toHaveProperty("stack");
  });

  it("status of a Tenant that is not open says to run nylorun status", async () => {
    const host = await runtime({ tenantOpen: false });
    const root = await linkedProject(host.url);
    const result = await nylo(["status"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `GET /v1/tenant failed (503). Run "npx nylorun status" to see the Tenant's state and why it is not open.`,
    );
    // Only the Management API: no Admin API fallback.
    expect(host.requests.map((r) => r.url)).toEqual(["/v1/tenant"]);
  });

  it("reset drains and resets the Tenant; --all asks first", async () => {
    const host = await runtime();
    const root = await linkedProject(host.url);
    const result = await nylo(["reset"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Reset Tenant demo (${host.url}) (sessions).`);
    const reset = host.requests.find((r) => r.url === "/v1/tenant/reset");
    expect(reset?.body).toMatchObject({ scope: "sessions", activeWork: "drain" });
    // Not a terminal: --all needs --yes.
    const all = await nylo(["reset", "--all"], root);
    expect(all.code).toBe(2);
    expect(all.stderr).toContain("pass --yes");
    expect((await nylo(["reset", "--all", "--yes"], root)).code).toBe(0);
    expect(host.requests.filter((r) => r.url === "/v1/tenant/reset").map((r) => r.body.scope)).toEqual([
      "sessions",
      "all",
    ]);
    for (const args of [["reset", "--all", "--sessions"], ["reset", "--everything"]])
      expect((await nylo(args, root)).code).toBe(2);
  });

  it("endpoints is a usage error: Action endpoints are gone", async () => {
    const host = await runtime();
    const root = await linkedProject(host.url);
    for (const args of [["endpoints"], ["endpoints", "ping", "support"]]) {
      const result = await nylo(args, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("nylo endpoints was removed");
      expect(result.stderr).toContain("http() tools and remote MCP servers");
    }
    expect(host.requests).toEqual([]);
  });

  it("uses NYLORUN_RUNTIME_URL with NYLORUN_MANAGEMENT_KEY without a link", async () => {
    const host = await runtime();
    const root = await project("nylo-installation-");
    roots.push(root);
    const result = await nylo(["status"], root, {
      NYLORUN_RUNTIME_URL: host.url,
      NYLORUN_MANAGEMENT_KEY: MANAGEMENT_KEY,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`runtime  ${host.url}`);
    expect(host.requests.map((r) => `${r.url} ${r.headers.authorization}`)).toEqual([
      `/v1/tenant Bearer ${MANAGEMENT_KEY}`,
    ]);
    // The Management API needs a management key.
    const status = await nylo(["status"], root, {
      NYLORUN_RUNTIME_URL: host.url,
      NYLORUN_SERVER_KEY: APPLICATION_KEY,
    });
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("No management key");
  });

  it("status and reset need a management key: a credentials file from before management keys is refused", async () => {
    const host = await runtime();
    const root = await linkedProject(host.url, {
      format: 1,
      applicationKey: APPLICATION_KEY,
      principalId: "project",
    });
    for (const args of [["status"], ["reset", "--yes"]]) {
      const result = await nylo(args, root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `No management key for the Tenant at ${host.url}: run npx nylorun start, or set NYLORUN_MANAGEMENT_KEY.`,
      );
    }
    expect(host.requests).toEqual([]);
    // NYLORUN_MANAGEMENT_KEY stands in for the missing one.
    expect((await nylo(["status"], root, { NYLORUN_MANAGEMENT_KEY: MANAGEMENT_KEY })).code).toBe(0);
  });

  it("requests carry the key of their API and the protocol, and never a Nylorun-Tenant header", async () => {
    const host = await runtime();
    const root = await linkedProject(host.url);
    for (const args of [["status"], ["reset", "--yes"]])
      expect((await nylo(args, root)).code).toBe(0);
    const requests = host.requests;
    expect(requests.map((r) => `${r.url} ${r.headers.authorization}`)).toEqual([
      `/v1/tenant Bearer ${MANAGEMENT_KEY}`,
      `/v1/tenant/reset Bearer ${MANAGEMENT_KEY}`,
    ]);
    for (const request of requests) {
      expect(request.headers["nylorun-protocol"]).toBe(String(PROTOCOL_VERSION));
      expect(request.headers["nylorun-tenant"]).toBeUndefined();
    }
  });

  it("refuses a link from an older nylorun and says to run nylorun start", async () => {
    const host = await runtime();
    const root = await project("nylo-installation-");
    roots.push(root);
    await writeProjectLink(root, { format: 2, stack: "demo", hostUrl: host.url, hostId: HOST_ID });
    const result = await nylo(["status"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is from an older nylorun");
    expect(result.stderr).toContain('Run "npx nylorun start"');
    expect(host.requests).toEqual([]);
  });

  it("without a link or variables it says to run nylorun start", async () => {
    const root = await project("nylo-installation-");
    roots.push(root);
    const result = await nylo(["status"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Run "npx nylorun start" in this project');
  });
});

describe("nylo tenant", () => {
  it("is a usage error that points at nylorun start and nylo status|reset", async () => {
    const root = await project("nylo-installation-");
    roots.push(root);
    for (const args of [["tenant"], ["tenant", "create"], ["tenant", "use", TENANT_ID], ["tenant", "list"]]) {
      const result = await nylo(args, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("an installation serves one Tenant");
      expect(result.stderr).toContain('"npx nylorun start"');
      expect(result.stderr).toContain("nylo status and nylo reset");
    }
  });

  it("is not in the usage", async () => {
    const root = await project("nylo-installation-");
    roots.push(root);
    const result = await nylo(["--help"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/\btenant (create|use|list|current|delete)\b/);
    expect(result.stdout).toMatch(/^nylo <status\|reset\|access\|configure\|env\|doctor>/);
  });
});
