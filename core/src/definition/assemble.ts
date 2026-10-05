import type { BoundMiddleware } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { AgentManifest, RuntimeManifest } from "../types/manifest.js";
import type { BuildDiagnostic, JsonObject } from "../types/shared.js";
import type { ToolSchemaSource } from "../types/tool.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { SkillManifest } from "../types/manifest.js";
import { bindAgent } from "./bind-agent.js";
import { createManifest } from "./manifest.js";
import { createSkillTools } from "./skill-tools.js";
import { DELEGATE_NAME_PATTERN, delegateOf, delegatesOf } from "./delegate.js";
import { SANDBOX_CAPABILITY_ID } from "./sandbox-capability.js";

type BuildResult<Agent> =
  | {
      readonly ok: true;
      readonly agent: Agent;
      readonly manifest: AgentManifest;
    }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };

export interface CapabilityDynamics {
  readonly middleware?: StepMiddleware<any>;
}

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {}
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  middleware: readonly BoundMiddleware[],
  identity: Readonly<{
    id: string;
    name?: string;
    description?: string;
    metadata?: JsonObject;
    outputSchema?: ToolSchemaSource;
    runtime?: RuntimeManifest;
  }>,
  dynamics: ReadonlyMap<string, CapabilityDynamics> = new Map()
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  if (typeof identity.id !== "string" || identity.id.length === 0) {
    diagnostics.push(
      diagnostic("agent.invalid-id", "Agent id must be a non-empty string")
    );
  }
  if (
    identity.name !== undefined &&
    (typeof identity.name !== "string" || identity.name.length === 0)
  ) {
    diagnostics.push(
      diagnostic("agent.invalid-name", "Agent name must be a non-empty string")
    );
  }

  const middlewareIds = new Set<string>();
  const frozen: BoundMiddleware[] = [];
  for (const item of middleware) {
    if (!item.id)
      diagnostics.push(
        diagnostic("middleware.invalid-id", "Middleware id must not be empty")
      );
    else if (middlewareIds.has(item.id))
      diagnostics.push(
        diagnostic(
          "middleware.duplicate-id",
          `Duplicate middleware id '${item.id}'`
        )
      );
    else if (typeof item.handle !== "function")
      diagnostics.push(
        diagnostic(
          "middleware.invalid",
          `Middleware '${item.id}' must provide a function`
        )
      );
    else if (item.name !== undefined && item.name.length === 0)
      diagnostics.push(
        diagnostic(
          "middleware.invalid",
          `Capability '${item.id}' name must be a non-empty string`
        )
      );
    else {
      middlewareIds.add(item.id);
      frozen.push(
        Object.freeze({
          id: item.id,
          ...(item.name === undefined ? {} : { name: item.name }),
          ...(item.description === undefined
            ? {}
            : { description: item.description }),
          handle: item.handle,
          hasMiddleware: item.hasMiddleware,
          ...(item.tools === undefined ? {} : { tools: item.tools }),
          ...(item.contributions === undefined
            ? {}
            : { contributions: item.contributions }),
          ...(item.manifestType === undefined
            ? {}
            : { manifestType: item.manifestType }),
          ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
          ...(item.mcpServers === undefined
            ? {}
            : { mcpServers: item.mcpServers }),
          ...(item.sandbox === undefined ? {} : { sandbox: item.sandbox }),
          ...(item.skills === undefined ? {} : { skills: item.skills }),
          ...(item.skillFiles === undefined
            ? {}
            : { skillFiles: item.skillFiles }),
          ...(item.sessionTools === undefined
            ? {}
            : { sessionTools: item.sessionTools }),
          ...(item.pluginRoot === undefined ? {} : { pluginRoot: item.pluginRoot }),
        })
      );
    }
  }

  const skilled = attachSkillTools(frozen);
  diagnostics.push(...skilled.diagnostics);
  // The wire schema rejects tool names shared across capabilities; report them at build time
  // with both owners. Duplicates within one capability keep their registration-time error.
  const toolOwners = new Map<string, string>();
  for (const item of skilled.items)
    for (const entry of item.tools ?? []) {
      const owner = toolOwners.get(entry.name);
      if (owner !== undefined && owner !== item.id)
        diagnostics.push(
          diagnostic(
            "tool.duplicate-name",
            `Tool '${entry.name}' is declared by capabilities '${owner}' and '${item.id}'`
          )
        );
      else toolOwners.set(entry.name, item.id);
    }

  diagnostics.push(...delegationDiagnostics(skilled.items));
  diagnostics.push(...sandboxDiagnostics(skilled.items));

  if (diagnostics.length)
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze(diagnostics),
    });
  const frozenMiddleware = Object.freeze(
    skilled.items.map((item) => Object.freeze(item))
  );
  const manifest = createManifest({
    id: identity.id,
    name: identity.name,
    description: identity.description,
    metadata: identity.metadata,
    outputSchema: identity.outputSchema,
    runtime: identity.runtime,
    middleware: frozenMiddleware,
  });
  const agent = bindAgent(frozenMiddleware, manifest, identity, dynamics);
  return Object.freeze({ ok: true, agent, manifest });
}

