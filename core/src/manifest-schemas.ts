/**
 * Agent manifest v8 and its two authoring files as JSON Schema documents (protocol 16),
 * generated from the zod schemas the Runtime and the composer validate with, so an editor checks
 * a manifest file from its `$schema` and a client in another language validates what core
 * enforces. The build writes them to `dist/schemas/`: `@nylorun/core/schemas/agent-manifest.json`
 * (`agent.manifest.json`, whose sections may be paths), `harness-manifest.json` and
 * `runtime-manifest.json`. Each allows a top-level `$schema`, which the composer drops before it
 * saves: the Runtime's own schemas stay strict. A runtime file's `files` also allow `{ path,
 * from }`, a folder beside the file the composer hashes into `{ path, files }`. A published `$id`
 * keeps its content but for descriptions: a change takes a new version (`published-schemas.test.ts`).
 */
import { z } from "zod";
import {
  AGENT_MANIFEST_V8_SCHEMA_VERSION,
  AgentManifestFileSchema,
  HARNESS_MANIFEST_FILE_SCHEMA_VERSION,
  HarnessManifestFileSchema,
  RUNTIME_MANIFEST_FILE_SCHEMA_VERSION,
  RuntimeManifestFileSchema,
} from "./contracts.js";

function document(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  const { $schema: _, ...definition } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  const properties = (definition.properties ?? {}) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://docs.nylorun.com/schemas/${id}.json`,
    title,
    ...definition,
    properties: {
      $schema: { type: "string", description: "This document's JSON Schema, for editors; clients drop it before saving" },
      ...properties,
    },
  };
}

/**
 * Agent manifest v8's JSON Schema document (protocol 16): the authoring form, whose `harness`
 * and `runtime` may each be a path to an authoring file, as `agent.manifest.json` is written.
 * What the API receives has both sections written out (`AgentManifestV8Schema`).
 */
export function agentManifestJsonSchema(): Record<string, unknown> {
  return document(
    AgentManifestFileSchema,
    `agent-manifest/v${AGENT_MANIFEST_V8_SCHEMA_VERSION}`,
    `Nylorun agent manifest ${AGENT_MANIFEST_V8_SCHEMA_VERSION}`,
  );
}

/** `harness.manifest.json`'s JSON Schema document: the harness section as an authoring file. */
export function harnessManifestJsonSchema(): Record<string, unknown> {
  return document(
    HarnessManifestFileSchema,
    `harness-manifest/v${HARNESS_MANIFEST_FILE_SCHEMA_VERSION}`,
    `Nylorun harness manifest ${HARNESS_MANIFEST_FILE_SCHEMA_VERSION}`,
  );
}

/** `runtime.manifest.json`'s JSON Schema document: the runtime section as an authoring file. */
export function runtimeManifestJsonSchema(): Record<string, unknown> {
  return document(
    RuntimeManifestFileSchema,
    `runtime-manifest/v${RUNTIME_MANIFEST_FILE_SCHEMA_VERSION}`,
    `Nylorun runtime manifest ${RUNTIME_MANIFEST_FILE_SCHEMA_VERSION}`,
  );
}
