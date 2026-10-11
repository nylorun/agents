/**
 * The fixture model (R4.3): a deterministic, scripted model the Model Gate answers with when the
 * Tenant's setting `model.fixture` is on (`PUT /v1/tenant/config/seed {fixtureModel: true}`).
 * The gate answers it itself, metered like any model (a `model_usage` row per call, provider
 * `fixture`, tokens counted from the text, cost 0), so every harness that calls the gate is seen
 * the same way: ours, and one written from the published contract (`@nylorun/harness-conformance`).
 *
 * What it answers is read from the call: the last user message and the offered tools.
 * - `conformance:text`: one text answer, `conformance ok`.
 * - `conformance:tool <name> <json>`: one call of the offered tool `<name>` with `<json>` as its
 *   arguments; once the tool's result is in the prompt, a text answer that quotes it.
 * - `conformance:budget`: a `budget_exhausted` failure.
 * - `conformance:slow <seconds>`: a text answer after that long (at most 60 s), or nothing once
 *   the call is aborted, for cancel checks.
 * - Anything else keeps the release demo: with a `lookup_order` tool it looks up order
 *   `demo-123` once, then answers with the result; on a later user message it says what the
 *   first one was; otherwise it says hello.
 */
import type { ModelCandidate, ModelFailureOutcome, PromptItem } from "@nylorun/core/harness-api";
import type { RuntimeModelCall } from "../contracts.js";

export const FIXTURE_PROVIDER = "fixture";

const MARKER = /^conformance:(\w+)(?:\s+([\s\S]*))?$/;

type Answer = ModelCandidate | ModelFailureOutcome;

/** The fixture model's answer to `call`. */
export async function fixtureAnswer(call: RuntimeModelCall, signal?: AbortSignal): Promise<Answer> {
  const last = call.prompt.at(-1);
  const users = call.prompt.filter(
    (item): item is Extract<PromptItem, { kind: "message" }> => item.kind === "message" && item.role === "user"
  );
  const marker = MARKER.exec(textOf(users.at(-1)?.content ?? []).trim());
  if (marker) return conformance(call, marker[1]!, marker[2]?.trim() ?? "", last, signal);
  if (last?.kind === "tool-result") return candidate(call, `Order lookup complete: ${textOf(last.content, true)}`);
  if (users.length > 1) return candidate(call, `I remember: ${textOf(users[0]!.content)}`);
  if (!call.tools.some((tool) => tool.name === "lookup_order"))
    return candidate(call, "Hello from the fixture model.");
  return candidate(call, [{ type: "tool-call", id: "fixture_lookup", name: "lookup_order", args: { orderId: "demo-123" } }]);
}

async function conformance(
  call: RuntimeModelCall,
  kind: string,
  rest: string,
  last: PromptItem | undefined,
  signal: AbortSignal | undefined
): Promise<Answer> {
  switch (kind) {
    case "text":
      return candidate(call, "conformance ok");
    case "tool": {
      if (last?.kind === "tool-result")
        return candidate(call, `conformance tool ${last.status}: ${textOf(last.content, true)}`);
      const space = rest.indexOf(" ");
      const name = space < 0 ? rest : rest.slice(0, space);
      if (!call.tools.some((tool) => tool.name === name))
        return candidate(call, `conformance: no tool ${name} is offered`);
      let args: unknown = {};
      try {
        if (space >= 0) args = JSON.parse(rest.slice(space + 1));
      } catch {
        return candidate(call, "conformance: the tool arguments are not JSON");
      }
      if (typeof args !== "object" || args === null || Array.isArray(args))
        return candidate(call, "conformance: the tool arguments are not an object");
      return candidate(call, [{ type: "tool-call", id: "conformance_call", name, args: args as Record<string, never> }]);
    }
    case "budget":
      return {
        kind: "failed",
        code: "budget_exhausted",
        message: "The fixture model's budget is exhausted (conformance:budget)",
        retryable: false,
      };
    case "slow": {
      const seconds = Math.min(Math.max(Number(rest) || 0, 0), 60);
      await sleep(seconds * 1000, signal);
      return candidate(call, `conformance slept ${seconds} s`);
    }
    default:
      return candidate(call, `conformance: unknown marker ${kind}`);
  }
}

function candidate(call: RuntimeModelCall, output: string | ModelCandidate["output"]): ModelCandidate {
  const blocks: ModelCandidate["output"] = typeof output === "string" ? [{ type: "text", text: output }] : output;
  const inputTokens = tokens(JSON.stringify(call.prompt));
  const outputTokens = tokens(JSON.stringify(blocks));
  return {
    output: blocks,
    finishReason: blocks.some((block) => block.type === "tool-call") ? "tool-calls" : "stop",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd: 0 },
    evidence: {
      resolvedModel: FIXTURE_PROVIDER,
      extras: { producer: { provider: FIXTURE_PROVIDER, model: FIXTURE_PROVIDER }, costKnown: true },
    },
  };
}

/** About four characters a token, at least one. */
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function textOf(content: readonly { type: string; text?: string }[], json = false): string {
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : json ? JSON.stringify(part) : ""))
    .join(" ");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}
