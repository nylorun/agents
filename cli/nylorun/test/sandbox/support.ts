import type { KubectlResult, KubectlRunner } from "../../src/sandbox/kubectl.js";

export interface KubectlCall {
  args: string[];
  input?: string;
}

export interface FakeKubectl extends KubectlRunner {
  calls: KubectlCall[];
  /** Calls made with `--context <context>`, without that prefix. */
  inContext(context: string): KubectlCall[];
}

const NOT_FOUND = { code: 1, stdout: "", stderr: 'Error from server (NotFound): not found' };

/**
 * kubectl fake: `respond` answers by arguments (the `--context` prefix included); unanswered
 * `get` calls are NotFound, everything else succeeds.
 */
export function fakeKubectl(
  respond: (args: string[], input?: string) => Partial<KubectlResult> | undefined,
): FakeKubectl {
  const calls: KubectlCall[] = [];
  return {
    calls,
    inContext(context) {
      return calls
        .filter((call) => call.args[0] === "--context" && call.args[1] === context)
        .map((call) => ({ ...call, args: call.args.slice(2) }));
    },
    async run(args, options = {}) {
      calls.push({ args: [...args], ...(options.input !== undefined ? { input: options.input } : {}) });
      const answer = respond([...args], options.input);
      if (answer) return { code: 0, stdout: "", stderr: "", ...answer };
      const rest = args[0] === "--context" ? args.slice(2) : args;
      if (rest[0] === "get") return NOT_FOUND;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

export const ok = (stdout: unknown = ""): Partial<KubectlResult> => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
});

export const NSLOOKUP = `Server:\t\t10.96.0.10
Address:\t10.96.0.10:53

** server can't find host.docker.internal.cluster.local: NXDOMAIN

Name:\thost.docker.internal
Address: 192.168.65.254

`;

/** A healthy Docker Desktop cluster with agent-sandbox v1.0.5 and an enforcing CNI. */
export function healthyCluster(options: { enforced?: boolean; version?: string; crd?: boolean } = {}) {
  let restrictedPeerAttempts = 0;
  return fakeKubectl((full) => {
    if (full[0] !== "--context") {
      if (full.join(" ") === "config get-contexts -o name") return ok("docker-desktop\nkind-nylorun\n");
      return undefined;
    }
    const args = full.slice(2);
    const line = args.join(" ");
    if (line === "config view --minify --raw -o json")
      return ok({ clusters: [{ cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "Q0E=" } }] });
    if (line === "get crd sandboxes.agents.x-k8s.io -o json")
      return options.crd === false ? undefined : ok({ spec: { versions: [{ name: "v1beta1", served: true }] } });
    if (line === "get deployment agent-sandbox-controller -n agent-sandbox-system -o json")
      return ok({
        spec: { template: { spec: { containers: [{ image: `registry.k8s.io/agent-sandbox/agent-sandbox-controller:${options.version ?? "v1.0.5"}` }] } } },
      });
    if (/^get secret nylorun-sandboxes-token -n \S+ -o json$/.test(line))
      return ok({ data: { token: Buffer.from("sa-token").toString("base64") } });
    if (args[0] === "exec" && args.includes("nslookup")) return { code: 1, stdout: NSLOOKUP };
    if (args[0] === "get" && args[1] === "pod" && args[2] === "peer") return ok("10.244.1.9");
    if (args[0] === "exec" && args.includes("wget")) {
      const pod = args[3];
      const url = args.at(-1)!;
      if (pod === "control") return { code: 0 };
      if (url.startsWith("http://10.244.1.9:")) {
        restrictedPeerAttempts += 1;
        return { code: options.enforced === false || restrictedPeerAttempts === 1 ? 0 : 1 };
      }
      // The allowed port is the first one the fake port probe picks (50000).
      return { code: url.endsWith(":50000/") ? 0 : 1 };
    }
    if (line === "get nodes -o json") return ok({ items: [{ metadata: { name: "desktop-worker" } }] });
    if (args[0] === "get" && args[1] === "pods" && args.includes("nylorun.dev/probe=pull"))
      return ok({
        items: [
          { metadata: { name: "pull-0-0" }, status: { phase: "Succeeded" } },
          {
            metadata: { name: "pull-0-1" },
            status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ErrImagePull" } } }] },
          },
        ],
      });
    return undefined;
  });
}
