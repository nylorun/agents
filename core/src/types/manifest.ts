import type { JsonObject } from "./shared.js";
import type { WorkflowManifest } from "./workflow.js";

/**
 * Published manifest schema version (no top-level model — Runtime-owned). Version 7 is flat: the
 * agent's instructions, tools, skills and MCP servers sit at the top level, with no capabilities.
 */
export type ManifestSchemaVersion = 7;

/** Which Agent Plugin brought a skill or an MCP server: its `plugin.json` name and version. */
export interface PluginLabel {
  readonly name: string;
  readonly version?: string;
}

/**
 * Whether each call waits for a person's approval, in a manifest saved before R5 step 2 (the
 * Tool Gate holds such a call). New definitions use the Tenant's tool policy instead.
 */
export type ApprovalMode = "never" | "always";

/**
 * The methods an HTTP tool may use. `POST`, `PUT` and `PATCH` send the tool input as a JSON body;
 * `GET` and `DELETE` send no body and put it in the query string.
 */
export type HttpToolMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A tool the Runtime runs as one HTTP request through its Tool Gate: the input's path parameters
 * in the URL, the rest as a JSON body (or, for `GET` and `DELETE`, as the query string), the
 * answer as the output. A sibling of `agent`; `fn` and `command` are reserved for later kinds.
 */
export interface HttpToolTarget {
  /**
   * Absolute `http` or `https` URL. Its path may name input fields as `{field}`, such as
   * `https://api.example.com/orders/{orderId}`: each is a required field of the input schema,
   * sent percent-encoded in its place and not again in the query string or body. A query string
   * in the URL is kept, and the input's fields are added after it.
   */
  readonly url: string;
  /** Default `POST`. */
  readonly method?: HttpToolMethod;
  /**
   * Adds a vault credential to each request, as for a remote MCP server: the credential in the
   * vault of the session's Environment bound to `url` (a `bearer` token or a `headers` map, sent
   * to its `via` when it has one, with its identity header). This name labels it in coverage.
   * When the vault holds none, the call fails with `http.credential` and is not sent.
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
  /**
   * @deprecated Removed in R5 step 2: the Runtime refuses a definition that sets it, and tool
   * approvals are the Tenant's tool policy (`PUT /v1/tenant/tool-policy`). Read only from
   * manifests saved before, which the Tool Gate still holds for approval.
   */
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
  /** The Agent Plugin that brought the skill. Absent: the agent's own. */
  readonly plugin?: PluginLabel;
}

/**
 * One tool's settings on an MCP server (manifest v6, R2b C9). Each setting resolves from the
 * tool's own entry, then the `"*"` entry, then the server, then the default.
 */
export interface McpToolSettings {
  /** `false`: the tool never reaches the model and cannot be called. Default `true`. */
  readonly enabled?: boolean;
  /** @deprecated Removed in R5 step 2, as `ToolManifest.approval`; read only from older manifests. */
  readonly approval?: ApprovalMode;
  /**
   * `true`: the tool leaves the model's tool list; the model finds it with `tool_search` and runs
   * it with `tool_call` (R2b C10). A hint the harness reads (`turn.start.mcp`): Nylorun's engine
   * follows it, and without one defers when the agent's MCP tools would take more than a tenth of
   * the model's context window.
   */
  readonly deferred?: boolean;
}

interface McpServerFields {
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** @deprecated Removed in R5 step 2, as `ToolManifest.approval`; read only from older manifests. */
  readonly approval?: ApprovalMode;
  /** Defers every tool of the server, or none (manifest v6, R2b C10). Default: automatic. */
  readonly deferred?: boolean;
  /**
   * Settings per tool (manifest v6, R2b C9), keyed by the server's own tool name (before C6
   * renaming), with `"*"` for every tool without an entry: `{"*": {enabled: false}}` and an
   * entry per wanted tool make an allowlist.
   */
  readonly tools?: Readonly<Record<string, McpToolSettings>>;
  /** The Agent Plugin that brought the server. Absent: the agent's own. */
  readonly plugin?: PluginLabel;
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

export interface AgentManifest {
  readonly manifestSchemaVersion: ManifestSchemaVersion;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly instructions?: readonly string[];
  readonly tools?: readonly ToolManifest[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  /** What the agent needs of its session's Environment, checked when a session opens (D65). */
  readonly requires?: AgentRequirements;
}

/** What an agent needs of the Environment its session opens on (protocol 14, D65). */
export interface AgentRequirements {
  /** `any`: kind `virtual` or `pod`; `pod`: kind `pod`; `none`: nothing. */
  readonly sandbox?: "none" | "any" | "pod";
  /** Secret names (environment variables) its skills' scripts read, which the vault must hold. */
  readonly secrets?: readonly string[];
}