/** v1 delegation is one level deep and non-interactive; anything else fails the build by name. */
function delegationDiagnostics(items: readonly BoundMiddleware[]): BuildDiagnostic[] {
  const found: BuildDiagnostic[] = [];
  for (const item of items)
    for (const tool of item.tools ?? []) {
      const delegate = delegateOf(tool);
      if (!delegate) continue;
      const child = delegate.manifest;
      const extra = { toolName: tool.name };
      if (!DELEGATE_NAME_PATTERN.test(child.id))
        found.push(
          diagnostic(
            "delegation.invalid-name",
            `Agent '${child.id}' is used as a tool, so its id must be 1-64 letters, digits, '_' or '-'`,
            extra
          )
        );
      if (!child.description?.trim())
        found.push(
          diagnostic(
            "delegation.description-required",
            `Agent '${child.id}' is used as a tool by capability '${item.id}' and needs a description: the parent's model reads it to decide when to delegate`,
            extra
          )
        );
      // A flow agent runs in its own linked session; its agents may delegate in turn.
      if ((child as { kind?: unknown }).kind === "workflow") continue;
      const nested = delegatesOf(child as AgentManifest)[0];
      if (nested)
        found.push(
          diagnostic(
            "delegation.nested",
            `'${child.id}' delegates to '${nested.manifest.id}'; nested delegation is not supported yet`,
            extra
          )
        );
      for (const childTool of delegate.agent?.getBinding().tools ?? [])
        if (childTool.approval)
          found.push(
            diagnostic(
              "delegation.approval-unsupported",
              `'${childTool.name}' in '${child.id}' needs approval; agents used as tools can't ask for it yet, so keep it on the parent`,
              extra
            )
          );
    }
  return found;
}

/**
 * Definitions declare no sandbox: a session gets one when it is opened (Sandboxes v3). A
 * capability that still carries `sandbox` fails the build instead of being silently dropped.
 * The Runtime's own capability (`nylorun.sandbox`, in a session's pinned manifest) is exempt.
 */
function sandboxDiagnostics(items: readonly BoundMiddleware[]): BuildDiagnostic[] {
  return items
    .filter((item) => item.sandbox !== undefined && item.id !== SANDBOX_CAPABILITY_ID)
    .map((item) =>
      diagnostic(
        "sandbox.in-definition",
        `Capability '${item.id}' declares a sandbox. Agents no longer declare one: open the session with it instead, createSession({ sandbox: { image, network: { allow }, resources } }), or set the Tenant's default sandbox.`
      )
    );
}

/**
 * Gives the first capability with skills `load_skill` (and `read_skill_resource`) for every skill
 * of the agent. A tool of that name it already has is kept: an agent rebuilt from its manifest
 * brings the hosted ones the Runtime serves.
 */
function attachSkillTools(items: readonly BoundMiddleware[]): {
  readonly items: BoundMiddleware[];
  readonly diagnostics: readonly BuildDiagnostic[];
} {
  const skills = new Map<string, SkillManifest>();
  const diagnostics: BuildDiagnostic[] = [];
  let ownerId: string | undefined;
  for (const item of items)
    for (const [key, skill] of Object.entries(item.skills ?? {})) {
      if (key !== skill.name || skills.has(skill.name)) {
        diagnostics.push(
          diagnostic(
            "skill.duplicate-name",
            `Duplicate skill '${skill.name}' on capability '${item.id}'`
          )
        );
        continue;
      }
      skills.set(skill.name, skill);
      ownerId ??= item.id;
    }
  if (diagnostics.length > 0 || ownerId === undefined)
    return { items: [...items], diagnostics };
  const skillTools = createSkillTools(skills);
  const next = items.map((item) => {
    if (item.id !== ownerId) return item;
    const declared = new Set((item.tools ?? []).map((entry) => entry.name));
    const added = skillTools.filter((entry) => !declared.has(entry.name));
    if (added.length === 0) return item;
    const tools = [...(item.tools ?? []), ...added];
    const advertised = [...tools, ...(item.sessionTools ?? [])];
    const handle: StepMiddleware = async (request, next) =>
      item.handle(request, async () => {
        request.configuration.tools.set(item.id, advertised);
        return next();
      });
    return { ...item, tools, handle };
  });
  return { items: next, diagnostics };
}
