/**
 * The engine in a pod sandbox stays off the network until the pod's NetworkPolicy is in force
 * (F7.2). kindnet applies a new pod's policy asynchronously: a fresh pod reached the API server
 * (`10.96.0.1:443`) for 0.5 to 5 s after it started (8a). So before the engine joins, or runs
 * anything, it connects to addresses the policy must block (the API server's service address,
 * `KUBERNETES_SERVICE_HOST:KUBERNETES_SERVICE_PORT`, which the kubelet always sets) until each
 * fails `CONFIRMATIONS` times in a row (refused, unreachable or timed out). A connection that
 * succeeds starts the count again. Past `timeoutMs` the engine exits, and the pod restarts it.
 */
import { connect } from "node:net";

export interface BlockedAddress {
  readonly host: string;
  readonly port: number;
}

/** Consecutive failed connections that prove an address blocked. */
export const CONFIRMATIONS = 3;

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
  /** Give up after this long. Default 120 s. */
  readonly timeoutMs?: number;
  /** One connection attempt. Default 1 s. */
  readonly attemptMs?: number;
  /** Between attempts after a connection opened. Default 250 ms. */
  readonly pauseMs?: number;
  readonly confirmations?: number;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/** Resolves once every address is blocked; rejects past the timeout. */
export async function awaitNetworkPolicy(options: NetworkGateOptions): Promise<{ waitedMs: number }> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 120_000);
  const needed = options.confirmations ?? CONFIRMATIONS;
  for (const address of options.addresses) {
    let failures = 0;
    let opened = 0;
    while (failures < needed) {
      if (Date.now() > deadline)
        throw new Error(
          `The pod's NetworkPolicy is not in force: ${address.host}:${address.port} still answered ${opened} time(s)`,
        );
      if (await opens(address, options.attemptMs ?? 1_000)) {
        failures = 0;
        opened += 1;
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 250));
      } else failures += 1;
    }
    options.log?.("sandbox_network_policy_checked", {
      address: `${address.host}:${address.port}`,
      openedBefore: opened,
    });
  }
  return { waitedMs: Date.now() - started };
}
