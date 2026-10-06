import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, model, type CapabilityItems, type ToolDefinition } from "@nylorun/core/define";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_MODE_RULE,
  CODE_MODE_USAGE,
  codeMode,
} from "../agents/code-mode/capability.js";
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

function catalogTool(
  name: string,
  declaration: Awaited<ReturnType<typeof codeMode>>
): ToolDefinition {
  const found = items(declaration.tools).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("codeMode()", () => {
  it("offers only run_code and a generated SDK for the tools catalog", async () => {
    const declaration = await codeMode();
    expect(items(declaration.tools).map((tool) => tool.name)).toEqual([
      "run_code",
    ]);
    expect(items(declaration.instructions)).toEqual([
      CODE_MODE_RULE,
      CODE_MODE_USAGE,
      expect.stringContaining("declare const tools:"),
    ]);
    const sdk = items(declaration.instructions)[2] ?? "";
    expect(sdk).toContain("calculate: (args:");
    expect(sdk).toContain("convert: (args:");
    expect(sdk).toContain("now: (args:");
    expect(sdk).toContain('from: "celsius"');
  });

  it("runs a program that composes calculate then convert", async () => {
    const declaration = await codeMode();
    await expect(
      invokeTool(catalogTool("run_code", declaration), {
        code: [
          'const calculated = await tools.calculate({ expression: "100 / 4" });',
          'const converted = await tools.convert({ value: calculated.value, from: "celsius", to: "fahrenheit" });',
          "return { value: calculated.value, result: converted.result };",
        ].join("\n"),
        description: "Convert 100/4 celsius to fahrenheit.",
      })
    ).resolves.toEqual({
      kind: "completed",
      output: {
        logs: [],
        result: { value: 25, result: 77 },
        calls: [
          {
            name: "calculate",
            args: { expression: "100 / 4" },
            output: { expression: "100 / 4", value: 25 },
          },
          {
            name: "convert",
            args: { value: 25, from: "celsius", to: "fahrenheit" },
            output: {
              value: 25,
              from: "celsius",
              to: "fahrenheit",
              result: 77,
            },
          },
        ],
      },
    });
  });

  it("rejects a failed binding as ToolCallError that the program can catch", async () => {
    const declaration = await codeMode();
    await expect(
      invokeTool(catalogTool("run_code", declaration), {
        code: [
          "try {",
          '  await tools.convert({ value: 1, from: "celsius", to: "meter" });',
          "  return { caught: false };",
          "} catch (error) {",
          "  return {",
          "    caught: error instanceof ToolCallError,",
          "    toolName: error.toolName,",
          "    message: error.message,",
          "  };",
          "}",
        ].join("\n"),
        description: "Catch an incompatible convert.",
      })
    ).resolves.toEqual({
      kind: "completed",
      output: {
        logs: [],
        result: {
          caught: true,
          toolName: "convert",
          message: "Cannot convert celsius to meter.",
        },
        calls: [
          {
            name: "convert",
            args: { value: 1, from: "celsius", to: "meter" },
            error: "Cannot convert celsius to meter.",
          },
        ],
      },
    });
  });

  it("rejects an unknown tools binding", async () => {
    const declaration = await codeMode();
    await expect(
      invokeTool(catalogTool("run_code", declaration), {
        code: "await tools.missing({});",
        description: "Call a tool that is not in the SDK.",
      })
    ).resolves.toEqual({
      kind: "failed",
      code: "code_run_failed",
      message: "missing: Unknown tool 'missing'.",
    });
  });

  it("omits the transport when the directory has no catalog modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-mode-test-"));
    temps.push(root);
    await expect(codeMode({ directory: root })).resolves.toEqual({
      id: "code-mode",
    });
  });

  it("builds the code-mode agent with only run_code on the model surface", async () => {
    const agent = Agent({
      id: "code-mode",
      name: "Code Mode",
    })
      .instructions("Be concise.")
      .capability(await codeMode())
      .build();
    expect(agent.manifest.capabilities.map((item) => item.id)).toEqual([
      "agent",
      "code-mode",
    ]);
    const offered = agent.manifest.capabilities.find(
      (item) => item.id === "code-mode"
    );
    expect(offered?.tools?.map((tool) => tool.name)).toEqual(["run_code"]);
    expect(offered?.tools?.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["calculate", "convert", "now"])
    );
    expect(offered?.instructions?.join("\n")).toContain("calculate: (args:");
  });
});
