/**
 * The agent manifest and the environment manifest as JSON Schema documents (protocol 14, D63),
 * generated from the zod schemas the Runtime validates with, so an editor checks a manifest file
 * from its `$schema` and a client in another language validates what core enforces. The build
 * writes them to `dist/schemas/` (`@nylorun/core/schemas/agent-manifest.json` and
 * `@nylorun/core/schemas/environment-manifest.json`). Both allow a top-level `$schema`, which
 * the CLI and SDK drop before they save: the Runtime's own schemas stay strict.
 */
import { z } from "zod";
import {
  AgentManifestSchema,
  ENVIRONMENT_MANIFEST_SCHEMA_VERSION,
  EnvironmentManifestSchema,
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
  return document(
    EnvironmentManifestSchema,
    `environment-manifest/v${ENVIRONMENT_MANIFEST_SCHEMA_VERSION}`,
    `Nylorun environment manifest ${ENVIRONMENT_MANIFEST_SCHEMA_VERSION}`,
  );
}

/** The agent manifest's JSON Schema document (draft 2020-12). */
export function agentManifestJsonSchema(): Record<string, unknown> {
  return document(
    AgentManifestSchema,
    `agent-manifest/v${AGENT_MANIFEST_SCHEMA_VERSION}`,
    `Nylorun agent manifest ${AGENT_MANIFEST_SCHEMA_VERSION}`,
  );
}
