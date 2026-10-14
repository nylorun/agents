/**
 * Join token → host token (F7.2, D42): how a pod sandbox's engine becomes the sandbox's host.
 *
 * Core mints a join token (32 random bytes) per incarnation of a pod sandbox (a create, a
 * reset), keeps only its sha256 (`sandbox_resources.join_token_hash`), and hands the plaintext
 * once to the sandboxes service, which writes it to the Sandbox's join Secret, mounted in the
 * pod. The engine exchanges it at the Harness API listener (`POST
 * /nylorun/harness/v1/host/join`, `ws-server.ts`) with its pod's UID:
 *
 * 1. the hash matches, the sandbox is a pod sandbox that is neither deleted, lost nor expired;
 * 2. the UID is the pod the sandboxes service sees in the Sandbox now (a token copied to
 *    another pod is refused);
 * 3. the volume is the sandbox's: the engine keeps an id on the volume (`volumeId`), recorded
 *    at the first join of an incarnation. agent-sandbox recreates a claim that was deleted, empty;
 *    a join from such a volume finds the sandbox `lost` (`sandbox.lost`) and is refused;
 * 4. the host epoch is bumped: tokens of the previous host stop working, and its connection is
 *    closed (`HarnessApiServer.revokeHost`), so its runs are given to the next advance. A pod
 *    other than the one that joined last records `sandbox.relaunched` (same volume, new pod);
 *    a first pod after a create, resume or reset records `sandbox.running`.
 *
 * The answer is a host token (`nylorun-host+jwt`, accepted only by the Harness API listener,
 * for a connection that serves this sandbox alone) and an egress token
 * (`nylorun-egress+jwt`, accepted only by egress-gate), both bound to the sandbox, the epoch
 * and the pod (`tenant/host-token.ts`). `renew` mints a new pair at the same epoch while the
 * host is current; it is refused once the epoch moved.
 *
 * The answer also carries the installation's egress CA certificate (R2c, D50): the engine adds it
 * to the trust bundle every command gets, so a host egress-gate terminates TLS for (one an
 * `environment_secret` is bound to) is trusted. Only the certificate: its key stays in keys.
 *
 * Every refusal answers the same 401 (the reason is logged), so a caller learns nothing about
 * which check failed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { HostJoinAnswer as PublishedJoinAnswer, HostJoinRequest } from "@nylorun/core/harness-api";
import { isEnvironmentId } from "@nylorun/core/contracts";
import type { Environment } from "../store/types.js";
import type { TenantContext } from "../tenant/context.js";
import { recoverLostVolume, runPendingSeed } from "../artifacts/disk.js";
import {
  recordSetup,
  setupFile,
  setupPlanOf,
  setupState,
  type SetupFile,
  type SetupPlan,
  type SetupReport,
} from "./setup.js";
import {
  mintHostTokens,
  staleHost,
  verifyHostToken,
  type HostClaims,
  type HostGrant,
  type HostTokenKeyCache,
} from "../tenant/host-token.js";

export type { HostJoinRequest } from "@nylorun/core/harness-api";

/** What `join` and `renew` answer: the published answer, with our engine's setup plan typed. */
export type HostJoinAnswer = Omit<PublishedJoinAnswer, "setup"> & {
  /** What to run and copy on a new disk before taking turns (`sandbox/setup.ts`); join only. */
  readonly setup?: SetupPlan;
};

