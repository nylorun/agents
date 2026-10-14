import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import { addPart, expectBuildError, model, testAgent, tool, turn } from "./fixtures.js";

describe("build", () => {
  it("keeps part order and returns a frozen adapter-free flat manifest", () => {
    const builder = testAgent()
      .part({ id: "first", instructions: ["One."] })
      .part({ id: "second", instructions: ["Two."] });
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(agent.id).toBe("test");
    expect(agent.name).toBe("Test");
    expect(agent.manifest).toEqual({
      manifestSchemaVersion: 7,
      id: "test",
      name: "Test",
      instructions: ["One.", "Two."],
    });
    expect(
      addPart(addPart(Agent({ id: "a" }), { id: "first" }), { id: "second" })
        .getBinding()
        .parts.map((part) => part.id),
    ).toEqual(["first", "second"]);
    expect(agent.manifest).not.toHaveProperty("adapters");
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("allows .instructions() after build() to return a new agent (build is a no-op)", () => {
    const builder = Agent({ id: "a", name: "A" });
    builder.build();
    const next = builder.instructions("Late.");
    expect(next).not.toBe(builder);
    expect(next.build().manifest.instructions).toEqual(["Late."]);
    expect(builder.build().manifest).not.toHaveProperty("instructions");
  });

  it("rejects duplicate part ids", () => {
    const builder = testAgent().part({ id: "same" }).part({ id: "same" });
    expect(() => builder.build()).toThrow(/'same' is added twice/);
  });

  it("snapshots static part instructions and tools", () => {
    const agent = testAgent()
      .part({
        id: "notes",
        instructions: ["Write notes."],
        tools: [tool("write_note")],
      })
      .build();
    expect(agent.manifest).toMatchObject({
      instructions: ["Write notes."],
      tools: [{ name: "write_note", inputSchema: expect.any(Object) }],
    });
    expect(agent.manifest.tools?.[0]?.inputSchema).toMatchObject({
      type: "object",
    });
  });

  it("reports empty identity at build", () => {
    const error = expectBuildError(() => Agent({ id: "", name: "" }).build());
    expect(error.diagnostics.map((item) => item.code)).toEqual([
      "agent.invalid-id",
      "agent.invalid-name",
    ]);
  });

  it("hides internal model and tool registries", () => {
    const agent = testAgent().build() as unknown as Record<string, unknown>;
    expect(agent.models).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.adapters).toBeUndefined();
    expect(agent.catalog).toBeUndefined();
    expect(agent.instructions).toBeUndefined();
  });

  it("starts an idle Session without submitting input", async () => {
    const agent = testAgent()
      .with(model(async () => "hello"))
      .build();
    const session = agent.run();
    expect(session.state.status).toBe("idle");
    await session.input("hi").completed;
    expect(session.state.transcript.some((entry) => entry.kind === "final")).toBe(true);
    const other = turn(agent, "other");
    expect(other.session.id).not.toBe(session.id);
    await other.handle.completed;
    await session.stop();
    await other.session.stop();
  });

  it("applies constructor instructions on the reserved agent slot", async () => {
    const seen: string[] = [];
    const contributors: Array<{ readonly partId: string; readonly slot: string }> = [];
    const agent = testAgent({ instructions: "Be concise." })
      .with(
        model(async (_call, { request }) => {
          seen.push(...request.instructions);
          return "done";
        }),
      )
      .build();
    const session = agent.run({
      observer: (event) => {
        if (event.type === "model.requested")
          contributors.push(...event.attributes.configuration.contributors);
      },
    });
    await session.input("go").completed;
    expect(seen).toEqual(["Be concise."]);
    expect(contributors).toContainEqual(
      expect.objectContaining({ partId: "agent", slot: "agent" }),
    );
    expect(agent.manifest.instructions).toEqual(["Be concise."]);
    await session.stop();
  });

  it("publishes the agent output schema on the catalog", () => {
    const agent = Agent({
      id: "extractor",
      name: "Extractor",
      outputSchema: z.object({ answer: z.string() }),
    }).build();
    expect(agent.manifest.outputSchema).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" } },
    });
  });

  it("rejects a part that reuses the reserved agent id", () => {
    const error = expectBuildError(() =>
      testAgent({ instructions: "Stay reserved." })
        .part({ id: "agent", instructions: ["overlap"] })
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "part.duplicate-id")).toBe(true);
  });
});
