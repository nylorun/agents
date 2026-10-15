/**
 * The structured answer (protocol 15, `loop/model/json-answer.ts`): with an output schema, our
 * engine reads the model's final text as JSON, repairing what open-weight models get wrong.
 */
import { describe, expect, it } from "vitest";
import type { ModelCandidate } from "@nylorun/core/define";
import { parseJsonWithRepair, structuredAnswer } from "../src/loop/model/json-answer.js";

const schema = { type: "object" };
const text = (value: string): ModelCandidate => ({ output: [{ type: "text", text: value }] });

describe("structuredAnswer", () => {
  it("reads a fenced answer with raw control characters as one json block", () => {
    expect(
      structuredAnswer(text('```json\n{"answer": "line one\nline two"}\n```'), schema).output,
    ).toEqual([{ type: "json", value: { answer: "line one\nline two" } }]);
  });

  it("joins the text blocks, keeps reasoning, and keeps the rest of the candidate", () => {
    const candidate: ModelCandidate = {
      output: [
        { type: "reasoning", text: "thinking", providerMetadata: { pi: { signature: "s" } } },
        { type: "text", text: '{"count":' },
        { type: "text", text: "3}" },
      ],
      finishReason: "stop",
      usage: { inputTokens: 1 },
    };
    expect(structuredAnswer(candidate, schema)).toEqual({
      output: [
        { type: "reasoning", text: "thinking", providerMetadata: { pi: { signature: "s" } } },
        { type: "json", value: { count: 3 } },
      ],
      finishReason: "stop",
      usage: { inputTokens: 1 },
    });
  });

  it("fails the step with model.invalid_output when the text is not JSON", () => {
    expect(() => structuredAnswer(text("not json at all"), schema)).toThrow(
      expect.objectContaining({
        code: "model.invalid_output",
        message: expect.stringContaining("The model's final answer is not valid JSON"),
      }),
    );
  });

  it("leaves an answer alone without a schema, with a json block, or with a tool call", () => {
    const plain = text("not json");
    expect(structuredAnswer(plain, undefined)).toBe(plain);
    const json: ModelCandidate = { output: [{ type: "json", value: { count: 3 } }] };
    expect(structuredAnswer(json, schema)).toBe(json);
    const call: ModelCandidate = {
      output: [
        { type: "text", text: "Looking it up." },
        { type: "tool-call", id: "c1", name: "lookup", args: {} },
      ],
    };
    expect(structuredAnswer(call, schema)).toBe(call);
  });
});

describe("parseJsonWithRepair", () => {
  it("repairs bad escapes and control characters in strings only", () => {
    expect(parseJsonWithRepair('{"path": "C:\\dir", "tab": "a\tb"}')).toEqual({
      path: "C:\\dir",
      tab: "a\tb",
    });
    expect(parseJsonWithRepair('{"u": "\\u00e9"}')).toEqual({ u: "é" });
    expect(() => parseJsonWithRepair("{nope}")).toThrow(SyntaxError);
  });
});
