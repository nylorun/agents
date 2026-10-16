/**
 * Tool results that fit (R2b C11, protocol 15), shaped by our engine before it reports them:
 * the record refuses an entry past `recordEntryBytes`, so text past the cap becomes an artifact
 * with a preview, binary parts become artifacts (an image also a file for a model that reads it),
 * one step's results share a budget, and every stored result is keyed by its call and its bytes.
 */
import { describe, expect, it } from "vitest";
import {
  RUNTIME_LIMIT_DEFAULTS,
  fromBase64,
  type HarnessChannel,
  type ModelDescriptor,
  type RecordedOutcome,
} from "@nylorun/core/harness-api";
import { apiHost } from "../src/api/host.js";
import { RunAbort } from "../src/api/abort.js";
import type { HarnessExecutors, HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";
import {
  DEFAULT_TOOL_RESULT_CONFIG,
  StepBudget,
  cutMessage,
  jsonBytes,
  previewOf,
  shapeToolOutcome,
  spillKey,
  type ShapeContext,
  type Stored,
} from "../src/tools/results.js";
import { engineConfig } from "./fixtures.js";

const KiB = 1024;
const config = DEFAULT_TOOL_RESULT_CONFIG;
/** About 200 KiB of lines, with two- and three-byte characters. */
const BIG = Array.from(
  { length: 3_100 },
  (_, i) => `line ${String(i).padStart(5, "0")} é€ ${"x".repeat(50)}\n`,
).join("");
/** A 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4 not really a pdf").toString("base64");
const reads = (inputs: ModelDescriptor["inputs"]): ModelDescriptor => ({
  provider: "p",
  id: "m",
  inputs,
  contextWindow: 100_000,
  maxOutputTokens: 1_000,
});

const effect = (id: string, fields: Partial<HostEffect> = {}): HostEffect => ({
  effectId: `t1:0:tool:${id}`,
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  kind: "tool",
  toolName: "files__read",
  target: { kind: "mcp", server: "files", tool: "read" },
  input: {},
  context: { callId: id, invocationId: `inv-${id}`, stepId: "step-1" },
  ...fields,
});

/** A store that keeps what it is given, or refuses it. */
function store(refuse?: string) {
  const kept: { bytes: Uint8Array; name: string; contentType: string }[] = [];
  const write = async (
    bytes: Uint8Array,
    artifact: { name: string; contentType: string },
  ): Promise<Stored> => {
    if (refuse) return { dropped: refuse, size: bytes.byteLength };
    kept.push({ bytes, ...artifact });
    return {
      artifactId: `af_${kept.length}`,
      version: 1,
      contentType: artifact.contentType,
      size: bytes.byteLength,
    };
  };
  return { kept, write };
}

function context(fields: Partial<ShapeContext> & Pick<ShapeContext, "store">): ShapeContext {
  return {
    effect: effect("c1"),
    limit: config.resultInlineBytes,
    limits: RUNTIME_LIMIT_DEFAULTS,
    config,
    ...fields,
  };
}

describe("shaping one result", () => {
  it("stores text past the cap whole, and previews its start and end", async () => {
    const s = store();
    const shaped = (await shapeToolOutcome(
      { kind: "completed", output: BIG },
      context({ store: s.write }),
    )) as any;
    expect(shaped).toMatchObject({
      kind: "completed",
      truncated: true,
      output: { truncated: true, artifactId: "af_1", version: 1, size: Buffer.byteLength(BIG) },
    });
    expect(new TextDecoder().decode(s.kept[0]!.bytes)).toBe(BIG);
    expect(s.kept[0]!.name).toBe("files__read-result.txt");
    expect(shaped.output.preview.startsWith("line 00000")).toBe(true);
    expect(shaped.output.preview.endsWith(BIG.slice(-20))).toBe(true);
    expect(jsonBytes(shaped.output)).toBeLessThanOrEqual(config.resultInlineBytes);
  });

  it("keeps a result that fits as it is", async () => {
    const value = { kind: "completed", output: "small" };
    expect(await shapeToolOutcome(value, context({ store: store().write }))).toBe(value);
  });

  it("stores a PNG and gives it to a model that reads images, as a file; a text-only model gets the part", async () => {
    const output = [
      { type: "text", text: "the page" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ];
    const seeing = store();
    const shaped = (await shapeToolOutcome(
      { kind: "completed", output },
      context({ store: seeing.write, model: reads(["text", "image"]) }),
    )) as any;
    expect(shaped.output).toEqual([
      { type: "text", text: "the page" },
      { type: "image", artifactId: "af_1", version: 1, contentType: "image/png", size: 70 },
    ]);
    expect(shaped.files).toEqual([
      {
        mediaType: "image/png",
        reference: { artifactId: "af_1", version: 1, name: "files__read-result-2.png", size: 70 },
      },
    ]);
    expect(seeing.kept[0]!.bytes).toEqual(fromBase64(PNG));
    const blind = (await shapeToolOutcome(
      { kind: "completed", output },
      context({ store: store().write, model: reads(["text"]) }),
    )) as any;
    expect(blind.output[1]).toMatchObject({ type: "image", artifactId: "af_1" });
    expect(blind).not.toHaveProperty("files");
  });

  it("shapes each part of a mixed result: binaries stored, links kept, the large text cut", async () => {
    const s = store();
    const shaped = (await shapeToolOutcome(
      {
        kind: "completed",
        output: [
          { type: "text", text: "summary" },
          { type: "resource_link", uri: "https://files.example/report", name: "report" },
          {
            type: "resource",
            resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: PDF },
          },
          { type: "text", text: BIG.slice(0, 100 * KiB) },
        ],
      },
      context({ store: s.write }),
    )) as any;
    expect(shaped.output[0]).toEqual({ type: "text", text: "summary" });
    expect(shaped.output[1]).toEqual({
      type: "resource_link",
      uri: "https://files.example/report",
      name: "report",
    });
    expect(shaped.output[2]).toMatchObject({
      type: "resource",
      uri: "file:///report.pdf",
      contentType: "application/pdf",
    });
    expect(shaped.output[3]).toMatchObject({
      type: "text",
      truncated: true,
      preview: expect.any(String),
    });
    expect(s.kept.map((item) => item.contentType)).toEqual([
      "application/pdf",
      "text/plain; charset=utf-8",
    ]);
    expect(jsonBytes(shaped.output)).toBeLessThanOrEqual(config.resultInlineBytes);
  });

  it("reads MCP parts only for an MCP call", async () => {
    const s = store();
    const parts = [{ type: "image", data: PNG, mimeType: "image/png" }];
    const value = { kind: "completed", output: parts };
    expect(
      await shapeToolOutcome(
        value,
        context({ store: s.write, effect: effect("h", { target: { kind: "http", tool: "x" } }) }),
      ),
    ).toBe(value);
    expect(s.kept).toEqual([]);
  });

  it("keeps the preview and says why the rest is gone when the store refuses it", async () => {
    const shaped = (await shapeToolOutcome(
      { kind: "completed", output: BIG },
      context({
        store: store("The result could not be stored as an artifact: over the limit").write,
      }),
    )) as any;
    expect(shaped.output).toMatchObject({
      truncated: true,
      dropped: expect.stringContaining("over the limit"),
    });
    expect(shaped.output.preview.length).toBeGreaterThan(0);
    expect(jsonBytes(shaped.output)).toBeLessThanOrEqual(config.resultInlineBytes);
  });

  it("cuts a failed message past its cap to its start and end", async () => {
    const shaped = (await shapeToolOutcome(
      { kind: "failed", code: "mcp.tool", message: BIG },
      context({ store: store().write, limit: 2 * KiB }),
    )) as any;
    expect(shaped.code).toBe("mcp.tool");
    expect(Buffer.byteLength(shaped.message)).toBeLessThanOrEqual(2 * KiB);
    expect(shaped.message).toContain("its middle is not shown");
  });

  it("previews in whole characters, by the harness's head and tail", () => {
    const text = "é".repeat(1_000);
    const preview = previewOf(text, 100, { previewHeadBytes: 4, previewTailBytes: 1 });
    expect(preview).not.toContain("�");
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(110);
  });
});

describe("the spill key", () => {
  it("is the call's and the bytes': the same bytes of a call again take the same key, others another", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(spillKey("e1", "whole", bytes)).toBe(
      spillKey("e1", "whole", new TextEncoder().encode("abc")),
    );
    expect(spillKey("e1", "whole", bytes)).not.toBe(
      spillKey("e1", "whole", new TextEncoder().encode("abd")),
    );
    expect(spillKey("e1", 1, bytes)).not.toBe(spillKey("e1", 2, bytes));
    expect(spillKey("e1", "whole", bytes)).not.toBe(spillKey("e2", "whole", bytes));
    expect(spillKey("e1", "whole", bytes)).toMatch(/^tr:[0-9a-f]{64}$/);
  });
});

