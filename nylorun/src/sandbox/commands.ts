import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CliError } from "../errors.js";
import {
  parseStackFlags,
  reservedSandboxPorts,
  restartTenant,
  selectTenant,
  type StackDeps,
} from "../stack/commands.js";
import { dockerPreflight } from "../stack/docker.js";
import type { SandboxStackEnv } from "../stack/env-file.js";
import { stackImages } from "../stack/images.js";
import { choosePort } from "../stack/ports.js";
import { readStackEnv } from "../stack/prepare.js";
import type { FetchLike } from "../stack/studio-login.js";
import {
  apiRoute,
  readClusterFile,
  removeClusterFiles,
  writeClusterFiles,
  type ClusterFile,
} from "./cluster-file.js";
import { contexts, kube, type Kube, type KubectlRunner } from "./kubectl.js";
import {
  CONTROLLER_DEPLOYMENT,
  CONTROLLER_NAMESPACE,
  CONTROLLER_SHA256,
  CONTROLLER_URL,
  CONTROLLER_VERSION,
  networkPolicy,
  SANDBOX_API_VERSION,
  SANDBOX_CRD,
  tenantLabel,
  tenantManifests,
  tenantNamespace,
  TOKEN_SECRET,
} from "./manifests.js";
import { assertIPv4, runProbe } from "./probe.js";

export const sandboxUsage = `  sandbox enable --context <name> [--tenant <name>] [--host-address <ip>] [--bind-address <ip>] [--no-pull]
                                      run the Tenant's sandboxes as pods on that kubeconfig context (agent-sandbox ${CONTROLLER_VERSION})
  sandbox disable [--tenant <name>] [--delete-namespace]
                                      stop the sandboxes service and forget the cluster
  sandbox status [--tenant <name>] [--json]
                                      the cluster, the sandboxes service's readiness and what it reports`;

const ENABLE_USAGE =
  "nylorun sandbox enable --context <name> [--tenant <name>] [--host-address <ip>] [--bind-address <ip>] [--no-pull]";

/** The default workload image (D36), pre-pulled with the Runtime image. */
export const DEFAULT_SANDBOX_IMAGE = "python:3.13-slim";

/** Preferred host ports for the Harness API, gates and egress (pods reach them). */
const PREFERRED_PORTS = { harness: 8790, gates: 8791, egress: 8792 } as const;

export interface SandboxDeps {
  stack: StackDeps;
  kubectl: KubectlRunner;
  /** Fetches the controller manifest; defaults to the stack's fetch. */
  fetch?: FetchLike;
  /** Poll interval and NetworkPolicy wait, for tests. */
  pollMs?: number;
  policyTimeoutMs?: number;
}

const usageError = (message: string) => new CliError(message, 2);

interface KubeconfigCluster {
  server?: string;
  "certificate-authority-data"?: string;
  "certificate-authority"?: string;
  "insecure-skip-tls-verify"?: boolean;
}

/** The context's API server and CA, from the kubeconfig. */
async function readKubeconfig(k: Kube): Promise<{ server: string; caData: string }> {
  const config = JSON.parse(
    await k.check("Reading the kubeconfig", ["config", "view", "--minify", "--raw", "-o", "json"]),
  ) as { clusters?: { cluster?: KubeconfigCluster }[] };
  const cluster = config.clusters?.[0]?.cluster;
  if (!cluster?.server) throw new CliError(`Context ${k.context} has no API server.`, 6);
  let caData = cluster["certificate-authority-data"];
  if (!caData && cluster["certificate-authority"])
    caData = (await readFile(cluster["certificate-authority"])).toString("base64");
  if (!caData)
    throw new CliError(
      `Context ${k.context} has no cluster CA: the sandboxes service only talks to an API server it can verify.`,
      6,
    );
  return { server: cluster.server, caData };
}

interface Crd {
  spec?: { versions?: { name?: string; served?: boolean }[] };
}
interface Deployment {
  spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
}

/**
 * agent-sandbox: install the pinned release when absent; accept it when the pinned version
 * serves v1beta1; refuse anything else. Never upgrades or uninstalls.
 */
