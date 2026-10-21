import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { APPLICATION_KEY, HOST_ID, MANAGEMENT_KEY, project } from "./helpers/project.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
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

/** A Runtime that answers the Management API routes `nylorun tenant` calls. */
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
    if (url === "/v1/tenant/keys" && request.method === "GET")
      return void response.end(
        JSON.stringify({ keys: [{ id: "app-server", role: "application", createdAt: "2026-10-14T00:00:00.000Z" }] }),
      );
    if (url === "/v1/tenant/keys/app-server" && request.method === "PUT")
      return void response.end(
        JSON.stringify({ id: "app-server", key: "ef".repeat(32), role: "application", rotated: false, createdAt: "2026-10-14T00:00:00.000Z" }),
      );
    if (url === "/v1/tenant/keys/app-server" && request.method === "DELETE")
      return void response.end(JSON.stringify({ id: "app-server", deleted: true }));
    if (url === "/v1/tenant/model" && request.method === "PUT") {
      const put = requests.at(-1)!.body;
      return void response.end(
        JSON.stringify({ configured: true, provider: put.provider, model: put.model, authType: "api_key" }),
      );
    }
    if (url === "/v1/tenant/budgets" && request.method === "PUT")
      return void response.end(JSON.stringify({ budgets: requests.at(-1)!.body.budgets }));
    if (url.startsWith("/v1/tenant/calls/model?") && request.method === "GET") {
      const after = new URLSearchParams(url.split("?")[1]).get("after");
      const call = (id: string) => ({
        id,
        effectId: `ef_${id}`,
        sessionId: "ses_1",
        turnId: "turn_1",
        manifestName: "support",
        provider: "openai",
        model: "gpt-test",
        at: "2026-10-14T00:00:00.000Z",
        startedAt: null,
        endedAt: null,
        outcome: "completed",
        usage: null,
      });
      const page = after === null
        ? { calls: [call("c1"), call("c2")], next: "cur_2", caughtUp: false }
        : { calls: [call("c3")], next: "cur_3", caughtUp: true };
      return void response.end(JSON.stringify({ ...page, asOf: "2026-10-14T00:00:00.000Z" }));
    }
    if (url === "/v1/tenant/signing-keys" && request.method === "GET")
      return void response.end(JSON.stringify({ keys: [{ kid: "k1", state: "current" }] }));
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

/** A directory with no Project link. */
async function directory(): Promise<string> {
  const root = await project("nylorun-tenant-");
  roots.push(root);
  return root;
}

/**
 * Run the built `nylorun` on the remote installation at `url` (with a management key unless `env`
 * says otherwise), with `input` piped to its stdin when given.
 */
function nylorun(args: string[], url: string, env: Record<string, string> = {}, input?: string) {
  return directory().then((cwd) => run(args, cwd, {
    NYLORUN_RUNTIME_URL: url,
    NYLORUN_MANAGEMENT_KEY: MANAGEMENT_KEY,
    ...env,
  }, input));
}

