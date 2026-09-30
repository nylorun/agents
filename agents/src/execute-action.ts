import {
  delegateOf,
  implementationsFor,
  isBuiltWorkflow,
  isToolError,
  normalizeToolDefinition,
  normalizedSchemasFor,
  runHookPoint,
  type BoundToolDefinition,
  type BuiltAgent,
  type BuiltWorkflow,
  type JsonValue,
  type ToolExecutionContext,
  type WorkflowBinding,
} from "@nylorun/core/define";
import type { Action, ActionOutcome } from "@nylorun/core/contracts";
import type { ActionSandbox } from "./sandbox/client.js";

class Suspend {
  constructor(readonly outcome: unknown) {}
}
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

export type ExecutableDefinition = BuiltAgent | BuiltWorkflow;

export type ExecuteActionOptions = {
  /** Claim-scoped sandbox client; omitted when the session has no sandbox. */
  readonly sandbox?: ActionSandbox;
};

/** Executes code only after a host-issued claim. No engine dependency. */
export async function executeAction(
  action: Action,
  root: ExecutableDefinition,
  signal: AbortSignal,
  options: ExecuteActionOptions = {},
): Promise<ActionOutcome> {
  const sandbox = options.sandbox;
  if (action.kind === "fn" || action.kind === "verify") {
    if (!isBuiltWorkflow(root))
      throw new Error(`Action ${action.kind} requires a workflow definition`);
    return executeWorkflowFn(action, root.getBinding(), signal, sandbox);
  }
  if (isBuiltWorkflow(root)) {
    if (action.kind === "tool" && "key" in action && typeof action.key === "string")
      return executeWorkflowTool(
        action as Extract<Action, { kind: "tool" }> & { key: string },
        root.getBinding(),
        signal,
        sandbox,
      );
    throw new Error(`Unsupported action kind ${action.kind} on workflow`);
  }
  // Work for an agent used as a tool runs that agent's code, served from the root's binding.
  const agent = action.agent ? delegatedAgent(root, action.agent.id) : root;
  const ref = action.agent ?? { id: root.id, path: root.id };
  if (action.kind === "hook")
    // All capabilities at this hook point run concurrently in one action. Never throws.
    return {
      value: {
        results: await runHookPoint(
          implementationsFor(agent),
          action.hook,
          action.input
        ),
      },
    };
  if (action.kind !== "tool" || !("capabilityId" in action))
    throw new Error(`Unsupported action kind ${action.kind}`);
  const impl = implementationsFor(agent)[action.capabilityId];
  if (!impl) throw new Error(`No capability ${action.capabilityId}`);
  const raw = impl.tools?.[action.toolName];
  if (!raw) throw new Error("Missing tool implementation");
  const tool = normalizeToolDefinition(raw);
  return runTool(action, tool, ref, signal, sandbox);
}

/**
 * True when `action` runs a tool marked `background` (`ToolDefinition.background`): an Action
 * endpoint answers its delivery at once and posts the outcome later. False for anything it
 * cannot find; `executeAction` reports those.
 */
export function runsInBackground(action: Action, root: ExecutableDefinition): boolean {
  if (action.kind !== "tool") return false;
  try {
    if (isBuiltWorkflow(root)) {
      const key = (action as { key?: unknown }).key;
      const impl = typeof key === "string" ? root.getBinding().nodes[key] : undefined;
      return impl?.kind === "tool" && (impl.tool as { background?: boolean }).background === true;
    }
    if (!("capabilityId" in action)) return false;
    const agent = action.agent ? delegatedAgent(root, action.agent.id) : root;
    const raw = implementationsFor(agent)[action.capabilityId]?.tools?.[action.toolName];
    return raw !== undefined && normalizeToolDefinition(raw).background === true;
  } catch {
    return false;
  }
}

