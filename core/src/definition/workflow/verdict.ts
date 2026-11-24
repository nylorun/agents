import { z } from "zod";
import type { Verdict as VerdictValue } from "../../types/workflow.js";

/**
 * Zod schema for Loop verify outcomes.
 * Extensible via `.extend({ data: ... })` as in the design examples.
 * Feedback is required on failure — enforced by `isVerdict` / `VerdictSchema`.
 */
export const Verdict = z.object({
  pass: z.boolean(),
  feedback: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
});

/** Full Verdict validation including required feedback on failure. */
export const VerdictSchema = Verdict.superRefine((value, ctx) => {
  if (value.pass === false && (value.feedback === undefined || value.feedback === "")) {
    ctx.addIssue({
      code: "custom",
      message: "Verdict feedback is required when pass is false",
      path: ["feedback"],
    });
  }
});

/** True when a value matches the Verdict wire shape. */
export function isVerdict(value: unknown): value is VerdictValue {
  return VerdictSchema.safeParse(value).success;
}
