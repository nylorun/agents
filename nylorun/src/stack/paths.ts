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
  /** The Docker Compose files: compose.yaml, .env and the Restate identity key. */
  docker: string;
  /** Where the Compose files lived before they moved to `docker/`. */
  legacyDocker: string;
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
    tenants: join(root, "tenants"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    docker,
    legacyDocker: join(root, "stack"),
    compose: join(docker, "compose.yaml"),
    env: join(docker, ".env"),
    restateIdentity: join(docker, "restate-identity.pem"),
  };
}
