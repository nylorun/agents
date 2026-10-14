import { expect, it } from "vitest";
import {
  CustomModelSettingsSchema,
  HostModelCatalogSchema,
  MODEL_INPUTS,
  PutModelInputsRequestSchema,
} from "../src/contracts.js";
import { mediaReferenceLine, mediaReferenceOf } from "../src/define.js";

it("names a file by its reference line (protocol 12)", () => {
  const part = {
    mediaType: "image/png",
    reference: { artifactId: "af_1", version: 2, name: 'a "b".png', size: 10 },
  };
  expect(mediaReferenceLine(part, "uploaded")).toBe(
    '[Uploaded artifact "a \\"b\\".png" · af_1 v2 · read_artifact to view]',
  );
  expect(mediaReferenceLine(part, { tool: "screenshot" })).toBe(
    '[Tool screenshot returned artifact "a \\"b\\".png" · af_1 v2 · read_artifact to view]',
  );
  expect(mediaReferenceOf(part.reference)).toEqual(part.reference);
  // Another host's reference has no line of ours.
  expect(mediaReferenceLine({ mediaType: "image/png", reference: "blob:1" }, "uploaded")).toBe(
    "[Uploaded artifact (image/png)]",
  );
});

it("takes model inputs in the catalog, settings and the inputs request", () => {
  expect(MODEL_INPUTS).toEqual(["text", "image", "pdf", "office", "audio", "video"]);
  expect(CustomModelSettingsSchema.safeParse({ inputs: ["text", "pdf"] }).success).toBe(true);
  expect(CustomModelSettingsSchema.safeParse({ inputs: ["svg"] }).success).toBe(false);
  expect(
    PutModelInputsRequestSchema.safeParse({ provider: "openai", model: "gpt", inputs: ["pdf"] }).success,
  ).toBe(true);
  expect(
    HostModelCatalogSchema.safeParse({
      providers: [{ id: "p", name: "P", models: [{ id: "m", name: "M" }] }],
    }).success,
  ).toBe(false);
});
