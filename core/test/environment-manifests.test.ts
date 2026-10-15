import { describe, expect, it } from "vitest";
import {
  EnvironmentManifestSchema,
  PutEnvironmentRequestSchema,
  parseEnvironmentManifestRef,
} from "../src/contracts.js";
import { Agent } from "../src/define.js";
import { agentManifestJsonSchema, environmentManifestJsonSchema } from "../src/manifest-schemas.js";

describe("environment manifests (protocol 14)", () => {
  it("reads name and name@n refs, and refuses the rest", () => {
    expect(parseEnvironmentManifestRef("analyst-box")).toEqual({ name: "analyst-box" });
    expect(parseEnvironmentManifestRef("analyst-box@3")).toEqual({ name: "analyst-box", version: 3 });
    for (const bad of ["analyst-box@0", "analyst-box@", "@3", "a/b", "box@1.2"])
      expect(parseEnvironmentManifestRef(bad), bad).toBeUndefined();
  });

  it("checks a manifest's version, name and slots", () => {
    const manifest = {
      manifestSchemaVersion: 1,
      name: "box",
      kind: "pod",
      secrets: { GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"], required: true } },
    };
    expect(EnvironmentManifestSchema.parse(manifest)).toEqual(manifest);
    expect(EnvironmentManifestSchema.safeParse({ ...manifest, manifestSchemaVersion: 2 }).success).toBe(false);
    expect(EnvironmentManifestSchema.safeParse({ ...manifest, name: "a/b" }).success).toBe(false);
    expect(EnvironmentManifestSchema.safeParse({ ...manifest, $schema: "x" }).success).toBe(false);
    const reserved = { ...manifest, secrets: { PATH: { type: "environment_variable" } } };
    expect(EnvironmentManifestSchema.safeParse(reserved).success).toBe(false);
    // A slot never carries a value.
    const valued = { ...manifest, secrets: { MODE: { type: "environment_variable", value: "x" } } };
    expect(EnvironmentManifestSchema.safeParse(valued).success).toBe(false);
  });

  it("takes a manifest ref on an Environment PUT", () => {
    expect(PutEnvironmentRequestSchema.parse({ manifest: "box@2", labels: { a: "b" } })).toEqual({
      manifest: "box@2",
      labels: { a: "b" },
    });
    expect(PutEnvironmentRequestSchema.safeParse({ manifest: "box@x" }).success).toBe(false);
  });

  it("publishes both manifests as JSON Schema documents that allow $schema", () => {
    const environment = environmentManifestJsonSchema();
    expect(environment.$id).toBe("https://docs.nylorun.com/schemas/environment-manifest/v1.json");
    expect(Object.keys(environment.properties as object)).toEqual(expect.arrayContaining(["$schema", "secrets", "name"]));
    const agent = agentManifestJsonSchema();
    expect(agent.$id).toBe("https://docs.nylorun.com/schemas/agent-manifest/v7.json");
    expect(Object.keys(agent.properties as object)).toEqual(expect.arrayContaining(["$schema", "requires"]));
  });

  it("lets the environment manifest's JSON Schema take the CLI's { path, from } files entry", () => {
    const files = (environmentManifestJsonSchema().properties as { files: { items: { anyOf: unknown[] } } }).files;
    expect(files.items.anyOf).toContainEqual(
      expect.objectContaining({
        properties: { path: expect.objectContaining({ type: "string" }), from: { type: "string", minLength: 1 } },
        required: ["path", "from"],
        additionalProperties: false,
      }),
    );
    // The Runtime's own schema still refuses it: the CLI resolves it before saving.
    const manifest = { manifestSchemaVersion: 1, name: "box", kind: "pod", files: [{ path: "/workspace/kit", from: "kit" }] };
    expect(EnvironmentManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("requires (D65)", () => {
  it("puts what an agent needs in its manifest, once, secret names sorted and each once", () => {
    const agent = Agent({ id: "a", name: "A" })
      .instructions("Work.")
      .requires({ sandbox: "pod", secrets: ["B", "A", "B"] })
      .build();
    expect(agent.manifest.requires).toEqual({ sandbox: "pod", secrets: ["A", "B"] });
    expect(() =>
      Agent({ id: "b", name: "B" }).instructions("x").requires({ sandbox: "any" }).requires({ sandbox: "pod" }).build(),
    ).toThrow();
  });
});
