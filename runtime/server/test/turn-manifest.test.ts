import { describe, expect, it } from "vitest";
import type { AgentManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import {
  allowedManifestHashes,
  pinTurnManifest,
  rebaseTurnState,
  resolveMessageManifest,
  type TurnManifestStore,
} from "../src/core/turn-manifest.js";

function memoryStore(): TurnManifestStore & {
  readonly map: Map<string, AgentManifest>;
} {
  const map = new Map<string, AgentManifest>();
  return {
    map,
    get: (hash) => map.get(hash),
    put: (hash, manifest) => {
      map.set(hash, manifest);
    },
  };
}

function manifest(
  overrides: Partial<AgentManifest> & { id?: string } = {}
): AgentManifest {
  return {
    manifestSchemaVersion: 5,
    id: "coder",
    capabilities: [
      {
        id: "main",
        type: "agent",
        instructions: ["Fix."],
        tools: [
          {
            name: "deploy",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("turn-manifest", () => {
  it("pins a valid message.manifest by hash without latching (LOOP-R26)", () => {
    const pinned = manifest({ name: "pinned" });
    const pinnedHash = hashManifest(pinned);
    const store = memoryStore();
    const variant = manifest({
      name: "one-turn",
      capabilities: [
        {
          id: "main",
          type: "agent",
          instructions: ["Be careful."],
          tools: [],
        },
      ],
    });
    const pinnedTurn = pinTurnManifest({
      candidate: variant,
      pinned,
      store,
    });
    expect(pinnedTurn.ok).toBe(true);
    if (!pinnedTurn.ok) throw new Error("expected ok");
    expect(pinnedTurn.hash).toBe(hashManifest(variant));
    expect(store.get(pinnedTurn.hash)).toEqual(variant);

    // A later message without manifest resolves back to the pin.
    const next = resolveMessageManifest({
      pinned,
      pinnedHash,
      store,
    });
    expect(next).toEqual({ ok: true, manifest: pinned, hash: pinnedHash });
  });

  it("rejects a non-variant message.manifest (LOOP-A6)", () => {
    const pinned = manifest({
      capabilities: [
        {
          id: "policy",
          type: "agent",
          mcpServers: { gh: { name: "gh", type: "streamable-http", url: "https://x.example/mcp" } },
          tools: [],
        },
      ],
    });
    const store = memoryStore();
    const bad = pinTurnManifest({
      candidate: {
        ...pinned,
        capabilities: [{ id: "policy", type: "agent", tools: [] }],
      },
      pinned,
      store,
    });
    expect(bad).toMatchObject({ ok: false, code: "loop.invalid-agent" });
    expect(store.map.size).toBe(0);
  });

  it("rebases state.manifestHash across pinned and variant turns (LOOP-R27, LOOP-A5)", () => {
    const pinned = manifest();
    const pinnedHash = hashManifest(pinned);
    const store = memoryStore();
    const variant = manifest({
      capabilities: [
        {
          id: "main",
          type: "agent",
          instructions: ["variant"],
          tools: [],
        },
      ],
    });
    const turn = pinTurnManifest({ candidate: variant, pinned, store });
    if (!turn.ok) throw new Error("expected ok");
    const allowed = allowedManifestHashes({
      pinnedHash,
      variantHashes: store.map.keys(),
    });
    const isAllowedHash = (hash: string) => allowed.has(hash);

    // Pinned turn after a variant turn.
    const afterVariant = rebaseTurnState({
      state: {
        manifestHash: turn.hash,
        agentId: "coder",
        executionId: "s1",
      },
      turnManifestHash: pinnedHash,
      isAllowedHash,
    });
    expect(afterVariant?.manifestHash).toBe(pinnedHash);

    // Turn after a cancelled variant turn (state restored to turnStart / pinned).
    const afterCancel = rebaseTurnState({
      state: {
        manifestHash: pinnedHash,
        agentId: "coder",
        executionId: "s1",
      },
      turnManifestHash: turn.hash,
      isAllowedHash,
    });
    expect(afterCancel?.manifestHash).toBe(turn.hash);

    // Unrelated hash is left alone so runDurable can still reject.
    const foreign = rebaseTurnState({
      state: { manifestHash: "deadbeef", agentId: "coder", executionId: "s1" },
      turnManifestHash: pinnedHash,
      isAllowedHash,
    });
    expect(foreign?.manifestHash).toBe("deadbeef");
  });
});
