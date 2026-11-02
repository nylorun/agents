/**
 * `ask` (ADR-106, `nylorun-interactions`): the agent asks whoever gave it the task a question it
 * can't answer itself, and waits. Offered to the session's root agent when the version sets
 * `harness.loop.ask: true` (`turn.start.loop.ask`; in an `agent-folder/3` folder, the
 * `nylorun-interactions` plugin with its `ask` tool on).
 *
 * It runs here (`harness`), as `request_connection` does. A first call pauses the turn with an
 * interaction of kind `response` whose `metadata` is `{ kind: "question", choices?, why? }`, which
 * the session's waits carry and the A2A server shows as a question (`TASK_STATE_INPUT_REQUIRED`).
 * The answer (`respond`) runs it again, in the next segment, with the value: `Answer: <value>`.
 * A replayed call answers its recorded outcome.
 *
 * Long input is cut, never refused: the question at `ASK_LIMITS.questionChars`, the reason at
 * `whyChars`, each choice at `choiceChars`, and at most `choices` of them.
 */
import { ASK_LIMITS, ASK_TOOL } from "@nylorun/core/engine";
import type { HostEffect } from "../run/durable.js";
import { cut } from "./plan.js";

export { ASK_LIMITS, ASK_TOOL } from "@nylorun/core/engine";

/** True when `effect` is a call of `ask` (ours: a `harness` call). */
export function isAskTool(effect: HostEffect): boolean {
  return effect.target?.kind === "harness" && effect.toolName === ASK_TOOL;
}

/** The answer as the model reads it: a string as it is, anything else as JSON. */
function answerOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { answer?: unknown }).answer === "string"
  )
    return (value as { answer: string }).answer;
  return JSON.stringify(value ?? null);
}

/** Runs a call of `ask`: the interaction to wait on, or, once answered, the answer. */
export function runAskTool(effect: HostEffect) {
  const input = (effect.input ?? {}) as { question?: unknown; choices?: unknown; why?: unknown };
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question === "")
    return {
      kind: "failed",
      code: "ask.invalid_input",
      message: "Give question, what you need to know.",
    } as const;
  const choices = Array.isArray(input.choices)
    ? input.choices
        .filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
        .slice(0, ASK_LIMITS.choices)
        .map((choice) => cut(choice.trim(), ASK_LIMITS.choiceChars))
    : [];
  const why =
    typeof input.why === "string" && input.why.trim() !== ""
      ? cut(input.why.trim(), ASK_LIMITS.whyChars)
      : undefined;
  const resume = effect.context?.resume as { kind?: unknown; value?: unknown } | undefined;
  if (resume?.kind === "response")
    return { kind: "completed", output: `Answer: ${answerOf(resume.value)}` } as const;
  const prompt = cut(question, ASK_LIMITS.questionChars);
  return {
    kind: "interaction-required",
    interaction: {
      kind: "response",
      prompt,
      metadata: {
        kind: "question",
        ...(choices.length > 0 ? { choices } : {}),
        ...(why === undefined ? {} : { why }),
      },
    },
  } as const;
}
