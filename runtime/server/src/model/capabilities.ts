/**
 * What a model reads (protocol 12): its pi-ai catalog's `input` (text, image) and what the
 * operator added. One function, `capabilitiesOf`, serves the catalog, the accept check, the Model
 * Gate and `read_artifact`.
 *
 * The operator may add only an input our provider path sends natively for the model's API
 * (`NATIVE_INPUTS`): an image on every API; a PDF on the APIs below; Office documents on the
 * OpenAI Responses APIs; audio and video on Google's APIs and OpenAI-compatible completions.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { MODEL_INPUTS, type ModelInput } from "@nylorun/core/contracts";

/** What `capabilitiesOf` reads of a pi-ai model. */
export type ModelShape = Pick<Model<Api>, "api" | "input">;

/** The inputs each API carries natively, beyond text. Any other API: images only. */
export const NATIVE_INPUTS: Readonly<Record<string, readonly ModelInput[]>> = {
  "anthropic-messages": ["image", "pdf"],
  "openai-responses": ["image", "pdf", "office"],
  "azure-openai-responses": ["image", "pdf", "office"],
  "openai-completions": ["image", "pdf", "audio", "video"],
  "google-generative-ai": ["image", "pdf", "audio", "video"],
  "google-vertex": ["image", "pdf", "audio", "video"],
};

function nativeInputs(model: ModelShape): readonly ModelInput[] {
  return NATIVE_INPUTS[model.api] ?? ["image"];
}

function ordered(inputs: Iterable<ModelInput>): ModelInput[] {
  const set = new Set(inputs);
  return MODEL_INPUTS.filter((input) => set.has(input));
}

/** What the operator may add to `model`: the inputs its API carries that its catalog lacks. */
export function addableInputs(model: ModelShape): ModelInput[] {
  const own: readonly string[] = model.input;
  return ordered(nativeInputs(model).filter((input) => !own.includes(input)));
}

/**
 * What `model` reads: text, its catalog's inputs and those of `added` its API carries, in
 * `MODEL_INPUTS` order.
 */
export function capabilitiesOf(
  model: ModelShape,
  added: readonly ModelInput[] = [],
): { readonly inputs: ModelInput[] } {
  const native = nativeInputs(model);
  return {
    inputs: ordered([
      "text",
      ...model.input,
      ...added.filter((input) => native.includes(input)),
    ]),
  };
}

/** Why `inputs` cannot be set for `model`, or undefined when they can. */
export function inputsError(model: ModelShape, inputs: readonly ModelInput[]): string | undefined {
  const allowed = new Set<ModelInput>(["text", ...model.input, ...nativeInputs(model)]);
  const refused = ordered(inputs.filter((input) => !allowed.has(input)));
  if (refused.length === 0) return undefined;
  return `This model's API (${model.api}) cannot carry ${refused.join(", ")}; it can read ${ordered(allowed).join(", ")}.`;
}
