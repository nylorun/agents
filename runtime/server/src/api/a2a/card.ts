/**
 * The Agent Card of one agent, from its manifest: name, description and one skill, never its
 * instructions, tools or MCP servers. The Runtime does not know where callers reach it, so
 * `supportedInterfaces` is empty: whoever publishes the card (the gateway in v1) adds its own
 * URL, provider and security schemes.
 */

export interface CardDefinition {
  readonly manifest: { id?: unknown; name?: unknown; description?: unknown };
  readonly implementationVersion: string;
}

import type { ModelInput } from "@nylorun/core/contracts";
import { MODEL_IMAGE_TYPES } from "@nylorun/core/contracts";

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
  inputModes: readonly string[] = MODES
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
    supportedInterfaces: [],
    version: definition.implementationVersion,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: [...inputModes],
    defaultOutputModes: MODES,
    skills: [{ id: agentId, name, description, tags: [] }],
  };
}
