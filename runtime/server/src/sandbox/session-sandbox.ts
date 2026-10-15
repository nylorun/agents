/**
 * Gives a session the sandbox chosen when it was opened, and the Runtime tools its agents need.
 * An agent session's pinned manifest is its definition with a `runtime` block
 * (`runtimeManifestFor`) on each agent of the tree:
 *
 * - with a sandbox, the six sandbox tools, their instructions and the resolved spec. The agents
 *   it uses as tools get the same spec, so the tree shares one sandbox. The sandbox's
 *   instructions name the agent's skills' folders (`/skills/<name>@<hash>/`);
 * - with skills, `load_skill`, `read_skill_resource` and the skill catalog.
 *
 * A session with neither pins its definition unchanged, so its manifest hash is the definition's.
 * The artifact tools (`read_artifact`, `save_artifact`) are not pinned: since protocol 15 they are
 * our engine's, which our harness offers each agent and runs itself. `tool_search` and
 * `tool_call` are not pinned either: they are session tools, given per run when the session
 * defers some MCP tools (R2b C10). An author tool may not take a name the Runtime serves (the
 * manifest schema refuses it), so a tool's name alone says whose it is. The definition in the
 * registry never changes.
 */
import { AgentManifestSchema } from "@nylorun/core/contracts";
import {
  hashManifest,
  runtimeManifestFor,
  type AgentManifest,
  type SandboxManifest,
  type ToolManifest,
} from "@nylorun/core/define";

export type SandboxedManifest =
  | { readonly ok: true; readonly manifest: AgentManifest; readonly manifestHash: string }
  | { readonly ok: false; readonly message: string };

function isAgentManifest(value: unknown): value is AgentManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind !== "workflow" &&
    typeof (value as AgentManifest).id === "string"
  );
}

/** `manifest` with its `runtime` block, and each agent it uses as a tool with its own. */
function pinRuntime(manifest: AgentManifest, spec: SandboxManifest | undefined): AgentManifest {
  let changed = false;
  const tools = manifest.tools?.map((tool): ToolManifest => {
    // Agents used as tools share the session's sandbox; flow agents used as tools run in linked
    // sessions that inherit it.
    if (tool.agent === undefined || !isAgentManifest(tool.agent)) return tool;
    const agent = pinRuntime(tool.agent, spec);
    if (agent === tool.agent) return tool;
    changed = true;
    return { ...tool, agent };
  });
  const runtime = runtimeManifestFor(manifest, spec === undefined ? {} : { sandbox: spec });
  if (runtime === undefined && !changed) return manifest;
  return {
    ...manifest,
    ...(changed ? { tools } : {}),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/** `pinned` checked as a manifest, with its hash. */
function checked(original: AgentManifest, pinned: AgentManifest): SandboxedManifest {
  const parsed = AgentManifestSchema.safeParse(pinned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    return {
      ok: false,
      message: `'${original.id}' cannot take the Runtime's tools: ${[...new Set(issues)].join("; ")}`,
    };
  }
  return { ok: true, manifest: pinned, manifestHash: hashManifest(pinned) };
}

/** The agent's pinned manifest with the session's sandbox, or why it cannot take one. */
export function withSandbox(manifest: AgentManifest, spec: SandboxManifest): SandboxedManifest {
  return checked(manifest, pinRuntime(manifest, spec));
}

/**
 * The pinned manifest of an agent session without a sandbox: the skill tools for each agent of
 * the tree with skills, and the definition as it is when none has any.
 */
export function withRuntimeTools(manifest: AgentManifest): SandboxedManifest {
  return checked(manifest, pinRuntime(manifest, undefined));
}
