/**
 * The A2A artifact of a file a turn wrote (`fileArtifact`): a file stored only for the model to
 * see (ADR-139) is no output of the task, like the caller's own uploads.
 */
import { expect, it } from "vitest";
import { fileArtifact } from "../../src/api/a2a/tasks.js";

const payload = (extra: Record<string, unknown> = {}) => ({
  artifactId: "af_1",
  kind: "file",
  name: "figure.png",
  contentType: "image/png",
  version: 1,
  size: 8,
  sha256: "0".repeat(64),
  source: "engine",
  ...extra,
});

it("hands back an output, and never a file stored for the model or an upload", () => {
  expect(fileArtifact(payload(), "https://runtime.test")).toMatchObject({ name: "figure.png" });
  expect(fileArtifact(payload({ audience: "model" }), "https://runtime.test")).toBeUndefined();
  expect(fileArtifact(payload({ source: "upload" }), "https://runtime.test")).toBeUndefined();
});
