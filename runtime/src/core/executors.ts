import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutorScope } from "@nylorun/core/contracts";
import type { SessionStore } from "../store/types.js";

const equals = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

/**
 * Executor bearer tokens are 256-bit CSPRNG values minted by the CLI and the wire schema
 * requires at least 16 characters, so an unsalted digest is adequate to keep them out of
 * the Session Store at rest. This is not a password KDF and must not be used for one.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface ExecutorRecord extends ExecutorScope {
  readonly tokenHash: string;
  /** Always true under Runtime Tenants; startup env executors are removed (D8). */
  readonly persisted: boolean;
  readonly updatedAt: string;
  /** Application principal that last registered this executor, when known. */
  readonly principalId?: string;
}

/**
 * Rejects tokens that are weak, empty of agent identity, or whose hash equals any
 * application principal hash (A5). Replaces the old `serverToken` equality check.
 */
export function assertExecutorCredential(
  executor: {
    agentId: string;
    implementationVersion: string;
    token: string;
  },
  applicationHashes: readonly string[],
): void {
  const tokenHash = hashToken(executor.token);
  const matchesApplication = applicationHashes.some((hash) =>
    equals(hash, tokenHash),
  );
  if (
    executor.token.length < 16 ||
    matchesApplication ||
    !executor.agentId ||
    !executor.implementationVersion
  )
    throw new Error(
      "Executor tokens require independent credentials and an agent id",
    );
}

/** Mint a 32-byte hex application/executor key for tests and CLI bootstrap. */
export function mintBearerToken(): string {
  return randomBytes(32).toString("hex");
}

export class ExecutorRegistry {
  private readonly byHash = new Map<string, ExecutorRecord>();
  private readonly byAgent = new Map<string, ExecutorRecord>();
  seed(records: readonly ExecutorRecord[]): void {
    for (const record of records) this.write(record);
  }
  find(tokenHash: string): ExecutorRecord | undefined {
    return this.byHash.get(tokenHash);
  }
  get(agentId: string): ExecutorRecord | undefined {
    return this.byAgent.get(agentId);
  }
  list(): readonly ExecutorRecord[] {
    return [...this.byAgent.values()];
  }
  upsert(record: ExecutorRecord): {
    rotated: boolean;
    previousHash?: string;
    previousPrincipalId?: string;
  } {
    const previous = this.byAgent.get(record.agentId);
    const collision = this.byHash.get(record.tokenHash);
    if (collision && collision.agentId !== record.agentId)
      throw new Error("Executor tokens must be unique");
    this.write(record);
    if (!previous || previous.tokenHash === record.tokenHash)
      return { rotated: false };
    return {
      rotated: true,
      previousHash: previous.tokenHash,
      ...(previous.principalId === undefined
        ? {}
        : { previousPrincipalId: previous.principalId }),
    };
  }
  remove(agentId: string): ExecutorRecord | undefined {
    const record = this.byAgent.get(agentId);
    if (!record) return undefined;
    this.byAgent.delete(agentId);
    this.byHash.delete(record.tokenHash);
    return record;
  }
  private write(record: ExecutorRecord): void {
    const previous = this.byAgent.get(record.agentId);
    if (previous) this.byHash.delete(previous.tokenHash);
    this.byAgent.set(record.agentId, record);
    this.byHash.set(record.tokenHash, record);
  }
}

/** A registry seeded from the executors the store persisted (at Tenant open). */
export async function loadExecutorRegistry(
  store: SessionStore,
): Promise<ExecutorRegistry> {
  const registry = new ExecutorRegistry();
  const rows = await store.tx((t) => t.listExecutors());
  registry.seed(
    rows.map((row) => ({
      agentId: row.agentId,
      implementationVersion: row.implementationVersion,
      ...(row.manifestHash === undefined
        ? {}
        : { manifestHash: row.manifestHash }),
      tokenHash: row.tokenHash,
      persisted: true,
      updatedAt: row.updatedAt,
      ...(row.principalId === undefined
        ? {}
        : { principalId: row.principalId }),
    })),
  );
  return registry;
}
