import { HarnessError, isHarnessError } from "@nylorun/core/define";
import type {
  ModelCandidate,
  ModelControls,
  ModelDirective,
  ModelEvidence,
  ModelFinishReason,
  ModelOutputBlock,
  ModelUsage,
} from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { assertJson, copyJson, copyJsonObject } from "@nylorun/core/define";

const FINISH_REASONS = new Set<ModelFinishReason>([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "other",
]);
const USAGE_TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

export function normalizeDirective(value: unknown): ModelDirective | HarnessError {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new HarnessError("model.invalid-directive", "Model directive must be an object");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "id" && key !== "controls" && key !== "config")
      return new HarnessError(
        "model.invalid-directive",
        `Model directive has unknown key '${key}'`,
        {
          details: { path: key },
        },
      );
  }
  const raw = value as { id?: unknown; controls?: unknown; config?: unknown };
  if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.length === 0))
    return new HarnessError(
      "model.invalid-directive",
      "Model directive id must be a non-empty string",
      {
        details: { path: "id" },
      },
    );
  let controls: ModelControls | undefined;
  if (raw.controls !== undefined) {
    const normalized = normalizeControls(raw.controls);
    if (isHarnessError(normalized)) return normalized;
    controls = normalized;
  }
  let config: JsonObject | undefined;
  if (raw.config !== undefined) {
    try {
      config = copyJsonObject(raw.config, "model directive config");
    } catch (error) {
      return isHarnessError(error)
        ? error
        : new HarnessError("model.invalid-directive", String(error), { cause: error });
    }
  }
  return Object.freeze({
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(controls === undefined ? {} : { controls }),
    ...(config === undefined ? {} : { config }),
  });
}

export function sameDirective(left: ModelDirective, right: ModelDirective): boolean {
  return sameJson(left, right);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJson(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      sameJson(leftRecord[key], rightRecord[key]),
  );
}

export function textFromOutput(output: readonly ModelOutputBlock[]): string {
  return output.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function normalizeCandidate(value: ModelCandidate | string): ModelCandidate {
  if (typeof value === "string")
    return Object.freeze({ output: freezeBlocks([{ type: "text", text: value }]) });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidCandidate("Model candidate must be an object or string");
  if (!Array.isArray(value.output))
    throw invalidCandidate("Model candidate output must be an array", "output");
  const output = freezeBlocks(value.output.map((block, index) => normalizeBlock(block, index)));
  return Object.freeze({
    output,
    ...(value.finishReason === undefined
      ? {}
      : { finishReason: normalizeFinishReason(value.finishReason) }),
    ...(value.usage === undefined ? {} : { usage: normalizeUsage(value.usage) }),
    ...(value.evidence === undefined ? {} : { evidence: normalizeEvidence(value.evidence) }),
  });
}

function normalizeControls(value: unknown): ModelControls | HarnessError {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new HarnessError(
      "model.invalid-directive",
      "Model directive controls must be an object",
      {
        details: { path: "controls" },
      },
    );
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "temperature" && key !== "maxOutputTokens")
      return new HarnessError(
        "model.invalid-directive",
        `Model directive controls has unknown key '${key}'`,
        { details: { path: `controls.${key}` } },
      );
  }
  const raw = value as { temperature?: unknown; maxOutputTokens?: unknown };
  if (raw.temperature !== undefined && !isFiniteNumber(raw.temperature))
    return new HarnessError(
      "model.invalid-directive",
      "Model directive temperature must be a finite number",
      { details: { path: "controls.temperature" } },
    );
  if (raw.maxOutputTokens !== undefined && !isNonNegativeInteger(raw.maxOutputTokens))
    return new HarnessError(
      "model.invalid-directive",
      "Model directive maxOutputTokens must be a non-negative integer",
      { details: { path: "controls.maxOutputTokens" } },
    );
  return Object.freeze({
    ...(raw.temperature === undefined ? {} : { temperature: raw.temperature }),
    ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
  });
}

