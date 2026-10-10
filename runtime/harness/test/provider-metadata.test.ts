import { expect, it } from "vitest";
import { testAgent, offer, model, tool } from "./fixtures.js";
import type { ModelCall, ModelOutputBlock } from "@nylorun/core/define";

it("preserves opaque block metadata through normalization, canonicalization and conversation projection", async () => {
  const metadata = {
    pi: { provider: "google", model: "gemini-flash-latest", signature: "signed" },
  };
  const output: ModelOutputBlock[] = [
    { type: "reasoning", text: "", providerMetadata: metadata },
    { type: "text", text: "", providerMetadata: metadata },
    {
      type: "tool-call",
      id: "call",
      name: "echo",
      args: { value: 26 },
      providerMetadata: metadata,
    },
  ];
  const calls: ModelCall[] = [];
  const agent = testAgent()
    .use("tools", offer(tool()))
    .with(
      model(async (call) => {
        calls.push(call);
        return calls.length === 1 ? { output } : "26";
      }),
    )
    .build();
  const session = agent.run();
  try {
    const result = await session.input("Add 19 and 7").completed;
    expect(result.status).toBe("completed");
    expect(result.events.at(-1)).toMatchObject({ type: "final", output: "26" });
    const projected = calls[1]?.prompt.find(
      (item) => item.kind === "message" && item.role === "assistant",
    );
    expect(projected?.content).toEqual(output);
    expect(Object.isFrozen(projected?.content[2]?.providerMetadata)).toBe(true);
    metadata.pi.signature = "mutated";
    expect(JSON.stringify(projected)).toContain('"signature":"signed"');
    await session.input("Follow up").completed;
    expect(calls[2]?.prompt).toContainEqual(projected);
    const other = agent.run();
    try {
      await other.input("Separate conversation").completed;
    } finally {
      await other.stop();
    }
    expect(JSON.stringify(calls[3]?.prompt)).not.toContain("signature");
    const restored = agent.run({
      state: { ...JSON.parse(JSON.stringify(session.state)), status: "completed" },
    });
    try {
      await restored.input("Restored conversation").completed;
    } finally {
      await restored.stop();
    }
    expect(calls[4]?.prompt).toContainEqual(projected);
  } finally {
    await session.stop();
  }
});

it.each(["invalid", ["invalid"], { signature: undefined }])(
  "rejects malformed provider metadata: %j",
  async (metadata) => {
    const session = testAgent()
      .with(
        model(
          async () =>
            ({ output: [{ type: "text", text: "x", providerMetadata: metadata }] }) as never,
        ),
      )
      .build()
      .run();
    try {
      expect((await session.input("go").completed).events).toContainEqual(
        expect.objectContaining({
          type: "tripwire",
          tripwire: expect.objectContaining({ code: "model.invalid-candidate" }),
        }),
      );
    } finally {
      await session.stop();
    }
  },
);