describe("the step budget", () => {
  it("is the configured budget, held under the record entry limit less the envelope", () => {
    expect(new StepBudget(config, RUNTIME_LIMIT_DEFAULTS).budget).toBe(config.stepBudgetBytes);
    const small = new StepBudget(config, { recordEntryBytes: 64 * KiB });
    expect(small.budget).toBe(64 * KiB - config.entryEnvelopeBytes);
    expect(small.inline).toBe(config.resultInlineBytes);
    const tiny = new StepBudget(config, { recordEntryBytes: 20 * KiB });
    expect(tiny.inline).toBe(20 * KiB - config.entryEnvelopeBytes);
  });

  it("gives a result what its step's others left, never less than a stub", () => {
    const budget = new StepBudget({ ...config, stepBudgetBytes: 40 * KiB }, RUNTIME_LIMIT_DEFAULTS);
    budget.count(effect("a"), { kind: "completed", output: "x".repeat(30 * KiB) });
    expect(budget.reserve(effect("b"), true)).toBeLessThan(11 * KiB);
    budget.count(effect("b"), { kind: "completed", output: "x".repeat(20 * KiB) });
    expect(budget.reserve(effect("c"), true)).toBe(config.stubBytes);
    // Another step has its own budget.
    expect(budget.reserve(effect("d", { context: { callId: "d", stepId: "step-2" } }), true)).toBe(
      config.resultInlineBytes,
    );
  });
});

