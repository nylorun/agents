import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessApiJsonSchema } from "../src/harness-api/json-schema.js";
import { agentManifestJsonSchema, harnessManifestJsonSchema, runtimeManifestJsonSchema } from "../src/manifest-schemas.js";

/**
 * Every JSON Schema document the package publishes, by its `exports` path, as the build writes
 * it (`scripts/manifest-schemas.mjs`, `scripts/harness-api-schema.mjs`).
 */
const PUBLISHED: Record<string, () => Record<string, unknown>> = {
  "./schemas/agent-manifest.json": agentManifestJsonSchema,
  "./schemas/harness-manifest.json": harnessManifestJsonSchema,
  "./schemas/runtime-manifest.json": runtimeManifestJsonSchema,
  "./harness-api/schema.json": harnessApiJsonSchema,
};

/**
 * Each published `$id` and the sha256 of its content (`canonical`). A `$id` names one document
 * for good: editors and other clients cache it by that URL. A document whose content changes gets
 * a new `$id` (a new manifest, file or Harness API version) and a new line here; the old `$id`
 * moves to `RETIRED`.
 */
const PINNED: Record<string, string> = {
  "https://docs.nylorun.com/schemas/agent-manifest/v8.json": "59b772a831556bc6f887642eeef1d250b9e541306dfb84fbd56933585492fd20",
  "https://docs.nylorun.com/schemas/harness-manifest/v1.json": "42d387639f0a07a2204d1253a836ffa493735e5f1784b281bd84c362a06c413c",
  "https://docs.nylorun.com/schemas/runtime-manifest/v1.json": "cd7c9cba1635920921cc5400389b50c4260047bb26213b37a7facd129f2ae06d",
  "https://docs.nylorun.com/schemas/harness-api/v5.json": "3ac689e286d8bd98564037bf13e1345f1e837ed6828ac9f3be22d3667b80fba8",
};

/** `$id`s published before and no longer built: never published again, with any content. */
const RETIRED = [
  "https://docs.nylorun.com/schemas/agent-manifest/v7.json",
  "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
  "https://docs.nylorun.com/schemas/harness-api/v3.json",
  "https://docs.nylorun.com/schemas/harness-api/v4.json",
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