function normalizeBlock(value: unknown, index: number): ModelOutputBlock {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidCandidate(`Model output[${index}] must be an object`, `output[${index}]`);
  const block = value as { type?: unknown };
  if (block.type === "text" || block.type === "reasoning") {
    rejectUnknownKeys(value, ["type", "text", "providerMetadata"], `Model output[${index}]`);
    const text = (value as { text?: unknown }).text;
    if (typeof text !== "string")
      throw invalidCandidate(
        `Model output[${index}].text must be a string`,
        `output[${index}].text`,
      );
    return Object.freeze({ type: block.type, text, ...providerMetadata(value, index) });
  }
  if (block.type === "json") {
    rejectUnknownKeys(value, ["type", "value"], `Model output[${index}]`);
    try {
      const raw = (value as { value?: unknown }).value;
      assertJson(raw, `Model output[${index}].value`);
      return Object.freeze({
        type: "json" as const,
        value: copyJson(raw),
      });
    } catch (error) {
      throw invalidCandidate(
        `Model output[${index}].value must be JSON-safe`,
        `output[${index}].value`,
        error,
      );
    }
  }
  if (block.type === "tool-call") {
    rejectUnknownKeys(
      value,
      ["type", "id", "name", "args", "raw", "providerMetadata"],
      `Model output[${index}]`,
    );
    const raw = value as { id?: unknown; name?: unknown; args?: unknown; raw?: unknown };
    if (raw.id !== undefined && typeof raw.id !== "string")
      throw invalidCandidate(`Model output[${index}].id must be a string`, `output[${index}].id`);
    if (raw.name !== undefined && typeof raw.name !== "string")
      throw invalidCandidate(
        `Model output[${index}].name must be a string`,
        `output[${index}].name`,
      );
    let args: JsonObject;
    try {
      args = copyJsonObject(raw.args, `Model output[${index}].args`);
    } catch (error) {
      throw isHarnessError(error) && error.code === "model.invalid-candidate"
        ? error
        : invalidCandidate(
            `Model output[${index}].args must be a JSON object`,
            `output[${index}].args`,
            error,
          );
    }
    if (raw.raw !== undefined && typeof raw.raw !== "string")
      throw invalidCandidate(`Model output[${index}].raw must be a string`, `output[${index}].raw`);
    return Object.freeze({
      type: "tool-call",
      ...providerMetadata(value, index),
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : "",
      args,
      ...(raw.raw === undefined ? {} : { raw: raw.raw }),
    });
  }
  throw invalidCandidate(`Model output[${index}] has unknown type`, `output[${index}].type`);
}

function normalizeFinishReason(value: unknown): ModelFinishReason {
  if (value === "error" || value === "aborted")
    throw invalidCandidate(
      "Model candidate finishReason cannot be error or aborted",
      "finishReason",
    );
  if (typeof value !== "string" || !FINISH_REASONS.has(value as ModelFinishReason))
    throw invalidCandidate("Model candidate finishReason is invalid", "finishReason");
  return value as ModelFinishReason;
}

function normalizeUsage(value: unknown): ModelUsage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidCandidate("Model candidate usage must be an object", "usage");
  rejectUnknownKeys(value, [...USAGE_TOKEN_KEYS, "costUsd"], "Model candidate usage");
  const raw = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const key of USAGE_TOKEN_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isNonNegativeInteger(raw[key]))
      throw invalidCandidate(
        `Model candidate usage.${key} must be a non-negative integer`,
        `usage.${key}`,
      );
    usage[key] = raw[key];
  }
  if (raw.costUsd !== undefined) {
    if (!isFiniteNumber(raw.costUsd))
      throw invalidCandidate(
        "Model candidate usage.costUsd must be a finite number",
        "usage.costUsd",
      );
    usage.costUsd = raw.costUsd;
  }
  return Object.freeze(usage);
}

function normalizeEvidence(value: unknown): ModelEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidCandidate("Model candidate evidence must be an object", "evidence");
  rejectUnknownKeys(
    value,
    ["requestId", "resolvedModel", "warnings", "extras"],
    "Model candidate evidence",
  );
  const raw = value as {
    requestId?: unknown;
    resolvedModel?: unknown;
    warnings?: unknown;
    extras?: unknown;
  };
  if (raw.requestId !== undefined && typeof raw.requestId !== "string")
    throw invalidCandidate(
      "Model candidate evidence.requestId must be a string",
      "evidence.requestId",
    );
  if (raw.resolvedModel !== undefined && typeof raw.resolvedModel !== "string")
    throw invalidCandidate(
      "Model candidate evidence.resolvedModel must be a string",
      "evidence.resolvedModel",
    );
  let warnings: readonly string[] | undefined;
  if (raw.warnings !== undefined) {
    if (!Array.isArray(raw.warnings) || raw.warnings.some((item) => typeof item !== "string"))
      throw invalidCandidate(
        "Model candidate evidence.warnings must be an array of strings",
        "evidence.warnings",
      );
    warnings = Object.freeze([...raw.warnings]);
  }
  const extras =
    raw.extras === undefined
      ? undefined
      : copyJsonObject(raw.extras, "Model candidate evidence.extras");
  return Object.freeze({
    ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
    ...(typeof raw.resolvedModel === "string" ? { resolvedModel: raw.resolvedModel } : {}),
    ...(warnings === undefined ? {} : { warnings }),
    ...(extras === undefined ? {} : { extras }),
  });
}

function freezeBlocks(blocks: readonly ModelOutputBlock[]): readonly ModelOutputBlock[] {
  return Object.freeze(blocks.map((block) => Object.freeze(block)));
}

function rejectUnknownKeys(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw invalidCandidate(`${path} has unknown key '${key}'`, `${path}.${key}`);
  }
}

function invalidCandidate(message: string, path?: string, cause?: unknown): HarnessError {
  return new HarnessError("model.invalid-candidate", message, {
    ...(cause === undefined ? {} : { cause }),
    ...(path === undefined ? {} : { details: { path } }),
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function providerMetadata(
  value: object,
  index: number,
): { readonly providerMetadata?: JsonObject } {
  const metadata = (value as { providerMetadata?: unknown }).providerMetadata;
  if (metadata === undefined) return {};
  try {
    return { providerMetadata: copyJsonObject(metadata, "providerMetadata") };
  } catch (error) {
    throw invalidCandidate(
      `Model output[${index}].providerMetadata must be a JSON object`,
      `output[${index}].providerMetadata`,
      error,
    );
  }
}