async function executeWorkflowTool(
  action: Extract<Action, { kind: "tool" }> & { key: string },
  binding: WorkflowBinding,
  signal: AbortSignal,
  sandbox: ActionSandbox | undefined,
): Promise<ActionOutcome> {
  const impl = binding.nodes[action.key];
  if (!impl || impl.kind !== "tool")
    throw new Error(`No tool implementation for key ${action.key}`);
  const path =
    "path" in action && typeof action.path === "string" ? action.path : action.key;
  return runTool(
    action,
    impl.tool,
    { id: action.agentId, path },
    signal,
    sandbox,
  );
}

async function runTool(
  action: Extract<Action, { kind: "tool" }>,
  raw: BoundToolDefinition | Parameters<typeof normalizeToolDefinition>[0],
  ref: { id: string; path: string; delegationId?: string },
  signal: AbortSignal,
  sandbox: ActionSandbox | undefined,
): Promise<ActionOutcome> {
  const tool =
    "execute" in raw && typeof raw.execute === "function" && "inputSchema" in raw
      ? (raw as BoundToolDefinition)
      : normalizeToolDefinition(raw as Parameters<typeof normalizeToolDefinition>[0]);
  const schemas =
    "inputSchema" in tool && tool.inputSchema && "validate" in tool.inputSchema
      ? {
          inputSchema: tool.inputSchema,
          outputSchema:
            "outputSchema" in tool ? tool.outputSchema : undefined,
        }
      : normalizedSchemasFor(tool as Parameters<typeof normalizedSchemasFor>[0]);
  const input = schemas.inputSchema.validate(action.input);
  if (!input.ok)
    return {
      value: {
        kind: "failed",
        code: "tool.invalid-input",
        message: JSON.stringify(input.issues),
      },
    };
  const ctx = action.context;
  const state: Record<string, JsonValue> = { ...object(ctx.state) };
  const statePatch: Record<string, JsonValue> = {};
  const resume = object(ctx.resume);
  const token = object(resume.token);
  const memo = object(token._nylorun);
  const steps: Record<string, JsonValue> = { ...object(memo.steps) };
  const answers: Record<string, JsonValue> = { ...object(memo.answers) };
  let waitIndex = 0;
  let gateApproved =
    Boolean(memo.gateApproved) ||
    Boolean(memo.approvalGate && resume.kind === "approval" && resume.approved);
  const durableToken = (extra: Record<string, unknown> = {}) => ({
    _nylorun: { steps, answers, waitIndex, gateApproved, ...extra },
  });
  const wait = async (
    kind: "approval" | "response",
    prompt: string,
    metadata?: any
  ): Promise<any> => {
    const index = String(waitIndex++);
    if (index in answers) return answers[index];
    if (
      !memo.approvalGate &&
      resume.kind === kind &&
      Number(memo.waitIndex ?? 0) === Number(index)
    ) {
      const answer =
        kind === "approval" ? Boolean(resume.approved) : resume.value;
      answers[index] = answer;
      return answer;
    }
    throw new Suspend({
      kind: "interaction-required",
      interaction: { kind, prompt, ...(metadata ? { metadata } : {}) },
      token: {
        _nylorun: { steps, answers, waitIndex: Number(index), gateApproved },
      },
    });
  };
  const context: ToolExecutionContext & { sandbox?: ActionSandbox } = {
    executionId: String(ctx.executionId ?? action.sessionId),
    turnId: String(ctx.turnId ?? action.turnId),
    stepId: String(ctx.stepId ?? ""),
    callId: String(ctx.callId ?? action.actionId),
    invocationId: String(ctx.invocationId ?? action.actionId),
    idempotencyKey: String(ctx.idempotencyKey ?? action.actionId),
    signal,
    info: ctx.info,
    session: { id: action.sessionId },
    agent: ref,
    ...(ctx.resume ? { resume: ctx.resume as any } : {}),
    ...(sandbox ? { sandbox } : {}),
    state: {
      get: (key) => state[key],
      set: (key, value) => {
        state[key] = value;
        statePatch[key] = value;
      },
      entries: () => ({ ...state }),
    },
    progress() {
      /* Canonical events are host-owned; progress transport is deferred. */
    },
    ask: (prompt, options) => wait("response", prompt, options),
    approve: (prompt) => wait("approval", prompt),
    sleep: async (duration) => {
      throw new Suspend({
        kind: "deferred",
        token: durableToken({ wait: { kind: "sleep", duration } }),
      });
    },
    waitFor: async (event, options) => {
      throw new Suspend({
        kind: "deferred",
        token: durableToken({ wait: { kind: "waitFor", event, ...options } }),
      });
    },
    step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      if (Object.prototype.hasOwnProperty.call(steps, name))
        return steps[name] as T;
      signal.throwIfAborted();
      const value = await fn();
      // Memoized values are durable only with a persisted action outcome. Interrupted actions stay uncertain.
      steps[name] = JSON.parse(JSON.stringify(value ?? null));
      return value;
    },
  };
  try {
    signal.throwIfAborted();
    const approval =
      "approval" in tool ? (tool as BoundToolDefinition).approval : undefined;
    if (approval && !gateApproved) {
      const result = await approval(input.value);
      if (result)
        throw new Suspend({
          kind: "interaction-required",
          interaction: {
            kind: "approval",
            prompt:
              typeof result === "string"
                ? result
                : `Approve ${"name" in tool ? tool.name : "tool"}?`,
          },
          token: durableToken({ approvalGate: true }),
        });
      gateApproved = true;
    }
    if (resume.kind === "approval" && resume.approved === false)
      return { value: { kind: "denied", reason: "Approval denied" } };
    const execute =
      "execute" in tool && typeof tool.execute === "function"
        ? tool.execute
        : undefined;
    if (!execute) throw new Error("Missing tool implementation");
    const value = await execute(input.value, context);
    const tagged = object(value);
    let outcome: any;
    if (
      [
        "completed",
        "failed",
        "denied",
        "interaction-required",
        "deferred",
      ].includes(tagged.kind)
    )
      outcome = value;
    else outcome = { kind: "completed", output: value ?? null };
    if (outcome.kind === "completed" && schemas.outputSchema) {
      const parsed = schemas.outputSchema.validate(outcome.output);
      outcome = parsed.ok
        ? { ...outcome, output: parsed.value }
        : {
            kind: "failed",
            code: "tool.invalid-output",
            message: JSON.stringify(parsed.issues),
          };
    }
    return { value: outcome, statePatch };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      value:
        error instanceof Suspend
          ? error.outcome
          : {
              kind: "failed",
              code: isToolError(error) ? error.code : "tool.execution-failed",
              message: message(error),
            },
      statePatch,
    };
  }
}

