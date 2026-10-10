import { join, resolve } from "node:path";

/** Files under the Host root that the nylorun commands read and write. */
export interface StackPaths {
  /** The Host root (`~/.nylorun/tenants/<name>` or `NYLORUN_HOME`), bind-mounted at /nylorun. */
  root: string;
  /** host.json: client-facing host and published port, no secrets. */
  config: string;
  /** host-credentials.json: the admin key, mode 0600. */
  credentials: string;
  /** host-state.json: written only by a launcher-managed Runtime. */
  state: string;
  /**
   * cli-credentials.json: the operator key `cli` that `nylorun` commands use outside a linked
   * project (`nylorun sandbox`), mode 0600.
   */
  cliCredentials: string;
  /**
   * project-credentials.json: the operator key `project` that `nylorun start` gives every
   * project it links to this Tenant (a copy of their `.nylorun/credentials.json`), mode 0600.
   */
  projectCredentials: string;
  /** operator-keys.lock: held while a command puts one of the keys above. */
  keysLock: string;
  /** tenant.json: the Tenant's name and the project it was created for. */
  record: string;
  /**
   * identity.yaml: the trusted issuers (F9 I2), written by the operator. When it exists the
   * runtime reads it at boot (`NYLORUN_IDENTITY_FILE`).
   */
  identity: string;
  /** The Tenant directory: home, sandboxes, logs. */
  tenant: string;
  /** The Tenant directory's parts the harness container mounts (F6.2): workspaces. */
  harness: { sandboxes: string };
  /** The keys directory, mounted only into the gateway (F4.2). */
  keys: string;
  /** The Tenant's vault key (KEK), `keys/vault-kek`. */
  vaultKey: string;
  home: string;
  tmp: string;
  /** The Docker Compose files: compose.yaml, .env and the Restate identity key. */
  docker: string;
  compose: string;
  env: string;
  /** Restate's request-identity private key (Ed25519 PKCS#8 PEM), mode 0600. */
  restateIdentity: string;
}

export function stackPaths(hostRoot: string): StackPaths {
  const root = resolve(hostRoot);
  const docker = join(root, "docker");
  return {
    root,
    config: join(root, "host.json"),
    credentials: join(root, "host-credentials.json"),
    state: join(root, "host-state.json"),
    cliCredentials: join(root, "cli-credentials.json"),
    projectCredentials: join(root, "project-credentials.json"),
    keysLock: join(root, "operator-keys.lock"),
    record: join(root, "tenant.json"),
    identity: join(root, "identity.yaml"),
    tenant: join(root, "tenant"),
    harness: { sandboxes: join(root, "tenant", "sandboxes") },
    keys: join(root, "keys"),
    vaultKey: join(root, "keys", "vault-kek"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    docker,
    compose: join(docker, "compose.yaml"),
    env: join(docker, ".env"),
    restateIdentity: join(docker, "restate-identity.pem"),
  };
}
