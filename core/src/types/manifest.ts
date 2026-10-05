import type { JsonObject } from "./shared.js";
import type { WorkflowManifestV2 } from "./workflow.js";

/** Published manifest schema version (no top-level model — Runtime-owned). */
export type ManifestSchemaVersion = 5;

export interface ToolManifest {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /**
   * Present when this tool is another agent. The engine runs it with a fresh context and
   * returns its final output; its input is always `{ task: string }`. One level deep. A flow
   * agent (workflow manifest v2) runs in its own linked session on the Runtime.
   */
  readonly agent?: AgentManifest | WorkflowManifestV2;
}

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  /**
   * Every file of the skill's folder, by its path in the folder (`/`-separated, e.g.
   * `SKILL.md`, `scripts/run.py`, `assets/logo.png`), as `sha256:<hex>`: the definition files
   * the Runtime holds and serves. `SKILL.md` is required.
   */
  readonly files: Readonly<Record<string, string>>;
}

export type McpServerManifest =
  | {
      readonly name: string;
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly name: string;
      readonly type: "streamable-http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly type: "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** Network egress preset for a sandbox. Private ranges and metadata endpoints are always blocked. */
export type SandboxNetworkPreset = "none" | "dev" | "open";

/**
 * What computer an agent needs. The Runtime decides where it runs; nothing here names a backend.
 * Every field is optional; omitted fields take Runtime defaults.
 */
export interface SandboxManifest {
  /** OCI image reference. Default: the Runtime's default sandbox image. */
  readonly image?: string;
  readonly network?: {
    /** Default: "dev" (package registries and code hosts over HTTPS). */
    readonly preset?: SandboxNetworkPreset;
    /** Extra hosts to allow, e.g. "api.github.com" or "*.example.com". */
    readonly allow?: readonly string[];
  };
  readonly resources?: {
    readonly cpus?: number;
    /** Size such as "512MiB" or "2GiB". */
    readonly memory?: string;
  };
  /** Stop compute after this long without use, e.g. "15m". Files persist. */
  readonly idle?: string;
}

export interface CapabilityManifest {
  readonly id: string;
  readonly type: "agent" | "agent-plugin";
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly instructions?: readonly string[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  readonly tools?: readonly ToolManifest[];
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  /** Present when this capability gives the agent a Runtime-owned sandbox. */
  readonly sandbox?: SandboxManifest;
}

/** Reserved. Empty until later fields are defined. Omit `runtime` while it has no fields. */
export interface RuntimeManifest {}

export interface AgentManifest {
  readonly manifestSchemaVersion: ManifestSchemaVersion;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly capabilities: readonly CapabilityManifest[];
  readonly runtime?: RuntimeManifest;
}
