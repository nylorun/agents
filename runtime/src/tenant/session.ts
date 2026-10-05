/**
 * Pure helpers over the session document: turn-manifest pins and variants, state rebasing,
 * and the event target of an Action. No store access and no I/O. (The tools of an MCP snapshot
 * live in `mcp/snapshot.ts`.)
 *
 * Later waves: stable; the async store conversion (Wave 1 / A) does not change these.
 */
import { agentTurnValue } from "@nylorun/harness/run";
import type { Action } from "@nylorun/core/contracts";
import type { AgentManifest, JsonValue } from "@nylorun/core/define";
import { isWorkflowManifest } from "../core/flow-host.js";
import {
  allowedManifestHashes,
  rebaseTurnState,
  type TurnManifestStore,
} from "../core/turn-manifest.js";
import type { Session } from "./context.js";

export { manifestFor, sessionToolsOf } from "../mcp/snapshot.js";

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

/** What an action runs, for events: a tool name, or a flow path and key. */
export function actionTarget(action: Action) {
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
