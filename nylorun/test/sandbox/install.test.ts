import { describe, expect, it } from "vitest";
import { apiRoute } from "../../src/sandbox/cluster-file.js";
import { installCluster } from "../../src/sandbox/commands.js";
import { CONTROLLER_URL, networkPolicy, tenantManifests, tenantNamespace } from "../../src/sandbox/manifests.js";
import { defaultBind, parseNslookup } from "../../src/sandbox/probe.js";
import { fakeDocker, fakeFetch, temporaryHome, testDeps } from "../stack/support.js";
import { healthyCluster, NSLOOKUP } from "./support.js";

const PORTS = { harness: 8790, gates: 8791, egress: 8792 };

async function deps(kubectl: ReturnType<typeof healthyCluster>, fetchText?: string) {
  const docker = fakeDocker();
  const fetch = fakeFetch((url) => (url === CONTROLLER_URL && fetchText !== undefined ? new Response(fetchText) : undefined));
  const stack = testDeps(await temporaryHome(), { docker, fetch });
  return { stack, kubectl, docker, fetch, pollMs: 1, policyTimeoutMs: 50 };
}

const install = (
  d: Awaited<ReturnType<typeof deps>>,
  extra: { hostAddress?: string; context?: string } = {},
) =>
  installCluster(d, {
    context: "docker-desktop",
    tenant: "shop",
    prePull: ["python:3.13-slim", "nylorun-runtime:ci"],
    ports: PORTS,
    ...extra,
  });

describe("installCluster", () => {
  it("installs into the named context only, probes the policy and records the cluster", async () => {
    const kubectl = healthyCluster();
    const d = await deps(kubectl);
    const result = await install(d);

    // Every call names the context; none relies on the current one.
    for (const call of kubectl.calls.filter((c) => c.args[0] !== "config"))
      expect(call.args.slice(0, 2)).toEqual(["--context", "docker-desktop"]);
    expect(result.token).toBe("sa-token");
    expect(result.notPulled).toEqual(["nylorun-runtime:ci"]);
    expect(result.cluster).toMatchObject({
      context: "docker-desktop",
      server: "https://127.0.0.1:6443",
      dial: "host.docker.internal:6443",
      tlsServerName: "127.0.0.1",
      caData: "Q0E=",
      namespace: "nylorun-sbx-shop",
      controllerVersion: "v1.0.5",
      hostAddress: "192.168.65.254",
      bindAddress: "127.0.0.1",
      ports: PORTS,
      networkPolicy: { enforced: true },
    });

    // The controller was present: nothing downloaded.
    expect(d.fetch.requests).toEqual([]);
    const calls = kubectl.inContext("docker-desktop");
    const applied = calls
      .filter((c) => c.args[0] === "apply")
      .map((c) => JSON.parse(c.input!) as { items: { kind: string; metadata: { name: string; namespace?: string } }[] });
    expect(applied[0]!.items.map((i) => i.kind)).toEqual([
      "Namespace", "ServiceAccount", "Role", "RoleBinding", "Secret",
    ]);
    // The namespace's policy: no ingress, egress to the host's three ports only.
    const policy = applied.at(-1)!.items[0]!;
    expect(policy).toEqual(networkPolicy("nylorun-sbx-shop", "192.168.65.254", [8790, 8791, 8792]));

    // The probe listener is published on the bind address and removed; so is the namespace.
    const listener = d.docker.calls.find((c) => c[0] === "run")!;
    expect(listener).toEqual(expect.arrayContaining(["--publish", "127.0.0.1:50000:8080", "--publish", "127.0.0.1:50001:8081"]));
    const probeNamespace = listener[listener.indexOf("--name") + 1]!;
    expect(probeNamespace).toMatch(/^nylorun-sbx-probe-[0-9a-f]{6}$/);
    expect(d.docker.calls).toContainEqual(["rm", "--force", probeNamespace]);
    expect(calls.map((c) => c.args.join(" "))).toContain(
      `delete namespace ${probeNamespace} --ignore-not-found --wait=false`,
    );
  });

  it("refuses a cluster that does not enforce NetworkPolicy, and still cleans up", async () => {
    const kubectl = healthyCluster({ enforced: false });
    const d = await deps(kubectl);
    await expect(install(d)).rejects.toThrow(/NetworkPolicy is not enforced/);
    expect(d.docker.calls.some((c) => c[0] === "rm")).toBe(true);
    expect(kubectl.inContext("docker-desktop").some((c) => c.args[0] === "delete")).toBe(true);
    // The Tenant's namespace never got a policy: nothing was applied after the probe's.
    const lastApply = kubectl.inContext("docker-desktop").filter((c) => c.args[0] === "apply").at(-1)!;
    expect(lastApply.input).toContain('"name":"probe"');
  });

  it("refuses another agent-sandbox version and never upgrades it", async () => {
    const d = await deps(healthyCluster({ version: "v1.0.4" }));
    await expect(install(d)).rejects.toThrow(/agent-sandbox v1\.0\.4 is installed; Nylorun needs v1\.0\.5/);
    expect(d.kubectl.inContext("docker-desktop").some((c) => c.args[0] === "apply")).toBe(false);
  });

  it("installs the pinned controller only when its sha256 matches", async () => {
    const d = await deps(healthyCluster({ crd: false }), "not the release manifest");
    await expect(install(d)).rejects.toThrow(/sha256 .* not the pinned/);
    expect(d.fetch.requests.map((r) => r.url)).toEqual([CONTROLLER_URL]);
    expect(d.kubectl.inContext("docker-desktop").some((c) => c.args[0] === "apply")).toBe(false);
  });

  it("uses --host-address instead of resolving host.docker.internal (kind on Linux)", async () => {
    const kubectl = healthyCluster();
    const d = await deps(kubectl);
    const result = await install(d, { hostAddress: "172.17.0.1", context: "kind-nylorun" });
    expect(kubectl.calls.some((c) => c.args.includes("nslookup"))).toBe(false);
    expect(result.cluster).toMatchObject({ hostAddress: "172.17.0.1", bindAddress: "172.17.0.1" });
  });
});

