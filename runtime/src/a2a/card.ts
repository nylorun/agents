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

const MODES = ["text/plain", "application/json"];

export function agentCard(agentId: string, definition: CardDefinition): Record<string, unknown> {
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
    defaultInputModes: MODES,
    defaultOutputModes: MODES,
    skills: [{ id: agentId, name, description, tags: [] }],
  };
}
