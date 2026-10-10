import { runAgent } from "./run-agent.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateExecutionState } from "../src/run/index.js";
import { Agent } from "@nylorun/core/define";
import { type ExecutionState } from "../src/index.js";

const candidate = (name: string, id = "call") => ({
  output: [{ type: "tool-call" as const, id, name, args: {} }],
});
const roundtrip = (state: ExecutionState): ExecutionState => JSON.parse(JSON.stringify(state));

describe("stateless execution", () => {
  it("supports minimal calls, independent runs and serializable immutable continuation", async () => {
    const agent = Agent({ id: "a", name: "A" }).build();
    const one = await runAgent(agent, { input: "one", onModelCall: async () => "hello" });
    expect(one.status).toBe("completed");
    const saved = JSON.stringify(one.state);
    const two = await runAgent(agent, {
      state: roundtrip(one.state),
      input: "two",
      onModelCall: async (call) => {
        expect(JSON.stringify(call.prompt)).toContain("one");
        return "world";
      },
    });
    expect(two.state.turnCount).toBe(2);
    expect(JSON.stringify(one.state)).toBe(saved);
    expect(validateExecutionState(two.state)).toEqual(two.state);
    expect(
      (await runAgent(agent, { input: "independent", onModelCall: async () => "ok" })).state
        .turnCount,
    ).toBe(1);
  });

  it("ignores a leftover executionVersion on saved state", async () => {
    const agent = Agent({ id: "a", name: "A" }).build();
    const result = await runAgent(agent, { input: "go", onModelCall: async () => "ok" });
    const legacy = { ...result.state, executionVersion: "1" };
    const checked = validateExecutionState(legacy);
    expect(checked).not.toHaveProperty("executionVersion");
    expect(checked.agentId).toBe("a");
    const continued = await runAgent(agent, {
      state: legacy,
      input: "again",
      onModelCall: async () => "next",
    });
    expect(continued.status).toBe("completed");
    expect(continued.state).not.toHaveProperty("executionVersion");
  });

  it("keeps info out of state and events while forwarding it to middleware and tools", async () => {
    const infos: unknown[] = [],
      events: unknown[] = [];
    const agent = Agent<{ tenantId: string }>({ id: "a", name: "A" })
      .use({
        id: "c",
        tools: [
          {
            name: "t",
            inputSchema: z.object({}),
            execute: async (_, { info }) => {
              infos.push(info);
              return { kind: "completed", output: "done" };
            },
          },
        ],
        middleware: async (request, next) => {
          infos.push(request.info);
          return next();
        },
      })
      .build();
    let n = 0;
    const result = await runAgent(agent, {
      input: "go",
      info: { tenantId: "private-principal" },
      onEvent: (event) => {
        events.push(event);
      },
      onModelCall: async (call) => {
        expect(JSON.stringify(call)).not.toContain("private-principal");
        return n++ === 0 ? candidate("t") : "ok";
      },
    });
    expect(result.status).toBe("completed");
    expect(infos).toEqual([
      { tenantId: "private-principal" },
      { tenantId: "private-principal" },
      { tenantId: "private-principal" },
    ]);
    expect(JSON.stringify([result.state, events])).not.toContain("private-principal");
  });

  it("restores a registered tool selected by middleware without rerunning that condition", async () => {
    const used: unknown[] = [];
    const lookup = {
      name: "lookup",
      inputSchema: z.object({}),
      execute: async (_: unknown, { info }: { info?: { role: string } }) => {
        used.push({ tool: "lookup", info });
        return { kind: "completed" as const, output: "rows" };
      },
    };
    const purge = {
      name: "purge",
      inputSchema: z.object({}),
      execute: async (_: unknown, { info }: { info?: { role: string } }) => {
        used.push({ tool: "purge", info });
        return { kind: "completed" as const, output: "purged" };
      },
    };
    const make = (middlewareSeen: () => void) =>
      Agent<{ role: string }>({ id: "a", name: "A" })
        .use({
          id: "db",
          tools: [lookup, purge],
          middleware: async (request, next) => {
            middlewareSeen();
            request.configuration.tools.set(
              "db",
              request.info?.role === "admin" ? [purge] : [lookup],
            );
            const response = await next();
            for (const call of response.toolCalls())
              response.requireInteraction(call.id, { kind: "approval", prompt: "Proceed?" });
            return response;
          },
        })
        .build();
    const firstSeen = vi.fn();
    const first = await runAgent(make(firstSeen), {
      input: "purge",
      info: { role: "admin" },
      onModelCall: async () => candidate("purge"),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("Expected pause");
    const seen = vi.fn();
    const second = await runAgent(make(seen), {
      state: roundtrip(first.state),
      input: { kind: "approve", interactionId: first.pending[0]!.interaction!.id, approved: true },
      info: { role: "user" },
      onModelCall: async () => "done",
    });
    expect(second.status).toBe("completed");
    expect(used).toEqual([{ tool: "purge", info: { role: "user" } }]);
    expect(seen).toHaveBeenCalledTimes(1); // Only the next model step, never restoration.
  });

  it("restores deferred tools without rerunning already settled siblings", async () => {
    const done = vi.fn(async () => ({ kind: "completed" as const, output: "saved" }));
    const deferred = vi.fn(async () => ({ kind: "deferred" as const, token: { jobId: "123" } }));
    const make = () =>
      Agent({ id: "a", name: "A" })
        .use({
          id: "c",
          tools: [
            { name: "done", inputSchema: z.object({}), execute: done },
            { name: "job", inputSchema: z.object({}), execute: deferred },
          ],
        })
        .build();
    const first = await runAgent(make(), {
      input: "go",
      onModelCall: async () => ({
        output: [...candidate("done", "d").output, ...candidate("job", "j").output],
      }),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("Expected pause");
    const second = await runAgent(make(), {
      state: roundtrip(first.state),
      input: {
        kind: "settle",
        invocationId: first.pending[0]!.invocationId,
        outcome: { kind: "completed", output: "finished" },
      },
      onModelCall: async () => "ok",
    });
    expect(second.status).toBe("completed");
    expect(done).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveBeenCalledTimes(1);
    await expect(
      runAgent(make(), {
        state: second.state,
        input: {
          kind: "settle",
          invocationId: first.pending[0]!.invocationId,
          outcome: { kind: "completed", output: "again" },
        },
        onModelCall: async () => "bad",
      }),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
  });

  it("isolates info across concurrent invocations on the same built agent", async () => {
    const query = {
      name: "query",
      inputSchema: z.object({}),
      execute: async (_: unknown, { info }: { info?: { table: string } }) => ({
        kind: "completed" as const,
        output: info!.table,
      }),
    };
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = Agent<{ table: string }>({ id: "concurrent", name: "Concurrent" })
      .use({
        id: "db",
        tools: [query],
        middleware: async (_request, next) => {
          if (++entered === 2) release();
          await bothEntered;
          return next();
        },
      })
      .build();
    const run = (table: string) => {
      let n = 0;
      return runAgent(agent, {
        input: "query",
        info: { table },
        onModelCall: async () => (n++ === 0 ? candidate("query") : "done"),
      });
    };
    const [orders, customers] = await Promise.all([run("orders"), run("customers")]);
    expect(orders.status).toBe("completed");
    expect(customers.status).toBe("completed");
    expect(JSON.stringify(orders.state)).toContain("orders");
    expect(JSON.stringify(orders.state)).not.toContain("customers");
    expect(JSON.stringify(customers.state)).toContain("customers");
    expect(JSON.stringify(customers.state)).not.toContain("orders");
  });

  it("awaits recording before effects and stops on recording failure", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "ok" }));
    const agent = Agent({ id: "a", name: "A" })
      .use({ id: "c", tools: [{ name: "t", inputSchema: z.object({}), execute }] })
      .build();
    await expect(
      runAgent(agent, {
        input: "go",
        onModelCall: async () => candidate("t"),
        record: async (state) => {
          if (state.plan) throw new Error("disk full");
        },
      }),
    ).rejects.toMatchObject({ code: "execution.record-failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels cooperatively and retains settled tool results", async () => {
    const controller = new AbortController();
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "c",
        tools: [
          {
            name: "t",
            inputSchema: z.object({}),
            execute: async (_, { signal }) => {
              expect(signal).toBe(controller.signal);
              controller.abort();
              return { kind: "completed", output: "effect completed" };
            },
          },
        ],
      })
      .build();
    const model = vi.fn(async () => candidate("t"));
    const result = await runAgent(agent, {
      input: "go",
      signal: controller.signal,
      onModelCall: model,
    });
    expect(result.status).toBe("cancelled");
    expect(JSON.stringify(result.state)).toContain("effect completed");
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("validates agent output and rejects incompatible state before model calls", async () => {
    const agent = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ count: z.number() }),
    }).build();
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        expect(call.outputSchema).toBeDefined();
        return { output: [{ type: "json", value: { count: 3 } }] };
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 3 } });
    const invoke = vi.fn(async () => "bad");
    await expect(
      runAgent(Agent({ id: "a", name: "A" }).build(), {
        state: result.state,
        input: "again",
        onModelCall: invoke,
      }),
    ).rejects.toMatchObject({ code: "execution.incompatible" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

it("rejects obsolete or malformed run controls before effects", async () => {
  const agent = Agent({ id: "a", name: "A" }).build();
  const onModelCall = vi.fn(async () => "unexpected");
  for (const invalid of [
    { outputSchema: {} },
    { onEvent: "bad" },
    { record: "bad" },
    { signal: null },
  ]) {
    await expect(
      runAgent(agent, Object.assign({ input: "go", onModelCall }, invalid) as never),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
  }
  expect(onModelCall).not.toHaveBeenCalled();
});

it("cancels a saved pause without accepting or dispatching its pending actions", async () => {
  const execute = vi.fn(async () => ({ kind: "completed" as const, output: "effect" }));
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "c",
      tools: [{ name: "t", inputSchema: z.object({}), execute }],
      middleware: async (_, next) => {
        const response = await next();
        for (const call of response.toolCalls())
          response.requireInteraction(call.id, { kind: "approval", prompt: "Proceed?" });
        return response;
      },
    })
    .build();
  const first = await runAgent(agent, { input: "go", onModelCall: async () => candidate("t") });
  expect(first.status).toBe("paused");
  const model = vi.fn(async () => "unexpected");
  const result = await runAgent(agent, {
    state: roundtrip(first.state),
    input: { kind: "continue" },
    signal: AbortSignal.abort(),
    onModelCall: model,
  });
  expect(result.status).toBe("cancelled");
  expect(result.state.plan).toBeUndefined();
  expect(JSON.stringify(result.state)).toContain("tool.cancelled");
  expect(execute).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
});
