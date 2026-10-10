/**
 * An in-memory sandboxes service (F7.2): what the Go service and agent-sandbox do, as far as
 * core sees it through `SandboxesClient`. A `PUT` with a new `opId` applies the spec; `Running`
 * gets a pod (a new UID) that is ready at once (or after `readyAfterMs`), `Suspended` loses it.
 * The join token of each name is kept as its Secret is. Tests drive what the cluster does on
 * its own: a pod replaced (`relaunch`), a volume gone (`losePvc`), a Sandbox deleted
 * (`vanish`), the service down (`down`).
 */
import { randomUUID } from "node:crypto";
import {
  SandboxesError,
  type ClusterInfo,
  type PodSpec,
  type PodStatus,
  type SandboxesClient,
} from "../../src/sandbox/pods/client.js";

interface FakeSandbox {
  spec: PodSpec;
  podUid?: string;
  readyAt?: number;
  volume: boolean;
  joinToken?: string;
}

export interface FakeSandboxes extends SandboxesClient {
  /** Sandboxes by name, as the cluster holds them. */
  readonly sandboxes: Map<string, FakeSandbox>;
  /** Every request, in order, for assertions. */
  readonly calls: { method: string; name?: string; spec?: PodSpec }[];
  /** The join token in the Sandbox's Secret. */
  joinToken(name: string): string | undefined;
  /** The current pod's UID. */
  podUid(name: string): string | undefined;
  /** The pod is replaced on the same volume (a force delete): a new UID. */
  relaunch(name: string): string;
  /** The volume is gone (and the pod with it). */
  losePvc(name: string): void;
  /** The Sandbox, pod and volume are gone. */
  vanish(name: string): void;
  /** The service answers nothing while true. */
  down: boolean;
  /** How long a new pod takes to be ready. Default 0. */
  readyAfterMs: number;
}

export function fakeSandboxes(): FakeSandboxes {
  const sandboxes = new Map<string, FakeSandbox>();
  const calls: FakeSandboxes["calls"] = [];
  const reachable = () => {
    if (fake.down) throw new SandboxesError(0, "unreachable", "The sandboxes service did not answer");
  };
  const statusOf = (name: string): PodStatus => {
    const sandbox = sandboxes.get(name);
    if (!sandbox) return { name, exists: false, deleting: false, ready: false, suspended: false, expired: false, volume: "missing" };
    const now = Date.now();
    const expired = sandbox.spec.shutdownTime !== undefined && Date.parse(sandbox.spec.shutdownTime) <= now;
    if (expired) sandbox.podUid = undefined;
    const running = sandbox.spec.mode === "Running" && !expired && sandbox.podUid !== undefined;
    return {
      name,
      exists: true,
      deleting: false,
      mode: sandbox.spec.mode,
      ready: running && (sandbox.readyAt ?? 0) <= now,
      suspended: sandbox.spec.mode === "Suspended" && sandbox.podUid === undefined,
      expired,
      ...(running ? { podUID: sandbox.podUid, podPhase: "Running" } : {}),
      volume: sandbox.volume ? "present" : "missing",
      opId: sandbox.spec.opId,
      ...(sandbox.spec.shutdownTime ? { shutdownTime: sandbox.spec.shutdownTime } : {}),
    };
  };
  const fake: FakeSandboxes = {
    sandboxes,
    calls,
    down: false,
    readyAfterMs: 0,
    async ready() {
      return !fake.down;
    },
    async info(): Promise<ClusterInfo> {
      reachable();
      return {
        namespace: "nylorun-sbx-test",
        context: "fake",
        controllerVersion: "v1.0.5",
        networkPolicy: { enforced: true, probedAt: new Date(0).toISOString() },
      };
    },
    async put(name, spec) {
      reachable();
      calls.push({ method: "PUT", name, spec });
      const current = sandboxes.get(name);
      if (current?.spec.opId === spec.opId) return statusOf(name);
      const sandbox: FakeSandbox = current ?? { spec, volume: true };
      sandbox.spec = spec;
      if (spec.joinToken) sandbox.joinToken = spec.joinToken;
      if (spec.mode === "Running" && sandbox.podUid === undefined) {
        sandbox.podUid = randomUUID();
        sandbox.readyAt = Date.now() + fake.readyAfterMs;
      }
      if (spec.mode === "Suspended") sandbox.podUid = undefined;
      sandboxes.set(name, sandbox);
      return statusOf(name);
    },
    async status(name) {
      reachable();
      return statusOf(name);
    },
    async delete(name) {
      reachable();
      calls.push({ method: "DELETE", name });
      sandboxes.delete(name);
      return statusOf(name);
    },
    joinToken: (name) => sandboxes.get(name)?.joinToken,
    podUid: (name) => sandboxes.get(name)?.podUid,
    relaunch(name) {
      const sandbox = sandboxes.get(name);
      if (!sandbox) throw new Error(`no sandbox ${name}`);
      sandbox.podUid = randomUUID();
      return sandbox.podUid;
    },
    losePvc(name) {
      const sandbox = sandboxes.get(name);
      if (!sandbox) throw new Error(`no sandbox ${name}`);
      sandbox.volume = false;
      sandbox.podUid = undefined;
    },
    vanish(name) {
      sandboxes.delete(name);
    },
  };
  return fake;
}
