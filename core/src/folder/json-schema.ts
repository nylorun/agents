/**
 * The JSON Schemas of an agent folder (`inputSchema`, `outputSchema` and the schema files they
 * name), checked as JSON Schema 2020-12 before the folder compiles. Two passes:
 *
 * 1. A check of the keywords' shapes, with the pointer of each problem in the schema, so the
 *    compiler names its file, line and column: a `type` that is no JSON Schema type, `properties`
 *    that is not a map, `required` that is not a list of names, and so on, in every subschema.
 * 2. The engine's own reading (`z.fromJSONSchema`, as `schemaFromJSON` reads a tool's schemas in
 *    each turn), when the first pass finds no error: a schema the engine cannot use would fail
 *    every turn, so it fails the check instead.
 *
 * Keywords JSON Schema allows and the engine cannot use (`if`, `not`, `dependentRequired`,
 * `unevaluatedProperties`, a `$ref` outside `$defs`) are errors with their own reasons. An
 * unknown keyword is an annotation in JSON Schema, so it is only a warning, and only when it is
 * close to a keyword (`proprties`).
 */
import { z } from "zod";
import { suggestion } from "./suggest.js";

/**
 * One problem in a schema: `path` is the pointer in the schema, `key` positions it at the key, and
 * `known` is what an unknown keyword may be meant as, for the compiler's rename fix-it.
 */
export interface JsonSchemaIssue {
  readonly severity: "error" | "warning";
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly key?: boolean;
  readonly known?: readonly string[];
}

/** JSON Schema's seven types. */
export const JSON_SCHEMA_TYPES = ["null", "boolean", "object", "array", "number", "string", "integer"] as const;

const TYPES_TEXT = "null, boolean, object, array, number, string and integer";
/** Keywords whose value is one schema. */
const ONE_SCHEMA = ["additionalProperties", "items", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "contentSchema", "additionalItems"];
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
/** Keywords whose value is a non-empty list of schemas. */
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"];
const NUMBERS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const STRINGS = ["title", "description", "format", "pattern", "$comment", "$id", "$schema", "$anchor", "$dynamicAnchor", "$ref", "$dynamicRef", "contentEncoding", "contentMediaType"];
const BOOLEANS = ["uniqueItems", "readOnly", "writeOnly", "deprecated"];
const OTHERS = ["type", "required", "enum", "const", "default", "examples", "dependentRequired", "$vocabulary"];
const KEYWORDS = [...ONE_SCHEMA, ...SCHEMA_MAPS, ...SCHEMA_LISTS, ...COUNTS, ...NUMBERS, ...STRINGS, ...BOOLEANS, ...OTHERS];

/** Why the engine cannot use a keyword JSON Schema allows. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  if: "conditional schemas (if, then, else) are not supported: write the cases as anyOf",
  then: "conditional schemas (if, then, else) are not supported: write the cases as anyOf",
  else: "conditional schemas (if, then, else) are not supported: write the cases as anyOf",
  dependentSchemas: "dependentSchemas is not supported",
  dependentRequired: "dependentRequired is not supported",
  unevaluatedProperties: "unevaluatedProperties is not supported: use additionalProperties",
  unevaluatedItems: "unevaluatedItems is not supported: use items",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/** Every problem in `schema`, a JSON Schema at the root of a field or file. */
