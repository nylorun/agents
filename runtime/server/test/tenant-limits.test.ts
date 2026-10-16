/**
 * The Runtime limits B15 made Tenant settings (`GET`/`PUT /v1/tenant/limits`): their defaults
 * and ceilings, and a lowered limit taking effect in each area: a request body, an Agent's labels,
 * an agent manifest's runtime section and HTTP tool timeouts, and the MCP facts a session pins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RUNTIME_LIMIT_CEILINGS,
  RUNTIME_LIMIT_DEFAULTS,
  TIMER_MAX_MS,
  type RuntimeLimits,
} from "@nylorun/core/contracts";
import { Agent, http } from "@nylorun/core/define";
import type { McpSnapshot } from "@nylorun/core/harness-api";
import { fitSnapshot, type McpDiagnostic } from "../src/mcp/snapshot.js";
import { labelIssues, manifestShapeIssues } from "../src/tenant/limits.js";
import { boot, plain, server, type Started } from "./host/execution-support.js";
import { manifestOf, saveManifest, writeManifest } from "./support/agents.js";

let runtime: Started;
beforeAll(async () => {
  runtime = await boot({ sandbox: { backend: "virtual" } });
  // Agent manifest `bot`, which the Agents here are made from.
  await saveManifest(runtime.url, server, manifestOf(plain));
});
afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = server) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}
const management = () => runtime.managementHeaders();
const setLimits = (limits: Partial<RuntimeLimits>) => call("PUT", "/v1/tenant/limits", { limits }, management());

describe("the Tenant's limits", () => {
  it("answer every limit's default, and refuse one above its ceiling, naming the dependency", async () => {
    expect((await call("GET", "/v1/tenant/limits", undefined, management())).body).toEqual({
      limits: RUNTIME_LIMIT_DEFAULTS,
    });
    const refused = await setLimits({ a2aWaitMs: TIMER_MAX_MS + 1, environmentLabels: 4 });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain(`limits.a2aWaitMs asks for ${TIMER_MAX_MS + 1} milliseconds`);
    expect(refused.body.message).toContain("JavaScript timer");
    const tooMany = await setLimits({ environmentLabels: RUNTIME_LIMIT_CEILINGS.environmentLabels.value + 1 });
    expect(tooMany.body.message).toContain("one request body");
    expect((await setLimits({})).status).toBe(200);
  });

  it("hold a request body to requestBodyBytes", async () => {
    expect((await setLimits({ requestBodyBytes: 512 })).status).toBe(200);
    try {
      const labels = { a: "x".repeat(250), b: "y".repeat(250), c: "z".repeat(250) };
      const big = await call("PUT", "/v1/agents/big", { requestId: "big", manifest: "bot", labels });
      expect(big.status).toBe(413);
      expect((await call("PUT", "/v1/agents/small", { requestId: "small", manifest: "bot" })).status).toBe(200);
    } finally {
      expect((await setLimits({})).status).toBe(200);
    }
  });

  it("hold an Agent's labels to environmentLabels whenever they are set", async () => {
    expect((await call("PUT", "/v1/agents/labelled", { requestId: "l1", manifest: "bot", labels: { a: "1", b: "2" } })).status).toBe(200);
    expect((await setLimits({ environmentLabels: 1 })).status).toBe(200);
    try {
      const more = await call("PUT", "/v1/agents/labelled", { requestId: "l2", manifest: "bot", labels: { a: "1", b: "2", c: "3" } });
      expect(more.status).toBe(400);
      expect(more.body.message).toContain("environmentLabels allows at most 1");
      // The ones it has stay; one that fits is set.
      expect((await call("PUT", "/v1/agents/labelled", { requestId: "l3", manifest: "bot", labels: { a: "1" } })).status).toBe(200);
    } finally {
      await setLimits({});
    }
  });

  it("hold a saved manifest's setup to environmentSetupCommands and setupCommandMs", async () => {
    expect((await setLimits({ environmentSetupCommands: 1, setupCommandMs: 60_000 })).status).toBe(200);
    try {
      const saved = await writeManifest(
        runtime.url,
        server,
        manifestOf(plain, {
          name: "builder",
          runtime: { kind: "pod", setup: [{ command: "make" }, { command: "make test", timeout: "5m" }] },
        }),
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(400);
      expect(JSON.stringify(saved.body)).toContain("environmentSetupCommands allows at most 1");
      expect(JSON.stringify(saved.body)).toContain("setupCommandMs allows at most 60000");
    } finally {
      await setLimits({});
    }
  });

  it("hold an HTTP tool's timeoutMs to httpToolTimeoutMs when the agent manifest is saved", async () => {
    const agent = Agent({ id: "slow", name: "Slow" })
      .tools(http({ name: "report", input: z.object({}), url: "https://reports.example.com/run", timeoutMs: 120_000 }))
      .build();
    const deploy = () => writeManifest(runtime.url, server, manifestOf(agent));
    expect((await deploy()).status).toBe(200);
    expect((await setLimits({ httpToolTimeoutMs: 60_000 })).status).toBe(200);
    try {
      const refused = await deploy();
      expect(refused.status).toBe(400);
      expect(String(refused.body.message)).toContain("HTTP tool 'report' of agent 'slow' asks for timeoutMs 120000");
    } finally {
      await setLimits({});
    }
  });
});

describe("the shape a manifest must fit", () => {
  it("counts setup commands, input files, the files of an entry, secret slots and labels", () => {
    const limits = { ...RUNTIME_LIMIT_DEFAULTS, environmentFiles: 1, environmentFilesPerEntry: 2, environmentSecretSlots: 1, environmentLabels: 2 };
    const hash = `sha256:${"0".repeat(64)}`;
    expect(
      manifestShapeIssues(
        {
          files: [
            { path: "/workspace/a", files: { a: hash, b: hash, c: hash } },
            { path: "/workspace/b", files: { a: hash } },
          ],
          secrets: { A: { type: "environment_variable" }, B: { type: "environment_variable" } },
        },
        limits,
      ),
    ).toEqual([
      expect.stringContaining("files has 2; the Runtime limit environmentFiles"),
      expect.stringContaining("secrets has 2; the Runtime limit environmentSecretSlots"),
      expect.stringContaining("files[0].files has 3; the Runtime limit environmentFilesPerEntry"),
    ]);
    expect(manifestShapeIssues({}, limits)).toEqual([]);
    expect(labelIssues({ a: "1", b: "2" }, limits)).toEqual([]);
    expect(labelIssues({ a: "1", b: "2", c: "3" }, limits)).toHaveLength(1);
  });
});

describe("the MCP facts a session pins", () => {
  const tool = (name: string, padding: number) => ({
    name,
    description: "d".repeat(padding),
    inputSchema: { type: "object" },
  });
  const snapshot: McpSnapshot = {
    snapshotSchemaVersion: 2,
    manifestHash: "h",
    servers: [
      { name: "small", tools: [tool("a", 10)] },
      { name: "huge", instructions: "i".repeat(4096), tools: [tool("b", 8192)] },
      { agentId: "helper", name: "other", tools: [tool("c", 10)] },
    ],
  };
  const diagnostics: McpDiagnostic[] = [
    { serverName: "small", outcome: "connected", message: "ok" },
    { serverName: "huge", outcome: "connected", message: "ok" },
  ];

  it("keep every server while they fit mcpSnapshotBytes", () => {
    expect(fitSnapshot(snapshot, diagnostics, RUNTIME_LIMIT_DEFAULTS.mcpSnapshotBytes)).toEqual({
      snapshot,
      diagnostics,
    });
  });

  it("leave out a server past it, in order, saying so in its diagnostic", () => {
    const fitted = fitSnapshot(snapshot, diagnostics, 2048);
    expect(fitted.snapshot.servers.map((item) => item.name)).toEqual(["small", "other"]);
    expect(Buffer.byteLength(JSON.stringify(fitted.snapshot))).toBeLessThanOrEqual(2048);
    expect(fitted.diagnostics[0]).toEqual(diagnostics[0]);
    expect(fitted.diagnostics[1]).toMatchObject({
      serverName: "huge",
      outcome: "failed",
      message: expect.stringContaining("mcpSnapshotBytes (2048 bytes"),
    });
    // A server with no diagnostic of its own gets one.
    const tiny = fitSnapshot(snapshot, [], 200);
    expect(tiny.snapshot.servers.map((item) => item.name)).toEqual(["small"]);
    expect(tiny.diagnostics.map((item) => [item.agentId, item.serverName])).toEqual([
      [undefined, "huge"],
      ["helper", "other"],
    ]);
  });
});