async function executeWorkflowFn(
  action: Extract<Action, { kind: "fn" | "verify" }>,
  binding: WorkflowBinding,
  signal: AbortSignal,
  sandbox: ActionSandbox | undefined,
): Promise<ActionOutcome> {
  const impl = binding.nodes[action.key];
  if (!impl || impl.kind !== action.kind)
    throw new Error(`No ${action.kind} implementation for key ${action.key}`);
  signal.throwIfAborted();
  try {
    // Verify may receive a tool-like context later (L3/L4); tracer passes input only.
    const value =
      action.kind === "verify"
        ? await (impl.fn as (args: unknown, ctx?: unknown) => unknown)(
            action.input,
            {
              signal,
              info: action.context.info,
              session: { id: action.sessionId },
              ...(sandbox ? { sandbox } : {}),
              step: async <T>(_name: string, fn: () => Promise<T> | T) => fn(),
              approve: async () => {
                throw new Error("Approvals in verify are not available in the tracer");
              },
              ask: async () => {
                throw new Error("ask in verify is not available in the tracer");
              },
              progress() {},
            },
          )
        : await (impl.fn as (args: unknown) => unknown)(action.input);
    return { value };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      value: {
        kind: "failed",
        code: action.kind === "verify" ? "loop.verify-failed" : "fn.failed",
        message: message(error),
      },
    };
  }
}

function delegatedAgent(root: BuiltAgent, id: string): BuiltAgent {
  for (const capability of Object.values(implementationsFor(root))) {
    const child = delegateOf(capability.tools?.[id])?.agent;
    if (child) return child;
  }
  throw new Error(`Agent '${root.id}' does not use '${id}' as a tool`);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
