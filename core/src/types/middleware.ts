import type { AgentTool } from "./agent.js";
import type {
  McpServerManifest,
  SkillManifest,
} from "./manifest.js";
import type { JsonObject } from "./shared.js";
import type { ToolDefinition } from "./tool.js";

/**
 * The bytes of one skill file the manifest names (`SkillManifest.files`), held on the developer
 * binding: the client uploads the files the Runtime lacks before it registers the agent. Not a
 * manifest field.
 */
export interface SkillFileSource {
  readonly size: number;
  read(): Promise<Uint8Array>;
}

/** @internal One part of an agent definition, as the SDK's `.skills()` and `.plugin()` add it. */
export interface CapabilityDeclaration<Info = unknown> {
  readonly id: string;
  readonly type?: "agent" | "agent-plugin";
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly tools?: readonly ToolDefinition<any, Info, any>[];
  readonly instructions?: readonly string[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  /** Each skill file's bytes, by `sha256:<hex>`, for the client to upload. Not projected into the manifest. */
  readonly skillFiles?: Readonly<Record<string, SkillFileSource>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
}

/** @internal A part whose `tools` may also hold agents used as tools. */
export type CapabilityInput<Info = unknown> = Omit<CapabilityDeclaration<Info>, "tools"> & {
  readonly tools?: readonly (ToolDefinition<any, Info, any> | AgentTool)[];
};
