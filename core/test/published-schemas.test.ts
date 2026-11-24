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
  "https://docs.nylorun.com/schemas/agent-manifest/v8.3.json": "378efba8440c64a1a874f7d2e15f14b599f58d74c998b9909007419d95d047b8",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.3.json": "54e76b932699d4c911796344aeeeabea293e9a360ca15d2fec8955d6634fe415",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.2.json": "56d01dd3fcfa7c4cc598bb836482642aa582ddc16eba7753932da6b565d55261",
  "https://docs.nylorun.com/schemas/harness-api/v5.8.json": "4028c1343ed6340c1d6642b927d3615e8eb5bee0f787961b7eb5c7c5aa7fec4c",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.3.json": "aa08b8858ac070bc624ae8a53375075d1c48ee09e1c2c9c9d4804292a91912de",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.4.json": "f3e0db6ca5734ef0274c829a09b4512b7c71ee1754fbfe149993b5634705ebc9",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.4.json": "d842f8709ab3f1ee678faa053ee211b09a28ad0aab78413aa5aaddeaa8c95ecb",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.4.json": "6602caa612a8595f45c33ffe9003023f4e5ef4fb5ec6786a86cfe6564fbda36b",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.5.json": "ced8f051482048852c5d524182c568134512dbf39b51c7e36662b036d59ff417",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.5.json": "89a02f5b4cc2e396d47727a180f9c55a260dcf7eeeed9d1c5566945e7d3a9eba",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.5.json": "ff02cb34866aa72cbdcf3424e66b564dc32274db36dcc4958626020b3b5ab4eb",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.6.json": "80368b322ac42ee66388237bdfd6268d0930a8a0e758f74e3f57f14191ba1a5e",
  "https://docs.nylorun.com/schemas/agent-folder/v1/trigger-md.json": "bb8d8d46e8171fd93b2789d4db35effe7fb5cae62783246ad561eefb4b65c515",
  "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.2.json": "8a693cea33e4edc961858e6f6beaa8fc38427f62f43baec487385255ef713d7c",
  "https://docs.nylorun.com/schemas/agent-folder/v1/tool.json": "632f25d978ae5da96ba4abd1da5647066541a63d07af1a65579e21f45dc7c1a7",
  "https://docs.nylorun.com/schemas/agent-folder/v1/mcp.json": "d470edffee6646192dc030ce68d25d020ec2f9b710e818886e1a5703f0780094",
  "https://docs.nylorun.com/schemas/agent-folder/v1/flow.json": "eb30c5bce859a38c6184b7aa36c7c4dc1ee1806f1d2a5fde423986bfb9261362",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.6.json": "c134dde982bec2702ea66466bb4079c8ea64ee5dbf4d6cf3391544d5f5dc3a6e",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.6.json": "4c7055e32def549bd9512f65f4ff235ccb037afbe2c74951114242c50a582fe7",
};

/** `$id`s published before and no longer built: never published again, with any content. */
const RETIRED = [
  "https://docs.nylorun.com/schemas/agent-manifest/v7.json",
  "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
  "https://docs.nylorun.com/schemas/harness-api/v3.json",
  "https://docs.nylorun.com/schemas/harness-api/v4.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.1.json",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.json",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.1.json",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.1.json",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.json",
  "https://docs.nylorun.com/schemas/agent-manifest/v8.2.json",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.2.json",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.1.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.2.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.3.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.4.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.5.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.6.json",
  "https://docs.nylorun.com/schemas/harness-api/v5.7.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.2.json",
  "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.1.json",
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