export function jsonSchemaIssues(schema: unknown): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  const error = (path: readonly PropertyKey[], message: string, key = false) => issues.push({ severity: "error", path, message, ...(key ? { key } : {}) });
  const warn = (path: readonly PropertyKey[], message: string, key = false) => issues.push({ severity: "warning", path, message, ...(key ? { key } : {}) });
  const defs = isObject(schema) && isObject(schema.$defs) ? schema.$defs : {};

  const visit = (node: unknown, path: readonly PropertyKey[]): void => {
    if (typeof node === "boolean") return;
    if (!isObject(node)) {
      error(path, `A schema is an object (or true or false), not ${show(node)}`);
      return;
    }
    for (const [keyword, value] of Object.entries(node)) {
      const at = [...path, keyword];
      if (keyword in UNSUPPORTED) {
        error(at, `${keyword} is JSON Schema, but the engine cannot use it: ${UNSUPPORTED[keyword]}`, true);
        continue;
      }
      if (keyword === "type") {
        typeIssues(value, at);
        continue;
      }
      if (keyword === "not") {
        if (!isObject(value) || Object.keys(value).length > 0)
          error(at, "not is JSON Schema, but the engine cannot use it, except as { \"not\": {} } for a value that never matches", true);
        continue;
      }
      if (ONE_SCHEMA.includes(keyword)) {
        if (keyword === "items" && Array.isArray(value)) {
          warn(at, "items is one schema in JSON Schema 2020-12; a list of schemas is draft-07's tuple form. Fix: rename it prefixItems", true);
          value.forEach((item, index) => visit(item, [...at, index]));
        } else visit(value, at);
        continue;
      }
      if (SCHEMA_MAPS.includes(keyword)) {
        if (!isObject(value)) {
          error(at, `${keyword} is a map of ${keyword === "properties" ? "property names" : keyword === "patternProperties" ? "patterns" : "names"} to schemas, not ${show(value)}`);
          continue;
        }
        for (const [name, child] of Object.entries(value)) {
          if (keyword === "patternProperties" && !isPattern(name)) error([...at, name], `${show(name)} is not a regular expression`, true);
          visit(child, [...at, name]);
        }
        continue;
      }
      if (SCHEMA_LISTS.includes(keyword)) {
        if (!Array.isArray(value) || value.length === 0) {
          error(at, `${keyword} is a list of one or more schemas, not ${show(value)}`);
          continue;
        }
        value.forEach((item, index) => visit(item, [...at, index]));
        continue;
      }
      if (COUNTS.includes(keyword)) {
        if (!Number.isInteger(value) || (value as number) < 0) error(at, `${keyword} is a whole number, 0 or more, not ${show(value)}`);
        continue;
      }
      if (NUMBERS.includes(keyword)) {
        if (typeof value !== "number") error(at, `${keyword} is a number, not ${show(value)}`);
        else if (keyword === "multipleOf" && value <= 0) error(at, `multipleOf is a number above 0, not ${show(value)}`);
        continue;
      }
      if (STRINGS.includes(keyword)) {
        if (typeof value !== "string") error(at, `${keyword} is a string, not ${show(value)}`);
        else if (keyword === "pattern" && !isPattern(value)) error(at, `pattern ${show(value)} is not a regular expression`);
        else if (keyword === "$ref") refIssue(value, at);
        continue;
      }
      if (BOOLEANS.includes(keyword)) {
        if (typeof value !== "boolean") error(at, `${keyword} is true or false, not ${show(value)}`);
        continue;
      }
      if (keyword === "required") {
        if (!Array.isArray(value)) {
          error(at, `required is a list of property names, such as ["id"], not ${show(value)}`);
          continue;
        }
        const seen = new Set<string>();
        value.forEach((name, index) => {
          if (typeof name !== "string") error([...at, index], `required lists property names, which are strings, not ${show(name)}`);
          else if (seen.has(name)) error([...at, index], `required lists ${show(name)} twice`);
          else seen.add(name);
        });
        continue;
      }
      if (keyword === "enum" || keyword === "examples") {
        if (!Array.isArray(value)) error(at, `${keyword} is a list of values, not ${show(value)}`);
        continue;
      }
      if (keyword === "dependentRequired" || keyword === "$vocabulary" || keyword === "const" || keyword === "default") continue;
      const close = suggestion(keyword, KEYWORDS);
      if (close)
        issues.push({ severity: "warning", path: at, message: `Unknown keyword '${keyword}'. Did you mean '${close}'? JSON Schema ignores a keyword it does not know`, key: true, known: KEYWORDS });
    }
  };

  const typeIssues = (value: unknown, at: readonly PropertyKey[]) => {
    const one = (name: unknown, path: readonly PropertyKey[]) => {
      if (typeof name === "string" && (JSON_SCHEMA_TYPES as readonly string[]).includes(name)) return;
      const close = typeof name === "string" ? suggestion(name, JSON_SCHEMA_TYPES) : undefined;
      error(path, `type ${show(name)} is not a JSON Schema type.${close ? ` Did you mean '${close}'?` : ""} The types are ${TYPES_TEXT}`);
    };
    if (!Array.isArray(value)) return one(value, at);
    if (value.length === 0) return error(at, `type is a type or a list of one or more types: ${TYPES_TEXT}`);
    const seen = new Set<unknown>();
    value.forEach((name, index) => {
      if (seen.has(name)) error([...at, index], `type lists ${show(name)} twice`);
      seen.add(name);
      one(name, [...at, index]);
    });
  };

  const refIssue = (ref: string, at: readonly PropertyKey[]) => {
    if (ref === "#") return;
    const local = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (local) {
      const name = local[1]!.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!(name in defs)) {
        const close = suggestion(name, Object.keys(defs));
        error(at, `$ref ${show(ref)} names no schema in this schema's $defs.${close ? ` Did you mean '#/$defs/${close}'?` : ""}`);
      }
      return;
    }
    error(
      at,
      ref.startsWith("#")
        ? `$ref ${show(ref)}: the engine resolves a $ref to the schema itself (#) or to one of its $defs (#/$defs/<name>) only`
        : `$ref ${show(ref)} names another document: the engine resolves a $ref inside this schema only (#/$defs/<name>)`,
    );
  };

  visit(schema, []);
  if (issues.some((issue) => issue.severity === "error")) return issues;
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (cause) {
    error([], `The engine cannot use this schema: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
  }
  return issues;
}

/** Whether `pattern` is an ECMA-262 regular expression, the dialect JSON Schema names. */
function isPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
