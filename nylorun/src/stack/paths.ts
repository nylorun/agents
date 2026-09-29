import { join, resolve } from "node:path";

/** Files under the Host root that the stack commands read and write. */
export interface StackPaths {
  /** The Host root (`~/.nylorun` or `NYLORUN_HOME`), bind-mounted at /nylorun. */
  root: string;
  /** host.json: client-facing host and published port, no secrets. */
  config: string;
  /** host-credentials.json: the admin key, mode 0600. */
  credentials: string;
  /** host-state.json: written only by a launcher-managed Runtime. */
  state: string;
  tenants: string;
  home: string;
  tmp: string;
  stack: string;
  compose: string;
  env: string;
  /** Restate's request-identity private key (Ed25519 PKCS#8 PEM), mode 0600. */
  restateIdentity: string;
  /** The OpenShell gateway's state (SQLite, supervisor binary), at the same path in its container. */
  openshellData: string;
  /** The gateway's sandbox-JWT signing key pair and kid. */
  openshellJwt: string;
  /** The gateway's TOML config. */
  openshellConfig: string;
}

export function stackPaths(hostRoot: string): StackPaths {
  const root = resolve(hostRoot);
  const stack = join(root, "stack");
  return {
    root,
    config: join(root, "host.json"),
    credentials: join(root, "host-credentials.json"),
    state: join(root, "host-state.json"),
    tenants: join(root, "tenants"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    stack,
    compose: join(stack, "compose.yaml"),
    env: join(stack, ".env"),
    restateIdentity: join(stack, "restate-identity.pem"),
    openshellData: join(root, "openshell"),
    openshellJwt: join(stack, "openshell-jwt"),
    openshellConfig: join(stack, "openshell-gateway.toml"),
  };
}
