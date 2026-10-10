import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `<Host root>/sandboxes/`: what the sandboxes service mounts read-only. `cluster.json`
 * records the cluster `nylorun sandbox enable` installed into; `token` is the
 * ServiceAccount token (0600). Only the sandboxes container reads them: the runtime
 * container sees an empty mount there.
 */
export interface ClusterFile {
  context: string;
  /** The API server URL in the kubeconfig. */
  server: string;
  /** host:port the sandboxes container dials. */
  dial: string;
  /** The name the API server's certificate is verified against. */
  tlsServerName: string;
  /** The cluster CA, base64 PEM. */
  caData: string;
  namespace: string;
  controllerVersion: string;
  hostAddress: string;
  bindAddress: string;
  ports: { harness: number; gates: number; egress: number };
  networkPolicy: { enforced: boolean; probedAt: string };
  enabledAt: string;
}

export function sandboxesDir(root: string): string {
  return join(root, "sandboxes");
}

export function clusterFilePath(root: string): string {
  return join(sandboxesDir(root), "cluster.json");
}

/** Sandboxes are enabled for the Tenant under `root`. */
export function sandboxesEnabled(root: string): boolean {
  return existsSync(clusterFilePath(root));
}

export async function readClusterFile(root: string): Promise<ClusterFile | undefined> {
  try {
    return JSON.parse(await readFile(clusterFilePath(root), "utf8")) as ClusterFile;
  } catch {
    return undefined;
  }
}

async function writeFileMode(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

export async function writeClusterFiles(root: string, cluster: ClusterFile, token: string): Promise<void> {
  const dir = sandboxesDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFileMode(join(dir, "token"), token, 0o600);
  await writeFileMode(clusterFilePath(root), `${JSON.stringify(cluster, null, 2)}\n`, 0o600);
}

export async function removeClusterFiles(root: string): Promise<void> {
  await rm(sandboxesDir(root), { recursive: true, force: true });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * How the sandboxes container reaches the API server. One on this machine's loopback
 * (Docker Desktop's `https://127.0.0.1:<port>`) is dialled at `host.docker.internal:<port>`
 * while the certificate is still verified against the kubeconfig's host (Experiment 2, Q3).
 */
export function apiRoute(server: string): { dial: string; tlsServerName: string } {
  const url = new URL(server);
  if (url.protocol !== "https:") throw new Error(`the API server ${server} is not https`);
  const port = url.port || "443";
  const host = url.hostname;
  const bare = host.replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(host) || LOOPBACK.has(bare))
    return { dial: `host.docker.internal:${port}`, tlsServerName: bare };
  return { dial: `${host}:${port}`, tlsServerName: bare };
}
