import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import type { DockerRunner } from "../stack/docker.js";
import type { PortProbe } from "../stack/ports.js";
import type { Kube } from "./kubectl.js";
import { networkPolicy, PROBE_IMAGE, probePod } from "./manifests.js";

/**
 * The NetworkPolicy probe `nylorun sandbox enable` runs before it trusts a cluster (D32), in
 * a throwaway namespace `nylorun-sbx-probe-<random>`:
 *
 * - a `control` pod (no policy) must reach a `peer` pod and the allowed host port, which
 *   proves the routes exist;
 * - the `restricted` pod, under the same policy shape as the Tenant's namespace (egress only
 *   to `<host>/32` on one port), must reach the allowed host port and nothing else: not the
 *   peer pod, not another port on the host.
 *
 * The host ports are served by a temporary busybox container published on the bind address.
 * The namespace and the container are always removed.
 */

export interface ProbeDeps {
  kube: Kube;
  docker: DockerRunner;
  ports: PortProbe;
  err(line: string): void;
  /** Delay between polls; tests shorten it. */
  pollMs?: number;
  /** How long the policy may take to apply. */
  policyTimeoutMs?: number;
}

export interface ProbeResult {
  hostAddress: string;
  bindAddress: string;
  enforced: true;
  probedAt: string;
  /** Images the pre-pull could not pull (warnings, not failures). */
  notPulled: string[];
}

const DOCKER_DESKTOP_HOST = "192.168.65.254";

