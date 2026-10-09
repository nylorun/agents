/**
 * One reconcile of a pod sandbox (S5): the `Sandbox` object's handler
 * (`WorkerHandlers.sandbox`, serialized per sandbox). It reads the row and the Tenant's
 * settings, asks the sandboxes service for the Sandbox's status, decides (`lifecycle.ts`),
 * then carries the decision out:
 *
 * 1. a join token rotation is written first (its hash and a new `rev`), so the token the
 *    service writes to the join Secret is always the one the row names;
 * 2. deletes and the apply go to the service, outside any transaction;
 * 3. the row's patch and the events are written under the row's lock, unless the row changed
 *    since it was read (an API call or a join): then nothing is written and the reconcile runs
 *    again at once. A host epoch the decision moves is recomputed from the locked row.
 *
 * It answers when to look again (`retryAfterMs`) and the timers to arm (idle, TTL). Only
 * infrastructure errors throw; Restate retries those.
 */
import { randomBytes } from "node:crypto";
import type { SandboxPodPatch } from "../../store/types.js";
import type { TenantContext } from "../../tenant/context.js";
import { readSandboxConfig } from "../tenant-config.js";
import { sha256Hex } from "../join.js";
import type { PodStatus } from "./client.js";
import { decide, type PodRow, type PodTimer, type PodTrigger } from "./lifecycle.js";
import { podLifecycleConfig, podSpecOf, type PodSandboxSpec } from "./spec.js";

/** What a reconcile asks of the `Sandbox` object next. */
export interface SandboxReconcileResult {
  readonly retryAfterMs?: number;
  readonly arm?: readonly { readonly timer: PodTimer; readonly at: number }[];
}

export async function reconcileSandbox(
  ctx: TenantContext,
  sandboxId: string,
  trigger: PodTrigger,
): Promise<SandboxReconcileResult> {
  const pods = ctx.pods;
  if (!pods || ctx.closed) return {};
  const read = await ctx.store.tx(async (t) => {
    const row = await t.sandboxResource(sandboxId);
    if (!row || row.kind !== "pod" || !row.pod) return undefined;
    const config = await readSandboxConfig(t);
    const busy = (await t.sessionsOnSandbox(sandboxId)).some(
      (session) => (session as { activeTurnId?: string | null }).activeTurnId != null,
    );
    return { row: row as PodRow, config, busy };
  });
  if (!read) return {};
  const { row, config } = read;
  const status = async (name: string): Promise<PodStatus | undefined> => {
    try {
      return await pods.client.status(name);
    } catch (error) {
      ctx.config.logger.warn("sandboxes service status failed", {
        sandboxId,
        name,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  const lifecycle = podLifecycleConfig(config);
  const decision = decide({
    row,
    config: lifecycle,
    status: await status(row.pod.k8sName),
    ...(row.pod.retiring ? { retiring: await status(row.pod.retiring) } : {}),
    busy: read.busy,
    now: Date.now(),
    trigger,
  });
  let patch: SandboxPodPatch = { ...decision.patch };
  const unchanged = (current: PodRow["pod"] | undefined) =>
    current !== undefined &&
    current.rev === row.pod.rev &&
    current.k8sName === row.pod.k8sName &&
    current.desired === row.pod.desired;

  // A new join token is recorded before the service writes it to the Sandbox's Secret.
  let joinToken: string | undefined;
  let rev = patch.rev ?? row.pod.rev;
  if (decision.apply?.rotateJoin) {
    joinToken = randomBytes(32).toString("base64url");
    rev += 1;
    const recorded = await ctx.store.tx(async (t) => {
      const current = await t.sandboxResource(sandboxId, { lock: true });
      if (!unchanged(current?.pod)) return false;
      await t.updateSandboxPod(
        sandboxId,
        { joinTokenHash: sha256Hex(joinToken!), rev },
        new Date().toISOString(),
      );
      return true;
    });
    if (!recorded) return { retryAfterMs: 0 };
    row.pod.rev = rev;
    row.pod.joinTokenHash = sha256Hex(joinToken);
    patch = { ...patch, rev };
  }

  for (const name of decision.delete) {
    try {
      await pods.client.delete(name, `${name}.delete`);
    } catch (error) {
      ctx.config.logger.warn("sandboxes service delete failed", {
        sandboxId,
        name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (decision.apply) {
    const spec = podSpecOf({
      sandboxId,
      spec: row.spec as PodSandboxSpec,
      pod: { ...row.pod, rev },
      config,
      mode: decision.apply.mode,
      harnessImage: pods.harnessImage,
      ...(joinToken ? { joinToken } : {}),
    });
    try {
      await pods.client.put(row.pod.k8sName, spec);
    } catch (error) {
      ctx.config.logger.warn("sandboxes service apply failed", {
        sandboxId,
        name: row.pod.k8sName,
        message: error instanceof Error ? error.message : String(error),
      });
      // Nothing of the decision is written: the next reconcile decides again.
      return { retryAfterMs: decision.retryAfterMs ?? 5_000 };
    }
  }

  const written = await ctx.store.tx(async (t) => {
    const current = await t.sandboxResource(sandboxId, { lock: true });
    if (!current?.pod) return { kind: "gone" as const };
    if (!unchanged(current.pod)) return { kind: "changed" as const };
    if (decision.removeRow) {
      await t.deleteSandboxResource(sandboxId);
      return { kind: "removed" as const };
    }
    const epochMoved = patch.hostEpoch !== undefined && patch.hostEpoch !== null;
    const finalPatch: SandboxPodPatch = {
      ...patch,
      ...(epochMoved ? { hostEpoch: current.pod.hostEpoch + 1 } : {}),
    };
    if (Object.keys(finalPatch).length > 0)
      await t.updateSandboxPod(sandboxId, finalPatch, new Date().toISOString());
    for (const item of decision.events) await t.sandboxEvent(sandboxId, item.type, item.payload as never);
    if (epochMoved) await t.signal({ type: "host.revoked", sandboxId, epoch: finalPatch.hostEpoch! });
    return { kind: "written" as const };
  });
  if (written.kind === "changed") return { retryAfterMs: 0 };
  if (written.kind === "removed") {
    await ctx.sandbox.removeSandbox(sandboxId).catch(() => undefined);
    return {};
  }
  return {
    ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
    ...(decision.arm.length > 0 ? { arm: decision.arm } : {}),
  };
}
