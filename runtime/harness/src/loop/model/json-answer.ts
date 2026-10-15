/**
 * The structured answer (protocol 15): with an output schema, the engine reads the model's
 * final text as JSON. The Model Gate passes the model's text through; the instruction to answer
 * in JSON (`schemaInstruction`) and the parse are ours.
 *
 * `repairJson` and `parseJsonWithRepair` are adapted from `utils/json-parse` in pi's `pi-ai`
 * (MIT, Copyright (c) Earendil Works).
 */
import {
  HarnessError,
  type JsonValue,
  type ModelCandidate,
  type ModelOutputBlock,
} from "@nylorun/core/define";

/**
 * The candidate as the turn's structured answer. With `schema`, an answer that calls no tool and
 * has no `json` block is its text blocks, joined, without one Markdown code fence, parsed as
 * JSON (raw control characters and bad escapes in strings repaired): one `json` block, after
 * the reasoning blocks. Text that is not JSON throws `model.invalid_output`. Without `schema`,
 * or for a candidate that already holds a `json` block or a tool call, it is unchanged.
 */
export function structuredAnswer(
  candidate: ModelCandidate,
  schema: unknown | undefined,
): ModelCandidate {
  if (schema === undefined) return candidate;
  const { output } = candidate;
  if (output.some((block) => block.type === "tool-call" || block.type === "json")) return candidate;
  const text = output
    .filter((block) => block.type === "text")
    .map((block) => (block as Extract<ModelOutputBlock, { type: "text" }>).text)
    .join("");
  let value: JsonValue;
  try {
    value = parseJsonWithRepair(withoutCodeFence(text)) as JsonValue;
  } catch (error) {
    throw new HarnessError(
      "model.invalid_output",
      `The model's final answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({
    ...candidate,
    output: Object.freeze([
      ...output.filter((block) => block.type === "reasoning"),
      Object.freeze({ type: "json" as const, value }),
    ]),
  });
}

/** Open-weight models often wrap a JSON answer in a Markdown code fence. */
export function withoutCodeFence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return fenced ? fenced[1]! : text;
}

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Repairs malformed JSON string literals: escapes raw control characters inside strings, and
 * doubles a backslash before a character JSON does not escape.
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index]!;
    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }
    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }
    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }
    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }
  return repaired;
}

/** `JSON.parse`, and on failure once more after `repairJson`; the first error if nothing changed. */
export function parseJsonWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    const repaired = repairJson(json);
    if (repaired !== json) return JSON.parse(repaired);
    throw error;
  }
}