/** Docker Desktop and OrbStack forward the host address to this machine's loopback. */
export function defaultBind(context: string, hostAddress: string): string {
  if (hostAddress === DOCKER_DESKTOP_HOST || context === "docker-desktop" || context === "orbstack")
    return "127.0.0.1";
  return hostAddress;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function assertIPv4(value: string, option: string): string {
  if (!IPV4.test(value)) throw new CliError(`${option} must be an IPv4 address: ${value}`, 2);
  return value;
}

/** The last IPv4 address `nslookup` prints for the name (the first is the DNS server). */
export function parseNslookup(output: string): string | undefined {
  const answer = output.split(/Name:\s*\S+/).slice(1).join("\n");
  const addresses = [...answer.matchAll(/Address(?:es)?:?\s*(?:\d+\s+)?([0-9.]+)\b/g)]
    .map((match) => match[1]!)
    .filter((address) => IPV4.test(address));
  return addresses.at(-1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** `wget` from a probe pod; true when the connection succeeds. */
async function reaches(kube: Kube, namespace: string, pod: string, address: string, port: number): Promise<boolean> {
  const result = await kube.run(
    ["exec", "-n", namespace, pod, "--", "wget", "-q", "-O", "-", "-T", "3", `http://${address}:${port}/`],
    { timeoutMs: 20_000 },
  );
  return result.code === 0;
}

export async function runProbe(
  deps: ProbeDeps,
  options: { hostAddress?: string; bindAddress?: string; prePull?: readonly string[] },
): Promise<ProbeResult> {
  const { kube, docker } = deps;
  const suffix = randomBytes(3).toString("hex");
  const namespace = `nylorun-sbx-probe-${suffix}`;
  const listener = namespace;
  const poll = deps.pollMs ?? 1000;
  let listenerStarted = false;
  const fail = (message: string) =>
    new CliError(`Refusing context ${kube.context}: ${message}`, 6);
  try {
    await kube.apply("Creating the probe namespace", [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { "app.kubernetes.io/managed-by": "nylorun" } } },
      probePod(namespace, "peer", { role: "peer", serve: true }),
      probePod(namespace, "control", { role: "control" }),
      probePod(namespace, "restricted", { role: "restricted" }),
    ]);
    await kube.check("Waiting for the probe pods", [
      "wait", "--for=condition=Ready", "pod", "--all", "-n", namespace, "--timeout=180s",
    ], { timeoutMs: 200_000 });

    let hostAddress = options.hostAddress;
    if (!hostAddress) {
      const lookup = await kube.run(["exec", "-n", namespace, "control", "--", "nslookup", "host.docker.internal"]);
      // busybox nslookup may exit non-zero after an NXDOMAIN on a search domain: parse anyway.
      hostAddress = parseNslookup(lookup.stdout);
      if (!hostAddress)
        throw fail(
          "pods cannot resolve host.docker.internal. Pass --host-address with the Docker host's address as pods reach it (172.17.0.1 for kind on Linux).",
        );
    }
    const bindAddress = options.bindAddress ?? defaultBind(kube.context, hostAddress);
    const allowed = await deps.ports.pickFree();
    let denied = await deps.ports.pickFree();
    if (denied === allowed) denied = await deps.ports.pickFree();

    const started = await docker.run([
      "run", "--detach", "--rm", "--name", listener, "--label", "dev.nylorun.probe=true",
      "--publish", `${bindAddress}:${allowed}:8080`, "--publish", `${bindAddress}:${denied}:8081`,
      PROBE_IMAGE, "sh", "-c",
      "echo ok > /tmp/index.html; httpd -p 8081 -h /tmp; exec httpd -f -p 8080 -h /tmp",
    ]);
    if (started.code !== 0)
      throw fail(`could not publish a probe listener on ${bindAddress}: ${started.stderr.trim()}`);
    listenerStarted = true;

    const peer = (await kube.check("Reading the peer pod's address", [
      "get", "pod", "peer", "-n", namespace, "-o", "jsonpath={.status.podIP}",
    ])).trim();
    if (!(await reaches(kube, namespace, "control", peer, 8080)))
      throw fail("a pod cannot reach another pod in its namespace (the probe cannot tell a policy from a broken network).");
    if (!(await reaches(kube, namespace, "control", hostAddress, allowed)))
      throw fail(
        `pods cannot reach ${hostAddress}:${allowed} on the Docker host (published on ${bindAddress}). Pass --host-address and --bind-address for this cluster.`,
      );

    await kube.apply("Applying the probe NetworkPolicy", [
      networkPolicy(namespace, hostAddress, [allowed], { name: "probe", podSelector: { "nylorun.dev/probe": "restricted" } }),
    ]);
    const deadline = Date.now() + (deps.policyTimeoutMs ?? 30_000);
    while (await reaches(kube, namespace, "restricted", peer, 8080)) {
      if (Date.now() > deadline)
        throw fail(
          "NetworkPolicy is not enforced: a pod under a deny policy still reached another pod. Sandboxes need a CNI that enforces NetworkPolicy (kindnet with policy support, Calico, Cilium).",
        );
      await sleep(poll);
    }
    if (await reaches(kube, namespace, "restricted", hostAddress, denied))
      throw fail(`NetworkPolicy is not enforced per port: a restricted pod reached ${hostAddress}:${denied}.`);
    if (!(await reaches(kube, namespace, "restricted", hostAddress, allowed)))
      throw fail(`a restricted pod cannot reach the allowed ${hostAddress}:${allowed}: the policy's ipBlock does not match the host route.`);

    const notPulled = options.prePull?.length ? await prePull(deps, namespace, options.prePull) : [];
    return { hostAddress, bindAddress, enforced: true, probedAt: new Date().toISOString(), notPulled };
  } finally {
    if (listenerStarted) await docker.run(["rm", "--force", listener]);
    await kube.run(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"]);
  }
}

interface PodList {
  items: {
    metadata: { name: string };
    status?: {
      phase?: string;
      containerStatuses?: { state?: { waiting?: { reason?: string } } }[];
    };
  }[];
}

/**
 * Pull images on every node with a pod per node and image (a cold pull of a pack-sized image
 * takes about 30 s). Best effort: images that do not pull (a local build, no registry) are
 * returned, for a warning.
 */
async function prePull(deps: ProbeDeps, namespace: string, images: readonly string[]): Promise<string[]> {
  const { kube } = deps;
  const nodes = JSON.parse(await kube.check("Listing nodes", ["get", "nodes", "-o", "json"])) as {
    items: { metadata: { name: string } }[];
  };
  const pods = nodes.items.flatMap((node, n) =>
    images.map((image, i) => ({
      name: `pull-${n}-${i}`,
      image,
      manifest: probePod(namespace, `pull-${n}-${i}`, {
        role: "pull", image, nodeName: node.metadata.name, command: ["true"],
      }),
    })),
  );
  await kube.apply("Pre-pulling images", pods.map((pod) => pod.manifest));
  const failed = new Set<string>();
  const done = new Set<string>();
  const deadline = Date.now() + 300_000;
  while (done.size + failed.size < pods.length && Date.now() < deadline) {
    const list = await kube.getJson<PodList>(["pods", "-n", namespace, "-l", "nylorun.dev/probe=pull"]);
    for (const item of list?.items ?? []) {
      const pod = pods.find((p) => p.name === item.metadata.name);
      if (!pod || done.has(pod.name) || failed.has(pod.name)) continue;
      const reason = item.status?.containerStatuses?.[0]?.state?.waiting?.reason ?? "";
      if (/ErrImagePull|ImagePullBackOff|InvalidImageName|ErrImageNeverPull/.test(reason)) failed.add(pod.name);
      else if (item.status?.phase && item.status.phase !== "Pending") done.add(pod.name);
    }
    if (done.size + failed.size < pods.length) await sleep(deps.pollMs ?? 2000);
  }
  return images.filter((image) =>
    pods.some((pod) => pod.image === image && !done.has(pod.name)),
  );
}
