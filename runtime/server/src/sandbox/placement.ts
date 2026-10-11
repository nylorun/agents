/**
 * Placement (F7.2, D38): where a session's harness runs, checked when the session opens and
 * never downgraded afterwards. The Tenant maps harness ids (`nylorun`, or `*` for the rest) to
 * the hosts they may run on (`environments.config` `placement`): `harness-container` (the
 * Runtime's harness: in process, or the harness container) and `sandbox` (the engine in a pod).
 * Default: both. `"*": { hosts: [] }` refuses every harness the map does not name (R4.1).
 *
 * A session on a pod Environment runs on `sandbox`; every other session (a virtual or `none`
 * Environment, or none) on `harness-container` (D52). A host the Tenant does not allow is
 * `409 placement_refused`. A pod Environment needs sandbox pods: without a cluster (`nylorun
 * sandbox enable`), or with the sandboxes service not ready, it is `409 environment_unavailable`.
 */
import {
  DEFAULT_HARNESS,
  type EnvironmentKind,
  type PlacementHost as SandboxPlacementHost,
} from "@nylorun/core/contracts";
import type { TenantSandboxConfig } from "./tenant-config.js";
import type { TenantPods } from "../tenant/context.js";
import { fail } from "../tenant/http.js";

/** Our harness's id (blueprint D38): what a session runs unless its Environment names another. */
export const HARNESS_ID = DEFAULT_HARNESS;

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

/** Refuses a session whose harness, on the host its Environment needs, the Tenant does not allow. */
export function checkPlacement(
  config: TenantSandboxConfig,
  kind: EnvironmentKind | undefined,
  harness: string = HARNESS_ID,
): void {
  const host: SandboxPlacementHost = kind === "pod" ? "sandbox" : "harness-container";
  const allowed = placementOf(config, harness);
  if (allowed.includes(host)) return;
  const where = allowed.length === 0 ? "it may run nowhere" : `placement allows ${allowed.join(", ")}`;
  fail(
    409,
    allowed.length === 0
      ? `This Tenant does not run the ${harness} harness (${where}).`
      : kind === "pod"
        ? `This Tenant does not let the ${harness} harness run in a sandbox pod (${where}).`
        : `This Tenant runs the ${harness} harness only in sandbox pods (${where}): open the session on a pod Environment.`,
    { code: "placement_refused", details: { harness, host, allowed: [...allowed] } },
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

/** Refuses a pod Environment without sandbox pods, or with the sandboxes service down. */
export async function requirePods(pods: TenantPods | undefined, what: string): Promise<TenantPods> {
  if (!pods)
    return fail(409, `${what} needs sandbox pods, and this Runtime has no cluster: ${ENABLE_PODS}.`, {
      code: "environment_unavailable",
    });
  if (!(await podsReady(pods)))
    fail(409, `${what} needs sandbox pods, and the sandboxes service is not ready. Check \`nylorun sandbox status\`.`, {
      code: "environment_unavailable",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
  return pods;
}
