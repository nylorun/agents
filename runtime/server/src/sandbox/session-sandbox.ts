/**
 * Gives a session the sandbox chosen when it was opened, and the platform tools its agents
 * need. An agent session's pinned manifest is its definition plus:
 *
 * - with a sandbox, the `nylorun.sandbox` capability (the six built-in tools, the sandbox
 *   instructions and the resolved spec) and the `nylorun.artifacts` capability
 *   (`save_artifact`), also added to each agent it uses as a tool, so the tree shares one spec.
 *   The sandbox's instructions name the agent's skills' folders (`/skills/<name>/`);
 * - for each agent of the tree with a remote MCP server or an HTTP tool, `read_artifact` in its
 *   `nylorun.artifacts` capability (R2b C11), with or without a sandbox: the Runtime stores a
 *   result of those tools too large to show as an artifact, and the model reads it in pages.
 *   An agent that declares a tool named `read_artifact` keeps its own, and sees previews only;
 * - for each agent of the tree with a remote MCP server, the `nylorun.tools` capability (R2b
 *   C10), empty: when the session defers some of the agent's MCP tools, its session tools put
 *   `tool_search` and `tool_call` there. An agent that declares either name defers nothing.
 *
 * The definition in the registry never changes.
 */
import { AgentManifestSchema } from "@nylorun/core/contracts";
import {
  READ_ARTIFACT_TOOL,
  TOOL_CALL_TOOL,
  TOOL_SEARCH_TOOL,
  TOOLS_CAPABILITY_ID,
  artifactsCapabilityManifest,
  hashManifest,
  sandboxCapabilityManifest,
  toolsCapabilityManifest,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxManifest,
  type ToolManifest,
} from "@nylorun/core/define";
import { sandboxSpecOf } from "./share.js";

export type SandboxedManifest =
  | { readonly ok: true; readonly manifest: AgentManifest; readonly manifestHash: string }
  | { readonly ok: false; readonly message: string };

function isAgentManifest(value: unknown): value is AgentManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind !== "workflow" &&
    Array.isArray((value as AgentManifest).capabilities)
  );
}

/** The names of the agent's own skills. */
function skillNamesOf(manifest: AgentManifest): string[] {
  return manifest.capabilities.flatMap((capability) => Object.keys(capability.skills ?? {})).sort();
}

/**
 * True when the agent itself declares a remote MCP server or an HTTP tool, whose results the
 * Runtime may store as artifacts (R2b C11), and no tool of its own is named `read_artifact`.
 */
function readsStoredResults(manifest: AgentManifest): boolean {
  const remote = manifest.capabilities.some(
    (capability) =>
      Object.keys(capability.mcpServers ?? {}).length > 0 ||
      (capability.tools ?? []).some((tool) => tool.http !== undefined)
  );
  const taken = manifest.capabilities.some((capability) =>
    (capability.tools ?? []).some((tool) => tool.name === READ_ARTIFACT_TOOL)
  );
  return remote && !taken;
}

/**
 * True when the agent itself declares a remote MCP server, some of whose tools the session may
 * defer (R2b C10), and names no tool `tool_search` or `tool_call` (it then keeps every tool in
 * its list).
 */
function defersTools(manifest: AgentManifest): boolean {
  const servers = manifest.capabilities.some(
    (capability) => Object.keys(capability.mcpServers ?? {}).length > 0
  );
  const taken = manifest.capabilities.some(
    (capability) =>
      capability.id === TOOLS_CAPABILITY_ID ||
      (capability.tools ?? []).some(
        (tool) => tool.name === TOOL_SEARCH_TOOL || tool.name === TOOL_CALL_TOOL
      )
  );
  return servers && !taken;
}

/** `manifest` with the session's capabilities added; the same object when none are. */
function addCapabilities(manifest: AgentManifest, spec: SandboxManifest | undefined): AgentManifest {
  let changed = false;
  const capabilities = manifest.capabilities.map((capability): CapabilityManifest => {
    if (capability.tools === undefined) return capability;
    let toolsChanged = false;
    const tools = capability.tools.map((tool): ToolManifest => {
      // Agents used as tools share the session's sandbox; flow agents used as tools run in
      // linked sessions that inherit it. One that declares its own sandbox keeps it.
      if (tool.agent === undefined || !isAgentManifest(tool.agent)) return tool;
      const agent = addCapabilities(
        tool.agent,
        sandboxSpecOf(tool.agent) === undefined ? spec : undefined
      );
      if (agent === tool.agent) return tool;
      toolsChanged = true;
      return { ...tool, agent };
    });
    if (!toolsChanged) return capability;
    changed = true;
    return { ...capability, tools };
  });
  const save = spec !== undefined;
  const read = readsStoredResults(manifest);
  const defer = defersTools(manifest);
  if (!save && !read && !defer && !changed) return manifest;
  return {
    ...manifest,
    // With a sandbox comes `save_artifact`, so files the agent makes reach the user (F8.1). The
    // sandbox's instructions name where the agent's skills are (R2 M4).
    capabilities: [
      ...capabilities,
      ...(spec === undefined
        ? []
        : [sandboxCapabilityManifest(spec, { skills: skillNamesOf(manifest) })]),
      ...(save || read ? [artifactsCapabilityManifest({ save, read })] : []),
      // Empty: when the session defers MCP tools, its tools put tool_search and tool_call here.
      ...(defer ? [toolsCapabilityManifest()] : []),
    ],
  };
}

/** `sandboxed` checked as a manifest, with its hash. */
function checked(original: AgentManifest, sandboxed: AgentManifest): SandboxedManifest {
  const parsed = AgentManifestSchema.safeParse(sandboxed);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    const clash = issues.some((message) => message === "Tool names must be unique");
    return {
      ok: false,
      message: clash
        ? `'${original.id}' declares a tool named like a sandbox tool (bash, read, write, edit, grep, glob, save_artifact). Rename it, or open the session with sandbox: false.`
        : `'${original.id}' cannot take this sandbox: ${[...new Set(issues)].join("; ")}`,
    };
  }
  return { ok: true, manifest: sandboxed, manifestHash: hashManifest(sandboxed) };
}

/** The agent's manifest with the sandbox capability added, or why it cannot take one. */
export function withSandboxCapability(
  manifest: AgentManifest,
  spec: SandboxManifest
): SandboxedManifest {
  return checked(manifest, addCapabilities(manifest, spec));
}

/**
 * The pinned manifest of an agent session without a sandbox: `read_artifact` for each agent of
 * the tree with a remote MCP server or an HTTP tool (R2b C11), and `nylorun.tools` for each with
 * a remote MCP server (R2b C10). Undefined when nothing is added, and the session pins its
 * definition as it is.
 */
export function withPlatformTools(manifest: AgentManifest): SandboxedManifest | undefined {
  const pinned = addCapabilities(manifest, undefined);
  return pinned === manifest ? undefined : checked(manifest, pinned);
}
