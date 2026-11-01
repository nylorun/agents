/**
 * Off means off (ADR-100): what this harness does for an agent that declares its engine features
 * (`engine`, `agent-folder/2`) and leaves one out, beside what it does for one that declares
 * nothing (`agent-folder/1`).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentManifest } from "@nylorun/core/define";
import {
  HARNESS_API_VERSION,
  RUNTIME_LIMIT_DEFAULTS,
  memoryChannels,
  type McpFacts,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { createHarness, type Harness, type HarnessExecutors } from "../../src/api/index.js";
import { createDurableCheckpoint } from "../../src/run/index.js";
import { DEFAULT_TOOL_RESULT_CONFIG, shapeToolOutcome } from "../../src/tools/results.js";
import { mediaReferenceLine } from "../../src/loop/model/files.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

const agent = (engine?: AgentManifest["engine"]): AgentManifest => ({
  manifestSchemaVersion: 7,
  id: "helper",
  instructions: ["Help."],
  ...(engine === undefined ? {} : { engine }),
});

function turnStart(manifest: AgentManifest, fields: Partial<TurnStart> = {}): TurnStart {
  return {
    type: "turn.start",
    engine: "agent",
    manifest,
    checkpoint: createDurableCheckpoint({ manifest, sessionId: "s1", turnId: "t1", input: "go" }),
    outcomes: [],
    transcript: { cursor: -1 },
    options: { fixtureModel: false },
    routing: { rootManifest: manifest },
    limits: RUNTIME_LIMIT_DEFAULTS,
    agent: { id: "ag_1", kind: "virtual", sandbox: { workspace: "/workspace" } },
    ...fields,
  } as TurnStart;
}

/** Runs one turn of `start` on a fake core: the requests it made, and the model's first call. */
async function run(start: TurnStart, extra: Partial<HarnessExecutors> = {}) {
  const channels = memoryChannels({ json: true });
  const calls: [string, any][] = [];
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  let offered = false;
  channels.core.handle(async (method, params: any) => {
    calls.push([method, params]);
    switch (method) {
      case "hello":
        return {
          api: HARNESS_API_VERSION,
          tenantId: "tn",
          sandbox: { backend: null },
          renewEveryMs: 1000,
        };
      case "lease":
        if (offered) return new Promise(() => undefined);
        offered = true;
        return { run: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1 }, input: start };
      case "effect.intent":
        return { status: "execute" };
      case "effect.outcome":
        return { status: "completed", outcome: { value: params.value } };
      case "lease.renew":
        return { ok: true };
      case "event":
      case "lease.release":
        return {};
      default:
        settled();
        return { cursor: 1 };
    }
  });
  let first: any;
  const listed: string[] = [];
  const executors: HarnessExecutors = {
    async model(effect) {
      first ??= effect.input;
      return { output: [{ type: "text", text: "done" }] };
    },
    tool: async () => "tool",
    recovers: { model: false, tool: () => false },
    files: {
      read: async (_run, path) => ({ kind: "missing", path }),
      write: async () => ({ kind: "failed", code: "x", message: "x" }),
      list: async (_run, dir) => {
        listed.push(dir);
        return { kind: "missing" };
      },
    } as unknown as HarnessExecutors["files"],
    ...extra,
  };
  const harness = createHarness({ channel: channels.harness, executors });
  harnesses.push(harness);
  await harness.start();
  await done;
  return { calls, first, listed };
}

