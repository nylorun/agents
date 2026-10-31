/**
 * `update_plan` (A2A profile v2, `progress/v1`): the agent keeps its plan, a short list of steps
 * with their states, which callers see while it works. Offered to the session's root agent when
 * the version the session runs sets `harness.loop.plan: true` (`turn.start.loop.plan`; in an agent
 * folder, `loop: { plan: true }` in `AGENT.md`). It runs here (`harness`): each call claims one
 * durable `plan.updated` event with the whole plan, never a diff, over the Harness API's `event`
 * request. A replayed call answers its recorded outcome and claims nothing again.
 *
 * Long input is cut, never refused: at most `PLAN_LIMITS.steps` steps (the first ones), a label of
 * at most `labelChars` and a note of at most `noteChars`, each cut ending in `…`.
 */
import {
  PLAN_LIMITS,
  PLAN_STEP_STATES,
  type PlanStep,
  type PlanStepState,
} from "@nylorun/core/contracts";
import { HarnessApiError, type EffectTarget, type HarnessChannel } from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import type { HarnessRun } from "../api/executors.js";

/** The tool's name. */
export const UPDATE_PLAN_TOOL = "update_plan";
/** What a call answers. */
export const PLAN_UPDATED = "Plan updated";

const HARNESS: EffectTarget = Object.freeze({ kind: "harness" });

const DESCRIPTION = [
  "Keep your plan for this task: a short list of steps, each with a state, which the person or agent who asked sees while you work.",
  "Pass the whole plan each time, never only the changes: the steps in order, each with a label (a few words) and a state (pending, active, done, blocked or skipped), and optionally a note (a short fact, such as why a step is blocked).",
  `At most ${PLAN_LIMITS.steps} steps; a label is cut at ${PLAN_LIMITS.labelChars} characters and a note at ${PLAN_LIMITS.noteChars}.`,
  "Never put tool arguments, results, secrets or file contents in a label or note.",
].join(" ");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      description: `The whole plan, in order: at most ${PLAN_LIMITS.steps} steps.`,
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            minLength: 1,
            description: `What the step does, in a few words (at most ${PLAN_LIMITS.labelChars} characters).`,
          },
          state: { type: "string", enum: [...PLAN_STEP_STATES], description: "The step's state." },
          note: {
            type: "string",
            description: `A short fact about the step (at most ${PLAN_LIMITS.noteChars} characters).`,
          },
        },
        required: ["label", "state"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

const INSTRUCTIONS =
  "For work of several steps, keep your plan with update_plan: set it when you start, and call it again, with the whole plan, as each step starts, finishes or is blocked.";

/** The tool, and the text the model reads with it. */
export function planTool(): { tool: DurableSessionTool; instructions: string } {
  return {
    tool: {
      name: UPDATE_PLAN_TOOL,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA as unknown as DurableSessionTool["inputSchema"],
      target: HARNESS,
    },
    instructions: INSTRUCTIONS,
  };
}

/** True when `effect` is a call of `update_plan` (ours: a `harness` call). */
export function isPlanTool(effect: HostEffect): boolean {
  return effect.target?.kind === "harness" && effect.toolName === UPDATE_PLAN_TOOL;
}

/** `text` cut to at most `max` UTF-16 units, ending in `…` when cut, never inside a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

const STATES: ReadonlySet<string> = new Set(PLAN_STEP_STATES);

/** The plan a call's input states, cut to the limits; a string naming the problem when it is not one. */
export function planOf(input: unknown): { steps: PlanStep[]; dropped: number } | string {
  const steps = (input as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) return "Give steps: the whole plan, as a list of { label, state, note? }.";
  const plan: PlanStep[] = [];
  for (const [index, raw] of steps.slice(0, PLAN_LIMITS.steps).entries()) {
    const step = (raw ?? {}) as { label?: unknown; state?: unknown; note?: unknown };
    const label = typeof step.label === "string" ? step.label.trim() : "";
    if (label === "") return `Step ${index + 1} has no label.`;
    if (typeof step.state !== "string" || !STATES.has(step.state))
      return `Step ${index + 1}'s state is one of ${PLAN_STEP_STATES.join(", ")}.`;
    if (step.note !== undefined && typeof step.note !== "string")
      return `Step ${index + 1}'s note is text.`;
    const note = typeof step.note === "string" ? step.note.trim() : "";
    plan.push({
      label: cut(label, PLAN_LIMITS.labelChars),
      state: step.state as PlanStepState,
      ...(note === "" ? {} : { note: cut(note, PLAN_LIMITS.noteChars) }),
    });
  }
  return { steps: plan, dropped: Math.max(0, steps.length - PLAN_LIMITS.steps) };
}

/** What a call of `update_plan` runs with. */
export interface PlanToolContext {
  readonly channel: Pick<HarnessChannel, "request">;
  readonly run: HarnessRun;
  readonly signal: AbortSignal;
}

/** Answers that say the run is no longer this harness's to go on with. */
const LOST: ReadonlySet<string> = new Set(["ownership_lost", "run_not_held", "turn_cancelled"]);

/**
 * Runs a call of `update_plan`: claims `plan.updated` with the whole plan for the run's turn, and
 * answers `Plan updated`. A malformed plan, or a claim the Runtime refuses (one that does not
 * know `plan.updated`), is a failed outcome the model sees; a run this harness no longer holds
 * throws.
 */
export async function runPlanTool(effect: HostEffect, context: PlanToolContext) {
  const plan = planOf(effect.input);
  if (typeof plan === "string")
    return { kind: "failed", code: "plan.invalid_input", message: plan } as const;
  const { channel, run, signal } = context;
  try {
    await channel.request(
      "event",
      {
        runId: run.runId,
        sessionId: run.grant.sessionId,
        turnId: run.grant.turnId,
        type: "plan.updated",
        payload: { steps: plan.steps },
      },
      signal,
    );
  } catch (error) {
    if (signal.aborted || !(error instanceof HarnessApiError) || LOST.has(error.code)) throw error;
    return { kind: "failed", code: "plan.not_recorded", message: `The plan was not recorded: ${error.message}` } as const;
  }
  return {
    kind: "completed",
    output:
      plan.dropped === 0
        ? PLAN_UPDATED
        : `${PLAN_UPDATED}: only the first ${PLAN_LIMITS.steps} steps were kept.`,
  } as const;
}
