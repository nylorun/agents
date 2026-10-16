/**
 * The agent manifest and the environment manifest as JSON Schema documents (protocol 14, D63),
 * generated from the zod schemas the Runtime validates with, so an editor checks a manifest file
 * from its `$schema` and a client in another language validates what core enforces. The build
 * writes them to `dist/schemas/` (`@nylorun/core/schemas/agent-manifest.json` and
 * `@nylorun/core/schemas/environment-manifest.json`). Both allow a top-level `$schema`, which
 * the CLI and SDK drop before they save: the Runtime's own schemas stay strict. The environment
 * manifest's `files` also allow the CLI's `{ path, from }`, a folder beside the file that
 * `nylorun environments manifests save` hashes into `{ path, files }`: the Runtime never sees it.
 */
import { z } from "zod";
import {
  AGENT_MANIFEST_V8_SCHEMA_VERSION,
  AgentManifestFileSchema,
  AgentManifestSchema,
  ENVIRONMENT_MANIFEST_SCHEMA_VERSION,
  EnvironmentManifestSchema,
  HARNESS_MANIFEST_FILE_SCHEMA_VERSION,
  HarnessManifestFileSchema,
  RUNTIME_MANIFEST_FILE_SCHEMA_VERSION,
  RuntimeManifestFileSchema,
} from "./contracts.js";

/** The agent manifest version these documents describe. */
export const AGENT_MANIFEST_SCHEMA_VERSION = 7;

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

/** The environment manifest's JSON Schema document (draft 2020-12). */
export function environmentManifestJsonSchema(): Record<string, unknown> {
  const schema = document(
    EnvironmentManifestSchema,
    `environment-manifest/v${ENVIRONMENT_MANIFEST_SCHEMA_VERSION}`,
    `Nylorun environment manifest ${ENVIRONMENT_MANIFEST_SCHEMA_VERSION}`,
  );
  // A `files` entry only the CLI reads: it turns the folder into `{ path, files }` before saving.
  type Shape = Record<string, unknown> & { properties: Record<string, unknown> };
  const shapes = (schema.properties as { files: { items: { anyOf: Shape[] } } }).files.items.anyOf;
  const tree = shapes.find((shape) => "files" in shape.properties);
  shapes.push({
    type: "object",
    description:
      "For the CLI only: a folder, relative to this file, that `nylorun environments manifests save` uploads by hash and saves as { path, files }",
    properties: { path: tree?.properties.path, from: { type: "string", minLength: 1 } },
    required: ["path", "from"],
    additionalProperties: false,
  });
  return schema;
}

/** The agent manifest's JSON Schema document (draft 2020-12). */
export function agentManifestJsonSchema(): Record<string, unknown> {
  return document(
    AgentManifestSchema,
    `agent-manifest/v${AGENT_MANIFEST_SCHEMA_VERSION}`,
    `Nylorun agent manifest ${AGENT_MANIFEST_SCHEMA_VERSION}`,
  );
}

/**
 * Agent manifest v8's JSON Schema document (protocol 16): the authoring form, whose `harness`
 * and `runtime` may each be a path to an authoring file, as `agent.manifest.json` is written.
 * What the API receives has both sections written out (`AgentManifestV8Schema`).
 */
export function agentManifestV8JsonSchema(): Record<string, unknown> {
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
