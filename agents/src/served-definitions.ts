/** The definitions an application serves Actions for (`createActionHandler`). */
import { AgentManifestSchema } from "@nylorun/core/contracts";
import {
  agentFrom,
  delegateOf,
  hashManifest,
  isFlowDelegate,
  isBuiltWorkflow,
  type BuiltAgent,
  type BuiltWorkflow,
} from "@nylorun/core/define";
import { assertNoMiddlewareClosures, type AgentSource } from "./client.js";
import type { ExecutableDefinition } from "./execute-action.js";
import { env } from "./http.js";

/** The implementation version to register: the option, `NYLORUN_IMPLEMENTATION_VERSION`, or `dev`. */
export function implementationVersionOf(options: {
  implementationVersion?: string;
}): string {
  return (
    options.implementationVersion ??
    env("NYLORUN_IMPLEMENTATION_VERSION") ??
    "dev"
  );
}

/** Agents embedded in a v2 workflow: served here, but saved only as part of the workflow. */
const embeddedAgents = new WeakMap<Map<string, ExecutableDefinition>, Set<string>>();

/** The ids among `agents` that are saved only as part of another definition. */
export function embeddedIn(agents: Map<string, ExecutableDefinition>): ReadonlySet<string> {
  return embeddedAgents.get(agents) ?? new Set<string>();
}

/**
 * Every definition `sources` serves, by id: the agents and workflows passed in, the agents
 * a v2 workflow embeds, and flow agents used as tools. `owner` names the caller in errors.
 */
export function buildAgents(
  sources: readonly (AgentSource | BuiltWorkflow)[],
  owner: string,
): Map<string, ExecutableDefinition> {
  const agents = new Map<string, ExecutableDefinition>();
  const embedded = new Set<string>();
  /**
   * Agents embedded in another definition (a v2 flow's agents, a flow agent used as a
   * tool) may be reached from more than one place; the same definition is served once.
   */
  const sameAsServed = (id: string, manifest: object): boolean => {
    const served = agents.get(id);
    if (!served) return false;
    if (hashManifest(served.manifest as never) === hashManifest(manifest as never)) return true;
    throw new Error(`Duplicate connected agent ${id}`);
  };
  const addAgent = (built: BuiltAgent, shared = false) => {
    assertNoMiddlewareClosures(built);
    AgentManifestSchema.parse(built.manifest);
    if (shared ? sameAsServed(built.id, built.manifest) : agents.has(built.id)) {
      if (!shared) throw new Error(`Duplicate connected agent ${built.id}`);
      return;
    }
    agents.set(built.id, built);
    for (const tool of built.getBinding().tools) {
      const delegate = delegateOf(tool);
      if (!delegate || !isFlowDelegate(delegate)) continue;
      // A flow agent used as a tool runs in its own linked session: serve its code too.
      if (!delegate.workflow)
        throw new Error(
          `Flow agent '${delegate.manifest.id}' is used as a tool by '${built.id}' but has no local implementation`,
        );
      addWorkflow(delegate.workflow, true);
      embedded.add(delegate.workflow.id);
    }
  };
  const addWorkflow = (workflow: BuiltWorkflow, shared = false) => {
    if (shared ? sameAsServed(workflow.id, workflow.manifest) : agents.has(workflow.id)) {
      if (!shared) throw new Error(`Duplicate connected agent ${workflow.id}`);
      return;
    }
    agents.set(workflow.id, workflow);
    const v2 = workflow.manifest.workflowSchemaVersion === 2;
    for (const binding of Object.values(workflow.getBinding().agents)) {
      addAgent(agentFrom(binding.manifest, binding.implementations), v2);
      if (v2) embedded.add(binding.manifest.id);
    }
  };
  for (const source of sources) {
    if (isBuiltWorkflow(source)) {
      addWorkflow(source);
      continue;
    }
    const built = source.build?.() ?? (source as BuiltAgent);
    if (isBuiltWorkflow(built)) {
      addWorkflow(built);
      continue;
    }
    addAgent(built);
  }
  if (!agents.size) throw new Error(`${owner} requires at least one agent`);
  // A definition passed in directly is saved on its own, even if another one embeds it.
  for (const source of sources) embedded.delete(source.id);
  embeddedAgents.set(agents, embedded);
  return agents;
}

/**
 * The manifest hash served for a workflow's flow actions. A run is pinned to one workflow
 * manifest, and its stage keys may shift between deploys, so flow actions for another hash
 * are left for whoever serves it.
 */
export function flowManifestHash(agent: ExecutableDefinition): string | undefined {
  return isBuiltWorkflow(agent) && agent.manifest.workflowSchemaVersion === 2
    ? hashManifest(agent.manifest)
    : undefined;
}
