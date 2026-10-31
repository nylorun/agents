/**
 * The Agent Card of one Agent, from its manifest version: its id as the name, the manifest's
 * description and one skill, never its instructions, tools or MCP servers. Its one interface is
 * the Runtime's own JSON-RPC endpoint (A2A 1.0) at the URL the caller reached, or
 * `NYLORUN_PUBLIC_URL`; a gateway that publishes the card (the SDK's) lists its own URL,
 * provider and security schemes instead. Capabilities (profile v2 §3): no streaming, push
 * notifications when the Runtime has a push secret, no extended card, and the profile's five
 * extensions, all optional.
 */

export interface CardDefinition {
  readonly manifest: { id?: unknown; name?: unknown; description?: unknown };
  /** The manifest version the Agent runs, as `name@version`. */
  readonly version: string;
}

import type { ModelInput } from "@nylorun/core/contracts";
import { MODEL_IMAGE_TYPES } from "@nylorun/core/contracts";
import { cardExtensions } from "./extensions.js";
import { A2A_VERSION } from "./protocol.js";

const MODES = ["text/plain", "application/json"];

/** The media types a card advertises for each file input a model reads. */
const INPUT_MODES: Readonly<Record<Exclude<ModelInput, "text">, readonly string[]>> = {
  image: MODEL_IMAGE_TYPES,
  pdf: ["application/pdf"],
  office: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  audio: ["audio/*"],
  video: ["video/*"],
};

/**
 * The input modes for a model that reads `inputs`: text and JSON, then the media types of the
 * files it reads. No inputs known (no model in the vault): text and JSON.
 */
export function inputModesFor(inputs: readonly ModelInput[] | undefined): string[] {
  return [...MODES, ...(inputs ?? []).flatMap((input) => (input === "text" ? [] : INPUT_MODES[input]))];
}

/**
 * `inputModes`: the media types the agent takes, when its model reads files; default text and
 * JSON. The output modes stay text and JSON.
 */
export function agentCard(
  agentId: string,
  definition: CardDefinition,
  inputModes: readonly string[] = MODES,
  serving: { url?: string; pushNotifications?: boolean } = {}
): Record<string, unknown> {
  const { manifest } = definition;
  const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : agentId;
  const description =
    typeof manifest.description === "string" && manifest.description !== ""
      ? manifest.description
      : name;
  return {
    name,
    description,
    supportedInterfaces: serving.url
      ? [{ url: serving.url, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION }]
      : [],
    version: definition.version,
    capabilities: {
      streaming: false,
      pushNotifications: serving.pushNotifications === true,
      extendedAgentCard: false,
      extensions: cardExtensions(),
    },
    defaultInputModes: [...inputModes],
    defaultOutputModes: MODES,
    skills: [{ id: agentId, name, description, tags: [] }],
  };
}
