import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessApiJsonSchema } from "../src/harness-api/json-schema.js";
import { agentManifestJsonSchema, harnessManifestJsonSchema, runtimeManifestJsonSchema } from "../src/manifest-schemas.js";
import { agentFolderJsonSchemas } from "../src/folder/index.js";

/**
 * Every JSON Schema document the package publishes, by its `exports` path, as the build writes
 * it (`scripts/manifest-schemas.mjs`, `scripts/harness-api-schema.mjs`). The agent folder's are
 * published at `agent-folder/v1/<kind>.json` and exported as `agent-folder-<kind>.json`.
 */
const PUBLISHED: Record<string, () => Record<string, unknown>> = {
  "./schemas/agent-manifest.json": agentManifestJsonSchema,
  "./schemas/harness-manifest.json": harnessManifestJsonSchema,
  "./schemas/runtime-manifest.json": runtimeManifestJsonSchema,
  "./harness-api/schema.json": harnessApiJsonSchema,
  ...Object.fromEntries(Object.entries(agentFolderJsonSchemas()).map(([kind, schema]) => [`./schemas/agent-folder-${kind}.json`, () => schema])),
};

/**
 * Each published `$id` and the sha256 of its content (`canonical`). A `$id` names one document
 * for good: editors and other clients cache it by that URL. A document whose content changes gets
 * a new `$id` (a new manifest, file or Harness API version) and a new line here; the old `$id`
 * moves to `RETIRED`.
 */
const PINNED: Record<string, string> = {
  "https://docs.nylorun.com/schemas/agent-manifest/v8.2.json": "274ac020dbca3a7f2c4068120eef0cde67e8db34ba9ffd77abb660c1d94d2973",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.2.json": "8412d108baf508d40aa49e0bc73dded4b828e3417e75d29114f2b586ffdce4b8",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.1.json": "1b8c81394fd34657b3b43098cc88ff7e74dcd6bd1e731a882bb6d1607a0e34df",
  "https://docs.nylorun.com/schemas/harness-api/v5.2.json": "3df2a99a800c1fd44b35fd6f6eca455df4d1875941a5873366261f8d40f32617",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.2.json": "a575e9a180df297a9c23984f5f28290d945c080e2484e3a9e32e9091911260e8",
  "https://docs.nylorun.com/schemas/agent-folder/v1/trigger-md.json": "bb8d8d46e8171fd93b2789d4db35effe7fb5cae62783246ad561eefb4b65c515",
  "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.1.json": "481fda4f99bb772554c69c8bc6afb3fe198ebccc489d67ec1d59b3496bf234f8",
  "https://docs.nylorun.com/schemas/agent-folder/v1/tool.json": "632f25d978ae5da96ba4abd1da5647066541a63d07af1a65579e21f45dc7c1a7",
  "https://docs.nylorun.com/schemas/agent-folder/v1/mcp.json": "d470edffee6646192dc030ce68d25d020ec2f9b710e818886e1a5703f0780094",
  "https://docs.nylorun.com/schemas/agent-folder/v1/flow.json": "eb30c5bce859a38c6184b7aa36c7c4dc1ee1806f1d2a5fde423986bfb9261362",
};

/** `$id`s published before and no longer built: never published again, with any content. */
const RETIRED = [
  "https://docs.nylorun.com/schemas/agent-manifest/v7.json",
  "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
  "https://docs.nylorun.com/schemas/harness-api/v3.json",
  "https://docs.nylorun.com/schemas/harness-api/v4.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.json",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.json",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.1.json",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.1.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.1.json",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.json",
];

/**
 * What a `$id` pins of `value`: JSON with every object's keys sorted, so the order it was built in
 * does not count, and without `description` annotations, which validate nothing: a reworded
 * description keeps its `$id`. Everything else (a property, a type, a bound, a `title`) does not.
 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value)
    .filter(([key, item]) => !(key === "description" && typeof item === "string"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};

const sha256 = (document: Record<string, unknown>): string => createHash("sha256").update(canonical(document)).digest("hex");

describe("published JSON Schemas", () => {
  it("covers every JSON Schema the package exports", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports).filter((path) => path.endsWith(".json")).sort()).toEqual(Object.keys(PUBLISHED).sort());
  });

  it("keeps each published $id's content: a changed document needs a new $id", () => {
    for (const [path, make] of Object.entries(PUBLISHED)) {
      const document = make();
      const id = String(document.$id);
      expect(RETIRED, `${path} is published as ${id}, a retired $id: give it a new one`).not.toContain(id);
      const pinned = PINNED[id];
      const hash = sha256(document);
      expect(
        pinned,
        `${path} is published as ${id}, which core/test/published-schemas.test.ts does not pin yet: add "${id}": "${hash}" to PINNED`,
      ).toBeDefined();
      expect(
        hash,
        `${path} changed, but its $id ${id} is already published with other content. Give the document a new $id ` +
          `(bump the version it is generated from in src/manifest-schemas.ts or src/harness-api/json-schema.ts), ` +
          `pin the new $id with sha256 ${hash}, and move ${id} to RETIRED. Never re-pin a published $id.`,
      ).toBe(pinned);
    }
  });
});
