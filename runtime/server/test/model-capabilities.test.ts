/**
 * What a model reads (protocol 12): its catalog's inputs and those the operator added where its
 * API carries them. Which input a file is: `core/test/media-types.test.ts`.
 */
import { expect, it } from "vitest";
import { addableInputs, capabilitiesOf, inputsError } from "../src/model/capabilities.js";
import { catalogModel, hostModelCatalog, inputsOfHostModel } from "../src/model/catalog.js";
import {
  FIXTURE_DESCRIPTOR,
  currentModelDescriptor,
  describeModel,
  hostModelDescriptor,
  selectionOf,
} from "../src/model/descriptor.js";
import { CUSTOM_CONTEXT_WINDOW, CUSTOM_MAX_TOKENS } from "../src/model/models.js";

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

it("describes a model the way the gate resolves it (protocol 15)", () => {
  const found = catalogModel("groq", "llama-3.1-8b-instant")!;
  expect(describeModel(found)).toEqual({
    provider: "groq",
    id: "llama-3.1-8b-instant",
    inputs: ["text"],
    contextWindow: found.contextWindow,
    maxOutputTokens: found.maxTokens,
    reasoning: found.reasoning,
  });
  // The operator's additions count, where the API carries them.
  expect(describeModel(found, ["image", "office"]).inputs).toEqual(["text", "image"]);
  expect(hostModelDescriptor({ provider: "groq", model: "llama-3.1-8b-instant" }, { "groq/llama-3.1-8b-instant": ["pdf"] })?.inputs).toEqual(["text", "pdf"]);
  // A custom endpoint: its settings, and small defaults without them.
  const custom = { provider: "custom", model: "m", baseUrl: "http://127.0.0.1:1/v1" };
  expect(hostModelDescriptor(custom)).toEqual({
    provider: "custom",
    id: "m",
    inputs: ["text"],
    contextWindow: CUSTOM_CONTEXT_WINDOW,
    maxOutputTokens: CUSTOM_MAX_TOKENS,
    reasoning: false,
  });
  expect(
    hostModelDescriptor({
      ...custom,
      settings: { contextWindow: 100_000, maxTokens: 4_000, reasoning: true, inputs: ["image", "audio"] },
    }),
  ).toEqual({
    provider: "custom",
    id: "m",
    inputs: ["text", "image", "audio"],
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
    reasoning: true,
  });
  // A call may name another model of the provider.
  expect(selectionOf(custom, "custom/other").model).toBe("other");
  expect(selectionOf({ provider: "groq", model: "a" }, "b")).toEqual({ provider: "groq", model: "b" });
});

it("describes the Tenant's current model: the fixture, the vault's, or none", async () => {
  const ctx = (settings: Record<string, string>, view: unknown) => ({
    store: { tx: async (fn: (t: unknown) => unknown) => fn({ getSetting: async (key: string) => settings[key] }) },
    vault: { getHostModel: async () => view },
  });
  const configured = { configured: true, provider: "groq", model: "llama-3.1-8b-instant", authType: "api_key" };
  expect(await currentModelDescriptor(ctx({ "model.fixture": "true" }, configured) as never)).toEqual(FIXTURE_DESCRIPTOR);
  expect(FIXTURE_DESCRIPTOR.inputs).toEqual(["text", "image", "pdf", "office", "audio", "video"]);
  expect(
    await currentModelDescriptor(ctx({ "model.inputs": '{"groq/llama-3.1-8b-instant":["image"]}' }, configured) as never),
  ).toMatchObject({ provider: "groq", id: "llama-3.1-8b-instant", inputs: ["text", "image"] });
  expect(await currentModelDescriptor(ctx({}, { configured: false }) as never)).toBeUndefined();
});
