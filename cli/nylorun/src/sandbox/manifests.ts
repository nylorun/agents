import { createHash } from "node:crypto";

/**
 * What `nylorun sandbox enable` installs into a cluster. The agent-sandbox controller is
 * pinned (D32, Experiment 2): v1.0.5, API agents.x-k8s.io/v1beta1, its release manifest
 * verified by sha256 before it is applied. It is never upgraded or uninstalled here.
 */
export const CONTROLLER_VERSION = "v1.0.5";
export const CONTROLLER_URL = `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${CONTROLLER_VERSION}/sandbox.yaml`;
export const CONTROLLER_SHA256 = "e89fd95c0aa57609fa24be4112bd52ce67fe8939ecf6f3c17edf2f1e8f1eb860";
export const CONTROLLER_NAMESPACE = "agent-sandbox-system";
export const CONTROLLER_DEPLOYMENT = "agent-sandbox-controller";
export const SANDBOX_CRD = "sandboxes.agents.x-k8s.io";
export const SANDBOX_API_VERSION = "v1beta1";

export const SERVICE_ACCOUNT = "nylorun-sandboxes";
export const TOKEN_SECRET = "nylorun-sandboxes-token";
export const NETWORK_POLICY = "nylorun-sandboxes";
const TENANT_LABEL = "dev.nylorun.tenant";
const MANAGED = { "app.kubernetes.io/managed-by": "nylorun" };

/**
 * The Tenant's namespace, `nylorun-sbx-<tenant>`: a DNS label, so `_` becomes `-`; a name
 * that had to change (or is too long) gets a short hash so two Tenants never share one.
 */
export function tenantNamespace(tenant: string): string {
  const base = tenant.replace(/_/g, "-").slice(0, 40).replace(/-+$/, "");
  const suffix =
    base === tenant ? "" : `-${createHash("sha256").update(tenant).digest("hex").slice(0, 6)}`;
  return `nylorun-sbx-${base}${suffix}`;
}

/** The `dev.nylorun.tenant` label value: a Tenant name, cut to a label's 63 characters. */
export function tenantLabel(tenant: string): string {
  return tenant.slice(0, 63).replace(/[^a-z0-9]+$/, "");
}

/** Namespace, ServiceAccount, Role, RoleBinding and the ServiceAccount's token Secret. */
export function tenantManifests(namespace: string, tenant: string): object[] {
  const labels = { ...MANAGED, [TENANT_LABEL]: tenantLabel(tenant) };
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: SERVICE_ACCOUNT, namespace, labels },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: SERVICE_ACCOUNT, namespace, labels },
      // Lifecycle only: no NetworkPolicies (enable owns the policy) and no pods/exec.
      rules: [
        {
          apiGroups: ["agents.x-k8s.io"],
          resources: ["sandboxes", "sandboxes/status"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
        {
          apiGroups: [""],
          resources: ["pods", "persistentvolumeclaims", "events"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "create", "update", "patch", "delete"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: SERVICE_ACCOUNT, namespace, labels },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: SERVICE_ACCOUNT },
      subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT, namespace }],
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      type: "kubernetes.io/service-account-token",
      metadata: {
        name: TOKEN_SECRET,
        namespace,
        labels,
        annotations: { "kubernetes.io/service-account.name": SERVICE_ACCOUNT },
      },
    },
  ];
}

/**
 * Every pod in the namespace: no ingress, and egress only to the Docker host on the
 * Harness API, gates and egress ports. No DNS: pods address the host by IP (D42).
 */
export function networkPolicy(
  namespace: string,
  hostAddress: string,
  ports: readonly number[],
  options: { name?: string; podSelector?: Record<string, string> } = {},
): object {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: options.name ?? NETWORK_POLICY, namespace, labels: MANAGED },
    spec: {
      podSelector: options.podSelector ? { matchLabels: options.podSelector } : {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ ipBlock: { cidr: `${hostAddress}/32` } }],
          ports: ports.map((port) => ({ protocol: "TCP", port })),
        },
      ],
    },
  };
}

export const PROBE_IMAGE = "busybox:1.37.0";

/** A small busybox pod; `nodeName` pins it (pre-pull), `serve` runs httpd on 8080. */
export function probePod(
  namespace: string,
  name: string,
  options: { role: string; serve?: boolean; image?: string; nodeName?: string; command?: string[] },
): object {
  const command =
    options.command ??
    (options.serve
      ? ["sh", "-c", "echo ok > /tmp/index.html; exec httpd -f -p 8080 -h /tmp"]
      : ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { ...MANAGED, "nylorun.dev/probe": options.role } },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 1,
      restartPolicy: options.command ? "Never" : "Always",
      ...(options.nodeName ? { nodeName: options.nodeName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "probe",
          image: options.image ?? PROBE_IMAGE,
          imagePullPolicy: "IfNotPresent",
          command,
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: { limits: { cpu: "200m", memory: "64Mi" } },
        },
      ],
    },
  };
}
