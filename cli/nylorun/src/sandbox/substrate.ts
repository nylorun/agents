/**
 * What `nylorun local sandbox enable --backend substrate` adds to a cluster that runs Agent
 * Substrate (ADR-138, Phase 1: preview): the sandboxes service's access to Substrate's API, the
 * Tenant's atespace (made by the sandboxes image's `substrate-setup`), and the name actors reach
 * the edge by, in CoreDNS.
 */
import { SERVICE_ACCOUNT } from "./manifests.js";

/** Substrate v1.0's install: its control plane's namespace, API Service and owner client. */
export const SUBSTRATE_NAMESPACE = "ate-system";
export const SUBSTRATE_API_SERVICE = "api";
export const SUBSTRATE_OWNER_ACCOUNT = "ate-client";
/** The audience ate-api-server accepts: its Service's DNS name. */
export const SUBSTRATE_AUDIENCE = `${SUBSTRATE_API_SERVICE}.${SUBSTRATE_NAMESPACE}.svc`;

/** Preferred host ports for the edge: the Harness API's and the gates' TLS fronts. */
export const PREFERRED_EDGE_PORTS = { harness: 8793, gates: 8794 } as const;

/** The name actors dial for the edge, unique to the Tenant's namespace. */
export function edgeHost(namespace: string): string {
  return `${namespace}.edge.nylorun.internal`;
}

const MANAGED = { "app.kubernetes.io/managed-by": "nylorun" };

/**
 * RBAC for the sandboxes service on Substrate: in the Tenant's namespace, its state ConfigMaps
 * and a token for its own ServiceAccount (its Substrate identity); in Substrate's namespace, a
 * port-forward to ate-api-server; cluster-wide, reading Substrate's trust bundles.
 */
export function substrateManifests(namespace: string): object[] {
  const subject = [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT, namespace }];
  const name = `nylorun-sandboxes-${namespace}`;
  return [
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: `${SERVICE_ACCOUNT}-substrate`, namespace, labels: MANAGED },
      rules: [
        { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "list", "watch", "create", "update", "delete"] },
        { apiGroups: [""], resources: ["serviceaccounts/token"], resourceNames: [SERVICE_ACCOUNT], verbs: ["create"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: `${SERVICE_ACCOUNT}-substrate`, namespace, labels: MANAGED },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: `${SERVICE_ACCOUNT}-substrate` },
      subjects: subject,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name, namespace: SUBSTRATE_NAMESPACE, labels: MANAGED },
      rules: [
        { apiGroups: [""], resources: ["services"], resourceNames: [SUBSTRATE_API_SERVICE], verbs: ["get"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["pods/portforward"], verbs: ["create", "get"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name, namespace: SUBSTRATE_NAMESPACE, labels: MANAGED },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
      subjects: subject,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name, labels: MANAGED },
      rules: [{ apiGroups: ["certificates.k8s.io"], resources: ["clustertrustbundles"], verbs: ["get", "list", "watch"] }],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name, labels: MANAGED },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name },
      subjects: subject,
    },
  ];
}

const BEGIN = "    # nylorun edge (nylorun local sandbox enable --backend substrate)";
const END = "    # end nylorun edge";

/**
 * CoreDNS's Corefile with `host` resolving to `address` for actors: a `hosts` block in the
 * default server block, marked so a later `enable` replaces it. Undefined when the Corefile has
 * no `.:53` block or already has a `hosts` plugin of its own.
 */
export function corefileWithEdge(corefile: string, host: string, address: string): string | undefined {
  const lines = corefile.split("\n");
  const start = lines.indexOf(BEGIN);
  if (start >= 0) {
    const end = lines.indexOf(END, start);
    if (end < 0) return undefined;
    const ours = lines.slice(start + 1, end).filter((line) => /^\s+\d+\.\d+\.\d+\.\d+\s+\S/.test(line));
    const entries = new Map(ours.map((line) => [line.trim().split(/\s+/)[1]!, line.trim().split(/\s+/)[0]!]));
    entries.set(host, address);
    lines.splice(start, end - start + 1, ...block(entries));
    return lines.join("\n");
  }
  if (lines.some((line) => /^\s*hosts(\s|$)/.test(line))) return undefined;
  const server = lines.findIndex((line) => /^\.:53\s*\{/.test(line.trim()));
  if (server < 0) return undefined;
  lines.splice(server + 1, 0, ...block(new Map([[host, address]])));
  return lines.join("\n");
}

function block(entries: Map<string, string>): string[] {
  return [
    BEGIN,
    "    hosts {",
    ...[...entries].map(([host, address]) => `      ${address} ${host}`),
    "      fallthrough",
    "    }",
    END,
  ];
}
