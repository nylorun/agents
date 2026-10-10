/**
 * Pure helpers over the session document: turn-manifest pins and variants, and state rebasing.
 * No store access and no I/O. (The tools of an MCP snapshot
 * live in `mcp/snapshot.ts`.)
 *
 * Later waves: stable; the async store conversion (Wave 1 / A) does not change these.
 */
import type { AgentManifest } from "@nylorun/core/define";
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
