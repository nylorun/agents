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
  /** tenant.json: the Tenant's name and the project it was created for. */
  record: string;
  /** The Tenant directory: homes, sandboxes, plugin data, logs. */
  tenant: string;
  /**
   * The Tenant directory's parts the harness container mounts (F6.2): workspaces, plugin data,
   * and the home and temporary directory of MCP stdio servers.
   */
  harness: { sandboxes: string; pluginData: string; home: string; tmp: string };
  /**
   * Plugin roots on this machine (`plugins/`), mounted read-only at the same path into the
   * runtime and harness containers, so a stdio MCP server's plugin root resolves there.
   */
  plugins: string;
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
    record: join(root, "tenant.json"),
    tenant: join(root, "tenant"),
    harness: {
      sandboxes: join(root, "tenant", "sandboxes"),
      pluginData: join(root, "tenant", "plugin-data"),
      home: join(root, "tenant", "home"),
      tmp: join(root, "tenant", "tmp"),
    },
    plugins: join(root, "plugins"),
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
