import type { JsonObject } from "./shared.js";
import type { WorkflowManifest } from "./workflow.js";

/**
 * Published manifest schema version (no top-level model — Runtime-owned). Version 6 (R2b C9) adds
 * an MCP server's `tools` and `deferred`; a manifest that uses neither stays version 5, so its
 * hash is unchanged, and the Runtime accepts both.
 */
export type ManifestSchemaVersion = 5 | 6;

/** Whether each call waits for a person's approval (`approve` on the session). Default `never`. */
export type ApprovalMode = "never" | "always";

/** The methods an HTTP tool may use: each sends the tool input as a JSON body. */
export type HttpToolMethod = "POST" | "PUT" | "PATCH";

/**
 * A tool the Runtime runs as one HTTP request through its Tool Gate: the input as a JSON body,
 * the answer as the output. A sibling of `agent`; `fn` and `command` are reserved for later kinds.
 */
export interface HttpToolTarget {
  /** Absolute `http` or `https` URL. */
  readonly url: string;
  /** Default `POST`. */
  readonly method?: HttpToolMethod;
  /**
   * Adds a vault credential to each request, as for a remote MCP server: a credential in the
   * session's vaults bound to `url` (a `bearer` token or a `headers` map, sent to its `via` when
   * it has one, with its identity header), chosen by the session's credential selection with
   * this name (`credentialSelections[].serverName`) when several are. When the vaults hold none,
   * the call fails with `http.credential` and is not sent.
   */
  readonly credential?: string;
  /** How long the service may take to answer. Default 60000, at most 300000. */
  readonly timeoutMs?: number;
}

export interface ToolManifest {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /**
   * Present when this tool is another agent. The engine runs it with a fresh context and
   * returns its final output; its input is always `{ task: string }`. One level deep. A flow
   * agent (workflow manifest v3) runs in its own linked session on the Runtime.
   */
  readonly agent?: AgentManifest | WorkflowManifest;
  /** Present when the Runtime runs this tool as an HTTP request. Never with `agent`. */
  readonly http?: HttpToolTarget;
  /** Each call of an HTTP tool waits for approval. */
  readonly approval?: ApprovalMode;
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

/**
 * One tool's settings on an MCP server (manifest v6, R2b C9). Each setting resolves from the
 * tool's own entry, then the `"*"` entry, then the server, then the default.
 */
export interface McpToolSettings {
  /** `false`: the tool never reaches the model and cannot be called. Default `true`. */
  readonly enabled?: boolean;
  /** `always`: each call waits for approval. Default: the server's `approval`, else `never`. */
  readonly approval?: ApprovalMode;
  /**
   * `true`: the tool leaves the model's tool list; the model finds it with `tool_search` and runs
   * it with `tool_call` (R2b C10). Default: the server's `deferred`, else deferred when the
   * agent's MCP tools would take more than a tenth of the model's context window.
   */
  readonly deferred?: boolean;
}

interface McpServerFields {
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Each call of every tool of the server waits for approval. */
  readonly approval?: ApprovalMode;
  /** Defers every tool of the server, or none (manifest v6, R2b C10). Default: automatic. */
  readonly deferred?: boolean;
  /**
   * Settings per tool (manifest v6, R2b C9), keyed by the server's own tool name (before C6
   * renaming), with `"*"` for every tool without an entry: `{"*": {enabled: false}}` and an
   * entry per wanted tool make an allowlist.
   */
  readonly tools?: Readonly<Record<string, McpToolSettings>>;
}

/** A remote MCP server, declared by URL. Nylorun accepts no stdio servers (`stdioMcpRefusal`). */
export type McpServerManifest =
  | (McpServerFields & { readonly type: "streamable-http" })
  | (McpServerFields & { readonly type: "sse" });

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