/** A refused join, renewal or host connection. */
export class HostAuthError extends Error {
  override readonly name = "HostAuthError";
  constructor(
    readonly status: 400 | 401 | 503,
    message: string,
    /** Logged, never answered. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The Tenant's side of the exchange, as the Harness API listener calls it. */
export interface HostAuthority {
  join(request: HostJoinRequest): Promise<HostJoinAnswer>;
  renew(hostToken: string): Promise<HostJoinAnswer>;
  /** The claims of a current host's token, for a connection; refuses a stale one. */
  verify(hostToken: string): Promise<HostClaims>;
  /** Whether to run the setup again, with the plan to run (`GET host/setup`). */
  setup(hostToken: string): Promise<{ retry: boolean; setup?: SetupPlan }>;
  /** Records the setup's outcome (`POST host/setup`). */
  reportSetup(hostToken: string, report: SetupReport): Promise<void>;
  /** Input file `index` of the host's recipe, or one file of it (`GET host/files/{index}[/{path}]`). */
  setupFile(hostToken: string, index: number, path: string | undefined): Promise<SetupFile | undefined>;
}

const POD_UID = /^[A-Za-z0-9-]{1,64}$/;
const REFUSED = "The join was refused";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function answerOf(grant: HostGrant, caCertificate: string): HostJoinAnswer {
  return {
    hostToken: grant.hostToken,
    egressToken: grant.egressToken,
    sandboxId: grant.claims.sandboxId,
    epoch: grant.claims.epoch,
    expiresAt: new Date(grant.claims.expiresAt).toISOString(),
    caCertificate,
  };
}

export function hostAuthority(ctx: TenantContext): HostAuthority {
  const cache: HostTokenKeyCache = new Map();
  const refuse = (reason: string): never => {
    throw new HostAuthError(401, REFUSED, reason);
  };

  const verified = async (raw: string): Promise<HostClaims> => {
    const verdict = await verifyHostToken(ctx.store, ctx.config.tenantId, raw, "host", cache);
    if (!verdict.ok) return refuse(verdict.reason);
    const stale = await staleHost(ctx.store, verdict.claims);
    if (stale) return refuse(stale);
    return verdict.claims;
  };

  return {
    async join(request) {
      const { sandboxId, podUid, joinToken, volumeId } = request;
      if (
        !isEnvironmentId(sandboxId) ||
        typeof podUid !== "string" ||
        !POD_UID.test(podUid) ||
        typeof joinToken !== "string" ||
        joinToken.length === 0 ||
        joinToken.length > 512 ||
        (volumeId !== undefined && (typeof volumeId !== "string" || !POD_UID.test(volumeId)))
      )
        throw new HostAuthError(400, "A join is { sandboxId, podUid, joinToken }");
      const pods = ctx.pods;
      if (!pods) return refuse("this Runtime has no sandbox pods");
      const hash = sha256Hex(joinToken);
      const usable = (row: Environment | undefined) => {
        const pod = row?.pod;
        if (!row || row.kind !== "pod" || !pod) return refuse("no such pod sandbox");
        if (!pod.joinTokenHash || !sameHash(pod.joinTokenHash, hash)) return refuse("join token mismatch");
        if (pod.desired === "deleted") return refuse("the sandbox was deleted");
        // A pod being stopped joins nothing: its sandbox runs again only when asked to.
        if (pod.desired !== "running") return refuse("the sandbox is stopped");
        if (pod.observed === "lost") return refuse("the sandbox is lost");
        return pod;
      };
      const readRow = () => ctx.store.tx((t) => t.environment(sandboxId));
      const before = usable(await readRow());
      let current: string | undefined;
      try {
        current = (await pods.client.status(before.k8sName)).podUID;
      } catch (error) {
        throw new HostAuthError(
          503,
          "The sandboxes service did not answer; try again",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (current !== podUid) refuse("the pod is not the sandbox's current pod");
      const joined = await ctx.store.tx(async (t) => {
        const row = await t.environment(sandboxId, { lock: true });
        const pod = usable(row);
        if (pod.k8sName !== before.k8sName) refuse("the sandbox was reset during the join");
        const epoch = pod.hostEpoch + 1;
        const now = new Date().toISOString();
        if (pod.volumeId !== undefined && volumeId !== pod.volumeId) {
          // A new, empty volume under the same Sandbox: the sandbox's files are gone.
          const reason = "The sandbox's volume was replaced: its files are gone";
          await t.updateEnvironmentPod(sandboxId, { observed: "lost", reason, hostEpoch: epoch }, now);
          await t.environmentEvent(sandboxId, "environment.lost", { reason });
          // Its Sandbox is deleted; only a reset brings the sandbox back.
          await t.signal({ type: "host.revoked", sandboxId, epoch });
          await t.signalSandbox(sandboxId, { kind: "reconcile" });
          return { lost: epoch };
        }
        await t.updateEnvironmentPod(
          sandboxId,
          {
            hostEpoch: epoch,
            podUid,
            ...(pod.volumeId === undefined && volumeId !== undefined ? { volumeId } : {}),
            ...(pod.desired === "running" ? { observed: "running", reason: null } : {}),
          },
          now,
        );
        if (pod.podUid !== podUid) {
          if (pod.podUid !== undefined) await t.environmentEvent(sandboxId, "environment.relaunched", { hostEpoch: epoch });
          else await t.environmentEvent(sandboxId, "environment.running", { hostEpoch: epoch });
        }
        // The previous host's connection (an older epoch) serves nothing more, on any process.
        await t.signal({ type: "host.revoked", sandboxId, epoch });
        return {
          epoch,
          setup: row ? await setupPlanOf(ctx, t, row) : undefined,
          seeded: row?.diskSeed !== undefined,
          afterSeed: row?.diskSeed?.setup === true,
        };
      });
      if ("lost" in joined) {
        // With a disk version, a new volume seeded from the latest one (R2d step 3).
        void recoverLostVolume(ctx, sandboxId).catch(() => undefined);
        return refuse("the volume was replaced: the sandbox is lost");
      }
      ctx.config.logger.info("sandbox host joined", { sandboxId, epoch: joined.epoch });
      const answer = answerOf(
        await mintHostTokens(ctx, { sandboxId, epoch: joined.epoch, podUid }),
        await ctx.keys.egressCa(),
      );
      if (joined.seeded) {
        // The engine connects next; the seed waits for it, then writes the version.
        void runPendingSeed(ctx, sandboxId);
        // A fork onto other setup (Q17): the engine runs it once the version is written.
        if (joined.afterSeed) return { ...answer, seeded: true, afterSeed: true, ...(joined.setup ? { setup: joined.setup } : {}) };
        return { ...answer, seeded: true };
      }
      return joined.setup ? { ...answer, setup: joined.setup } : answer;
    },
    async renew(hostToken) {
      const claims = await verified(hostToken);
      return answerOf(await mintHostTokens(ctx, claims), await ctx.keys.egressCa());
    },
    verify: verified,
    async setup(hostToken) {
      const claims = await verified(hostToken);
      return setupState(ctx, claims.sandboxId);
    },
    async reportSetup(hostToken, report) {
      const claims = await verified(hostToken);
      await recordSetup(ctx, claims.sandboxId, claims.epoch, report);
    },
    async setupFile(hostToken, index, path) {
      const claims = await verified(hostToken);
      return setupFile(ctx, claims.sandboxId, index, path);
    },
  };
}
