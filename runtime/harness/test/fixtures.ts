import { runAgent } from "./run-agent.js";
import { z } from "zod";
import { createExecutionState } from "../src/run/index.js";
import {
  Agent,
  AgentBuildError,
  tool as typedTool,
  type AgentTool,
  type BuiltAgent,
  type CapabilityInput,
  type JsonObject,
  type ModelCandidate,
  type ModelAdapter,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutcome,
} from "@nylorun/core/define";
export const objectSchema = z.object({}).passthrough();

/** Test-only convenience for existing pipeline assertions. All execution uses Promise run(). */
export function testAgent(options: any = {}): any {
  let builder = Agent({
    id: options.id ?? "test",
    name: options.name ?? "Test",
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  });
  let adapter: ModelAdapter;
  let built: any;
  const fixture: any = {
    get id() {
      return builder.id;
    },
    get name() {
      return builder.name;
    },
  };
  fixture.with = (value: ModelAdapter) => {
    adapter = value;
    return fixture;
  };
  fixture.tools = (...tools: (ToolDefinition<any, any, any> | AgentTool)[]) => {
    builder = builder.tools(...tools);
    return fixture;
  };
  fixture.instructions = (...text: string[]) => {
    builder = builder.instructions(...text);
    return fixture;
  };
  /** Adds a part with its own id, as the SDK's `.skills()` and `.plugin()` do. */
  fixture.part = (declaration: CapabilityInput) => {
    builder = addPart(builder, declaration);
    return fixture;
  };
  fixture.build = () => {
    if (built) return built;
    const agent = builder.build();
    return (built = {
      ...agent,
      run: (options: any = {}) => fixtureSession(agent, adapter, options),
    });
  };
  return fixture;
}
function fixtureSession(agent: BuiltAgent, adapter: ModelAdapter, options: any): any {
  let state: any = options.state ?? {
    ...createExecutionState(agent),
    ...(options.id === undefined ? {} : { executionId: options.id }),
  };
  const observers = new Set<any>();
  const controller = new AbortController();
  let last: Promise<any> = Promise.resolve();
  const session: any = {
    id: options.id ?? crypto.randomUUID(),
    get state() {
      return state
        ? {
            ...state,
            status: ["ready", "completed"].includes(state.status)
              ? "idle"
              : state.status === "paused"
                ? "waiting"
                : state.status === "failed"
                  ? "stopped"
                  : state.status,
            pendingInteraction: state.plan?.calls.find((call: any) => call.status === "interaction")
              ?.interaction,
          }
        : { transcript: [], status: "idle", turnCount: 0 };
    },
    observe(listener: any) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    input(input: any, controls: any = {}) {
      const before = state?.transcript.length ?? 0;
      const completed = runAgent(agent, {
        state,
        input,
        info: options.info ?? {
          userId: options.userId,
          ...(options.context === undefined ? {} : { context: options.context }),
        },
        signal: controls.signal ?? controller.signal,
        onModelCall: options.onModelCall ?? adapter,
        onEvent: (event) => {
          options.observer?.(event);
          for (const listener of observers) listener(event);
        },
      }).then((result) => {
        state = result.state;
        const events: any[] = result.state.transcript.slice(before).flatMap((entry: any) =>
          entry.kind === "input"
            ? [{ type: "input", event: entry.event, turnId: entry.turnId }]
            : entry.kind === "candidate"
              ? [
                  {
                    type: "candidate",
                    candidate: entry.candidate,
                    turnId: entry.turnId,
                    stepId: entry.stepId,
                  },
                ]
              : entry.kind === "final"
                ? [{ type: "final", output: entry.output, turnId: entry.turnId }]
                : [],
        );
        if (result.status === "failed") events.push({ type: "tripwire", tripwire: result.error });
        if (result.status === "paused")
          for (const call of result.pending)
            if (call.interaction)
              events.push({ type: "interaction.required", interaction: call.interaction });
        return { status: result.status === "paused" ? "waiting" : result.status, events };
      });
      last = completed;
      return { completed };
    },
    continue() {
      return session.input({ kind: "continue" });
    },
    async stop() {
      controller.abort();
      await last.catch(() => {});
    },
  };
  return session;
}

export function tool(
  name = "echo",
  execute: ToolDefinition["execute"] = async (args) => ({ kind: "completed", output: args }),
) {
  return typedTool({ name, inputSchema: objectSchema, execute });
}

export function execution(
  execute?: (
    call: { readonly args: JsonObject; readonly callId?: string; readonly toolName?: string },
    context: ToolExecutionContext,
  ) => Promise<ToolOutcome>,
): ToolDefinition["execute"] {
  return async (args, context) =>
    execute
      ? execute({ args: args as JsonObject }, context)
      : { kind: "completed" as const, output: args as JsonObject };
}

/** Identity helper that types an inline model adapter. */
export function model(invoke: ModelAdapter): ModelAdapter {
  return invoke;
}

export function toolCalls(
  ...calls: readonly { readonly id: string; readonly name: string; readonly args?: JsonObject }[]
): ModelCandidate {
  return {
    output: calls.map((call) => ({
      type: "tool-call" as const,
      id: call.id,
      name: call.name,
      args: call.args ?? {},
    })),
  };
}

export function expectBuildError(build: () => unknown): AgentBuildError {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError) return error;
    throw error;
  }
  throw new Error("expected AgentBuildError");
}

export function turn(agent: any, input: any = "go", options: any = {}) {
  const session = agent.run(options);
  return { session, handle: session.input(input, { signal: options.signal }) };
}

/** Adds a raw definition part with a chosen id (the protected `withPart` the SDK uses). */
export function addPart<B>(builder: B, declaration: CapabilityInput): B {
  return (builder as unknown as { withPart(d: CapabilityInput, method: string): B }).withPart(
    declaration,
    "part()",
  );
}
