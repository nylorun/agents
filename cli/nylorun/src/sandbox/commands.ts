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
import { assertIPv4, defaultBind, parseNslookup, parseProbePorts, runProbe, type ProbePorts } from "./probe.js";
import {
  corefileWithEdge,
  edgeHost,
  PREFERRED_EDGE_PORTS,
  SUBSTRATE_API_SERVICE,
  SUBSTRATE_AUDIENCE,
  SUBSTRATE_NAMESPACE,
  SUBSTRATE_OWNER_ACCOUNT,
  substrateManifests,
} from "./substrate.js";
import { PROBE_IMAGE, SERVICE_ACCOUNT } from "./manifests.js";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { sandboxesDir } from "./cluster-file.js";
import { cliTuning } from "../tuning.js";

export const sandboxUsage = `  sandbox enable --context <name> [--tenant <name>] [--backend agent-sandbox|substrate] [--host-address <ip>] [--bind-address <ip>] [--probe-ports <allowed>,<denied>] [--no-pull]
                                      run the Tenant's sandboxes as pods on that kubeconfig context (agent-sandbox ${CONTROLLER_VERSION}),
                                      or as Agent Substrate actors (--backend substrate, preview: Kubernetes 1.37 with Substrate v1.0 installed)
  sandbox disable [--tenant <name>] [--delete-namespace]
                                      stop the sandboxes service and forget the cluster
  sandbox status [--tenant <name>] [--json]
                                      the cluster, the sandboxes service's readiness and what it reports`;

const ENABLE_USAGE =
  "nylorun local sandbox enable --context <name> [--tenant <name>] [--backend agent-sandbox|substrate] [--host-address <ip>] [--bind-address <ip>] [--probe-ports <allowed>,<denied>] [--no-pull]";

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
  status?: { conditions?: { type?: string; status?: string }[] };
}
interface Deployment {
  spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
}

/**
 * agent-sandbox: install the pinned release when absent; accept it when the pinned version
 * serves v1beta1; refuse anything else. Never upgrades or uninstalls.
 */
async function ensureController(k: Kube, fetch: FetchLike, err: (line: string) => void, pollMs: number): Promise<void> {
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
  const response = await fetch(CONTROLLER_URL, { signal: AbortSignal.timeout(cliTuning().sandbox.manifestDownloadMs) });
  if (!response.ok) throw new CliError(`Downloading ${CONTROLLER_URL} failed (HTTP ${response.status}).`, 1);
  const manifest = await response.text();
  const digest = createHash("sha256").update(manifest).digest("hex");
  if (digest !== CONTROLLER_SHA256)
    throw new CliError(`${CONTROLLER_URL} has sha256 ${digest}, not the pinned ${CONTROLLER_SHA256}; not applying it.`, 1);
  await k.check("Installing agent-sandbox", ["apply", "--server-side", "-f", "-"], { input: manifest });
  await waitForCrd(k, pollMs);
  const tuning = cliTuning().sandbox;
  await k.check(
    "Waiting for the agent-sandbox controller",
    ["rollout", "status", `deployment/${CONTROLLER_DEPLOYMENT}`, "-n", CONTROLLER_NAMESPACE, `--timeout=${tuning.rolloutWaitSeconds}s`],
    { timeoutMs: tuning.rolloutWaitSeconds * 1000 + tuning.kubectlMarginMs },
  );
}

/**
 * Waits until the Sandbox CRD is Established. Polled, not `kubectl wait`: a CRD the API server has
 * not given any conditions yet makes `kubectl wait --for=condition` fail at once instead of waiting
 * (seen on GKE right after the apply).
 */
