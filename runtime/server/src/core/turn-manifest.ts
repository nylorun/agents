import {
  AgentManifestSchema,
  type AgentManifest,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { isVariantOf } from "@nylorun/core/define";

export type TurnManifestStore = {
  /** Look up a previously pinned turn variant by hash. */
  get(hash: string): AgentManifest | undefined;
  /** Persist a validated turn variant for replay / Studio. */
  put(hash: string, manifest: AgentManifest): void;
};

export type TurnManifestOk = {
  readonly ok: true;
  readonly manifest: AgentManifest;
  readonly hash: string;
};

export type TurnManifestErr = {
  readonly ok: false;
  readonly code: "loop.invalid-agent";
  readonly message: string;
};

/**
 * The candidate's agents used as tools with the `runtime` block the pin gave each, when the
 * candidate left it out: a turn variant is written from the definition, and only the Runtime
 * writes `runtime`. A candidate that sets one keeps it, and must then match the pin's.
 */
function withPinnedDelegates(candidate: AgentManifest, pinned: AgentManifest): AgentManifest {
  if (candidate.tools === undefined) return candidate;
  const pinnedAgents = new Map(
    (pinned.tools ?? []).flatMap((tool) =>
      tool.agent !== undefined && !("kind" in tool.agent) ? [[tool.name, tool.agent] as const] : []
    )
  );
  let changed = false;
  const tools = candidate.tools.map((tool) => {
    const agent = tool.agent;
    const prior = pinnedAgents.get(tool.name);
    if (agent === undefined || "kind" in agent || agent.runtime !== undefined || prior?.runtime === undefined)
      return tool;
    changed = true;
    return { ...tool, agent: { ...agent, runtime: prior.runtime } };
  });
  return changed ? { ...candidate, tools } : candidate;
}

/**
 * Parse `message.manifest`, require it to be a variant of the session pin, and store the
 * manifest the turn runs with: the variant with the pin's `runtime` block (a variant never sets
 * one), by its hash. Applies to that turn only (caller must not latch).
 */
export function pinTurnManifest(args: {
  readonly candidate: unknown;
  readonly pinned: AgentManifest;
  readonly store: TurnManifestStore;
}): TurnManifestOk | TurnManifestErr {
  const parsed = AgentManifestSchema.safeParse(args.candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "loop.invalid-agent",
      message: "Turn manifest failed AgentManifestSchema validation",
    };
  }
  const candidate = withPinnedDelegates(parsed.data as AgentManifest, args.pinned);
  if (!isVariantOf(candidate, args.pinned)) {
    return {
      ok: false,
      code: "loop.invalid-agent",
      message:
        candidate.runtime === undefined
          ? "Turn manifest is not a variant of the session's pinned manifest"
          : "Turn manifest sets runtime, which only the Runtime writes: leave it out, and the turn runs with the session's",
    };
  }
  const manifest: AgentManifest =
    args.pinned.runtime === undefined ? candidate : { ...candidate, runtime: args.pinned.runtime };
  const hash = hashManifest(manifest);
  args.store.put(hash, manifest);
  return { ok: true, manifest, hash };
}

/** Resolve the manifest a turn runs with: optional message field, else the pin. */
export function resolveMessageManifest(args: {
  readonly pinned: AgentManifest;
  readonly pinnedHash: string;
  readonly messageManifest?: unknown;
  readonly store: TurnManifestStore;
}): TurnManifestOk | TurnManifestErr {
  if (args.messageManifest === undefined) {
    return {
      ok: true,
      manifest: args.pinned,
      hash: args.pinnedHash,
    };
  }
  return pinTurnManifest({
    candidate: args.messageManifest,
    pinned: args.pinned,
    store: args.store,
  });
}

/**
 * At turn start: if state's hash differs from the turn's, set `state.manifestHash`
 * to the turn's when both are the pin or validated variants (`loops.md` §4.2).
 * Leaves state unchanged when either hash is unrelated (runDurable still rejects).
 */
export function rebaseTurnState<S extends { manifestHash?: string }>(args: {
  readonly state: S | undefined;
  readonly turnManifestHash: string;
  readonly isAllowedHash: (hash: string) => boolean;
}): S | undefined {
  const state = args.state;
  if (!state?.manifestHash) return state;
  if (state.manifestHash === args.turnManifestHash) return state;
  if (
    !args.isAllowedHash(state.manifestHash) ||
    !args.isAllowedHash(args.turnManifestHash)
  )
    return state;
  return { ...state, manifestHash: args.turnManifestHash };
}

/** Allowed hashes: the session pin plus every stored turn variant. */
export function allowedManifestHashes(args: {
  readonly pinnedHash: string;
  readonly variantHashes: Iterable<string>;
}): Set<string> {
  const set = new Set<string>([args.pinnedHash]);
  for (const hash of args.variantHashes) set.add(hash);
  return set;
}