describe("an agent that declares its engine features", () => {
  it("saves the outputs folder only with engine.outputs", async () => {
    expect((await run(turnStart(agent()))).listed).toEqual(["/workspace/outputs"]);
    expect((await run(turnStart(agent({ outputs: true })))).listed).toEqual(["/workspace/outputs"]);
    expect((await run(turnStart(agent({ sandbox: ["bash"] })))).listed).toEqual([]);
  });

  it("pins no memory index when turn.start.memory has none", async () => {
    const memory = { access: "read_write" as const, truncated: false };
    const pinned = (call: any) => call.prompt.filter((item: any) => item.kind === "context");
    expect(
      pinned((await run(turnStart(agent({}), { memory: { ...memory, index: "" } }))).first),
    ).toHaveLength(1);
    const off = (await run(turnStart(agent({}), { memory }))).first;
    expect(pinned(off)).toEqual([]);
    expect(off.prompt[0].content[0].text).not.toContain("index of the memory files");
  });

  it("claims engine.diagnostic, once, for MCP tools past the threshold it does not defer", async () => {
    const big = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `p${i}`,
          { type: "string", description: "x".repeat(200) },
        ]),
      ),
    };
    const mcp = {
      servers: [
        {
          name: "gh",
          tools: Array.from({ length: 10 }, (_, i) => ({
            name: `t${i}`,
            inputSchema: big,
            enabled: true,
          })),
        },
      ],
    } as unknown as McpFacts;
    const declared = await run(turnStart(agent({}), { mcp }));
    const claims = declared.calls.filter(
      ([method, params]) => method === "event" && params.type === "engine.diagnostic",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]![1].payload).toMatchObject({ code: "mcp_tools_inline" });
    expect(declared.first.tools.map((tool: any) => tool.name)).toContain("gh__t0");
    const v1 = await run(turnStart(agent(), { mcp }));
    expect(
      v1.calls.some(
        ([method, params]) => method === "event" && params.type === "engine.diagnostic",
      ),
    ).toBe(false);
    expect(v1.first.tools.map((tool: any) => tool.name)).toContain("tool_search");
  });

  it("cuts a large result to its preview, not retrievable, without read_artifact", async () => {
    const effect = {
      effectId: "e1",
      kind: "tool",
      toolName: "find",
      target: { kind: "http", tool: "find" },
    } as never;
    const store = async (bytes: Uint8Array) => ({
      artifactId: "af_1",
      version: 1,
      contentType: "text/plain",
      size: bytes.byteLength,
    });
    const value = { kind: "completed", output: "x".repeat(100_000) };
    const context = {
      effect,
      limit: 4096,
      limits: { modelFileBytes: 1 },
      config: DEFAULT_TOOL_RESULT_CONFIG,
      store,
    };
    const kept = (await shapeToolOutcome(value, context)) as any;
    expect(kept.output).toMatchObject({ truncated: true, artifactId: "af_1" });
    expect(kept.output).not.toHaveProperty("retrievable");
    const cut = (await shapeToolOutcome(value, { ...context, retrievable: false })) as any;
    expect(cut.output).toMatchObject({ truncated: true, retrievable: false, artifactId: "af_1" });
    expect(JSON.stringify(cut.output).length).toBeLessThanOrEqual(4096);
  });

  it("names an earlier file without offering read_artifact", () => {
    const part = {
      mediaType: "image/png",
      reference: { artifactId: "af_1", version: 2, name: "a.png", size: 1 },
    };
    expect(mediaReferenceLine(part, "uploaded")).toBe(
      '[Uploaded artifact "a.png" · af_1 v2 · read_artifact to view]',
    );
    expect(mediaReferenceLine(part, "uploaded", false)).toBe(
      '[Uploaded artifact "a.png" · af_1 v2]',
    );
  });

  it("offers read_artifact in no reference line of a turn's prompt when it does not declare it", async () => {
    const files = { read: true };
    const input = {
      content: [
        { type: "text", text: "look" },
        {
          type: "media",
          mediaType: "image/png",
          reference: { artifactId: "af_p", version: 1, name: "a.png", size: 9 },
        },
      ],
    };
    const start = (engine?: AgentManifest["engine"]) => {
      const manifest = agent(engine);
      return turnStart(manifest, {
        checkpoint: createDurableCheckpoint({
          manifest,
          sessionId: "s1",
          turnId: "t1",
          input: input as never,
        }),
      });
    };
    const text = (call: any) => JSON.stringify(call.prompt);
    expect(text((await run(start())).first)).toContain("read_artifact to view");
    expect(text((await run(start({ artifacts: files }))).first)).toContain("read_artifact to view");
    expect(text((await run(start({}))).first)).not.toContain("read_artifact");
  });
});
