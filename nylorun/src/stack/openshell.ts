import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackPaths } from "./paths.js";

/**
 * The optional OpenShell gateway (`nylorun start --sandbox openshell`): real sandboxes on the
 * Docker driver, OpenShell 0.1.2. Its sandboxes are containers and volumes the gateway creates
 * beside the stack, labelled with the stack's Compose project as their namespace.
 */
export const OPENSHELL_VERSION = "0.1.2";
export const OPENSHELL_IMAGES = {
  gateway: `ghcr.io/nvidia/openshell/gateway:${OPENSHELL_VERSION}`,
  sandbox: `ghcr.io/nvidia/openshell/sandbox:${OPENSHELL_VERSION}`,
  supervisor: `ghcr.io/nvidia/openshell/supervisor:${OPENSHELL_VERSION}`,
  workload: "nvcr.io/nvidia/base/ubuntu:24.04",
} as const;
/** The Docker label carrying a sandbox's namespace (the driver's `sandbox_label`). */
export const OPENSHELL_NAMESPACE_LABEL = "openshell.ai/sandbox-namespace";
export const OPENSHELL_SERVICE = "openshell-gateway";
export const OPENSHELL_TELEMETRY_NOTICE =
  "OpenShell's gateway sends anonymous usage counts to NVIDIA (no names, paths, prompts or credentials). Turn it off with: nylorun start --openshell-telemetry off";

export type StackSandbox = "virtual" | "openshell";

/** The gateway's TOML, written on every start. `namespace` labels its sandboxes (the project). */
export function renderGatewayConfig(namespace: string): string {
  return `# Written by \`nylorun start --sandbox openshell\`; rewritten on every start.
# OpenShell gateway, Docker driver. The host-networked supervisors dial the
# gateway at 127.0.0.1:<NYLORUN_OPENSHELL_PORT>, so grpc_endpoint stays unset.
[openshell]
version = 2

[openshell.gateway]
health_bind_address = "0.0.0.0:8081"
log_level           = "info"
compute_driver      = "docker"
disable_tls         = true

[openshell.gateway.gateway_jwt]
signing_key_path = "/etc/openshell/jwt/signing.pem"
public_key_path  = "/etc/openshell/jwt/public.pem"
kid_path         = "/etc/openshell/jwt/kid"
gateway_id       = "nylorun"

# Reached only by the Runtime on the stack network and on 127.0.0.1.
[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.drivers.docker]
default_image         = "${OPENSHELL_IMAGES.workload}"
sandbox_runtime_image = "${OPENSHELL_IMAGES.sandbox}"
supervisor_image      = "${OPENSHELL_IMAGES.supervisor}"
image_pull_policy     = "if_not_present"
sandbox_label         = "${namespace}"
app_armor_profile     = "Unconfined"
`;
}

/**
 * The gateway's data directory (mounted at the same path inside its container, which the Docker
 * driver requires), its config, and its sandbox-JWT signing key, created once.
 */
export async function prepareOpenShell(paths: StackPaths, namespace: string): Promise<void> {
  await mkdir(paths.openshellData, { recursive: true, mode: 0o700 });
  await mkdir(paths.openshellJwt, { recursive: true, mode: 0o700 });
  await writeFile(paths.openshellConfig, renderGatewayConfig(namespace), { mode: 0o644 });
  const signing = join(paths.openshellJwt, "signing.pem");
  if (existsSync(signing)) return;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(join(paths.openshellJwt, "public.pem"), publicKey.export({ type: "spki", format: "pem" }), {
    mode: 0o644,
  });
  await writeFile(join(paths.openshellJwt, "kid"), randomUUID().slice(0, 8), { mode: 0o644 });
  await writeFile(signing, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
}
