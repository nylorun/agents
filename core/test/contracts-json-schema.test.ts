/**
 * Every schema `@nylorun/core/contracts` exports converts to JSON Schema, as requests (input)
 * and as responses (output): the Runtime's OpenAPI document is generated from them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "../src/contracts.js";

const schemas = Object.entries(contracts).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);

describe("contracts as JSON Schema", () => {
  it("exports schemas", () => {
    expect(schemas.length).toBeGreaterThan(100);
  });

  it.each(schemas)("%s converts", (_name, schema) => {
    for (const io of ["input", "output"] as const)
      expect(() => z.toJSONSchema(schema, { io, unrepresentable: "throw" })).not.toThrow();
  });
});
