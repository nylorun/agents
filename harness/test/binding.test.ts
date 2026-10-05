import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import { expectBuildError, model, testAgent, tool, turn } from "./fixtures.js";

describe("build", () => {
  it("seals middleware order and returns a frozen adapter-free manifest", () => {
    const builder = testAgent()
      .use("first", async (_request, next) => next())
      .use("second", async (_request, next) => next());
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(agent.id).toBe("test");
    expect(agent.name).toBe("Test");
    expect(agent.manifest).toEqual({
      manifestSchemaVersion: 5,
      id: "test",
      name: "Test",
      capabilities: [
        { id: "first", type: "agent" },
        { id: "second", type: "agent" },
      ],
    });
    expect(agent.manifest).not.toHaveProperty("adapters");
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("allows .use() after build() to return a new agent (build is a no-op)", () => {
    const builder = Agent({ id: "a", name: "A" });
    builder.build();
    const next = builder.use("late", async (_request, nextFn) => nextFn());
    expect(next).not.toBe(builder);
    expect(next.build().manifest.capabilities.map((item) => item.id)).toContain("late");
  });

  it("rejects duplicate middleware ids", () => {
    const builder = testAgent()
      .use("same", async (_request, next) => next())
      .use("same", async (_request, next) => next());
    expect(() => builder.build()).toThrow(/Duplicate middleware id/);
  });

  it("does not project capability model into the published manifest (Runtime-owned)", () => {
    const agent = testAgent()
      .use({ id: "model", model: { id: "opus", controls: { temperature: 0.2 } } })
      .build();
    expect(agent.manifest).toEqual({
      manifestSchemaVersion: 5,
      id: "test",
      name: "Test",
      capabilities: [{ id: "model", type: "agent" }],
    });
    expect(agent.manifest).not.toHaveProperty("model");
    expect(agent.manifest.capabilities[0]).not.toHaveProperty("model");
  });

  it("snapshots static declaration instructions and tools without embedding model", () => {
    const agent = testAgent()
      .use({
        id: "notes",
        instructions: ["Write notes."],
        tools: [tool("write_note")],
        model: { id: "opus", controls: { temperature: 0.2 } },
      })
      .build();
    expect(agent.manifest.capabilities).toEqual([
      {
        id: "notes",
        type: "agent",
        instructions: ["Write notes."],
        tools: [{ name: "write_note", inputSchema: expect.any(Object) }],
      },
    ]);
    expect(agent.manifest.capabilities[0]?.tools?.[0]?.inputSchema).toMatchObject({
      type: "object",
    });
    expect(agent.manifest.capabilities[0]).not.toHaveProperty("model");
  });

  it("reports empty identity at build", () => {
    const error = expectBuildError(() => Agent({ id: "", name: "" }).build());
    expect(error.diagnostics.map((item) => item.code)).toEqual([
      "agent.invalid-id",
      "agent.invalid-name",
    ]);
  });

  it("assigns generated middleware ids and skips explicit collisions", () => {
    const agent = testAgent()
      .use("middleware-1", async (_request, next) => next())
      .use(async (_request, next) => next())
      .use("named", async (_request, next) => next())
      .build();
    expect(agent.manifest.capabilities.map((item) => item.id)).toEqual([
      "middleware-1",
      "middleware-2",
      "named",
    ]);
    expect(agent.manifest.capabilities).toEqual([
      { id: "middleware-1", type: "agent" },
      { id: "middleware-2", type: "agent" },
      { id: "named", type: "agent" },
    ]);
  });

  it("snapshots middleware descriptors when build starts", () => {
    const id = { value: "original" };
    const builder = testAgent().use(id.value, async (_request, next) => next());
    id.value = "mutated";
    expect(builder.build().manifest.capabilities).toEqual([{ id: "original", type: "agent" }]);
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
    const contributors: Array<{ readonly middlewareId: string; readonly slot: string }> = [];
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
      expect.objectContaining({ middlewareId: "agent", slot: "agent" }),
    );
    expect(agent.manifest.capabilities).toEqual([
      { id: "agent", type: "agent", instructions: ["Be concise."] },
    ]);
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

  it("marks author-supplied declaration middleware", () => {
    const agent = testAgent()
      .use({
        id: "notes",
        tools: [tool("write_note")],
        middleware: async (_request, next) => next(),
      })
      .build();
    expect(agent.manifest.capabilities).toEqual([
      {
        id: "notes",
        type: "agent",
        tools: [{ name: "write_note", inputSchema: expect.any(Object) }],
      },
    ]);
  });

  it("projects a raw middleware layer as id only", () => {
    const agent = testAgent()
      .use(async (_request, next) => next())
      .build();
    expect(agent.manifest.capabilities).toEqual([{ id: "middleware-1", type: "agent" }]);
  });

  it("rejects a capability that reuses the reserved agent id", () => {
    const error = expectBuildError(() =>
      testAgent({ instructions: "Stay reserved." })
        .use({ id: "agent", instructions: ["overlap"] })
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "middleware.duplicate-id")).toBe(true);
  });
});
