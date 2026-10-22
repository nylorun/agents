/**
 * The CLI's own timings and sizes (B15): how long `nylorun` waits for the local stack, how often
 * it polls, the healthchecks it writes into the Compose file, and the waits of `nylorun local
 * sandbox`. Each has a default, the value the CLI used before it was configuration. Set any part
 * in `NYLORUN_CLI_TUNING`, a JSON object of the groups below
 * (`{"stack":{"healthWaitMs":120000}}`), read each time a value is used; an unknown key or a value
 * that is not a positive whole number stops the command naming it.
 *
 * The Runtime's own timings are its Host tuning (`NYLORUN_TUNING`), which `nylorun start` passes
 * to its containers; Tenant-facing limits are the Runtime limits (`nylorun tenant settings
 * limits`). Neither is here.
 */
import { CliError } from "./errors.js";

/** A Compose healthcheck: seconds between checks, seconds one check may take, and failures in a row. */
export interface Healthcheck {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
}
const check = (retries: number, intervalSeconds = 2, timeoutSeconds = 5): Healthcheck => ({
  intervalSeconds,
  timeoutSeconds,
  retries,
});

export const DEFAULT_CLI_TUNING = deepFreeze({
  /** `nylorun start` and the commands that reach the local stack. */
  stack: {
    /** One `/health` or `/ready` probe of the Runtime. */
    probeTimeoutMs: 3_000,
    /** How long `start` waits for the Runtime's `/health`, and then for the Tenant to open. */
    healthWaitMs: 60_000,
    tenantWaitMs: 60_000,
    /** How often `start` polls while it waits. */
    pollMs: 500,
    /** While the Tenant opens, `nylorun-operate status` is asked every this many polls. */
    operateEveryPolls: 10,
    /** `docker compose up --wait-timeout` of the core services, and of Studio, in seconds. */
    composeWaitSeconds: 300,
    studioWaitSeconds: 120,
    /** How long a Studio login is retried, and how long one request for it may take. */
    loginWaitMs: 15_000,
    loginRequestMs: 5_000,
    /** How long a key check against the Runtime (`/v1/me`) may take. */
    keyCheckMs: 10_000,
    /** The local key file's lock: how long to wait for it, when a held one is stale, how often to look. */
    lockWaitMs: 30_000,
    lockStaleMs: 60_000,
    lockPollMs: 100,
    /** Tries at picking a free port. */
    portAttempts: 20,
    /** How long one seed or model call to the Management API may take (`nylorun dev`). */
    seedRequestMs: 15_000,
  },
  /** What `nylorun start` writes into the Compose file. */
  compose: {
    /** Postgres's `max_slot_wal_keep_size`: the WAL a stuck replication slot may hold, in MiB. */
    walKeepSizeMb: 4_096,
    healthchecks: {
      postgres: check(30),
      restate: check(30),
      rustfs: check(30),
      gateway: check(60),
      runtime: check(60),
      studio: check(30),
      harness: check(90),
      sandboxes: check(24, 5, 5),
    },
  },
  /** `nylorun local sandbox` (agent-sandbox on a local Kubernetes cluster). */
  sandbox: {
    /** How long a `kubectl` call may run before it is killed, and how much longer than a wait it was told. */
    kubectlTimeoutMs: 300_000,
    kubectlMarginMs: 20_000,
    /** Downloading the agent-sandbox manifest. */
    manifestDownloadMs: 60_000,
    /** How long the CRD may take to be Established, and `rollout status` of the controller, in seconds. */
    crdWaitSeconds: 60,
    rolloutWaitSeconds: 180,
    /** How long to wait for the service account's token Secret. */
    tokenWaitMs: 60_000,
    /** How often install and the network probe poll. */
    pollMs: 1_000,
    /** `docker compose up --wait-timeout` of the sandboxes service, in seconds. */
    composeWaitSeconds: 120,
    /** How long the sandboxes service's `/v1/info`, read from the runtime container, may take. */
    infoRequestMs: 5_000,
    /** The reachability probe: `wget -T` in seconds, and the `kubectl exec` around it. */
    probeWgetSeconds: 3,
    probeExecMs: 20_000,
    /** How long probe pods may take to be Ready, in seconds, and the NetworkPolicy to apply. */
    probeReadySeconds: 180,
    policyTimeoutMs: 30_000,
    /** How long image pre-pulls may take, and how often they are checked. */
    prepullMs: 300_000,
    prepullPollMs: 2_000,
    /** A probe pod's `terminationGracePeriodSeconds`, and its resources (Kubernetes quantities). */
    probeGraceSeconds: 1,
    probeCpu: "200m",
    probeMemory: "64Mi",
  },
});

type Widen<T> = T extends number ? number : T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type CliTuning = Widen<typeof DEFAULT_CLI_TUNING>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function merge(defaults: unknown, set: unknown, path: string): unknown {
  if (set === undefined) return defaults;
  if (typeof defaults === "number") {
    // A grace period may be 0; everything else is at least 1.
    const least = path.endsWith("GraceSeconds") ? 0 : 1;
    if (typeof set !== "number" || !Number.isSafeInteger(set) || set < least)
      throw new CliError(`NYLORUN_CLI_TUNING: ${path} must be a whole number of at least ${least}`, 2);
    return set;
  }
  if (typeof defaults === "string") {
    if (typeof set !== "string" || set.trim() === "")
      throw new CliError(`NYLORUN_CLI_TUNING: ${path} must be a non-empty string`, 2);
    return set;
  }
  if (!set || typeof set !== "object" || Array.isArray(set))
    throw new CliError(`NYLORUN_CLI_TUNING: ${path || "(root)"} must be an object`, 2);
  const out: Record<string, unknown> = {};
  const known = defaults as Record<string, unknown>;
  for (const key of Object.keys(set))
    if (!(key in known)) throw new CliError(`NYLORUN_CLI_TUNING: ${path ? `${path}.` : ""}${key} is not a setting`, 2);
  for (const [key, value] of Object.entries(known))
    out[key] = merge(value, (set as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
  return out;
}

/** The CLI's tuning: `NYLORUN_CLI_TUNING` over the defaults, read now. */
export function cliTuning(env: Readonly<Record<string, string | undefined>> = process.env): CliTuning {
  const raw = env.NYLORUN_CLI_TUNING;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CLI_TUNING;
  let set: unknown;
  try {
    set = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `NYLORUN_CLI_TUNING must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  return merge(DEFAULT_CLI_TUNING, set, "") as CliTuning;
}
