import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { mcpCommand } from "../../src/stack/mcp.js";
import { stackPaths } from "../../src/stack/paths.js";
import {
  bearerIn,
  fakeDocker,
  fakeFetch,
  fakeOperate,
  json,
  readyResponse,
  temporaryHome,
  testDeps,
  type FakeKeys,
} from "./support.js";

const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;

const psUp = {
  code: 0,
  stdout: JSON.stringify([
    { Service: "gateway", State: "running", Health: "healthy" },
    { Service: "runtime", State: "running", Health: "healthy" },
    { Service: "harness", State: "running", Health: "healthy" },
    { Service: "studio", State: "running", Health: "healthy" },
  ]),
  stderr: "",
};

const LINEAR = "https://mcp.linear.app/mcp";
const PREVIEW = {
  name: "linear",
  url: LINEAR,
  type: "streamable-http",
  credentialSent: true,
  serverInfo: { name: "linear-mcp", version: "2.0.0" },
  tools: [
    {
      serverToolName: "search",
      modelName: "linear__search",
      description: "Searches issues.",
      annotations: { readOnlyHint: true },
      schemaBytes: 120,
    },
    {
      serverToolName: "issues.create",
      modelName: "linear__issues_create",
      description: "Creates an issue.",
      schemaBytes: 184,
    },
  ],
  renamed: [{ serverToolName: "issues.create", name: "linear__issues_create" }],
};

/** A running Tenant whose Runtime answers the preview route as `answer` says. */
async function running(answer: (body: Record<string, unknown>) => Response) {
  const home = await temporaryHome();
  const keys: FakeKeys = new Map();
  const operate = fakeOperate(() => keys);
  const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : operate(args)) });
  const fetch = fakeFetch((url, init) => {
    if (url.endsWith("/health"))
      return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/ready")) return readyResponse();
    if (url.endsWith("/_studio/login-tokens")) return json({ token: "t" }, 201);
    const path = new URL(url).pathname;
    if (path === "/v1/me")
      return bearerIn(keys.values(), init)
        ? json({ kind: "application" })
        : json({ status: "rejected", code: "not_found", message: "Not found" }, 404);
    if (path === "/v1/tenant/mcp/preview" && init?.method === "POST")
      return answer(JSON.parse(String(init.body)) as Record<string, unknown>);
    return undefined;
  });
  const deps = testDeps(home, { docker, fetch });
  await runStackCommand("start", ["--no-open"], deps);
  deps.lines.length = 0;
  deps.errors.length = 0;
  return { deps, fetch, keys };
}

describe("nylorun mcp inspect", () => {
  it("previews a server with the management key and prints its tools and renames", async () => {
    const { deps, fetch, keys } = await running(() => json(PREVIEW));
    expect(await mcpCommand(deps, ["inspect", LINEAR, "--vault", "v1"])).toBe(0);
    const request = fetch.requests.find((item) => item.url.endsWith("/v1/tenant/mcp/preview"))!;
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${keys.get("cli-management")!.key}`);
    expect(headers.get("nylorun-protocol")).toBe(String(PROTOCOL_VERSION));
    expect(JSON.parse(String(request.init?.body))).toEqual({ url: LINEAR, vaultId: "v1" });
    expect(deps.lines).toEqual([
      `MCP server linear-mcp 2.0.0 at ${LINEAR}, with the installation vault's credential: 2 tools, named for the model as linear__<tool>.`,
      "",
      "TOOL           MODEL NAME             SCHEMA  HINTS      DESCRIPTION",
      "search         linear__search         120 B   read-only  Searches issues.",
      "issues.create  linear__issues_create  184 B   -          Creates an issue.",
      "",
      "Renamed for the model (characters outside A-Z, a-z, 0-9, _ and -, or past 64):",
      "  issues.create -> linear__issues_create",
    ]);
  });

  it("sends --server and --sse, and prints the preview with --json", async () => {
    const { deps, fetch } = await running(() => json(PREVIEW));
    expect(await mcpCommand(deps, ["inspect", LINEAR, "--server", "linear", "--sse", "--json"])).toBe(0);
    const request = fetch.requests.find((item) => item.url.endsWith("/v1/tenant/mcp/preview"))!;
    expect(JSON.parse(String(request.init?.body))).toEqual({ url: LINEAR, type: "sse", name: "linear" });
    expect(JSON.parse(deps.lines.join("\n"))).toEqual(PREVIEW);
  });

  it("says a server needs a person's sign-in, and names its authorization server", async () => {
    const { deps } = await running(() =>
      json({
        name: "linear",
        url: LINEAR,
        type: "streamable-http",
        credentialSent: false,
        tools: [],
        renamed: [],
        authRequired: {
          resourceMetadataUrl: "https://mcp.linear.app/.well-known/oauth-protected-resource",
          resourceMetadata: { authorization_servers: ["https://mcp.linear.app"] },
        },
      }),
    );
    expect(await mcpCommand(deps, ["inspect", LINEAR])).toBe(0);
    expect(deps.lines[0]).toBe(`The MCP server at ${LINEAR} answered 401: it needs a credential.`);
    expect(deps.lines[1]).toBe(
      "It signs people in with https://mcp.linear.app (https://mcp.linear.app/.well-known/oauth-protected-resource).",
    );
    expect(deps.lines.join("\n")).toMatch(/gateway/);
  });

  it("fails with the Runtime's message and the failure code", async () => {
    const { deps } = await running(() =>
      json(
        {
          status: "rejected",
          code: "mcp_preview_failed",
          message: "The MCP server 'linear' was not called: This Runtime does not call private addresses",
          details: { failure: "mcp.unreachable" },
        },
        502,
      ),
    );
    await expect(mcpCommand(deps, ["inspect", LINEAR])).rejects.toMatchObject({
      exitCode: 1,
      message: "The MCP server 'linear' was not called: This Runtime does not call private addresses (mcp.unreachable)",
    });
  });

  it("says connect was removed, and checks its arguments", async () => {
    const { deps } = await running(() => json(PREVIEW));
    await expect(mcpCommand(deps, ["connect", LINEAR])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/removed with MCP OAuth \(protocol 10\).*nylorun mcp inspect/),
    });
    await expect(mcpCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(mcpCommand(deps, ["inspect"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(mcpCommand(deps, ["inspect", LINEAR, "--bogus"])).rejects.toMatchObject({ exitCode: 2 });
  });
});
