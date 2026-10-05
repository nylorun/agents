/**
 * Gives a session the sandbox chosen when it was opened. An agent session's pinned manifest is
 * its definition plus the `nylorun.sandbox` capability (the six built-in tools, the sandbox
 * instructions and the resolved spec) and the `nylorun.artifacts` capability (`save_artifact`),
 * also added to each agent it uses as a tool, so the tree shares one spec. The sandbox's
 * instructions name the agent's skills' folders (`/skills/<name>/`). The definition in the
 * registry never changes.
 */
import { AgentManifestSchema } from "@nylorun/core/contracts";
import {
  artifactsCapabilityManifest,
  hashManifest,
  sandboxCapabilityManifest,
  type AgentManifest,
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

function addCapability(manifest: AgentManifest, spec: SandboxManifest): AgentManifest {
  const capabilities = manifest.capabilities.map((capability) =>
    capability.tools === undefined
      ? capability
      : {
          ...capability,
          tools: capability.tools.map((tool): ToolManifest => {
            // Agents used as tools share the session's sandbox; flow agents used as tools run
            // in linked sessions that inherit it.
            if (tool.agent === undefined || !isAgentManifest(tool.agent)) return tool;
            if (sandboxSpecOf(tool.agent) !== undefined) return tool;
            return { ...tool, agent: addCapability(tool.agent, spec) };
          }),
        }
  );
  return {
    ...manifest,
    // With a sandbox comes `save_artifact`, so files the agent makes reach the user (F8.1). The
    // sandbox's instructions name where the agent's skills are (R2 M4).
    capabilities: [
      ...capabilities,
      sandboxCapabilityManifest(spec, { skills: skillNamesOf(manifest) }),
      artifactsCapabilityManifest(),
    ],
  };
}

/** The agent's manifest with the sandbox capability added, or why it cannot take one. */
export function withSandboxCapability(
  manifest: AgentManifest,
  spec: SandboxManifest
): SandboxedManifest {
  const sandboxed = addCapability(manifest, spec);
  const parsed = AgentManifestSchema.safeParse(sandboxed);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    const clash = issues.some((message) => message === "Tool names must be unique");
    return {
      ok: false,
      message: clash
        ? `'${manifest.id}' declares a tool named like a sandbox tool (bash, read, write, edit, grep, glob, save_artifact). Rename it, or open the session with sandbox: false.`
        : `'${manifest.id}' cannot take this sandbox: ${[...new Set(issues)].join("; ")}`,
    };
  }
  return { ok: true, manifest: sandboxed, manifestHash: hashManifest(sandboxed) };
}
