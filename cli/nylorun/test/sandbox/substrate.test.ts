import { describe, expect, it } from "vitest";
import { installSubstrate } from "../../src/sandbox/commands.js";
import { corefileWithEdge, edgeHost, substrateManifests } from "../../src/sandbox/substrate.js";
import { renderComposeFile } from "../../src/stack/compose-file.js";
import { parsePersisted, renderEnvFile } from "../../src/stack/env-file.js";
import { fakeDocker, temporaryHome, testDeps } from "../stack/support.js";
import { fakeKubectl, NSLOOKUP, ok } from "./support.js";

const KIND_COREFILE = `.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30
    loop
    reload
    loadbalance
}
`;

/** A kind cluster with Substrate installed. */
function substrateCluster(options: { substrate?: boolean } = {}) {
  return fakeKubectl((full) => {
    if (full[0] !== "--context") return undefined;
    const args = full.slice(2);
    const line = args.join(" ");
    if (line === "config view --minify --raw -o json")
      return ok({ clusters: [{ cluster: { server: "https://127.0.0.1:41245", "certificate-authority-data": "Q0E=" } }] });
    if (line === "get service api -n ate-system -o json")
      return options.substrate === false ? undefined : ok({ spec: { ports: [{ port: 443 }] } });
    if (/^get secret nylorun-sandboxes-token -n \S+ -o json$/.test(line))
      return ok({ data: { token: Buffer.from("sa-token").toString("base64") } });
    if (args[0] === "run" && args.includes("nslookup")) return ok(NSLOOKUP);
    if (line === "get configmap coredns -n kube-system -o json") return ok({ data: { Corefile: KIND_COREFILE } });
    return undefined;
  });
}

const PORTS = { harness: 8790, gates: 8791, egress: 8792 };
const EDGE = { harness: 8793, gates: 8794 };

async function deps(kubectl: ReturnType<typeof substrateCluster>) {
  const stack = testDeps(await temporaryHome(), { docker: fakeDocker() });
  return { stack, kubectl, pollMs: 1 };
}

describe("installSubstrate", () => {
  it("makes the RBAC, finds the host, names the edge in CoreDNS and records the cluster", async () => {
    const kubectl = substrateCluster();
    const result = await installSubstrate(await deps(kubectl), { context: "kind-kind", tenant: "shop", ports: PORTS, edgePorts: EDGE });
    expect(result.token).toBe("sa-token");
    expect(result.cluster).toMatchObject({
      context: "kind-kind",
      namespace: "nylorun-sbx-shop",
      hostAddress: "192.168.65.254",
      bindAddress: "127.0.0.1",
      backend: "substrate",
      substrate: {
        atespace: "nylorun-sbx-shop",
        systemNamespace: "ate-system",
        apiService: "api",
        serviceAccount: "nylorun-sandboxes",
        edge: { host: "nylorun-sbx-shop.edge.nylorun.internal", harnessPort: 8793, gatesPort: 8794 },
      },
    });
    const calls = kubectl.inContext("kind-kind");
    const applied = calls.filter((c) => c.args[0] === "apply").map((c) => JSON.parse(c.input!).items.map((i: { kind: string }) => i.kind));
    expect(applied.flat()).toEqual(expect.arrayContaining(["Namespace", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]));
    const patch = calls.find((c) => c.args[0] === "patch");
    expect(patch?.args).toContain("coredns");
    const corefile = JSON.parse(patch!.args.at(-1)!).data.Corefile as string;
    expect(corefile).toContain("192.168.65.254 nylorun-sbx-shop.edge.nylorun.internal");
  });

  it("refuses a cluster without Substrate", async () => {
    await expect(
      installSubstrate(await deps(substrateCluster({ substrate: false })), { context: "kind-kind", tenant: "shop", ports: PORTS, edgePorts: EDGE }),
    ).rejects.toThrow(/Agent Substrate is not installed/);
  });
});

describe("corefileWithEdge", () => {
  it("adds a marked hosts block and replaces it on a second enable", () => {
    const once = corefileWithEdge(KIND_COREFILE, "a.edge.nylorun.internal", "192.168.65.254")!;
    expect(once.split("\n")[1]).toContain("nylorun edge");
    expect(once).toContain("      192.168.65.254 a.edge.nylorun.internal");
    const twice = corefileWithEdge(once, "b.edge.nylorun.internal", "172.17.0.1")!;
    expect(twice.match(/hosts \{/g)).toHaveLength(1);
    expect(twice).toContain("192.168.65.254 a.edge.nylorun.internal");
    expect(twice).toContain("172.17.0.1 b.edge.nylorun.internal");
    const moved = corefileWithEdge(twice, "a.edge.nylorun.internal", "10.0.0.9")!;
    expect(moved).toContain("10.0.0.9 a.edge.nylorun.internal");
    expect(moved).not.toContain("192.168.65.254 a.edge");
  });

  it("leaves a Corefile with its own hosts plugin, or without a default block, alone", () => {
    expect(corefileWithEdge(KIND_COREFILE.replace("ready", "ready\n    hosts /etc/hosts"), "a", "1.2.3.4")).toBeUndefined();
    expect(corefileWithEdge("example.org:53 {\n}\n", "a", "1.2.3.4")).toBeUndefined();
  });
});

describe("substrate settings", () => {
  it("names the edge after the namespace and grants only what the service uses", () => {
    expect(edgeHost("nylorun-sbx-shop")).toBe("nylorun-sbx-shop.edge.nylorun.internal");
    const rules = substrateManifests("nylorun-sbx-shop")
      .filter((m) => (m as { kind: string }).kind.endsWith("Role"))
      .flatMap((m) => (m as { rules: { resources: string[] }[] }).rules.flatMap((r) => r.resources));
    expect(rules.sort()).toEqual(["clustertrustbundles", "configmaps", "pods", "pods/portforward", "services", "serviceaccounts/token"].sort());
  });

  it("keeps the edge ports in .env and publishes them from the sandboxes service", () => {
    const sandboxes = {
      token: "a".repeat(64), image: "ghcr.io/nylorun/sandboxes:0.45.0-beta", harnessPort: 8790, gatesPort: 8791, egressPort: 8792,
      hostAddress: "192.168.65.254", bind: "127.0.0.1", edgeHarnessPort: 8793, edgeGatesPort: 8794,
    };
    const text = renderEnvFile({ ...envBase(), sandboxes } as never);
    expect(parsePersisted(text).sandboxes).toMatchObject({ edgeHarnessPort: 8793, edgeGatesPort: 8794 });
    const compose = renderComposeFile("nylorun-shop", "shop", { sandboxes: true, sandboxEdge: true });
    expect(compose).toContain("NYLORUN_SANDBOX_EDGE_HARNESS_PORT");
    expect(compose).toContain(":8443\" # the edge: the Harness API, for actors");
    expect(renderComposeFile("nylorun-shop", "shop", { sandboxes: true })).not.toContain("EDGE_HARNESS_PORT");
  });
});

function envBase() {
  return {
    runtimePort: 8787, studioPort: 4161, restatePort: 9070,
    restateUi: false, postgresPassword: "0123456789abcdef0123456789abcdef", gatesToken: "ab".repeat(32),
    harnessToken: "ef".repeat(32), harness: "remote", objectStoreSecretKey: "12".repeat(32),
    restateIdentityKey: "publickeyv1_x", uid: 501, gid: 20, hostRoot: "/h", runtimeImage: "r",
    studioImage: "s", studioFrameAncestors: "", studioAnalyticsId: "", tenantName: "shop",
    derivedPrincipals: "project",
  };
}
