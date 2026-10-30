import type { AgentTool } from "./agent.js";
import type {
  McpServerManifest,
  SkillManifest,
} from "./manifest.js";
import type { ToolDefinition } from "./tool.js";

/**
 * The bytes of one skill file the manifest names (`SkillManifest.files`), held on the developer
 * binding: the client uploads the files the Runtime lacks before it registers the agent. Not a
 * manifest field.
 */
export interface SkillFileSource {
  readonly size: number;
  read(): Promise<Uint8Array>;
  /**
   * The bytes as a stream, for a file too large to hold in memory (an org's skill of a gigabyte,
   * ADR-93). When present, the client's upload sends it instead of `read()`'s bytes. Each call
   * opens a new stream.
   */
  stream?(): ReadableStream<Uint8Array>;
}

/**
 * @internal What one builder call, skills folder or plugin adds to an agent. The manifest holds
 * the agent's parts merged: a plugin's skills and servers carry its `plugin` label.
 */
export interface PartDeclaration<Info = unknown> {
  readonly id: string;
  readonly tools?: readonly (ToolDefinition<any, Info, any> | AgentTool)[];
  readonly instructions?: readonly string[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  /** Each skill file's bytes, by `sha256:<hex>`, for the client to upload. Not projected into the manifest. */
  readonly skillFiles?: Readonly<Record<string, SkillFileSource>>;
  /**
   * The secret slots each skill's scripts read, by skill name (a SKILL.md's `secrets`): the
   * harness section's `skills.<name>.secrets` when the agent is saved. Not projected into the manifest.
   */
  readonly skillSecrets?: Readonly<Record<string, readonly string[]>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
}
