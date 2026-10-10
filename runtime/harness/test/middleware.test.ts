import { registered } from "./fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { testAgent, execution, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("middleware", () => {
  it("runs as an outward-to-inward request onion and inward-to-outward response onion", async () => {
    const order: string[] = [];
    const result = testAgent()
      .use("one", async (request, next) => {
        order.push("enter-one");
        request.configuration.instructions.set("extra", ["extra"]);
        const response = await next();
        order.push("exit-one");
        return response;
      })
      .use("two", async (_request, next) => {
        order.push("enter-two");
        const response = await next();
        order.push("exit-two");
        return response;
      })
      .with(
        model(async (_call, { request }) => {
          order.push(`model:${request.instructions.at(-1)}`);
          return "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(order).toEqual(["enter-one", "enter-two", "model:extra", "exit-two", "exit-one"]);
  });

  it("exposes the same Session identity to middleware across a tool loop", async () => {
    const executionIds: string[] = [];
    let calls = 0;
    const result = testAgent()
      .use("durability", async (request, next) => {
        executionIds.push(request.executionId);
        return next();
      })
      .use("tools", offer(tool()))
      .with(
        model(async () =>
          ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
        ),
      )
      .build();

    await turn(result, "go", { id: "durable-session" }).handle.completed;

    expect(executionIds).toEqual(["durable-session", "durable-session"]);
  });

  it("tripwires conflicting model selection", async () => {
    const result = testAgent()
      .use("a", async (request, next) => {
        request.configuration.model.select({ id: "haiku" });
        return next();
      })
      .use("b", async (request, next) => {
        request.configuration.model.select({ id: "opus" });
        return next();
      })
      .with(model(async () => "done"))
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "configuration.model-selection-conflict" } },
    ]);
  });

  it("keeps Step restrictions and the candidate behind frozen branded facades", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "unexpected" }));
    const facadeChecks: boolean[] = [];
    let step = 0;
    const result = testAgent()
      .use("attacker", async (request, next) => {
        const raw = request as unknown as Record<string, unknown>;
        facadeChecks.push(Object.isFrozen(request), raw.hiddenTools === undefined);
        const response = await next();
        const responseRaw = response as unknown as Record<string, unknown>;
        facadeChecks.push(
          Object.isFrozen(response),
          responseRaw.denials === undefined,
          responseRaw.currentCandidate === undefined,
        );
        const candidate = response.candidate();
        const first = candidate?.output[0] as { name?: string } | undefined;
        expect(() => {
          first!.name = "replacement";
        }).toThrow();
        return response;
      })
      .use(
        "restrictions",
        registered(
          [[tool("echo", execution(execute))]],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("restrictions", registeredTools[0]);
            const response = await next();
            response.deny("deny", "policy");
            response.requireInteraction("deny", { kind: "approval", prompt: "approve" });
            return response;
          },
        ),
      )
      .with(
        model(async (_call, { request }) => {
          if (++step > 1) return "done";
          expect(request.tools.map((item) => item.name)).toEqual(["echo"]);
          return toolCalls(
            { id: "hidden", name: "hidden", args: {} },
            { id: "deny", name: "echo", args: {} },
          );
        }),
      )
      .build();

    const { session, handle: streamed } = turn(result, "go");
    const output = (await streamed.completed).events;
    const toolEntry = session.state.transcript.find((entry) => entry.kind === "tool-results");

    expect(facadeChecks.every(Boolean)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(toolEntry).toMatchObject({
      results: [
        { kind: "failed", code: "tool.unknown", callId: "hidden" },
        { kind: "denied", reason: "policy", callId: "deny" },
      ],
    });
    expect(output.at(-1)).toMatchObject({ type: "final", output: "done" });
  });

  it("rejects missing, double, and forged middleware responses", async () => {
    const invoke = vi.fn(async () => "done");
    const omitted = testAgent()
      .use("omitted", async () => undefined as never)
      .with(model(invoke))
      .build();
    expect((await turn(omitted, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "middleware.invalid-response" } },
    ]);

    const omittedNextReturn = testAgent()
      .use("omitted-next-return", async (_request, next) => {
        await next();
      })
      .with(model(invoke))
      .build();
    const omittedNextReturnTurn = turn(omittedNextReturn, "go");
    expect((await omittedNextReturnTurn.handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      {
        type: "tripwire",
        tripwire: { code: "middleware.invalid-response", scope: "step" },
      },
    ]);
    expect(omittedNextReturnTurn.session.state.status).toBe("stopped");

    const doubled = testAgent()
      .use("double", async (_request, next) => {
        void next();
        return next();
      })
      .with(model(invoke))
      .build();
    await expect(turn(doubled, "go").handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "candidate" },
        { type: "tripwire", tripwire: { code: "middleware.next-called-twice" } },
      ],
    });
    expect(doubled.run().state.status).toBe("idle");

    const spoofed = testAgent()
      .use("spoof", async () => {
        throw new Error("Middleware 'spoof' called next() more than once");
      })
      .with(model(invoke))
      .build();
    const spoofedTurn = turn(spoofed, "go");
    expect((await spoofedTurn.handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "middleware.failed" } },
    ]);
    expect(spoofedTurn.session.state.status).toBe("stopped");
  });

  it("copies context contributions before their source can mutate", async () => {
    const source = { type: "fixture", value: { nested: { value: 1 } } };
    const result = testAgent()
      .use("context", async (request, next) => {
        request.context.set("fixture", [source]);
        queueMicrotask(() => {
          source.value.nested.value = 9;
        });
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          expect(request.context.items).toEqual([
            { type: "fixture", value: { nested: { value: 1 } } },
          ]);
          expect(
            Object.isFrozen((request.context.items[0]?.value as { nested: object }).nested),
          ).toBe(true);
          return "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
  });

  it("offers tools only for the Step that added them", async () => {
    let step = 0;
    const seen: string[][] = [];
    const result = testAgent()
      .use("test", offer(tool()))
      .with(
        model(async (_call, { request }) => {
          seen.push(request.tools.map((item) => item.name));
          return ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([["echo"], ["echo"]]);
  });

  it("forwards a selected model directive and omits it when nobody selects", async () => {
    const seen: unknown[] = [];
    const selected = testAgent()
      .use("route", async (request, next) => {
        request.configuration.model.select({
          id: "test-model",
          controls: { temperature: 0.2, maxOutputTokens: 128 },
          config: { reasoning: "high" },
        });
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          seen.push(request.model);
          return "done";
        }),
      )
      .build();
    await turn(selected, "go").handle.completed;
    expect(seen).toEqual([
      {
        id: "test-model",
        controls: { temperature: 0.2, maxOutputTokens: 128 },
        config: { reasoning: "high" },
      },
    ]);

    seen.length = 0;
    const omitted = testAgent()
      .with(
        model(async (_call, { request }) => {
          seen.push(request.model);
          return "done";
        }),
      )
      .build();
    await turn(omitted, "go").handle.completed;
    expect(seen).toEqual([undefined]);
  });

  it("treats select({}) as an explicit empty directive and allows an identical select", async () => {
    const seen: unknown[] = [];
    const result = testAgent()
      .use("outer", async (request, next) => {
        request.configuration.model.select({ id: undefined });
        return next();
      })
      .use("inner", async (request, next) => {
        request.configuration.model.select({});
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          seen.push(request.model);
          return "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([{}]);
  });

  it("allows identical model configs with different object key order", async () => {
    const seen: unknown[] = [];
    const result = testAgent()
      .use("outer", async (request, next) => {
        request.configuration.model.select({ config: { beta: 2, alpha: 1 } });
        return next();
      })
      .use("inner", async (request, next) => {
        request.configuration.model.select({ config: { alpha: 1, beta: 2 } });
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          seen.push(request.model);
          return "done";
        }),
      )
      .build();

    await turn(result, "go").handle.completed;
    expect(seen).toEqual([{ config: { beta: 2, alpha: 1 } }]);
  });

  it("tripwires a partial-merge select and invalid directives", async () => {
    const merge = testAgent()
      .use("id", async (request, next) => {
        request.configuration.model.select({ id: "haiku" });
        return next();
      })
      .use("config", async (request, next) => {
        request.configuration.model.select({ config: { reasoning: "high" } });
        return next();
      })
      .with(model(async () => "done"))
      .build();
    expect((await turn(merge, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "configuration.model-selection-conflict" } },
    ]);

    const unknownKey = testAgent()
      .use("bad", async (request, next) => {
        request.configuration.model.select({ id: "haiku", extra: true } as never);
        return next();
      })
      .with(model(async () => "done"))
      .build();
    expect((await turn(unknownKey, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);

    const emptyId = testAgent()
      .use("empty", async (request, next) => {
        request.configuration.model.select({ id: "" });
        return next();
      })
      .with(model(async () => "done"))
      .build();
    expect((await turn(emptyId, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);

    const unknownControl = testAgent()
      .use("bad-control", async (request, next) => {
        request.configuration.model.select({ controls: { topP: 0.5 } } as never);
        return next();
      })
      .with(model(async () => "done"))
      .build();
    expect((await turn(unknownControl, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);
  });

  it("deep-copies and freezes directive config so source mutation cannot leak in", async () => {
    const source = { reasoning: "low", nested: { n: 1 } };
    const result = testAgent()
      .use("route", async (request, next) => {
        request.configuration.model.select({ id: "test-model", config: source });
        source.nested.n = 9;
        source.reasoning = "high";
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          expect(request.model?.config).toEqual({ reasoning: "low", nested: { n: 1 } });
          expect(Object.isFrozen(request.model?.config)).toBe(true);
          expect(Object.isFrozen((request.model?.config as { nested: object }).nested)).toBe(true);
          return "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
  });

  it("exposes a frozen pre-call transcript and starts the next Step without a prior directive", async () => {
    const seen: Array<{ model?: unknown; transcriptKinds: string[] }> = [];
    const result = testAgent()
      .use("route", async (request, next) => {
        expect(Object.isFrozen(request.transcript)).toBe(true);
        expect(() => {
          (request.transcript as { kind: string }[]).push({ kind: "forged" });
        }).toThrow();
        if (request.stepNumber === 1) request.configuration.model.select({ id: "test-model" });
        else request.configuration.model.clear({ reason: "Tool loop returned to default route." });
        return next();
      })
      .use("test", offer(tool()))
      .with(
        model(async (_call, { request }) => {
          seen.push({
            model: request.model,
            transcriptKinds: request.transcript.map((entry) => entry.kind),
          });
          return seen.length === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([
      { model: { id: "test-model" }, transcriptKinds: ["input"] },
      { model: undefined, transcriptKinds: ["input", "candidate", "tool-results"] },
    ]);
  });

  it("revokes model.select after next() without stopping a settled Session", async () => {
    const observed: string[] = [];
    let lateError = "";
    const result = testAgent()
      .use("late", async (request, next) => {
        const response = await next();
        try {
          request.configuration.model.select({ id: "test-model" });
        } catch (error) {
          lateError = error instanceof Error ? error.message : String(error);
        }
        return response;
      })
      .with(model(async () => "done"))
      .build();
    const session = result.run();
    session.observe((event) => observed.push(event.type));
    await session.input("go").completed;
    expect(lateError).toMatch(/no longer active/);
    expect(observed).toContain("middleware.lease-violation");
    expect(session.state.status).toBe("idle");
    await session.stop();
  });

  it("declares a model through middleware on every Step", async () => {
    const seen: unknown[] = [];
    const configurations: unknown[] = [];
    const agent = testAgent()
      .use({ id: "model", model: { id: "opus", controls: { temperature: 0.2 } } })
      .with(
        model(async (_call, { request }) => {
          seen.push(request.model);
          return "done";
        }),
      )
      .build();
    const session = agent.run();
    session.observe((event) => {
      if (event.type === "model.requested") configurations.push(event.attributes.configuration);
    });
    await session.input("go").completed;
    expect(seen).toEqual([{ id: "opus", controls: { temperature: 0.2 } }]);
    expect(configurations).toMatchObject([
      {
        model: { id: "opus", controls: { temperature: 0.2 } },
        contributors: [{ middlewareId: "model", slot: "model" }],
      },
    ]);
    await session.stop();
  });

  it("exposes stable session and unique turn/step identities on the middleware lease", async () => {
    const seen: Array<{ executionId: string; turnId: string; stepId: string }> = [];
    const session = testAgent()
      .use("identity", async (request, next) => {
        seen.push({
          executionId: request.executionId,
          turnId: request.turnId,
          stepId: request.stepId,
        });
        return next();
      })
      .with(model(async () => "done"))
      .build()
      .run({ id: "session-identity" });
    await session.input("first").completed;
    await session.input("second").completed;

    expect(seen).toHaveLength(2);
    expect(seen.map((item) => item.executionId)).toEqual(["session-identity", "session-identity"]);
    expect(seen[0]?.turnId).not.toBe(seen[1]?.turnId);
    expect(seen[0]?.stepId).not.toBe(seen[1]?.stepId);
  });

  it("lets middleware replace or clear a declared directive and rejects a conflicting select", async () => {
    const replaced: unknown[] = [];
    const replaceAgent = testAgent()
      .use({ id: "model", model: { id: "opus" } })
      .use("route", async (request, next) => {
        request.configuration.model.select({ id: "opus" });
        request.configuration.model.replace({ id: "haiku" });
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          replaced.push(request.model);
          return "done";
        }),
      )
      .build();
    await turn(replaceAgent, "go").handle.completed;
    expect(replaced).toEqual([{ id: "haiku" }]);

    const cleared: unknown[] = [];
    const clearAgent = testAgent()
      .use({ id: "model", model: { id: "opus" } })
      .use("route", async (request, next) => {
        if (request.stepNumber === 2) request.configuration.model.clear();
        return next();
      })
      .use("tools", offer(tool()))
      .with(
        model(async (_call, { request }) => {
          cleared.push(request.model);
          return request.toolResults.length === 0
            ? toolCalls({ id: "call", name: "echo", args: {} })
            : "done";
        }),
      )
      .build();
    await turn(clearAgent, "go").handle.completed;
    expect(cleared).toEqual([{ id: "opus" }, undefined]);

    const conflict = testAgent()
      .use({ id: "model", model: { id: "opus" } })
      .use("route", async (request, next) => {
        request.configuration.model.select({ id: "haiku" });
        return next();
      })
      .with(model(async () => "done"))
      .build();
    expect((await turn(conflict, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "configuration.model-selection-conflict" } },
    ]);
  });
});