describe("helpers", () => {
  it("names the Tenant's namespace as a DNS label", () => {
    expect(tenantNamespace("shop")).toBe("nylorun-sbx-shop");
    expect(tenantNamespace("my_shop")).toMatch(/^nylorun-sbx-my-shop-[0-9a-f]{6}$/);
    expect(tenantNamespace("a".repeat(80)).length).toBeLessThanOrEqual(63);
  });

  it("gives the sandboxes ServiceAccount lifecycle verbs only", () => {
    const role = tenantManifests("nylorun-sbx-shop", "shop").find(
      (m) => (m as { kind: string }).kind === "Role",
    ) as { rules: { resources: string[]; verbs: string[] }[] };
    const resources = role.rules.flatMap((r) => r.resources);
    expect(resources).not.toContain("networkpolicies");
    expect(resources).not.toContain("pods/exec");
    expect(role.rules.find((r) => r.resources.includes("secrets"))!.verbs).not.toContain("list");
  });

  it("dials the Docker host for an API server on this machine's loopback, keeping its TLS name", () => {
    expect(apiRoute("https://127.0.0.1:60864")).toEqual({ dial: "host.docker.internal:60864", tlsServerName: "127.0.0.1" });
    expect(apiRoute("https://localhost:6443")).toEqual({ dial: "host.docker.internal:6443", tlsServerName: "localhost" });
    expect(apiRoute("https://172.17.0.1:41234")).toEqual({ dial: "172.17.0.1:41234", tlsServerName: "172.17.0.1" });
    expect(apiRoute("https://k8s.example")).toEqual({ dial: "k8s.example:443", tlsServerName: "k8s.example" });
    expect(() => apiRoute("http://127.0.0.1:8080")).toThrow(/not https/);
  });

  it("reads the host address from busybox nslookup and binds loopback on Docker Desktop", () => {
    expect(parseNslookup(NSLOOKUP)).toBe("192.168.65.254");
    expect(parseNslookup("Server: 10.96.0.10\nAddress: 10.96.0.10:53\n")).toBeUndefined();
    expect(defaultBind("docker-desktop", "192.168.65.254")).toBe("127.0.0.1");
    expect(defaultBind("kind-nylorun", "172.17.0.1")).toBe("172.17.0.1");
  });
});
