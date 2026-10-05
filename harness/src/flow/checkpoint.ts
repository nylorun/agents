import type { JsonValue } from "@nylorun/core/define";
import { WorkflowManifestSchema, type WorkflowManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/define";
import {
  CHECKPOINT_VERSION,
  flowEngineVersionOf,
  type FlowEngineVersion,
} from "../compatibility.js";

/** Private persistence contract for workflow sessions; not a session wire type. */
export interface FlowCheckpoint {
  readonly version: 1;
  readonly engineVersion: FlowEngineVersion;
  readonly manifestHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Increment for each human/event continuation, not for an action result. */
  readonly segment: number;
  readonly input: JsonValue;
  /**
   * Answers to the flow's own interactions (a tool node's `ctx.approve` / `ctx.ask`), by
   * interaction id. A flow resumes in the same segment, so its journaled effects replay; the
   * tool that asked runs again as a new effect with its answer.
   */
  readonly resumes?: Readonly<Record<string, FlowResume>>;
}

/** The answer to one flow interaction (`approve` or `respond`). */
export type FlowResume =
  | { readonly kind: "approval"; readonly approved: boolean }
  | { readonly kind: "response"; readonly value: JsonValue };

export function createFlowCheckpoint(input: {
  manifest: WorkflowManifest;
  sessionId: string;
  turnId: string;
  input: JsonValue;
  segment?: number;
}): FlowCheckpoint {
  WorkflowManifestSchema.parse(input.manifest);
  return {
    version: CHECKPOINT_VERSION,
    engineVersion: flowEngineVersionOf(input.manifest),
    manifestHash: hashManifest(input.manifest),
    sessionId: input.sessionId,
    turnId: input.turnId,
    segment: input.segment ?? 0,
    input: input.input,
  };
}

/** `checkpoint` with the answer to interaction `interactionId`. */
export function resumeFlowCheckpoint(
  checkpoint: FlowCheckpoint,
  interactionId: string,
  answer: FlowResume,
): FlowCheckpoint {
  return { ...checkpoint, resumes: { ...checkpoint.resumes, [interactionId]: answer } };
}
