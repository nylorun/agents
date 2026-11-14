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
export const PREFERRED_EDGE_PORTS = { harness: 8793, gates: 8794, keys: 8795 } as const;

/** The name actors dial for the edge, unique to the Tenant's namespace. */
export function edgeHost(namespace: string): string {
  return `${namespace}.edge.nylorun.internal`;
}

const MANAGED = { "app.kubernetes.io/managed-by": "nylorun" };

/**
 * RBAC for the sandboxes service on Substrate: in the Tenant's namespace, its state ConfigMaps
 * and a token for its own ServiceAccount (its Substrate identity); in Substrate's namespace, a
 * port-forward to ate-api-server; cluster-wide, reading Substrate's trust bundles and watching
 * worker pods (label `ate.dev/worker-pool`), so it can suspend the Tenant's actors on one that
 * stops before Substrate's 30 minutes are up (suspend before drain).
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
      rules: [
        { apiGroups: ["certificates.k8s.io"], resources: ["clustertrustbundles"], verbs: ["get", "list", "watch"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
      ],
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

/**
 * Keys at Substrate's egress (ADR-142): the keys provider, `sandboxes provider` from the sandboxes
 * image, runs beside Substrate's egress in its namespace. One per cluster: its config Secret holds
 * an entry per Tenant, by atespace. Substrate learns it at its own install
 * (`--credential-provider`); `enable` deploys it and checks that registration, never changing
 * Substrate's install.
 */
export const KEYS_PROVIDER_NAME = "keys.nylorun.dev";
export const KEYS_PROVIDER = "nylorun-keys-provider";
export const KEYS_PROVIDER_PORT = 50051;
/** The address Substrate's egress dials, as `ate-setup`'s `--credential-provider` names it. */
export const KEYS_PROVIDER_ADDRESS = `${KEYS_PROVIDER}.${SUBSTRATE_NAMESPACE}.svc:${KEYS_PROVIDER_PORT}`;
/** The flag to install Substrate with, so its egress asks the keys provider. */
export const KEYS_PROVIDER_FLAG = `--credential-provider='[{"name":"${KEYS_PROVIDER_NAME}","address":"${KEYS_PROVIDER_ADDRESS}"}]'`;

/** One Tenant's entry in the keys provider's config. */
export interface KeysProviderTenant {
  readonly decideUrl: string;
  readonly token: string;
  readonly edgeCa: string;
  readonly outside?: { readonly url: string; readonly token: string };
}

/** Whether Substrate's egress was installed with the keys provider among its providers. */
export function keysProviderRegistered(deployment: unknown): boolean {
  const containers =
    (deployment as { spec?: { template?: { spec?: { containers?: { args?: unknown }[] } } } } | undefined)?.spec?.template?.spec
      ?.containers ?? [];
  return containers.some(
    (c) => Array.isArray(c.args) && c.args.some((arg) => arg === `--credential-provider-name=${KEYS_PROVIDER_NAME}`),
  );
}

const PODCERT = (name: string, signer: string) => ({
  name,
  projected: {
    sources: [
      { podCertificate: { signerName: `${signer}/identity`, keyType: "ECDSAP256", credentialBundlePath: "credential-bundle.pem" } },
      {
        clusterTrustBundle: {
          signerName: `${signer}/identity`,
          labelSelector: { matchLabels: { "podcert.ate.dev/canarying": "live" } },
          path: "trust-bundle.pem",
        },
      },
    ],
  },
});

/**
 * The keys provider: its ServiceAccount, Deployment, Service, a NetworkPolicy that admits only
 * Substrate's egress, and its config Secret. Mutual TLS as Substrate's reference provider serves
 * it: its servicedns pod certificate, callers' podidentity certificates.
 */
export function keysProviderManifests(image: string, tenants: Record<string, KeysProviderTenant>): object[] {
  const labels = { app: KEYS_PROVIDER, ...MANAGED };
  const ns = SUBSTRATE_NAMESPACE;
  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: KEYS_PROVIDER, namespace: ns, labels: MANAGED } },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: KEYS_PROVIDER, namespace: ns, labels: MANAGED },
      type: "Opaque",
      stringData: { "config.json": JSON.stringify({ tenants }) },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: KEYS_PROVIDER, namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: KEYS_PROVIDER } },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: KEYS_PROVIDER,
            securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true },
            containers: [
              {
                name: "provider",
                image,
                args: ["provider", "--name", KEYS_PROVIDER_NAME, "--listen", `:${KEYS_PROVIDER_PORT}`, "--config", "/etc/nylorun-keys/config.json"],
                ports: [
                  { name: "grpc", containerPort: KEYS_PROVIDER_PORT },
                  { name: "health", containerPort: 9091 },
                ],
                readinessProbe: { httpGet: { path: "/readyz", port: "health" }, periodSeconds: 10 },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
                volumeMounts: [
                  { name: "config", mountPath: "/etc/nylorun-keys", readOnly: true },
                  { name: "servicedns", mountPath: "/run/servicedns.podcert.ate.dev", readOnly: true },
                  { name: "podidentity", mountPath: "/run/podidentity.podcert.ate.dev", readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: "config", secret: { secretName: KEYS_PROVIDER } },
              PODCERT("servicedns", "servicedns.podcert.ate.dev"),
              PODCERT("podidentity", "podidentity.podcert.ate.dev"),
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: KEYS_PROVIDER, namespace: ns, labels: MANAGED },
      spec: { type: "ClusterIP", selector: { app: KEYS_PROVIDER }, ports: [{ name: "grpc", port: KEYS_PROVIDER_PORT, targetPort: "grpc", protocol: "TCP" }] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: KEYS_PROVIDER, namespace: ns, labels: MANAGED },
      spec: {
        podSelector: { matchLabels: { app: KEYS_PROVIDER } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { app: "atenet-egress" } } }], ports: [{ protocol: "TCP", port: KEYS_PROVIDER_PORT }] }],
      },
    },
  ];
}
