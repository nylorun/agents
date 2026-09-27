/**
 * Pure helpers over the session document: turn-manifest pins and variants, state rebasing,
 * the tools of an MCP snapshot, and the event target of an Action. No store access and no I/O.
 *
 * Later waves: stable; the async store conversion (Wave 1 / A) does not change these.
 */
import {
  agentTurnValue,
  type DurableSessionTool,
  type HostEffect,
} from "@nylorun/harness/run";
import type { Action } from "@nylorun/core/contracts";
import {
  delegateManifest,
  type AgentManifest,
  type JsonValue,
} from "@nylorun/core/define";
import { isWorkflowManifest } from "../core/flow-host.js";
import {
  allowedManifestHashes,
  rebaseTurnState,
  type TurnManifestStore,
} from "../core/turn-manifest.js";
import type { McpSnapshot, McpToolRecord } from "../mcp/snapshot.js";
import type { Session } from "./context.js";

export function sessionToolsOf(
  snapshot: McpSnapshot | undefined
): readonly DurableSessionTool[] | undefined {
  if (!snapshot?.mcpTools.length) return undefined;
  return snapshot.mcpTools.map((tool) => ({
    ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
    capabilityId: tool.capabilityId,
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
  }));
}

/** Turn-manifest store backed by the session's `variants` map (no schema change). */
export function variantStore(session: Session): TurnManifestStore {
  return {
    get(hash) {
      return session.variants?.[hash];
    },
    put(hash, manifest) {
      session.variants = { ...(session.variants ?? {}), [hash]: manifest };
    },
  };
}

/** Manifest this turn's checkpoint is pinned to (session pin or a stored variant). */
export function turnManifestOf(session: Session): AgentManifest {
  const hash = session.checkpoint?.manifestHash;
  if (!hash || hash === session.manifestHash) return session.manifest;
  return session.variants?.[hash] ?? session.manifest;
}

/** Wrap a linked agent turn so the Loop learns the turn's manifest (SD-I4 pin stays on session). */
export function linkedAgentOutput(
  session: Session,
  output: JsonValue | undefined
): JsonValue {
  if (isWorkflowManifest(session.manifest)) return output ?? null;
  return agentTurnValue(
    output ?? null,
    turnManifestOf(session)
  ) as unknown as JsonValue;
}

export function rebaseSessionState(session: Session, turnHash: string): void {
  const allowed = allowedManifestHashes({
    pinnedHash: session.manifestHash,
    variantHashes: Object.keys(session.variants ?? {}),
  });
  const next = rebaseTurnState({
    state: session.state,
    turnManifestHash: turnHash,
    isAllowedHash: (hash) => allowed.has(hash),
  });
  if (next !== session.state) session.state = next;
}

export function mcpToolOf(
  session: Session,
  request: Pick<HostEffect, "agent" | "capabilityId" | "toolName">
): McpToolRecord | undefined {
  return session.mcpSnapshot?.mcpTools.find(
    (tool) =>
      tool.agentId === request.agent?.id &&
      tool.capabilityId === request.capabilityId &&
      tool.name === request.toolName
  );
}

/** The manifest of the agent an effect belongs to: the root, or an agent it uses as a tool. */
export function manifestFor(
  manifest: AgentManifest,
  agent: HostEffect["agent"]
): AgentManifest | undefined {
  return agent ? delegateManifest(manifest, agent.id) : manifest;
}

export function pinnedTool(
  manifest: AgentManifest,
  capabilityId?: string,
  toolName?: string
) {
  const capability = manifest.capabilities.find(
    (item) => item.id === capabilityId
  );
  return capability?.tools?.find((tool) => tool.name === toolName);
}

/** What an action runs, for events: a tool name, or a hook point and its capabilities. */
export function actionTarget(action: Action) {
  if (action.kind === "hook")
    return {
      hook: action.hook,
      ...(action.agent ? { agent: action.agent } : {}),
    };
  if (action.kind === "tool" && "toolName" in action)
    return {
      toolName: action.toolName,
      ...(action.agent ? { agent: action.agent } : {}),
    };
  return {
    path: action.path,
    key: action.key,
    ...(action.agent ? { agent: action.agent } : {}),
  };
}