export async function waitForCrd(k: Kube, pollMs: number): Promise<void> {
  const deadline = Date.now() + cliTuning().sandbox.crdWaitSeconds * 1000;
  for (;;) {
    const crd = await k.getJson<Crd>(["crd", SANDBOX_CRD]);
    if (crd?.status?.conditions?.some((c) => c.type === "Established" && c.status === "True")) return;
    if (Date.now() > deadline)
      throw new CliError(`The ${SANDBOX_CRD} CRD in ${k.context} was not Established within ${cliTuning().sandbox.crdWaitSeconds}s.`, 6);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

interface Namespace {
  metadata?: { labels?: Record<string, string> };
}

/** The ServiceAccount token the token controller writes into the Secret. */
export async function serviceAccountToken(k: Kube, namespace: string, pollMs: number): Promise<string> {
  const deadline = Date.now() + cliTuning().sandbox.tokenWaitMs;
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
    probePorts?: ProbePorts;
    prePull: readonly string[];
    ports: { harness: number; gates: number; egress: number };
  },
): Promise<InstallResult> {
  const { stack } = deps;
  const k = kube(deps.kubectl, input.context);
  const pollMs = deps.pollMs ?? cliTuning().sandbox.pollMs;
  const { server, caData } = await readKubeconfig(k);
  let route: { dial: string; tlsServerName: string };
  try {
    route = apiRoute(server);
  } catch (error) {
    throw new CliError(`Context ${input.context}: ${error instanceof Error ? error.message : String(error)}`, 6);
  }
  await ensureController(k, deps.fetch ?? stack.fetch, stack.err, pollMs);

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
      ...(input.probePorts ? { probePorts: input.probePorts } : {}),
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

/**
 * `enable --backend substrate` against one context (ADR-138, preview): checks Substrate is
 * installed, makes the Tenant's namespace and RBAC, finds the Docker host's address as pods see
 * it, and names the edge for actors in CoreDNS. The atespace is made later, by the sandboxes
 * image's substrate-setup, once cluster.json is written.
 */
export async function installSubstrate(
  deps: SandboxDeps,
  input: {
    context: string;
    tenant: string;
    hostAddress?: string;
    bindAddress?: string;
    ports: { harness: number; gates: number; egress: number };
    edgePorts: { harness: number; gates: number };
  },
): Promise<{ cluster: ClusterFile; token: string }> {
  const k = kube(deps.kubectl, input.context);
  const pollMs = deps.pollMs ?? cliTuning().sandbox.pollMs;
  const { server, caData } = await readKubeconfig(k);
  let route: { dial: string; tlsServerName: string };
  try {
    route = apiRoute(server);
  } catch (error) {
    throw new CliError(`Context ${input.context}: ${error instanceof Error ? error.message : String(error)}`, 6);
  }
  const service = await k.getJson<{ spec?: { ports?: { port?: number }[] } }>([
    "service", SUBSTRATE_API_SERVICE, "-n", SUBSTRATE_NAMESPACE,
  ]);
  if (!service)
    throw new CliError(
      `Refusing context ${input.context}: Agent Substrate is not installed (no ${SUBSTRATE_NAMESPACE}/${SUBSTRATE_API_SERVICE} Service). Install Substrate v1.0 first; see "Pods on Agent Substrate" in the CLI README.`,
      6,
    );
  const namespace = tenantNamespace(input.tenant);
  const existing = await k.getJson<Namespace>(["namespace", namespace]);
  const owner = existing?.metadata?.labels?.["dev.nylorun.tenant"];
  if (existing && owner !== tenantLabel(input.tenant))
    throw new CliError(`Namespace ${namespace} exists in ${input.context} but belongs to ${owner ?? "something else"}.`, 6);
  await k.apply("Creating the Tenant's namespace and RBAC", [...tenantManifests(namespace, input.tenant), ...substrateManifests(namespace)]);
  const token = await serviceAccountToken(k, namespace, pollMs);

  let hostAddress = input.hostAddress;
  if (!hostAddress) {
    // A pod's first lookup can find no IPv4 address on a cluster that just started (P1.8 rerun:
    // once, while 10 of 10 by hand did), so it is tried three times before `enable` gives up.
    for (let attempt = 0; attempt < 3 && !hostAddress; attempt += 1) {
      const lookup = await k.run(
        ["run", "nylorun-host-lookup", "-n", namespace, "--rm", "-i", "--quiet", "--restart=Never", `--image=${PROBE_IMAGE}`, "--", "nslookup", "host.docker.internal"],
        { timeoutMs: cliTuning().sandbox.probeExecMs * 3 },
      );
      hostAddress = parseNslookup(lookup.stdout);
    }
    if (!hostAddress)
      throw new CliError(
        `Refusing context ${input.context}: pods cannot resolve host.docker.internal. Pass --host-address with the Docker host's address as pods reach it (172.17.0.1 for kind on Linux).`,
        6,
      );
  }
  const bindAddress = input.bindAddress ?? defaultBind(input.context, hostAddress);
  const host = edgeHost(namespace);

  const coredns = await k.getJson<{ data?: { Corefile?: string } }>(["configmap", "coredns", "-n", "kube-system"]);
  const corefile = coredns?.data?.Corefile;
  const patched = corefile === undefined ? undefined : corefileWithEdge(corefile, host, hostAddress);
  if (patched === undefined)
    deps.stack.err(
      `Warning: could not add ${host} -> ${hostAddress} to CoreDNS in ${input.context}; actors resolve the edge only once that name resolves (add it to the cluster's DNS).`,
    );
  else if (patched !== corefile)
    await k.check("Naming the edge in CoreDNS", ["patch", "configmap", "coredns", "-n", "kube-system", "--type", "merge", "-p", JSON.stringify({ data: { Corefile: patched } })]);

  return {
    cluster: {
      context: input.context,
      server,
      dial: route.dial,
      tlsServerName: route.tlsServerName,
      caData,
      namespace,
      controllerVersion: "",
      hostAddress,
      bindAddress,
      ports: input.ports,
      networkPolicy: { enforced: false, probedAt: "" },
      enabledAt: new Date().toISOString(),
      backend: "substrate",
      substrate: {
        atespace: namespace,
        systemNamespace: SUBSTRATE_NAMESPACE,
        apiService: SUBSTRATE_API_SERVICE,
        serviceAccount: SERVICE_ACCOUNT,
        edge: { host, harnessPort: input.edgePorts.harness, gatesPort: input.edgePorts.gates },
      },
    },
    token,
  };
}


/**
 * The edge's certificate and the Tenant's atespace, with the sandboxes image: `edge-cert` writes
 * the CA and certificate next to cluster.json, and `substrate-setup` makes the atespace and its
 * access policy as Substrate's owner client, with a 10-minute token minted from the kubeconfig.
 */
async function prepareSubstrate(deps: SandboxDeps, root: string, cluster: ClusterFile, image: string): Promise<void> {
  const { stack } = deps;
  const dir = sandboxesDir(root);
  const user = `${stack.uid}:${stack.gid}`;
  const cert = await stack.docker.run([
    "run", "--rm", "--user", user, "-v", `${dir}:/out`, image, "edge-cert", cluster.substrate!.edge.host, "/out",
  ]);
  if (cert.code !== 0) throw new CliError(`Making the edge's certificate failed: ${cert.stderr.trim() || cert.stdout.trim()}`, 1);
  const k = kube(deps.kubectl, cluster.context);
  const owner = (
    await k.check("Minting Substrate's owner token", [
      "create", "token", SUBSTRATE_OWNER_ACCOUNT, "-n", SUBSTRATE_NAMESPACE, "--audience", SUBSTRATE_AUDIENCE, "--duration", "10m",
    ])
  ).trim();
  const tokenFile = join(dir, "owner-token");
  await writeFile(tokenFile, owner, { mode: 0o600 });
  try {
    const setup = await stack.docker.run([
      "run", "--rm", "--user", user, "--add-host", "host.docker.internal:host-gateway",
      "-v", `${dir}:/run/nylorun/sandboxes:ro`, "-e", "NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE=/run/nylorun/sandboxes/owner-token",
      image, "substrate-setup",
    ]);
    if (setup.code !== 0)
      throw new CliError(`Making the Tenant's atespace failed: ${setup.stderr.trim() || setup.stdout.trim()}`, 1);
    stack.err(setup.stdout.trim());
  } finally {
    await rm(tokenFile, { force: true });
  }
}

async function enable(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const flags = parseStackFlags(
    args,
    { booleans: ["--no-pull"], values: ["--context", "--tenant", "--backend", "--host-address", "--bind-address", "--probe-ports"] },
    ENABLE_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${ENABLE_USAGE}`);
  const context = flags.values.get("--context");
  if (!context)
    throw usageError(
      `nylorun local sandbox enable needs --context <name>: the kubeconfig context to run pods in (never the current one implicitly). Usage: ${ENABLE_USAGE}`,
    );
  const backend = flags.values.get("--backend") ?? "agent-sandbox";
  if (backend !== "agent-sandbox" && backend !== "substrate")
    throw usageError(`--backend must be agent-sandbox or substrate, not ${backend}. Usage: ${ENABLE_USAGE}`);
  const hostAddress = flags.values.get("--host-address");
  const bindAddress = flags.values.get("--bind-address");
  if (hostAddress) assertIPv4(hostAddress, "--host-address");
  if (bindAddress) assertIPv4(bindAddress, "--bind-address");
  const probePortsFlag = flags.values.get("--probe-ports");
  const probePorts = probePortsFlag === undefined ? undefined : parseProbePorts(probePortsFlag);
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
  if (backend === "substrate") {
    const edgePorts = {
      harness: await pick(PREFERRED_EDGE_PORTS.harness, persisted?.edgeHarnessPort),
      gates: await pick(PREFERRED_EDGE_PORTS.gates, persisted?.edgeGatesPort),
    };
    const images = stackImages(stack.env, { runtime: stack.runtimeVersion, studio: stack.studioVersion });
    const installed = await installSubstrate(deps, {
      context,
      tenant: tenant.name,
      ...(hostAddress ? { hostAddress } : {}),
      ...(bindAddress ? { bindAddress } : {}),
      ports,
      edgePorts,
    });
    await writeClusterFiles(tenant.paths.root, installed.cluster, installed.token);
    await prepareSubstrate(deps, tenant.paths.root, installed.cluster, images.sandboxes);
    const settings: SandboxStackEnv = {
      token: persisted?.token ?? randomBytes(32).toString("hex"),
      image: images.sandboxes,
      harnessPort: ports.harness,
      gatesPort: ports.gates,
      egressPort: ports.egress,
      hostAddress: installed.cluster.hostAddress,
      bind: installed.cluster.bindAddress,
      edgeHarnessPort: edgePorts.harness,
      edgeGatesPort: edgePorts.gates,
    };
    await restartTenant(stack, { name: tenant.name, sandboxes: settings });
    const ready = await stack.docker.stream(
      tenant.compose("up", "--detach", "--wait", "--wait-timeout", String(cliTuning().sandbox.composeWaitSeconds), "sandboxes"),
    );
    if (ready !== 0)
      throw new CliError(
        `The sandboxes service did not become ready (image ${images.sandboxes}). See "nylorun local logs sandboxes" and "nylorun local sandbox status".`,
        7,
      );
    const c = installed.cluster;
    stack.out(`Sandboxes ${tenant.name}  enabled on ${c.context} (backend substrate, atespace ${c.substrate!.atespace}; preview)`);
    stack.out(`Actors reach the edge ${c.substrate!.edge.host} (${c.hostAddress}) on ports ${edgePorts.harness} and ${edgePorts.gates}`);
    return 0;
  }
  if (probePorts && [probePorts.allowed, probePorts.denied].some((port) => taken.has(port)))
    throw usageError(
      `--probe-ports ${probePortsFlag} overlaps the sandbox ports ${ports.harness}, ${ports.gates} and ${ports.egress}; pick two others.`,
    );
  const images = stackImages(stack.env, { runtime: stack.runtimeVersion, studio: stack.studioVersion });
  const installed = await installCluster(deps, {
    context,
    tenant: tenant.name,
    ...(hostAddress ? { hostAddress } : {}),
    ...(bindAddress ? { bindAddress } : {}),
    ...(probePorts ? { probePorts } : {}),
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
    tenant.compose("up", "--detach", "--wait", "--wait-timeout", String(cliTuning().sandbox.composeWaitSeconds), "sandboxes"),
  );
  if (ready !== 0)
    throw new CliError(
      `The sandboxes service did not become ready (image ${images.sandboxes}). See "nylorun local logs sandboxes" and "nylorun local sandbox status".`,
      7,
    );
  const c = installed.cluster;
  stack.out(`Sandboxes ${tenant.name}  enabled on ${c.context} (namespace ${c.namespace}, agent-sandbox ${c.controllerVersion})`);
  stack.out(`Pods reach ${c.hostAddress} on ports ${c.ports.harness}, ${c.ports.gates}, ${c.ports.egress}; NetworkPolicy enforced (probed ${c.networkPolicy.probedAt})`);
  return 0;
}

async function disable(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const usage = "nylorun local sandbox disable [--tenant <name>] [--delete-namespace]";
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
const infoScript = (timeoutMs: number) =>
  `fetch(process.env.NYLORUN_SANDBOXES_URL+'/v1/info',{headers:{authorization:'Bearer '+process.env.NYLORUN_SANDBOXES_TOKEN},signal:AbortSignal.timeout(${timeoutMs})}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))`;

async function status(deps: SandboxDeps, args: readonly string[]): Promise<number> {
  const { stack } = deps;
  const usage = "nylorun local sandbox status [--tenant <name>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const name = flags.values.get("--tenant");
  const tenant = await selectTenant(stack, name === undefined ? {} : { name });
  const cluster = await readClusterFile(tenant.paths.root);
  if (!cluster) {
    if (flags.booleans.has("--json")) stack.out(JSON.stringify({ enabled: false }, null, 2));
    else stack.out(`Sandboxes are not enabled for Tenant ${tenant.name}. Run "nylorun local sandbox enable --context <name>".`);
    return 3;
  }
  await dockerPreflight(stack.docker);
  const ready = (await stack.docker.run(tenant.compose("exec", "-T", "sandboxes", "/sandboxes", "healthcheck"))).code === 0;
  const answer = await stack.docker.run(tenant.compose("exec", "-T", "runtime", "node", "-e", infoScript(cliTuning().sandbox.infoRequestMs)));
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
    if (cluster.backend === "substrate" && cluster.substrate) {
      stack.out(`Namespace   ${cluster.namespace}  backend substrate (preview), atespace ${cluster.substrate.atespace}`);
      stack.out(`Edge        ${cluster.substrate.edge.host} ports ${cluster.substrate.edge.harnessPort}, ${cluster.substrate.edge.gatesPort} (bound on ${cluster.bindAddress}, actors reach ${cluster.hostAddress})`);
    } else {
      stack.out(`Namespace   ${cluster.namespace}  agent-sandbox ${cluster.controllerVersion}`);
    }
    if (cluster.backend !== "substrate") {
      stack.out(`Pods reach  ${cluster.hostAddress} ports ${cluster.ports.harness}, ${cluster.ports.gates}, ${cluster.ports.egress} (bound on ${cluster.bindAddress})`);
      stack.out(`Policy      ${cluster.networkPolicy.enforced ? "enforced" : "NOT enforced"} (probed ${cluster.networkPolicy.probedAt})`);
    }
    stack.out(`Service     ${ready ? "ready" : "not ready"}${info ? "" : " (no /v1/info answer)"}`);
  }
  return ready ? 0 : 3;
}

const COMMANDS: Record<string, (deps: SandboxDeps, args: readonly string[]) => Promise<number>> = {
  enable,
  disable,
  status,
};

/** `nylorun local sandbox <enable|disable|status>`. */
export async function runSandboxCommand(args: readonly string[], deps: SandboxDeps): Promise<number> {
  const [name, ...rest] = args;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) throw usageError(`Usage:\n${sandboxUsage}`);
  return await command(deps, rest);
}
