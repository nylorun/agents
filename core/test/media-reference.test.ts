import { expect, it } from "vitest";
import {
  CustomModelSettingsSchema,
  HostModelCatalogSchema,
  MODEL_INPUTS,
  PutModelInputsRequestSchema,
} from "../src/contracts.js";
import { mediaReferenceOf } from "../src/define.js";

it("reads the reference of a media part the Runtime made (protocol 12)", () => {
  const reference = { artifactId: "af_1", version: 2, name: 'a "b".png', size: 10 };
  expect(mediaReferenceOf(reference)).toEqual(reference);
  expect(mediaReferenceOf({ artifactId: "af_1", version: 2, name: 3 })).toEqual({ artifactId: "af_1", version: 2 });
  // Another host's reference is not ours.
  expect(mediaReferenceOf("blob:1")).toBeUndefined();
  expect(mediaReferenceOf({ artifactId: "af_1", version: 1.5 })).toBeUndefined();
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