/** A core over a channel: answers `execute`, keeps outcomes and artifact writes. */
function core(options: { recorded?: RecordedOutcome[]; recordEntryBytes?: number } = {}) {
  const outcomes: any[] = [];
  const written = new Map<string, { size: number; effectId?: string }>();
  const keys: string[] = [];
  const channel = {
    async request(method: string, params: any) {
      if (method === "effect.intent") return { status: "execute" };
      if (method === "effect.outcome") {
        outcomes.push(params.value);
        return { status: "completed", outcome: { value: params.value } };
      }
      if (method === "artifact.write") {
        keys.push(params.key);
        const known = written.get(params.key);
        const created = known === undefined;
        const size = fromBase64(params.base64).byteLength;
        written.set(params.key, { size, effectId: params.effectId });
        return {
          status: "written",
          created,
          artifact: {
            artifactId: `af_${[...written.keys()].indexOf(params.key) + 1}`,
            kind: "file",
            name: params.name,
            version: 1,
            contentType: params.contentType ?? "application/octet-stream",
            size,
            sha256: "0".repeat(64),
            tenantWide: false,
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HarnessChannel;
  const controller = new AbortController();
  const run: HarnessRun = {
    runId: "r1",
    grant: {} as HarnessRun["grant"],
    start: {
      outcomes: options.recorded ?? [],
      limits: {
        ...RUNTIME_LIMIT_DEFAULTS,
        recordEntryBytes: options.recordEntryBytes ?? RUNTIME_LIMIT_DEFAULTS.recordEntryBytes,
      },
    } as unknown as HarnessRun["start"],
    signal: controller.signal,
  };
  return { channel, run, controller, outcomes, written, keys };
}

function executors(answer: (effect: HostEffect) => unknown): HarnessExecutors {
  return {
    model: async () => ({}),
    tool: async (effect) => answer(effect),
    recovers: { model: false, tool: () => false },
  };
}

describe("the API host", () => {
  const chunk = (n: number) => `chunk ${n} `.padEnd(30 * KiB, String.fromCharCode(97 + (n % 26)));

  it("shapes a result before it reports it, storing the rest keyed by the call", async () => {
    const c = core();
    const host = apiHost(
      c.channel,
      executors(() => ({ kind: "completed", output: BIG })),
      c.run,
      engineConfig(),
    );
    const resolved = (await host.resolveEffect(effect("c1"))) as any;
    expect(resolved.outcome.value.output).toMatchObject({ truncated: true, artifactId: "af_1" });
    expect(c.outcomes[0]).toEqual(resolved.outcome.value);
    expect([...c.written.values()]).toEqual([
      { size: Buffer.byteLength(BIG), effectId: "t1:0:tool:c1" },
    ]);
    // The same call run again (a crash before its outcome) stores nothing new.
    const again = apiHost(
      c.channel,
      executors(() => ({ kind: "completed", output: BIG })),
      c.run,
      engineConfig(),
    );
    await again.resolveEffect(effect("c1"));
    expect(c.keys).toHaveLength(2);
    expect(c.keys[1]).toBe(c.keys[0]);
    expect(c.written.size).toBe(1);
  });

  it("keeps forty parallel 30 KiB results of one step under the record entry limit", async () => {
    const c = core({ recordEntryBytes: 512 * KiB });
    const host = apiHost(
      c.channel,
      executors((e) => ({
        kind: "completed",
        output: chunk(Number(String(e.context.callId).slice(1))),
      })),
      c.run,
      engineConfig(),
    );
    await Promise.all(Array.from({ length: 40 }, (_, i) => host.resolveEffect(effect(`c${i}`))));
    const total = c.outcomes.reduce((sum, value) => sum + jsonBytes(value.output), 0);
    // The budget, and a stub for each result past it: the step's entry stays under the record's limit.
    expect(total).toBeLessThanOrEqual(config.stepBudgetBytes + 40 * config.stubBytes);
    expect(total).toBeLessThan(512 * KiB - config.entryEnvelopeBytes);
    expect(c.outcomes.filter((value) => typeof value.output === "string").length).toBeGreaterThan(
      0,
    );
    expect(c.outcomes.filter((value) => value.output?.truncated).length).toBeGreaterThan(0);
  });

  it("counts replayed results toward their step's budget", async () => {
    const replayed = Array.from({ length: 8 }, (_, i) => effect(`r${i}`));
    const recorded = replayed.map((e, i) => ({
      effectId: e.effectId,
      requestHash: "",
      outcome: { value: { kind: "completed", output: chunk(i) } },
    }));
    const c = core({ recorded });
    const host = apiHost(
      c.channel,
      executors(() => ({ kind: "completed", output: chunk(99) })),
      c.run,
      engineConfig(),
    );
    // Replays resolve without asking core (their hashes are set below).
    const { effectRequestHash } = await import("@nylorun/core/harness-api");
    for (const [i, e] of replayed.entries())
      (recorded[i] as { requestHash: string }).requestHash = effectRequestHash(e);
    for (const e of replayed) await host.resolveEffect(e);
    const fresh = (await host.resolveEffect(effect("n1"))) as any;
    // 8 × 30 KiB of the step's 256 KiB is spent: the new result is cut to what is left.
    expect(fresh.outcome.value.output).toMatchObject({ truncated: true });
  });

  it("stores nothing after a cancel: the outcome is discarded", async () => {
    const c = core();
    const host = apiHost(
      c.channel,
      executors(() => {
        c.controller.abort(new RunAbort("cancel", "cancelled"));
        return { kind: "completed", output: BIG };
      }),
      c.run,
      engineConfig(),
    );
    await host.resolveEffect(effect("c1")).catch(() => undefined);
    expect(c.written.size).toBe(0);
  });

  it("names the call's target on its intent, and leaves our engine's own results as they are", async () => {
    const c = core();
    const intents: any[] = [];
    const channel = {
      request: async (method: string, params: any) => {
        if (method === "effect.intent") intents.push(params.effect);
        return c.channel.request(method as never, params as never);
      },
    } as unknown as HarnessChannel;
    const host = apiHost(
      channel,
      executors(() => ({ kind: "completed", output: "ok" })),
      c.run,
      engineConfig(),
    );
    await host.resolveEffect(effect("c1"));
    expect(intents[0].target).toEqual({ kind: "mcp", server: "files", tool: "read" });
  });
});

describe("tool result configuration (B15c)", () => {
  it("keeps no preview under minPreviewBytes, and a cut message fits its limit as JSON", () => {
    expect(DEFAULT_TOOL_RESULT_CONFIG.minPreviewBytes).toBe(64);
    for (const limit of [200, 2_000]) {
      const cut = cutMessage("a".repeat(10_000), limit, DEFAULT_TOOL_RESULT_CONFIG);
      expect(jsonBytes(cut)).toBeLessThanOrEqual(limit);
      expect(cut).toContain("its middle is not shown");
    }
  });
});
