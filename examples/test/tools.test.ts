import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, model, type CapabilityItems, type ToolDefinition } from "@nylorun/core/define";
import { afterEach, describe, expect, it } from "vitest";
import { catalog, tools } from "../agents/shared/tools/index.js";
import { toolsService } from "../agents/shared/tools/service.js";
import { lookupOrderCode } from "../agents/shared/orders.js";
import { invokeTool } from "./support.js";

const adapter = model(async () => ({
  output: [{ type: "text" as const, text: "ok" }],
  finishReason: "stop" as const,
}));

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function items<T>(value: CapabilityItems<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return "items" in value ? value.items : value;
}

async function catalogTool(name: string): Promise<ToolDefinition> {
  const found = (await catalog()).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("tools()", () => {
  it("loads calculate from the tools catalog", async () => {
    await expect(
      invokeTool(await catalogTool("calculate"), {
        expression: "19 * 7",
      })
    ).resolves.toEqual({
      kind: "completed",
      output: { expression: "19 * 7", value: 133 },
    });
  });

  it("converts compatible units and rejects incompatible ones", async () => {
    const convert = await catalogTool("convert");
    await expect(
      invokeTool(convert, { value: 25, from: "celsius", to: "fahrenheit" })
    ).resolves.toEqual({
      kind: "completed",
      output: { value: 25, from: "celsius", to: "fahrenheit", result: 77 },
    });
    await expect(
      invokeTool(convert, { value: 1, from: "celsius", to: "meter" })
    ).resolves.toEqual({
      kind: "failed",
      code: "convert.incompatible",
      message: "Cannot convert celsius to meter.",
    });
  });

  it("returns UTC iso and unixMs from now", async () => {
    const result = await invokeTool(await catalogTool("now"), {});
    expect(result).toMatchObject({
      kind: "completed",
      output: {
        iso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        unixMs: expect.any(Number),
      },
    });
  });

  it("omits tools when the directory has no catalog modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "tools-test-"));
    temps.push(root);
    await expect(tools({ directory: root })).resolves.toEqual({ id: "tools" });
  });

  it("serves the catalog and lookup_order to the Runtime as JSON over POST", async () => {
    const service = toolsService([lookupOrderCode, ...(await catalog())]);
    const call = (name: string, input: unknown) =>
      service(
        new Request(`http://localhost/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      );
    const calculated = await call("calculate", { expression: "19 * 7" });
    expect(calculated.status).toBe(200);
    await expect(calculated.json()).resolves.toEqual({ expression: "19 * 7", value: 133 });
    await expect((await call("lookup_order", { orderId: "demo-123" })).json()).resolves.toEqual({
      orderId: "demo-123",
      status: "shipped",
    });
    const refused = await call("convert", { value: 1, from: "celsius", to: "meter" });
    expect(refused.status).toBe(422);
    await expect(refused.text()).resolves.toBe("Cannot convert celsius to meter.");
    expect((await call("missing", {})).status).toBe(404);
  });

  it("builds the tool-use agent with one tools capability", async () => {
    const agent = Agent({
      id: "tool-use",
      name: "Tool Use",
    })
      .instructions("Be concise.")
      .capability(await tools())
      .build();
    expect(agent.manifest.capabilities.map((item) => item.id)).toEqual([
      "agent",
      "tools",
    ]);
    const offered =
      agent.manifest.capabilities.find((item) => item.id === "tools")?.tools ??
      [];
    expect(offered.map((tool) => tool.name).sort()).toEqual([
      "calculate",
      "convert",
      "now",
    ]);
    // HTTP tools: the Runtime calls the tools service; no code of the examples runs in it.
    expect(offered.map((tool) => (tool as { http?: { url: string } }).http?.url).sort()).toEqual([
      "http://localhost:3001/calculate",
      "http://localhost:3001/convert",
      "http://localhost:3001/now",
    ]);
  });
});
