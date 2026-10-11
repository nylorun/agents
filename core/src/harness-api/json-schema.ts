/**
 * The Harness API as one JSON Schema document (R4.5, Q4), generated from the same zod schemas the
 * Runtime validates with, so a harness written in another language validates against what core
 * enforces. The build writes it to `dist/harness-api/harness-api.schema.json`
 * (`@nylorun/core/harness-api/schema.json`). `$defs` holds every published schema by name, and
 * each request's params and result as `<method>.params` and `<method>.result`.
 */
import { z } from "zod";
import * as gates from "./gates.js";
import * as mcp from "./mcp.js";
import * as entries from "./entries.js";
import * as transport from "./transport.js";
import { HARNESS_API_VERSION } from "./messages.js";
import {
  EffectIntentSchema,
  FrameSchema,
  IntentAnswerSchema,
  OutcomeAnswerSchema,
  RecordedOutcomeSchema,
  RunGrantSchema,
  RunRoutingSchema,
  TraceContextSchema,
  TranscriptUpdateSchema,
  TurnOutputSchema,
  TurnStartSchema,
  coreMessages,
  coreRequests,
  harnessRequests,
} from "./schema.js";

const named: Record<string, unknown> = {
  EffectIntentSchema,
  FrameSchema,
  IntentAnswerSchema,
  OutcomeAnswerSchema,
  RecordedOutcomeSchema,
  RunGrantSchema,
  RunRoutingSchema,
  TraceContextSchema,
  TranscriptUpdateSchema,
  TurnOutputSchema,
  TurnStartSchema,
  ...gates,
  ...mcp,
  ...entries,
  ...transport,
};

/** Every published schema by name, and each request's and message's params and result. */
export function harnessApiSchemas(): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [name, value] of Object.entries(named))
    if (value instanceof z.ZodType && name.endsWith("Schema")) out[name.slice(0, -"Schema".length)] = value;
  for (const [method, { params, result }] of Object.entries({ ...harnessRequests, ...coreRequests })) {
    out[`${method}.params`] = params;
    out[`${method}.result`] = result;
  }
  for (const [method, params] of Object.entries(coreMessages)) out[`${method}.params`] = params;
  return out;
}

/** The JSON Schema document of the Harness API (draft 2020-12). */
export function harnessApiJsonSchema(): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(harnessApiSchemas())) {
    const { $schema: _, ...definition } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    $defs[name] = definition;
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://docs.nylorun.com/schemas/harness-api/v${HARNESS_API_VERSION}.json`,
    title: `Nylorun Harness API ${HARNESS_API_VERSION}`,
    $defs,
  };
}
