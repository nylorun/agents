import type { BoundToolDefinition } from "@nylorun/core/define";
import type { ModelCandidate } from "@nylorun/core/define";
import { textFromOutput } from "../model/normalize.js";
import type { JsonValue, Tripwire } from "@nylorun/core/define";
import type {
  RequiredInteraction,
  SchemaIssue,
  ToolValidationFailureDetails,
  ToolOwner,
  ToolOutcome,
  ToolResult,
} from "@nylorun/core/define";
import { createId } from "../../utils/ids.js";
import { HarnessError, isHarnessError } from "@nylorun/core/define";
import { assertJson, copyJson } from "@nylorun/core/define";
import type { CanonicalCall } from "./canonicalize.js";
import type { StepContext } from "./step-context.js";
import type { TurnOutputContract } from "@nylorun/core/define";

export interface SealedToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
}

export interface ExecutablePlanEntry {
  readonly definition: BoundToolDefinition;
  readonly rawArgs: JsonValue;
  readonly call: SealedToolCall;
  readonly invocationId: string;
  readonly owner: ToolOwner;
  readonly execute: BoundToolDefinition["execute"];
  readonly outputSchema?: BoundToolDefinition["outputSchema"];
  readonly interaction?: RequiredInteraction;
}

export interface InternalToolPlan {
  readonly candidate: ModelCandidate;
  readonly order: readonly { readonly callId: string; readonly toolName: string }[];
  readonly executable: readonly ExecutablePlanEntry[];
  readonly immediateResults: readonly ToolResult[];
}

export type SealedStepOutput =
  | { readonly kind: "tripwire"; readonly tripwire: Tripwire }
  | { readonly kind: "final"; readonly output: JsonValue }
  | { readonly kind: "tools"; readonly plan: InternalToolPlan };

interface SealedCall {
  readonly order: { readonly callId: string; readonly toolName: string };
  readonly canonical: { readonly id: string; readonly name: string; readonly args: unknown };
  readonly executable?: ExecutablePlanEntry;
  readonly immediate?: ToolResult;
}

const failed = (
  callId: string,
  toolName: string,
  code: string,
  message: string,
  details?: ToolValidationFailureDetails,
): ToolResult =>
  Object.freeze({
    kind: "failed",
    callId,
    toolName,
    code,
    message,
    ...(details ? { details } : {}),
  });

/** Converts the reviewed canonical candidate into either a final response or an executable tool plan. */
export function sealStep(
  context: StepContext,
  outputContract?: TurnOutputContract,
): SealedStepOutput {
  if (context.currentTripwire)
    return Object.freeze({ kind: "tripwire", tripwire: context.currentTripwire });
  const calls = context.canonicalCalls();
  if (!calls.length) {
    if (outputContract) return sealStructuredOutput(context, outputContract);
    return Object.freeze({
      kind: "final",
      output: textFromOutput(context.currentCandidate?.output ?? []),
    });
  }

  const catalog = context.catalogByName;
  const sealed = calls.map((call) => sealCall(context, catalog, call));
  const canonicalCandidate =
    context.currentCandidate ?? Object.freeze({ output: Object.freeze([]) });
  return Object.freeze({
    kind: "tools",
    plan: Object.freeze({
      candidate: canonicalCandidate,
      order: Object.freeze(sealed.map((item) => item.order)),
      executable: Object.freeze(
        sealed.flatMap((item) => (item.executable ? [item.executable] : [])),
      ),
      immediateResults: Object.freeze(
        sealed.flatMap((item) => (item.immediate ? [item.immediate] : [])),
      ),
    }),
  });
}

function sealStructuredOutput(
  context: StepContext,
  contract: TurnOutputContract,
): SealedStepOutput {
  const output = context.currentCandidate?.output ?? [];
  const json = output.filter(
    (block): block is Extract<(typeof output)[number], { type: "json" }> => block.type === "json",
  );
  if (json.length !== 1 || output.some((block) => block.type === "text"))
    return invalidOutput(
      "Structured terminal output must contain exactly one JSON block and no text blocks",
    );
  const validation = contract.schema.validate(json[0]!.value);
  if (!validation.ok)
    return invalidOutput(
      `Structured terminal output failed validation: ${validation.issues
        .map(renderIssue)
        .join("; ")}`,
    );
  try {
    assertJson(validation.value, "structured terminal output");
    return Object.freeze({ kind: "final", output: copyJson(validation.value) });
  } catch (error) {
    return invalidOutput(error instanceof Error ? error.message : String(error));
  }
}

function invalidOutput(message: string): SealedStepOutput {
  return Object.freeze({
    kind: "tripwire",
    tripwire: Object.freeze({ code: "output.invalid", message }),
  });
}

function sealCall(
  context: StepContext,
  catalog: ReadonlyMap<string, BoundToolDefinition>,
  candidate: CanonicalCall,
): SealedCall {
  const order = Object.freeze({ callId: candidate.id, toolName: candidate.name });
  const canonical = Object.freeze({
    id: candidate.id,
    name: candidate.name,
    args: candidate.args,
  });
  if (candidate.missingId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.invalid-call-id",
        "Tool call id must not be empty",
      ),
    };
  if (candidate.duplicateId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.duplicate-call-id",
        `Duplicate Tool call id '${candidate.duplicateId}'`,
      ),
    };

  const tool = catalog.get(candidate.name);
  if (!tool)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.unknown",
        `Unknown Tool '${candidate.name}'`,
      ),
    };
  const args = validatedArguments(tool, candidate);
  if (!args.ok)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.invalid-arguments",
        args.message,
        args.details,
      ),
    };
  const denial = context.denialFor(candidate.id);
  if (denial)
    return {
      order,
      canonical,
      immediate: Object.freeze({
        kind: "denied",
        callId: candidate.id,
        toolName: candidate.name,
        reason: denial,
      }),
    };

  const requested = context.interactionFor(candidate.id);
  const interaction = requested
    ? Object.freeze({ ...requested, id: requested.id ?? createId("interaction") })
    : undefined;
  return {
    order,
    canonical,
    executable: Object.freeze({
      definition: tool,
      rawArgs: copyJson(candidate.args) as JsonValue,
      call: Object.freeze({
        callId: candidate.id,
        toolName: candidate.name,
        args: args.value,
      }),
      invocationId: createId("invocation"),
      owner: tool.owner,
      execute: tool.execute,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(interaction ? { interaction } : {}),
    }),
  };
}

function validatedArguments(
  tool: BoundToolDefinition,
  candidate: CanonicalCall,
):
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details: ToolValidationFailureDetails;
    } {
  const validation = tool.inputSchema.validate(candidate.args);
  if (!validation.ok)
    return {
      ok: false,
      message: validation.issues.map(renderIssue).join("; "),
      details: Object.freeze({ phase: "input", issues: validation.issues }),
    };
  try {
    assertJson(validation.value, `arguments for '${candidate.name}'`);
    return { ok: true, value: copyJson(validation.value) };
  } catch (error) {
    return {
      ok: false,
      message: isHarnessError(error) ? error.message : String(error),
      details: Object.freeze({
        phase: "input",
        issues: Object.freeze([
          Object.freeze({
            path: Object.freeze([]),
            code: "invalid_json",
            message: isHarnessError(error) ? error.message : String(error),
          }),
        ]),
      }),
    };
  }
}

function renderIssue(issue: SchemaIssue): string {
  return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}
