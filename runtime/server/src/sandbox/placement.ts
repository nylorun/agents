/**
 * Placement (F7.2, D38): where a session's harness runs, checked when the session opens and
 * never downgraded afterwards. The Tenant maps harness ids (`nylorun`, or `*` for the rest) to
 * the hosts they may run on (`sandbox.config` `placement`): `harness-container` (the Runtime's
 * harness: in process, or the harness container) and `sandbox` (the engine in a pod sandbox).
 * Default: both.
 *
 * A session attached to a pod sandbox runs on `sandbox`; every other session on
 * `harness-container`. A host the Tenant does not allow is `409 placement_refused`. A pod
 * sandbox needs sandbox pods: without a cluster (`nylorun sandbox enable`), or with the
 * sandboxes service not ready, it is `409 sandbox_unavailable`.
 */
import type { SandboxPlacementHost, TenantSandboxConfig } from "@nylorun/core/contracts";
import type { TenantPods } from "../tenant/context.js";
import { fail } from "../tenant/http.js";

/** The harness every session of this Runtime runs (blueprint D38). */
export const HARNESS_ID = "nylorun";

export const DEFAULT_PLACEMENT: readonly SandboxPlacementHost[] = ["harness-container", "sandbox"];

/** The hosts harness `harnessId` may run on. */
export function placementOf(
  config: TenantSandboxConfig,
  harnessId: string = HARNESS_ID,
): readonly SandboxPlacementHost[] {
  const placement = config.placement;
  return placement?.[harnessId]?.hosts ?? placement?.["*"]?.hosts ?? DEFAULT_PLACEMENT;
}

/** How to enable sandbox pods, for the messages that need them. */
export const ENABLE_PODS = "run `nylorun sandbox enable --context <name>` to give this Tenant a cluster";

/** Refuses a session whose sandbox needs a host the Tenant does not allow. */
export function checkPlacement(config: TenantSandboxConfig, kind: "virtual" | "pod" | undefined): void {
  const host: SandboxPlacementHost = kind === "pod" ? "sandbox" : "harness-container";
  const allowed = placementOf(config);
  if (!allowed.includes(host))
    fail(
      409,
      kind === "pod"
        ? `This Tenant does not let the ${HARNESS_ID} harness run in a sandbox pod (placement allows ${allowed.join(", ")}).`
        : `This Tenant runs the ${HARNESS_ID} harness only in sandbox pods (placement allows ${allowed.join(", ")}): attach a pod sandbox with sandbox: { id }.`,
      { code: "placement_refused", details: { harness: HARNESS_ID, host, allowed: [...allowed] } },
    );
}

const READY_CACHE_MS = 5_000;
const ready = new WeakMap<TenantPods, { at: number; ready: boolean }>();

/** Whether the sandboxes service is up, cached for a few seconds. */
export async function podsReady(pods: TenantPods): Promise<boolean> {
  const cached = ready.get(pods);
  if (cached && Date.now() - cached.at < READY_CACHE_MS) return cached.ready;
  const answer = await pods.client.ready();
  ready.set(pods, { at: Date.now(), ready: answer });
  return answer;
}

/** Refuses a pod sandbox without sandbox pods, or with the sandboxes service down. */
export async function requirePods(pods: TenantPods | undefined, what: string): Promise<TenantPods> {
  if (!pods)
    return fail(409, `${what} needs sandbox pods, and this Runtime has no cluster: ${ENABLE_PODS}.`, {
      code: "sandbox_unavailable",
    });
  if (!(await podsReady(pods)))
    fail(409, `${what} needs sandbox pods, and the sandboxes service is not ready. Check \`nylorun sandbox status\`.`, {
      code: "sandbox_unavailable",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
  return pods;
}
