/**
 * Run tokens for gate tests (F5): a test Tenant's store with its signing keys, sessions holding
 * a lease on an active turn, and the run tokens an advance would mint for them, registered in
 * `grants` as `advance.ts` does.
 */
import { randomBytes } from "node:crypto";
import { newTenantId } from "@nylorun/core/compatibility";
import { inProcessKeys, type Keys } from "../../src/keys/keys.js";
import type { SessionStore } from "../../src/store/types.js";
import type { Lease, Session } from "../../src/tenant/context.js";
import { createRunGrants, type RunGrants } from "../../src/tenant/run-grants.js";
import { mintRunToken, type RunGrant } from "../../src/tenant/run-token.js";
import { SigningKeys } from "../../src/tenant/signing-keys.js";
import type { VaultService } from "../../src/vault/service.js";
import { createTestSessionStore } from "./store.js";

export interface RunFixture {
  readonly tenantId: string;
  readonly store: SessionStore;
  /** Signs with the Tenant's keys, as the keys service does. */
  readonly keys: Keys;
  /** The grants a gate client reads; `run` and `takeOver` register theirs here. */
  readonly grants: RunGrants;
  /**
   * Creates session `sessionId` (running, on turn `turnId`), takes its lease and mints its run
   * token.
   */
  run(
    sessionId: string,
    options?: { agentId?: string; turnId?: string; manifest?: unknown },
  ): Promise<RunGrant>;
  /** A new owner takes the session over (the epoch moves on) and mints its own run token. */
  takeOver(sessionId: string): Promise<RunGrant>;
  /** Changes the session's body (a cancel, a new turn). */
  update(sessionId: string, patch: Partial<Session>): Promise<void>;
  /**
   * Journals a tool call of the session's active turn, `invoking`, as core does before a harness
   * sends it (R5.6). With `mcp`, the session's snapshot gets the tool's record, so the gate can
   * match the call to its server.
   */
  journal(
    sessionId: string,
    call: {
      effectId: string;
      toolName: string;
      input: unknown;
      mcp?: { serverName: string; serverToolName: string };
    },
  ): Promise<void>;
}

export async function runFixture(tenantId = newTenantId()): Promise<RunFixture> {
  const store = await createTestSessionStore(tenantId);
  const kek = randomBytes(32);
  const keys = inProcessKeys({
    store,
    // Signing never touches a vault credential.
    vault: undefined as unknown as VaultService,
    signingKeys: new SigningKeys({ tenantId, kek: () => kek }),
    kek: () => kek,
  });
  const grants = createRunGrants();
  const signer = { keys, config: { tenantId } };

  async function lease(sessionId: string): Promise<Lease> {
    return store.tx(async (t) => {
      const current = await t.get<Session & { owner: string | null; epoch: number }>("sessions", sessionId);
      if (current?.owner) await t.releaseOwnership(sessionId, current.owner, current.epoch);
      const taken = await t.takeOwnership(sessionId, { owner: "test-worker", now: new Date(), leaseMs: 60_000 });
      if (taken.status !== "owned") throw new Error(`Could not take ${sessionId}: ${taken.status}`);
      return { sessionId, owner: "test-worker", epoch: taken.epoch };
    });
  }

  async function mint(sessionId: string): Promise<RunGrant> {
    const taken = await lease(sessionId);
    const session = await store.tx((t) => t.get<Session>("sessions", sessionId));
    const grant = await mintRunToken(signer, taken, session!);
    grants.set(grant);
    return grant;
  }

  return {
    tenantId,
    store,
    keys,
    grants,
    async run(sessionId, options = {}) {
      await store.tx((t) =>
        t.put("sessions", sessionId, {
          id: sessionId,
          agentId: options.agentId ?? "bot",
          ownerUserId: "user-1",
          manifest: options.manifest ?? { id: options.agentId ?? "bot" },
          manifestHash: "h",
          implementationVersion: "1",
          status: "running",
          activeTurnId: options.turnId ?? "turn-1",
          creation: {},
        }),
      );
      return mint(sessionId);
    },
    takeOver: (sessionId) => mint(sessionId),
    async journal(sessionId, call) {
      await store.tx(async (t) => {
        const session = await t.get<Session>("sessions", sessionId);
        if (!session) throw new Error(`No session ${sessionId}`);
        await t.put("effects", call.effectId, {
          request: {
            kind: "tool",
            effectId: call.effectId,
            sessionId,
            turnId: session.activeTurnId,
            toolName: call.toolName,
            // What runs the call (protocol 15): an MCP tool's, else the agent's HTTP tool.
            ...(call.toolName === undefined ? {} : { target: { kind: call.mcp ? "mcp" : "http" } }),
            input: call.input,
            context: {},
          },
          status: "invoking",
        });
        if (call.mcp) {
          const tools = (session.mcpSnapshot as { mcpTools?: unknown[] } | undefined)?.mcpTools ?? [];
          await t.put("sessions", sessionId, {
            ...session,
            mcpSnapshot: {
              ...(session.mcpSnapshot as object | undefined),
              mcpTools: [
                ...tools,
                {
                  serverName: call.mcp.serverName,
                  serverToolName: call.mcp.serverToolName,
                  name: call.toolName,
                  inputSchema: { type: "object" },
                },
              ],
            },
          });
        }
      });
    },
    async update(sessionId, patch) {
      await store.tx(async (t) => {
        const current = await t.get<Session>("sessions", sessionId);
        await t.put("sessions", sessionId, { ...current, ...patch });
      });
    },
  };
}
