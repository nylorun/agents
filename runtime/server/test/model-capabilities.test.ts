/**
 * What a model reads (protocol 12): its catalog's inputs and those the operator added where its
 * API carries them, and which input a file is.
 */
import { expect, it } from "vitest";
import { modelInputOf, unreadableReason } from "../src/artifacts/media-types.js";
import { addableInputs, capabilitiesOf, inputsError } from "../src/model/capabilities.js";
import { hostModelCatalog, inputsOfHostModel } from "../src/model/catalog.js";

it("reads the catalog's inputs, and additions only where the API carries them", () => {
  const claude = { api: "anthropic-messages", input: ["text", "image"] } as const;
  expect(capabilitiesOf(claude)).toEqual({ inputs: ["text", "image"] });
  expect(addableInputs(claude)).toEqual(["pdf"]);
  expect(capabilitiesOf(claude, ["video", "pdf"])).toEqual({ inputs: ["text", "image", "pdf"] });
  expect(inputsError(claude, ["pdf"])).toBeUndefined();
  expect(inputsError(claude, ["office", "audio"])).toContain("cannot carry office, audio");

  const responses = { api: "openai-responses", input: ["text"] } as const;
  expect(addableInputs(responses)).toEqual(["image", "pdf", "office"]);
  const completions = { api: "openai-completions", input: ["text"] } as const;
  expect(addableInputs(completions)).toEqual(["image", "pdf", "audio", "video"]);
  expect(addableInputs({ api: "google-vertex", input: ["text", "image"] })).toEqual(["pdf", "audio", "video"]);
  // Any other API: images only.
  expect(addableInputs({ api: "mistral-conversations", input: ["text"] })).toEqual(["image"]);
});

it("says what each catalog model reads, and a configured model", () => {
  const catalog = hostModelCatalog({ "groq/llama-3.1-8b-instant": ["image"] });
  const groq = catalog.providers.find((provider) => provider.id === "groq")!;
  expect(groq.models.find((model) => model.id === "llama-3.1-8b-instant")).toMatchObject({
    inputs: ["text", "image"],
    addableInputs: ["image", "pdf", "audio", "video"],
  });
  // A custom endpoint reads text only unless its settings say more.
  const custom = { configured: true, provider: "custom", model: "m", baseUrl: "http://127.0.0.1:1/v1" };
  expect(inputsOfHostModel(custom)).toEqual(["text"]);
  expect(inputsOfHostModel({ ...custom, settings: { inputs: ["image", "pdf"] } })).toEqual(["text", "image", "pdf"]);
  expect(inputsOfHostModel({ configured: false })).toBeUndefined();
  expect(inputsOfHostModel({ configured: true, provider: "groq", model: "no-such-model" })).toBeUndefined();
});

it("tells which input a file is, and why a model cannot read one", () => {
  expect(modelInputOf("text/csv; charset=utf-8")).toBe("text");
  expect(modelInputOf("application/json")).toBe("text");
  // SVG is XML: the model reads it as text.
  expect(modelInputOf("image/svg+xml")).toBe("text");
  expect(modelInputOf("image/bmp")).toBe("image");
  expect(modelInputOf("application/pdf")).toBe("pdf");
  expect(modelInputOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("office");
  expect(modelInputOf("audio/mpeg")).toBe("audio");
  expect(modelInputOf("video/mp4")).toBe("video");
  expect(modelInputOf("application/zip")).toBeUndefined();

  const inputs = ["text", "image"] as const;
  expect(unreadableReason("text/plain", ["text"])).toBeUndefined();
  expect(unreadableReason("image/png", inputs)).toBeUndefined();
  expect(unreadableReason("image/png", ["text"])).toBe("this model does not read images");
  expect(unreadableReason("image/bmp", inputs)).toBe("the model reads PNG, JPEG, GIF and WebP images only");
  expect(unreadableReason("application/pdf", inputs)).toBe("this model does not read PDFs");
  expect(unreadableReason("application/zip", inputs)).toBe("no model reads application/zip files");
});