async function ensureController(k: Kube, fetch: FetchLike, err: (line: string) => void): Promise<void> {
  const crd = await k.getJson<Crd>(["crd", SANDBOX_CRD]);
  if (crd) {
    if (!crd.spec?.versions?.some((v) => v.name === SANDBOX_API_VERSION && v.served))
      throw new CliError(
        `Refusing context ${k.context}: its agent-sandbox does not serve agents.x-k8s.io/${SANDBOX_API_VERSION}. Nylorun needs agent-sandbox ${CONTROLLER_VERSION}.`,
        6,
      );
    const deployment = await k.getJson<Deployment>(["deployment", CONTROLLER_DEPLOYMENT, "-n", CONTROLLER_NAMESPACE]);
    const image = deployment?.spec?.template?.spec?.containers?.[0]?.image ?? "";
    const version = /:(v[^@:]+)(?:@.*)?$/.exec(image)?.[1];
    if (version !== CONTROLLER_VERSION)
      throw new CliError(
        `Refusing context ${k.context}: agent-sandbox ${version ?? "(controller not found)"} is installed; Nylorun needs ${CONTROLLER_VERSION} and never upgrades or removes it.`,
        6,
      );
    return;
  }
  err(`Installing agent-sandbox ${CONTROLLER_VERSION} into ${k.context}.`);
  const response = await fetch(CONTROLLER_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new CliError(`Downloading ${CONTROLLER_URL} failed (HTTP ${response.status}).`, 1);
  const manifest = await response.text();
  const digest = createHash("sha256").update(manifest).digest("hex");
  if (digest !== CONTROLLER_SHA256)
    throw new CliError(`${CONTROLLER_URL} has sha256 ${digest}, not the pinned ${CONTROLLER_SHA256}; not applying it.`, 1);
  await k.check("Installing agent-sandbox", ["apply", "--server-side", "-f", "-"], { input: manifest });
  await k.check("Waiting for the Sandbox CRD", ["wait", "--for=condition=Established", `crd/${SANDBOX_CRD}`, "--timeout=60s"]);
  await k.check(
    "Waiting for the agent-sandbox controller",
    ["rollout", "status", `deployment/${CONTROLLER_DEPLOYMENT}`, "-n", CONTROLLER_NAMESPACE, "--timeout=180s"],
    { timeoutMs: 200_000 },
  );
}

interface Namespace {
  metadata?: { labels?: Record<string, string> };
}

/** The ServiceAccount token the token controller writes into the Secret. */
async function serviceAccountToken(k: Kube, namespace: string, pollMs: number): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const secret = await k.getJson<{ data?: { token?: string } }>(["secret", TOKEN_SECRET, "-n", namespace]);
    if (secret?.data?.token) return Buffer.from(secret.data.token, "base64").toString("utf8");
    if (Date.now() > deadline)
      throw new CliError(`The ServiceAccount token in ${namespace}/${TOKEN_SECRET} was not issued.`, 6);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface InstallResult {
  cluster: ClusterFile;
  /** The ServiceAccount token. */
  token: string;
  /** Images the pre-pull could not pull. */
  notPulled: string[];
}

/**
 * Steps 2–8 of `enable` against one context: controller, namespace and RBAC, NetworkPolicy
 * probe, the namespace's policy, pre-pull. Returns what cluster.json records.
 */
export async function installCluster(
  deps: SandboxDeps,
  input: {
    context: string;
    tenant: string;
    hostAddress?: string;
    bindAddress?: string;
    prePull: readonly string[];
    ports: { harness: number; gates: number; egress: number };
  },
): Promise<InstallResult> {
  const { stack } = deps;
  const k = kube(deps.kubectl, input.context);
  const pollMs = deps.pollMs ?? 1000;
  const { server, caData } = await readKubeconfig(k);
  let route: { dial: string; tlsServerName: string };
  try {
    route = apiRoute(server);
  } catch (error) {
    throw new CliError(`Context ${input.context}: ${error instanceof Error ? error.message : String(error)}`, 6);
  }
  await ensureController(k, deps.fetch ?? stack.fetch, stack.err);

  const namespace = tenantNamespace(input.tenant);
  const existing = await k.getJson<Namespace>(["namespace", namespace]);
  const owner = existing?.metadata?.labels?.["dev.nylorun.tenant"];
  if (existing && owner !== tenantLabel(input.tenant))
    throw new CliError(`Namespace ${namespace} exists in ${input.context} but belongs to ${owner ?? "something else"}.`, 6);
  await k.apply("Creating the Tenant's namespace and RBAC", tenantManifests(namespace, input.tenant));
  const token = await serviceAccountToken(k, namespace, pollMs);

  stack.err(`Probing NetworkPolicy enforcement in ${input.context}.`);
  const probe = await runProbe(
    {
      kube: k,
      docker: stack.docker,
      ports: stack.ports,
      err: stack.err,
      pollMs,
      ...(deps.policyTimeoutMs !== undefined ? { policyTimeoutMs: deps.policyTimeoutMs } : {}),
    },
    {
      ...(input.hostAddress ? { hostAddress: input.hostAddress } : {}),
      ...(input.bindAddress ? { bindAddress: input.bindAddress } : {}),
      prePull: input.prePull,
    },
  );
  await k.apply("Applying the namespace's NetworkPolicy", [
    networkPolicy(namespace, probe.hostAddress, [input.ports.harness, input.ports.gates, input.ports.egress]),
  ]);
  return {
    cluster: {
      context: input.context,
      server,
      dial: route.dial,
      tlsServerName: route.tlsServerName,
      caData,
      namespace,
      controllerVersion: CONTROLLER_VERSION,
      hostAddress: probe.hostAddress,
      bindAddress: probe.bindAddress,
      ports: input.ports,
      networkPolicy: { enforced: probe.enforced, probedAt: probe.probedAt },
      enabledAt: new Date().toISOString(),
    },
    token,
    notPulled: probe.notPulled,
  };
}

async function enable(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const flags = parseStackFlags(
    args,
    { booleans: ["--no-pull"], values: ["--context", "--tenant", "--host-address", "--bind-address"] },
    ENABLE_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${ENABLE_USAGE}`);
  const context = flags.values.get("--context");
  if (!context)
    throw usageError(
      `nylorun sandbox enable needs --context <name>: the kubeconfig context to run pods in (never the current one implicitly). Usage: ${ENABLE_USAGE}`,
    );
  const hostAddress = flags.values.get("--host-address");
  const bindAddress = flags.values.get("--bind-address");
  if (hostAddress) assertIPv4(hostAddress, "--host-address");
  if (bindAddress) assertIPv4(bindAddress, "--bind-address");
  const name = flags.values.get("--tenant");
  const tenant = await selectTenant(stack, name === undefined ? {} : { name });
  await dockerPreflight(stack.docker);
  const known = await contexts(deps.kubectl);
  if (!known.includes(context))
    throw usageError(`Context ${context} is not in your kubeconfig. Contexts: ${known.join(", ") || "(none)"}.`);

  const persisted = (await readStackEnv(tenant.paths))?.sandboxes;
  const reserved = await reservedSandboxPorts(stack, tenant.paths.root);
  const taken = new Set<number>();
  const pick = async (preferred: number, kept: number | undefined) => {
    const port = await choosePort(stack.ports, preferred, kept, new Set([...taken, ...(kept === undefined ? reserved : [])]));
    taken.add(port);
    return port;
  };
  const ports = {
    harness: await pick(PREFERRED_PORTS.harness, persisted?.harnessPort),
    gates: await pick(PREFERRED_PORTS.gates, persisted?.gatesPort),
    egress: await pick(PREFERRED_PORTS.egress, persisted?.egressPort),
  };
  const images = stackImages(stack.env, { runtime: stack.runtimeVersion, studio: stack.studioVersion });
  const installed = await installCluster(deps, {
    context,
    tenant: tenant.name,
    ...(hostAddress ? { hostAddress } : {}),
    ...(bindAddress ? { bindAddress } : {}),
    prePull: flags.booleans.has("--no-pull") ? [] : [DEFAULT_SANDBOX_IMAGE, images.runtime],
    ports,
  });
  for (const image of installed.notPulled)
    stack.err(`Warning: could not pre-pull ${image} on the cluster's nodes; the first sandbox using it pulls it (or load it, e.g. kind load docker-image ${image}).`);

  await writeClusterFiles(tenant.paths.root, installed.cluster, installed.token);
  const settings: SandboxStackEnv = {
    token: persisted?.token ?? randomBytes(32).toString("hex"),
    image: images.sandboxes,
    harnessPort: ports.harness,
    gatesPort: ports.gates,
    egressPort: ports.egress,
    hostAddress: installed.cluster.hostAddress,
    bind: installed.cluster.bindAddress,
  };
  await restartTenant(stack, { name: tenant.name, sandboxes: settings });
  const ready = await stack.docker.stream(
    tenant.compose("up", "--detach", "--wait", "--wait-timeout", "120", "sandboxes"),
  );
  if (ready !== 0)
    throw new CliError(
      `The sandboxes service did not become ready (image ${images.sandboxes}). See "nylorun logs sandboxes" and "nylorun sandbox status".`,
      7,
    );
  const c = installed.cluster;
  stack.out(`Sandboxes ${tenant.name}  enabled on ${c.context} (namespace ${c.namespace}, agent-sandbox ${c.controllerVersion})`);
  stack.out(`Pods reach ${c.hostAddress} on ports ${c.ports.harness}, ${c.ports.gates}, ${c.ports.egress}; NetworkPolicy enforced (probed ${c.networkPolicy.probedAt})`);
  return 0;
}

async function disable(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const usage = "nylorun sandbox disable [--tenant <name>] [--delete-namespace]";
  const flags = parseStackFlags(args, { booleans: ["--delete-namespace"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const name = flags.values.get("--tenant");
  const tenant = await selectTenant(stack, name === undefined ? {} : { name });
  const cluster = await readClusterFile(tenant.paths.root);
  const persisted = (await readStackEnv(tenant.paths))?.sandboxes;
  if (!cluster && !persisted) {
    stack.out(`Sandboxes are not enabled for Tenant ${tenant.name}.`);
    return 0;
  }
  await dockerPreflight(stack.docker);
  // While compose.yaml still names the service; absent after an earlier failed disable.
  await stack.docker.run(tenant.compose("rm", "--stop", "--force", "sandboxes"));
  await removeClusterFiles(tenant.paths.root);
  await restartTenant(stack, { name: tenant.name, sandboxes: null });
  if (flags.booleans.has("--delete-namespace") && cluster) {
    await kube(deps.kubectl, cluster.context).check("Deleting the namespace", [
      "delete", "namespace", cluster.namespace, "--ignore-not-found", "--wait=false",
    ]);
    stack.out(`Deleting namespace ${cluster.namespace} in ${cluster.context}.`);
  }
  stack.out(
    `Sandboxes disabled for Tenant ${tenant.name}.${cluster && !flags.booleans.has("--delete-namespace") ? ` Namespace ${cluster.namespace} in ${cluster.context} is kept (--delete-namespace removes it and every sandbox in it).` : ""}`,
  );
  return 0;
}

/** Asks the sandboxes service from inside the runtime container, which holds the token. */
const INFO_SCRIPT =
  "fetch(process.env.NYLORUN_SANDBOXES_URL+'/v1/info',{headers:{authorization:'Bearer '+process.env.NYLORUN_SANDBOXES_TOKEN},signal:AbortSignal.timeout(5000)}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))";

async function status(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const usage = "nylorun sandbox status [--tenant <name>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const name = flags.values.get("--tenant");
  const tenant = await selectTenant(stack, name === undefined ? {} : { name });
  const cluster = await readClusterFile(tenant.paths.root);
  if (!cluster) {
    if (flags.booleans.has("--json")) stack.out(JSON.stringify({ enabled: false }, null, 2));
    else stack.out(`Sandboxes are not enabled for Tenant ${tenant.name}. Run "nylorun sandbox enable --context <name>".`);
    return 3;
  }
  await dockerPreflight(stack.docker);
  const ready = (await stack.docker.run(tenant.compose("exec", "-T", "sandboxes", "/sandboxes", "healthcheck"))).code === 0;
  const answer = await stack.docker.run(tenant.compose("exec", "-T", "runtime", "node", "-e", INFO_SCRIPT));
  let info: unknown;
  try {
    info = answer.code === 0 ? JSON.parse(answer.stdout) : undefined;
  } catch {
    info = undefined;
  }
  const { caData: _ca, ...recorded } = cluster;
  if (flags.booleans.has("--json")) {
    stack.out(JSON.stringify({ enabled: true, cluster: recorded, ready, ...(info ? { info } : {}) }, null, 2));
  } else {
    stack.out(`Context     ${cluster.context}  (${cluster.server}, dialled at ${cluster.dial})`);
    stack.out(`Namespace   ${cluster.namespace}  agent-sandbox ${cluster.controllerVersion}`);
    stack.out(`Pods reach  ${cluster.hostAddress} ports ${cluster.ports.harness}, ${cluster.ports.gates}, ${cluster.ports.egress} (bound on ${cluster.bindAddress})`);
    stack.out(`Policy      ${cluster.networkPolicy.enforced ? "enforced" : "NOT enforced"} (probed ${cluster.networkPolicy.probedAt})`);
    stack.out(`Service     ${ready ? "ready" : "not ready"}${info ? "" : " (no /v1/info answer)"}`);
  }
  return ready ? 0 : 3;
}

const COMMANDS: Record<string, (deps: SandboxDeps, args: readonly string[]) => Promise<number>> = {
  enable,
  disable,
  status,
};

/** `nylorun sandbox <enable|disable|status>`. */
export async function runSandboxCommand(args: readonly string[], deps: SandboxDeps): Promise<number> {
  const [name, ...rest] = args;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) throw usageError(`Usage:\n${sandboxUsage}`);
  return await command(deps, rest);
}