/** Run the built `nylorun` with no inherited connection variables. */
function run(args: string[], cwd: string, env: Record<string, string> = {}, input?: string) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
  if (input !== undefined) child.stdin!.end(input);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => (stdout += data));
  child.stderr!.on("data", (data) => (stderr += data));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("nylorun status and tenant on a remote installation", { timeout: 20_000 }, () => {
  it("status shows the Tenant through the Management API", async () => {
    const host = await runtime();
    const text = await nylorun(["status"], host.url);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`demo  ${TENANT_ID}`);
    expect(text.stdout).toContain(`runtime  ${host.url}`);
    expect(text.stdout).toContain("counts   sessions=3 running=1 uncertain=0");
    const json = await nylorun(["status", "--json"], host.url);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ tenant: { id: TENANT_ID } });
  });

  it("status of a Tenant that is not open says so (exit 1)", async () => {
    const host = await runtime({ tenantOpen: false });
    const result = await nylorun(["status"], host.url);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`GET /v1/tenant failed (503). The installation at ${host.url} did not answer.`);
    expect(host.requests.map((r) => r.url)).toEqual(["/v1/tenant"]);
  });

  it("tenant reset drains and resets the Tenant; --all asks first", async () => {
    const host = await runtime();
    const result = await nylorun(["tenant", "reset"], host.url);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Reset ${host.url} (sessions).`);
    const reset = host.requests.find((r) => r.url === "/v1/tenant/reset");
    expect(reset?.body).toMatchObject({ scope: "sessions", activeWork: "drain" });
    // Not a terminal: --all needs --yes.
    const all = await nylorun(["tenant", "reset", "--all"], host.url);
    expect(all.code).toBe(2);
    expect(all.stderr).toContain("pass --yes");
    expect((await nylorun(["tenant", "reset", "--all", "--yes"], host.url)).code).toBe(0);
    expect((await nylorun(["tenant", "reset", "--agents"], host.url)).code).toBe(0);
    expect(host.requests.filter((r) => r.url === "/v1/tenant/reset").map((r) => r.body.scope)).toEqual([
      "sessions",
      "all",
      "agents",
    ]);
    const environments = await nylorun(["tenant", "reset", "--environments"], host.url);
    expect(environments.code).toBe(2);
    expect(environments.stderr).toContain("--environments is --agents in protocol 16");
    for (const args of [["tenant", "reset", "--all", "--sessions"], ["tenant", "reset", "--everything"]])
      expect((await nylorun(args, host.url)).code).toBe(2);
  });

  it("tenant keys put, list and rm application keys through the Management API", async () => {
    const host = await runtime();
    const put = await nylorun(["tenant", "keys", "put", "app-server"], host.url);
    expect(put.code).toBe(0);
    expect(put.stdout).toBe(`${"ef".repeat(32)}\n`);
    expect(put.stderr).toContain(`Created application key app-server on ${host.url}`);
    const list = await nylorun(["tenant", "keys", "list", "--json"], host.url);
    expect(JSON.parse(list.stdout)).toEqual([
      { id: "app-server", role: "application", createdAt: "2026-10-14T00:00:00.000Z" },
    ]);
    expect((await nylorun(["tenant", "keys", "rm", "app-server"], host.url)).stdout).toContain(
      "Deleted key app-server",
    );
    // Management keys are issued only on the Runtime's machine.
    const management = await nylorun(["tenant", "keys", "put", "ops", "--management"], host.url);
    expect(management.code).toBe(2);
    expect(management.stderr).toContain("Management keys are issued only on the Runtime's machine");
  });

  it("tenant signing-keys list prints the keys as JSON", async () => {
    const host = await runtime();
    const result = await nylorun(["tenant", "signing-keys", "list"], host.url);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ kid: "k1", state: "current" }]);
  });

  it("tenant models set --provider --model reads the API key from stdin, never from the arguments", async () => {
    const host = await runtime();
    const key = "sk-test-0123456789";
    const result = await nylorun(
      ["tenant", "models", "set", "--provider", "openai", "--model", "gpt-test"],
      host.url,
      {},
      `${key}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("openai  gpt-test  api_key\n");
    const put = host.requests.find((r) => r.url === "/v1/tenant/model");
    expect(put?.method).toBe("PUT");
    expect(put?.headers.authorization).toBe(`Bearer ${MANAGEMENT_KEY}`);
    expect(put?.body).toMatchObject({ provider: "openai", model: "gpt-test", auth: { type: "api_key", key } });
    // No stdin: a usage error, and nothing is sent.
    const none = await runtime();
    const refused = await nylorun(["tenant", "models", "set", "--provider", "openai", "--model", "gpt-test"], none.url);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("held no API key");
    expect(none.requests).toEqual([]);
  });

  it("tenant models set --host-identity sends the project and location and no key (ADR-71)", async () => {
    const host = await runtime();
    const result = await nylorun(
      [
        "tenant", "models", "set", "--provider", "google-vertex", "--model", "gemini-4-argon",
        "--host-identity", "--project", "nylorun-bot-beta", "--location", "global",
      ],
      host.url,
    );
    expect(result.code).toBe(0);
    const put = host.requests.find((r) => r.url === "/v1/tenant/model");
    expect(put?.body).toMatchObject({
      provider: "google-vertex",
      model: "gemini-4-argon",
      auth: { type: "host_identity", project: "nylorun-bot-beta", location: "global" },
    });
    // Without the project, or with a base URL: a usage error, and nothing is sent.
    const none = await runtime();
    for (const args of [
      ["--provider", "google-vertex", "--model", "gemini-4-argon", "--host-identity", "--location", "global"],
      ["--provider", "google-vertex", "--model", "m", "--project", "p", "--location", "global"],
      ["--provider", "google-vertex", "--model", "m", "--host-identity", "--project", "p", "--location", "l", "--base-url", "https://x"],
    ]) {
      const refused = await nylorun(["tenant", "models", "set", ...args], none.url);
      expect(refused.code).toBe(2);
    }
    expect(none.requests).toEqual([]);
  });

  it("tenant budgets put - reads the body from stdin", async () => {
    const host = await runtime();
    const budgets = [{ scope: "tenant", period: "month", limitUsd: 50 }];
    const result = await nylorun(["tenant", "budgets", "put", "-"], host.url, {}, JSON.stringify({ budgets }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ budgets });
    expect(host.requests.map((r) => [r.method, r.url, r.body.budgets])).toEqual([["PUT", "/v1/tenant/budgets", budgets]]);
    const invalid = await nylorun(["tenant", "budgets", "put", "-"], host.url, {}, "{");
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Standard input is not JSON");
    expect(host.requests).toHaveLength(1);
  });

  it("tenant calls prints NDJSON across pages until caught up", async () => {
    const host = await runtime();
    const result = await nylorun(["tenant", "calls"], host.url);
    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line).id)).toEqual(["c1", "c2", "c3"]);
    expect(result.stderr).toContain("Resume with --after cur_3");
    expect(host.requests.map((r) => r.url)).toEqual([
      "/v1/tenant/calls/model?limit=200",
      "/v1/tenant/calls/model?limit=200&after=cur_2",
    ]);
  });

  it("requests carry the management key and the protocol, and never a Nylorun-Tenant header", async () => {
    const host = await runtime();
    for (const args of [["status"], ["tenant", "reset", "--yes"]])
      expect((await nylorun(args, host.url)).code).toBe(0);
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

  it("NYLORUN_RUNTIME_URL with only an application key is an app's: the Management API looks for a local Tenant", async () => {
    const host = await runtime();
    const result = await nylorun(["tenant", "reset"], host.url, {
      NYLORUN_MANAGEMENT_KEY: "",
      NYLORUN_SERVER_KEY: APPLICATION_KEY,
      HOME: await directory(),
      PATH: "",
    });
    expect(result.code).not.toBe(0);
    expect(host.requests).toEqual([]);
  });
});
