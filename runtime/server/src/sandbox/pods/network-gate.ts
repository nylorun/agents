/**
 * The engine in a pod sandbox stays off the network until the pod's NetworkPolicy is in force
 * (F7.2). kindnet applies a new pod's policy asynchronously: a fresh pod reached the API server
 * (`10.96.0.1:443`) for 0.5 to 5 s after it started (8a). So before the engine joins, or runs
 * anything, it connects to addresses the policy must block (the API server's service address,
 * `KUBERNETES_SERVICE_HOST:KUBERNETES_SERVICE_PORT`, which the kubelet always sets) until each
 * fails `harness.networkConfirmations` times in a row (Host tuning) (refused, unreachable or timed out). A connection that
 * succeeds starts the count again. Past `timeoutMs` the engine exits, and the pod restarts it.
 *
 * A wake (`wake`: the disk already holds the engine's `volume-id`, so a pod of this sandbox ran
 * in this namespace before) starts the pod into a namespace whose policy has long been in force.
 * The gate then takes `harness.wakeNetworkConfirmations` failed probes of
 * `harness.wakeNetworkProbeMs` (1 of 150 ms) instead of three of a second: 152 ms instead of
 * 3.0 s per wake (the A2 wake lab). It trusts a wake's quick check only while nothing answers:
 * once a blocked address connects, the policy is not in force, and the gate goes back to the full
 * check for every address.
 */
import { connect } from "node:net";
import { hostTuning } from "../../tuning.js";

export interface BlockedAddress {
  readonly host: string;
  readonly port: number;
}

/** The addresses a pod's NetworkPolicy must block: the API server's service address. */
export function blockedAddresses(env: Readonly<Record<string, string | undefined>>): BlockedAddress[] {
  const override = env.NYLORUN_SANDBOX_BLOCKED_PROBE;
  if (override) {
    return override
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.lastIndexOf(":");
        return { host: entry.slice(0, at).replace(/^\[|\]$/g, ""), port: Number(entry.slice(at + 1)) };
      });
  }
  const host = env.KUBERNETES_SERVICE_HOST ?? "10.96.0.1";
  const port = Number(env.KUBERNETES_SERVICE_PORT ?? "443");
  return [{ host, port }];
}

/** Whether a TCP connection to `address` opens within `timeoutMs`. */
export function opens(address: BlockedAddress, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port });
    const done = (open: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface NetworkGateOptions {
  readonly addresses: readonly BlockedAddress[];
  /** Give up after this long. Default `harness.networkPolicyTimeoutMs` (Host tuning, 120 s). */
  readonly timeoutMs?: number;
  /** One connection attempt. Default `harness.networkProbeMs` (1 s). */
  readonly attemptMs?: number;
  /** Between attempts after a connection opened. Default `harness.networkPauseMs` (250 ms). */
  readonly pauseMs?: number;
  /** Consecutive failed connections that prove an address blocked. Default `harness.networkConfirmations` (3). */
  readonly confirmations?: number;
  /**
   * The pod starts on a disk an earlier pod of this sandbox used (a wake): check quickly, with
   * `harness.wakeNetworkProbeMs` and `harness.wakeNetworkConfirmations`, until an address answers.
   */
  readonly wake?: boolean;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/** Resolves once every address is blocked; rejects past the timeout. */
export async function awaitNetworkPolicy(
  options: NetworkGateOptions,
): Promise<{ waitedMs: number; check: "full" | "wake" }> {
  const tuning = hostTuning().harness;
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? tuning.networkPolicyTimeoutMs);
  const full = {
    needed: options.confirmations ?? tuning.networkConfirmations,
    attemptMs: options.attemptMs ?? tuning.networkProbeMs,
  };
  const quick = { needed: tuning.wakeNetworkConfirmations, attemptMs: tuning.wakeNetworkProbeMs };
  let check: "full" | "wake" = options.wake ? "wake" : "full";
  for (const address of options.addresses) {
    let failures = 0;
    let opened = 0;
    while (failures < (check === "wake" ? quick : full).needed) {
      if (Date.now() > deadline)
        throw new Error(
          `The pod's NetworkPolicy is not in force: ${address.host}:${address.port} still answered ${opened} time(s)`,
        );
      if (await opens(address, (check === "wake" ? quick : full).attemptMs)) {
        // An address the policy blocks answered: whatever the disk says, check in full.
        check = "full";
        failures = 0;
        opened += 1;
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? tuning.networkPauseMs));
      } else failures += 1;
    }
    options.log?.("sandbox_network_policy_checked", {
      address: `${address.host}:${address.port}`,
      openedBefore: opened,
      check,
    });
  }
  return { waitedMs: Date.now() - started, check };
}
