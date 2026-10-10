import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import {
  parseTranscriptEvent,
  type LiveEvent,
} from "@nylorun/core/contracts";
import {
  SANDBOX_CAPABILITY_ID,
} from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { startToolServer } from "./support/tool-server.js";

const APP = "transcript-events-app-token-aaaa";

/** Plays one step per entry: optional text and one tool call; then a closing text. */
function script(
  steps: readonly { text?: string; call?: { name: string; args: object } }[],
  closing: string
): ModelProvider {
  const baseline = new Map<string, number>();
  return async (effect) => {
    const prompt =
      (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    if (!baseline.has(effect.turnId))
      baseline.set(effect.turnId, results.length);
    const index = results.length - baseline.get(effect.turnId)!;
    const step = steps[index];
    if (!step) return { output: [{ type: "text", text: closing }] };
    return {
      output: [
        ...(step.text ? [{ type: "text", text: step.text }] : []),
        ...(step.call
          ? [
              {
                type: "tool-call",
                id: `call-${index}`,
                name: step.call.name,
                args: step.call.args,
              },
            ]
          : []),
      ],
    };
  };
}

async function settle(
  session: ReturnType<AgentsClient["session"]>,
  statuses: readonly string[]
) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await session.inspect();
    if (statuses.includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session did not reach ${statuses.join(", ")}`);
}

const ofType = (items: LiveEvent[], type: string) =>
  items.filter((item) => item.type === type);

it("advertises transcript-events", () => {
  expect(HOST_PROTOCOL.features).toContain("transcript-events");
});

it("writes message.assistant per model step and tool.completed for Runtime-run tools", async () => {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    sandbox: { backend: "virtual" },
    modelProvider: script(
      [
        {
          text: "Writing the file.",
          call: { name: "write", args: { path: "a.txt", content: "hi" } },
        },
        { call: { name: "read", args: { path: "missing.txt" } } },
      ],
      "Done."
    ),
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).instructions("Write, then read.").build();
    await client.saveAgent(agent, { implementationVersion: "dev" });
    const session = await client.createSession({
      id: "s1",
      agentId: "bot",
      ownerUserId: "ada",
      sandbox: {},
    });
    await session.input("write then read", { idempotencyKey: "m1" });
    expect((await settle(session, ["completed", "failed"])).status).toBe(
      "completed"
    );
    const { items } = await session.history();

    const messages = ofType(items, "message.assistant").map(
      (item) => parseTranscriptEvent(item)!.payload as any
    );
    expect(messages.map((m) => m.text)).toEqual([
      "Writing the file.",
      "",
      "Done.",
    ]);
    expect(messages[0].toolCalls).toEqual([
      { callId: "call-0", name: "write", input: { path: "a.txt", content: "hi" } },
    ]);
    expect(messages[2].toolCalls).toEqual([]);
    expect(new Set(messages.map((m) => m.invocationId)).size).toBe(3);

    const tools = ofType(items, "tool.completed").map(
      (item) => parseTranscriptEvent(item)!.payload as any
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      callId: "call-0",
      capabilityId: SANDBOX_CAPABILITY_ID,
      toolName: "write",
    });
    expect(tools[0].invocationId).toEqual(expect.any(String));
    expect(tools[0].error).toBeUndefined();
    expect(tools[1]).toMatchObject({ callId: "call-1", toolName: "read" });
    expect(tools[1].error).toMatchObject({ code: expect.any(String) });

    // Order: each step's message precedes its tool's result.
    const order = items
      .filter((item) =>
        ["message.assistant", "tool.completed"].includes(item.type)
      )
      .map((item) => item.type);
    expect(order).toEqual([
      "message.assistant",
      "tool.completed",
      "message.assistant",
      "tool.completed",
      "message.assistant",
    ]);
  } finally {
    await runtime.close();
  }
});

it("pauses for approval on an HTTP tool with an output schema, with the call id on the pause and the result, and no replayed duplicates", async () => {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: script(
      [{ text: "Saving it.", call: { name: "save", args: { note: "hi" } } }],
      "Saved."
    ),
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  const service = await startToolServer({ save: () => ({ saved: true }) });
  const agent = Agent({ id: "notes", name: "Notes" })
    .tools(
      service.tool("save", {
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        approval: "always",
      })
    )
    .build();
  try {
    await client.saveAgent(agent, { implementationVersion: "dev" });
    const session = await client.createSession({
      id: "s1",
      agentId: "notes",
      ownerUserId: "ada",
    });
    await session.input("save hi", { idempotencyKey: "m1" });

    let waits: unknown[] = [];
    for (let attempt = 0; attempt < 400 && waits.length === 0; attempt += 1) {
      const pending = await session.pending();
      waits = Array.isArray(pending) ? pending : [];
      if (!waits.length) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waits).toHaveLength(1);
    const interactionId = (waits[0] as { interaction: { id: string } })
      .interaction.id;
    expect(service.calls).toEqual([]);
    await session.approve(interactionId, true, { idempotencyKey: "a1" });
    expect((await settle(session, ["completed", "failed"])).status).toBe(
      "completed"
    );
    expect(service.calls.map((call) => call.input)).toEqual([{ note: "hi" }]);

    const { items } = await session.history();
    const paused = ofType(items, "turn.paused");
    expect(paused).toHaveLength(1);
    const interaction = (parseTranscriptEvent(paused[0]!)!.payload as any).interactions[0];
    expect(interaction.callId).toBe("call-0");
    const results = ofType(items, "tool.completed").map(
      (item) => parseTranscriptEvent(item)!.payload as any
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      callId: "call-0",
      invocationId: interaction.invocationId,
      toolName: "save",
      output: { saved: true },
    });
    expect(items.some((item) => item.type.startsWith("action."))).toBe(false);

    // Two model steps, each written once, although the paused segment replays the first.
    const messages = ofType(items, "message.assistant").map(
      (item) => item.payload as { text: string }
    );
    expect(messages.map((m) => m.text)).toEqual(["Saving it.", "Saved."]);
  } finally {
    await service.close();
    await runtime.close();
  }
});
