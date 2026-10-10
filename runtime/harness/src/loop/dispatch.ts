import { HostSuspension } from "./host-suspension.js";
import { HarnessError, isHarnessError } from "@nylorun/core/define";
import { isToolError } from "@nylorun/core/define";
import type { ToolOutcome, ToolResult, ToolRunResult } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import { createId } from "../utils/ids.js";
import { copyJson } from "@nylorun/core/define";
import { createSessionStateBag } from "./initial-state.js";
import type { Invocation } from "./invocation.js";
import { toolResult } from "./tool-result.js";
import { isWaitSignal, WaitSignal } from "./waits.js";
import { INTERACTION_UNSUPPORTED, runDelegation } from "./delegation.js";
import { execute } from "./run.js";

export async function dispatchPlan(invocation: Invocation): Promise<"paused" | undefined> {
  const { signal, definitions, options, observe, record } = invocation;
  let plan = invocation.state.plan!;
  if (invocation.delegated && plan.calls.some((call) => call.status === "interaction")) {
    // Agents used as tools can't pause; the model sees why and can continue without the call.
    plan = {
      ...plan,
      calls: plan.calls.map((call) =>
        call.status === "interaction"
          ? copyJson({
              ...call,
              status: "settled" as const,
              result: unsupported(call.callId, call.toolName),
            })
          : call,
      ),
    };
    invocation.state = { ...invocation.state, plan };
  }
  if (
    plan.calls.some((call) => call.status === "interaction" && call.interactionPhase === "before")
  ) {
    for (const call of plan.calls)
      if (call.status === "interaction")
        observe({
          type: "interaction.required",
          turnId: plan.turnId,
          stepId: plan.stepId,
          interactionId: call.interaction!.id,
          kind: call.interaction!.kind,
          callId: call.callId,
          toolName: call.toolName,
          phase: "interaction",
          attributes: {
            prompt: call.interaction!.prompt,
            ...(call.interaction!.metadata ? { metadata: call.interaction!.metadata } : {}),
          },
        });
    return "paused";
  }
  signal.throwIfAborted();
  const pending = plan.calls.filter(
    (call) => call.status === "pending" || call.status === "active",
  );
  const redelivering = plan.calls.some((call) => call.status === "active");
  if (pending.length) {
    invocation.state = {
      ...invocation.state,
      plan: {
        ...plan,
        calls: plan.calls.map((call) =>
          call.status === "pending" || call.status === "active"
            ? { ...call, status: "active" }
            : call,
        ),
      },
    };
    await record();
    signal.throwIfAborted();
    const sessionBag = invocation.sessionBag;
    const stateApi = createSessionStateBag(sessionBag);
    const settled = await settleDispatch(
      pending.map(async (call) => {
        const definition = definitions.get(call.invocationId)!;
        const eventIds = {
          executionId: invocation.state.executionId,
          turnId: plan.turnId,
          stepId: plan.stepId,
          callId: call.callId,
          invocationId: call.invocationId,
          toolName: call.toolName,
          middlewareId: call.reference.capabilityId,
          slot: definition.owner.slot,
        };
        observe({ type: "tool.started", ...eventIds, attributes: { args: call.args } });
        let outcome: ToolOutcome;
        try {
          signal.throwIfAborted();

          if (definition.delegate) {
            const result = toolResult(
              call,
              definition,
              await runDelegation(
                invocation,
                execute,
                { ...eventIds, args: call.args },
                definition.delegate,
              ),
            );
            observe({
              type: "tool.completed",
              ...eventIds,
              outcome: result.kind,
              attributes: result,
            });
            return copyJson({ ...call, status: "settled" as const, result });
          }

          if (definition.approval && !call.resume) {
            const decision = await definition.approval(call.args as never);
            const prompt =
              typeof decision === "string"
                ? decision
                : decision === true
                  ? `Approve ${call.toolName}?`
                  : undefined;
            if (prompt) {
              return copyJson({
                ...call,
                status: "interaction" as const,
                interaction: {
                  kind: "approval" as const,
                  prompt,
                  id: createId("interaction"),
                },
                interactionPhase: "before" as const,
              });
            }
          }

          const stepMemos = new Map<string, JsonValue>();
          if (call.token && typeof call.token === "object" && !Array.isArray(call.token)) {
            const memos = (call.token as { steps?: Record<string, JsonValue> }).steps;
            if (memos) for (const [key, value] of Object.entries(memos)) stepMemos.set(key, value);
          }

          const raw = await definition.execute(call.args, {
            executionId: invocation.state.executionId,
            turnId: plan.turnId,
            stepId: plan.stepId,
            callId: call.callId,
            invocationId: call.invocationId,
            signal,
            info: options.info,
            onModelCall: options.onModelCall,
            idempotencyKey: call.callId,
            ...(redelivering || call.status === "active" ? { redelivery: true } : {}),
            state: stateApi,
            session: { id: invocation.state.executionId },
            agent: invocation.delegated ?? {
              id: invocation.agent.id,
              path: invocation.agent.id,
            },
            progress(message: string, data?: import("@nylorun/core/define").JsonObject) {
              observe({
                type: "tool.progress",
                ...eventIds,
                attributes: {
                  message,
                  ...(data === undefined ? {} : { data }),
                },
              });
            },
            async ask(prompt, opts) {
              if (call.resume?.kind === "response") return call.resume.value as JsonValue;
              throw new WaitSignal({
                kind: "interaction-required",
                interaction: {
                  kind: "response",
                  prompt,
                  ...(opts ? { metadata: opts } : {}),
                },
                wait: { kind: "ask", waitId: createId("wait") },
                token: { steps: Object.fromEntries(stepMemos) },
              });
            },
            async approve(prompt) {
              if (call.resume?.kind === "approval") return Boolean(call.resume.approved);
              throw new WaitSignal({
                kind: "interaction-required",
                interaction: { kind: "approval", prompt },
                wait: { kind: "approve", waitId: createId("wait") },
                token: { steps: Object.fromEntries(stepMemos) },
              });
            },
            async sleep(duration) {
              throw new WaitSignal({
                kind: "deferred",
                wait: { kind: "sleep", waitId: createId("wait") },
                token: { steps: Object.fromEntries(stepMemos), duration },
              });
            },
            async waitFor(event, opts) {
              throw new WaitSignal({
                kind: "deferred",
                wait: { kind: "waitFor", waitId: createId("wait"), name: event },
                token: { steps: Object.fromEntries(stepMemos), event, ...(opts ?? {}) },
              });
            },
            async step(name, fn) {
              if (stepMemos.has(name)) return stepMemos.get(name) as never;
              const value = await fn();
              stepMemos.set(name, value as JsonValue);
              return value;
            },
            ...(call.resume ? { resume: call.resume } : {}),
          });
          outcome = normalizeOutcome(raw);
          if (!outcome || typeof outcome !== "object")
            throw new HarnessError("tool.invalid-tool-result", "Tool returned an invalid outcome");
          if (
            invocation.delegated &&
            (outcome.kind === "interaction-required" || outcome.kind === "deferred")
          )
            outcome = {
              kind: "failed",
              code: "delegation.interaction-unsupported",
              message: INTERACTION_UNSUPPORTED,
            };
          if (outcome.kind === "interaction-required") {
            if (
              !["approval", "response"].includes(outcome.interaction.kind) ||
              typeof outcome.interaction.prompt !== "string"
            )
              throw new HarnessError(
                "tool.invalid-tool-result",
                "Tool returned an invalid interaction",
              );
            return copyJson({
              ...call,
              status: "interaction" as const,
              interaction: {
                ...outcome.interaction,
                id: outcome.interaction.id ?? createId("interaction"),
              },
              interactionPhase: "execute" as const,
              ...(outcome.token === undefined ? {} : { token: outcome.token }),
            });
          }
          if (outcome.kind === "deferred") {
            observe({
              type: "tool.deferred",
              ...eventIds,
              attributes: outcome.token === undefined ? {} : { token: outcome.token },
            });
            return copyJson({
              ...call,
              status: "deferred" as const,
              ...(outcome.token === undefined ? {} : { token: outcome.token }),
            });
          }
          const result = toolResult(call, definition, outcome);
          observe({
            type: "tool.completed",
            ...eventIds,
            outcome: result.kind,
            attributes: result,
          });
          return copyJson({ ...call, status: "settled" as const, result });
        } catch (cause) {
          if (cause instanceof HostSuspension) throw cause;
          if (isWaitSignal(cause) && invocation.delegated) {
            const result = unsupported(call.callId, call.toolName);
            observe({
              type: "tool.completed",
              ...eventIds,
              outcome: result.kind,
              attributes: result,
            });
            return copyJson({ ...call, status: "settled" as const, result });
          }
          if (isWaitSignal(cause)) {
            if (cause.outcome.kind === "interaction-required") {
              return copyJson({
                ...call,
                status: "interaction" as const,
                interaction: {
                  ...cause.outcome.interaction,
                  id: createId("interaction"),
                },
                interactionPhase: "execute" as const,
                wait: cause.outcome.wait,
                ...(cause.outcome.token === undefined ? {} : { token: cause.outcome.token }),
              });
            }
            observe({
              type: "tool.deferred",
              ...eventIds,
              attributes: cause.outcome.token === undefined ? {} : { token: cause.outcome.token },
            });
            return copyJson({
              ...call,
              status: "deferred" as const,
              wait: cause.outcome.wait,
              ...(cause.outcome.token === undefined ? {} : { token: cause.outcome.token }),
            });
          }
          if (isToolError(cause)) {
            const result: ToolResult = {
              callId: call.callId,
              toolName: call.toolName,
              kind: "failed",
              code: cause.code,
              message: cause.message,
            };
            observe({
              type: "tool.completed",
              ...eventIds,
              outcome: result.kind,
              attributes: result,
            });
            return copyJson({ ...call, status: "settled" as const, result });
          }
          const result: ToolResult = {
            callId: call.callId,
            toolName: call.toolName,
            kind: "failed",
            code: signal.aborted
              ? "tool.cancelled"
              : isHarnessError(cause)
                ? cause.code
                : "tool.execution-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          };
          observe({
            type: "tool.completed",
            ...eventIds,
            outcome: result.kind,
            attributes: result,
          });
          return copyJson({ ...call, status: "settled" as const, result });
        }
      }),
    );
    const byId = new Map(settled.map((call) => [call.invocationId, call]));
    plan = { ...plan, calls: plan.calls.map((call) => byId.get(call.invocationId) ?? call) };
    invocation.state = {
      ...invocation.state,
      plan,
    };
    await record();
  }
  signal.throwIfAborted();
  if (plan.calls.some((call) => call.status === "interaction" || call.status === "deferred")) {
    for (const call of plan.calls)
      if (call.status === "interaction")
        observe({
          type: "interaction.required",
          turnId: plan.turnId,
          stepId: plan.stepId,
          interactionId: call.interaction!.id,
          kind: call.interaction!.kind,
          callId: call.callId,
          toolName: call.toolName,
          phase: call.interactionPhase === "before" ? "interaction" : "execute",
          attributes: {
            prompt: call.interaction!.prompt,
            ...(call.interaction!.metadata ? { metadata: call.interaction!.metadata } : {}),
          },
        });
    return "paused";
  }
  const results = [
    ...plan.immediate,
    ...plan.calls.flatMap((call) => (call.result ? [call.result] : [])),
  ];
  const ordered = plan.order.map((item) =>
    results.find((result) => result.callId === item.callId && result.toolName === item.toolName)!,
  );
  const { plan: _, ...rest } = invocation.state;
  invocation.state = {
    ...rest,
    transcript: [
      ...invocation.state.transcript,
      { kind: "tool-results", turnId: plan.turnId, stepId: plan.stepId, results: ordered },
    ],
  };
  await record();
}

function unsupported(callId: string, toolName: string): ToolResult {
  return {
    callId,
    toolName,
    kind: "failed",
    code: "delegation.interaction-unsupported",
    message: INTERACTION_UNSUPPORTED,
  };
}

function normalizeOutcome(raw: ToolRunResult): ToolOutcome {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: string }).kind;
    if (
      kind === "completed" ||
      kind === "denied" ||
      kind === "failed" ||
      kind === "interaction-required" ||
      kind === "deferred"
    )
      return raw as ToolOutcome;
  }
  return { kind: "completed", output: raw as JsonValue };
}

// Persist all parallel action intents before handing control back to a durable host.
async function settleDispatch<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
