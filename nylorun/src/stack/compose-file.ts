import { PINNED_IMAGES } from "./images.js";

/**
 * A local Tenant's Compose file (Runtime Architecture §14.3), written to
 * `<Host root>/docker/compose.yaml` by `nylorun start`. Each local Tenant is one installation
 * (tenancy.md §6): its own Compose project (`nylorun-<name>`, the file's `name`), volumes,
 * network and ports. Container, network and volume names are global on the Docker engine, so
 * every one is `<project>-<role>` (`nylorun-shop-studio`, network `nylorun-shop`, volume
 * `nylorun-shop-postgres`), labelled `dev.nylorun.tenant: <name>`; they are written here, from
 * the project and the Tenant's name. Everything else that varies (ports, the Postgres password and the other
 * secrets, UID/GID, the Host root, the images) comes from `docker/.env`.
 *
 * The Tenant's state is its Postgres database, executed through Restate, with its
 * history in s2-lite; the Runtime's /ready checks all three. Postgres initialises the
 * database with C collation (`--locale=C`) and runs with `wal_level=logical`: the stream
 * relay feeds s2-lite from the record over logical replication (Durable Streams), and
 * `max_slot_wal_keep_size` caps the WAL a stuck relay can hold. The Runtime creates the
 * Tenant on its first start, with its name (`NYLORUN_TENANT_NAME`) and the derived
 * principals of `NYLORUN_DERIVED_PRINCIPALS` (`project` for the Project link).
 *
 * Restate signs requests to the Worker endpoint with the private key in
 * `docker/restate-identity.pem`, mounted read-only; the Runtime gets the public
 * key as NYLORUN_RESTATE_IDENTITY_KEY.
 *
 * The combined packing (blueprint D12): the `runtime` container runs the core
 * and loop services, and the `gateway` container runs gates: the Model Gate,
 * which alone reads model credentials, and the Tool Gate (F4.1), which alone
 * holds remote MCP connections and their credentials and POSTs every Action
 * delivery. Every model call, remote MCP call and delivery of the loop crosses it
 * (NYLORUN_GATES_URL, with NYLORUN_GATES_TOKEN from `.env`); stdio MCP servers
 * still run in the runtime container. The gateway also runs keys (F4.2): the only
 * holder of the vault key, it runs every vault write that touches a secret and signs
 * every token (NYLORUN_KEYS_URL). The gateway mounts only the Host's Tenant directory
 * (`tenant/`) and its keys directory (`keys/`, the vault key), read-only: never
 * host-credentials.json. The runtime mounts the Host root with `keys/` and `docker/`
 * covered by empty read-only mounts, so it can read neither the vault key nor
 * Restate's private key and `.env`. The runtime does not wait for the gateway: while
 * it is down, model and MCP calls fail, deliveries are retried, vault writes and
 * token minting answer 503, and the session takes the next message.
 *
 * The Object store (blueprint D35) is RustFS, single node and single drive, pinned by digest,
 * on the `rustfs` volume; it is not published. Its credential is the access key `nylorun` and
 * the secret key NYLORUN_OBJECT_STORE_SECRET_KEY from `.env`, and only the runtime and the
 * gateway receive it (NYLORUN_OBJECT_STORE_*). The runtime creates the bucket at boot and
 * reaches the store through its `s3` BlobStore.
 *
 * With `sandboxes` (after `nylorun sandbox enable`, F7.2) the `sandboxes` service runs the
 * agent-sandbox driver: the only container holding the cluster credentials
 * (`<Host root>/sandboxes`, read-only), not published, reached by the runtime alone with
 * NYLORUN_SANDBOXES_TOKEN. The runtime gets an empty read-only mount over that directory.
 * The gateway then also runs egress-gate (`--service gates,keys,egress`), pods' CONNECT proxy to
 * the hosts their spec allows, published on NYLORUN_SANDBOX_BIND at NYLORUN_SANDBOX_EGRESS_PORT.
 */
export function renderComposeFile(
  project: string,
  name: string,
  options: { sandboxes?: true } = {},
): string {
  const sandboxes = options.sandboxes === true;
  return `# Written by \`nylorun start\`; rewritten on every start. Settings live in .env.
name: ${project}

x-tenant: &tenant
  dev.nylorun.tenant: "${name}"

services:
  postgres: # Session Store
    image: ${PINNED_IMAGES.postgres}
    container_name: ${project}-postgres
    labels: *tenant
    # Logical replication feeds the stream relay; a stuck slot is capped at 4 GB of WAL.
    command: ["postgres", "-c", "wal_level=logical", "-c", "max_slot_wal_keep_size=4GB"]
    environment:
      POSTGRES_USER: nylorun
      POSTGRES_PASSWORD: \${NYLORUN_POSTGRES_PASSWORD:?run nylorun start}
      POSTGRES_DB: nylorun
      POSTGRES_INITDB_ARGS: "--locale=C" # C collation for the whole database
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nylorun -d nylorun"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  restate: # Durable Session Execution
    image: ${PINNED_IMAGES.restate}
    container_name: ${project}-restate
    labels: *tenant
    command: ["--node-name=restate-1"] # stable name, so data is found on restart
    environment:
      RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE: /run/nylorun/restate-identity.pem
    volumes:
      - restate:/restate-data
      - \${NYLORUN_HOST_ROOT:?run nylorun start}/docker/restate-identity.pem:/run/nylorun/restate-identity.pem:ro
    ports:
      - "127.0.0.1:\${NYLORUN_RESTATE_PORT:?run nylorun start}:9070" # Restate UI and admin, for debugging
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:9070/health"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  s2-lite: # Durable Streams; not published, only the Runtime reaches it
    image: ${PINNED_IMAGES.s2}
    container_name: ${project}-s2-lite
    labels: *tenant
    command: ["lite", "--local-root", "/home/nonroot/data"] # local disk; listens on port 80
    # The image runs as uid 65532. Docker fills a new volume with the image's
    # /home/nonroot, owned by that user; a volume at a path the image lacks
    # (e.g. /data) is root-owned and s2-lite cannot write it.
    volumes:
      - s2-lite:/home/nonroot
    # The s2 image has no shell or HTTP client, so it has no health check;
    # the Runtime's /ready covers it.
    restart: unless-stopped

  rustfs: # the Object store (D35); not published, only the runtime and the gateway hold its credential
    image: ${PINNED_IMAGES.rustfs}
    container_name: ${project}-rustfs
    labels: *tenant
    environment:
      RUSTFS_ACCESS_KEY: nylorun
      RUSTFS_SECRET_KEY: \${NYLORUN_OBJECT_STORE_SECRET_KEY:?run nylorun start}
      RUSTFS_CONSOLE_ENABLE: "false" # no web console: clients go through the Runtime
      RUSTFS_OBS_LOG_DIRECTORY: "" # log to stdout (nylorun logs rustfs)
    # The image runs as uid 10001 and owns /data, which Docker copies into the new volume.
    volumes:
      - rustfs:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:9000/health"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  gateway: # the Model and Tool Gates and keys: the vault key, credentials, signing, outbound calls; not published${sandboxes ? ", but for egress-gate" : ""}
    image: \${NYLORUN_RUNTIME_IMAGE:?run nylorun start}
    container_name: ${project}-gateway
    labels: *tenant
    command: ["--service", "gates,keys${sandboxes ? ",egress" : ""}"]
    user: "\${NYLORUN_UID:?run nylorun start}:\${NYLORUN_GID:?run nylorun start}"
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      NYLORUN_HOME: /nylorun
      NYLORUN_PACKING: combined
      NYLORUN_GATES_LISTEN_PORT: "4100"
      NYLORUN_GATES_ALLOWED_HOSTS: gateway:4100
      NYLORUN_GATES_TOKEN: \${NYLORUN_GATES_TOKEN:?run nylorun start}
      NYLORUN_DATABASE_URL: postgres://nylorun:\${NYLORUN_POSTGRES_PASSWORD}@postgres:5432/nylorun
      # The Object store, where model-gate will read file parts (F8.1).
      NYLORUN_OBJECT_STORE_ENDPOINT: http://rustfs:9000
      NYLORUN_OBJECT_STORE_ACCESS_KEY: nylorun
      NYLORUN_OBJECT_STORE_SECRET_KEY: \${NYLORUN_OBJECT_STORE_SECRET_KEY:?run nylorun start}
      # Action endpoints on this machine: \`localhost\` in a registered URL means the Docker host.
      NYLORUN_ENDPOINT_LOOPBACK: docker-host${sandboxes ? SANDBOXES_GATEWAY_ENV : ""}
    extra_hosts:
      host.docker.internal: host-gateway # model servers, MCP servers and Action endpoints on this machine${sandboxes ? SANDBOXES_GATEWAY_PORTS : ""}
    volumes:
      # The Tenant's homes and its vault key only, read-only.
      - \${NYLORUN_HOST_ROOT:?run nylorun start}/tenant:/nylorun/tenant:ro
      - \${NYLORUN_HOST_ROOT:?run nylorun start}/keys:/nylorun/keys:ro
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:4100/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 2s
      timeout: 5s
      retries: 60
    restart: unless-stopped

  runtime:
    image: \${NYLORUN_RUNTIME_IMAGE:?run nylorun start}
    container_name: ${project}-runtime
    labels: *tenant
    command: ["--service", "core,loop"]
    user: "\${NYLORUN_UID:?run nylorun start}:\${NYLORUN_GID:?run nylorun start}"
    depends_on:
      postgres: { condition: service_healthy }
      restate: { condition: service_healthy }
      s2-lite: { condition: service_started }
      rustfs: { condition: service_healthy }
    environment:
      NYLORUN_HOME: /nylorun
      NYLORUN_PACKING: combined
      # The Tenant the Runtime creates on its first start (later starts open it).
      NYLORUN_TENANT_NAME: \${NYLORUN_TENANT_NAME:?run nylorun start}
      NYLORUN_DERIVED_PRINCIPALS: \${NYLORUN_DERIVED_PRINCIPALS:-project}
      # Model calls, remote MCP calls and deliveries go through the gateway, and vault writes
      # and token signing through its keys service: this container never reads a credential
      # or the vault key.
      NYLORUN_GATES_URL: http://gateway:4100
      NYLORUN_KEYS_URL: http://gateway:4100
      NYLORUN_GATES_TOKEN: \${NYLORUN_GATES_TOKEN:?run nylorun start}
      NYLORUN_LISTEN_HOST: 0.0.0.0
      NYLORUN_LISTEN_PORT: "4000"
      # Host headers the Runtime accepts: its name on the Compose network, and the
      # published port as clients on this machine address it.
      NYLORUN_ALLOWED_HOSTS: runtime:4000,localhost:\${NYLORUN_PORT},127.0.0.1:\${NYLORUN_PORT}
      NYLORUN_PUBLIC_URL: http://localhost:\${NYLORUN_PORT} # reported by /v1/admin/status
      # The Admin API on its own listener, published on loopback only; Studio reaches it on
      # the Compose network. Port 4000 serves the Tenant API alone.
      NYLORUN_ADMIN_LISTEN_PORT: "4001"
      NYLORUN_ADMIN_ALLOWED_HOSTS: runtime:4001,localhost:\${NYLORUN_ADMIN_PORT},127.0.0.1:\${NYLORUN_ADMIN_PORT}
      NYLORUN_DATABASE_URL: postgres://nylorun:\${NYLORUN_POSTGRES_PASSWORD}@postgres:5432/nylorun
      NYLORUN_RESTATE_INGRESS_URL: http://restate:8080
      NYLORUN_RESTATE_ADMIN_URL: http://restate:9070
      NYLORUN_WORKER_URL: http://runtime:9080 # registered with Restate; not published
      NYLORUN_RESTATE_IDENTITY_KEY: \${NYLORUN_RESTATE_IDENTITY_KEY:?run nylorun start}
      NYLORUN_S2_ENDPOINT: http://s2-lite:80
      NYLORUN_S2_TOKEN: ignored # s2-lite has no access tokens yet
      NYLORUN_WORKSPACE_STORE_URL: file:///workspaces
      # The Object store, through the BlobStore seam's s3 adapter; the runtime creates the bucket.
      NYLORUN_OBJECT_STORE_ENDPOINT: http://rustfs:9000
      NYLORUN_OBJECT_STORE_ACCESS_KEY: nylorun
      NYLORUN_OBJECT_STORE_SECRET_KEY: \${NYLORUN_OBJECT_STORE_SECRET_KEY:?run nylorun start}
      # Action endpoints on this machine: \`localhost\` in a registered URL means the Docker host.
      NYLORUN_ENDPOINT_LOOPBACK: docker-host${sandboxes ? SANDBOXES_RUNTIME_ENV : ""}
    extra_hosts:
      host.docker.internal: host-gateway # the Docker host, also on Linux Docker Engine
    volumes:
      - \${NYLORUN_HOST_ROOT:?run nylorun start}:/nylorun # Host root
      # Empty and read-only over the vault key (keys/) and the Compose secrets (docker/):
      # only the gateway reads the key, and only Restate its private key.
      - type: tmpfs
        target: /nylorun/keys
        read_only: true
        tmpfs: { size: 4096, mode: 0755 } # empty, and listable by the runtime user
      - type: tmpfs
        target: /nylorun/docker
        read_only: true
        tmpfs: { size: 4096, mode: 0755 } # empty, and listable by the runtime user${sandboxes ? SANDBOXES_RUNTIME_MOUNT : ""}
      - workspaces:/workspaces
    ports:
      - "127.0.0.1:\${NYLORUN_PORT:?run nylorun start}:4000" # Tenant API, SSE, browsers
      - "127.0.0.1:\${NYLORUN_ADMIN_PORT:?run nylorun start}:4001" # Admin API (operators only)
    healthcheck: # liveness: a Tenant that cannot open is reported by nylorun start from the Admin status, not by a 300 s wait
      test: ["CMD", "node", "-e", "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 2s
      timeout: 5s
      retries: 60
    restart: unless-stopped

  studio: # dashboard + trusted proxy
    image: \${NYLORUN_STUDIO_IMAGE:?run nylorun start}
    container_name: ${project}-studio
    labels: *tenant
    user: "\${NYLORUN_UID}:\${NYLORUN_GID}" # reads the 0600 admin key file
    depends_on:
      runtime: { condition: service_healthy }
    environment:
      NYLORUN_RUNTIME_URL: http://runtime:4001 # the operator listener: Admin and Tenant API
      NYLORUN_ADMIN_KEY_FILE: /run/nylorun/host-credentials.json
      PORT: "3000"
      # Studio's Host check accepts localhost/127.0.0.1 on the published port.
      NYLORUN_STUDIO_PUBLIC_PORT: \${NYLORUN_STUDIO_PORT}
      # Browsers share cookies across ports of one host: a cookie per Tenant keeps the
      # sessions of two Studios on localhost apart.
      NYLORUN_STUDIO_SESSION_COOKIE: nylorun_studio_${name}
      # Exact origins that may frame Studio (Babai Desktop); kept in .env.
      NYLORUN_STUDIO_FRAME_ANCESTORS: \${NYLORUN_STUDIO_FRAME_ANCESTORS:-}
      # Studio's anonymous usage analytics; empty when telemetry is off.
      NYLORUN_STUDIO_ANALYTICS_ID: \${NYLORUN_STUDIO_ANALYTICS_ID:-}
    volumes:
      - \${NYLORUN_HOST_ROOT}/host-credentials.json:/run/nylorun/host-credentials.json:ro
    ports:
      - "127.0.0.1:\${NYLORUN_STUDIO_PORT:?run nylorun start}:3000" # opened as http://localhost:<port>
    healthcheck: # /healthz needs no session; Host studio:3000 is accepted
      test: ["CMD", "node", "-e", "require('http').get({port:3000,path:'/healthz',headers:{host:'studio:3000'}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped
${sandboxes ? sandboxesService(project) : ""}
networks:
  default:
    name: ${project}
    labels: *tenant

volumes:
  postgres: { name: ${project}-postgres, labels: *tenant }
  restate: { name: ${project}-restate, labels: *tenant }
  s2-lite: { name: ${project}-s2-lite, labels: *tenant }
  rustfs: { name: ${project}-rustfs, labels: *tenant }
  workspaces: { name: ${project}-workspaces, labels: *tenant }
`;
}

/** The runtime reaches the sandboxes service on the Compose network with its token. */
const SANDBOXES_RUNTIME_ENV = `
      # The sandboxes service (nylorun sandbox enable): pods on the Tenant's cluster.
      NYLORUN_SANDBOXES_URL: http://sandboxes:4300
      NYLORUN_SANDBOXES_TOKEN: \${NYLORUN_SANDBOXES_TOKEN:?run nylorun sandbox enable}`;

/** egress-gate (F7.2): pods' CONNECT proxy in the gateway. */
const SANDBOXES_GATEWAY_ENV = `
      # egress-gate: the only way out of a sandbox pod, to the hosts its spec allows.
      NYLORUN_EGRESS_LISTEN_PORT: "4200"`;

/** Pods reach egress-gate on the host address; published on the bind address only. */
const SANDBOXES_GATEWAY_PORTS = `
    ports:
      - "\${NYLORUN_SANDBOX_BIND:?run nylorun sandbox enable}:\${NYLORUN_SANDBOX_EGRESS_PORT:?run nylorun sandbox enable}:4200"`;

/** Empty and read-only over the cluster credentials: only the sandboxes service reads them. */
const SANDBOXES_RUNTIME_MOUNT = `
      - type: tmpfs
        target: /nylorun/sandboxes
        read_only: true
        tmpfs: { size: 4096, mode: 0755 } # empty, and listable by the runtime user`;

/**
 * The sandboxes service. The pod-facing ports (NYLORUN_SANDBOX_*_PORT in .env) are recorded
 * by `nylorun sandbox enable`; egress-gate's is published by the gateway, the Harness API
 * listener's and the gates' are not published yet.
 */
function sandboxesService(project: string): string {
  return `
  sandboxes: # agent-sandbox driver; the only holder of the cluster credentials; not published
    image: \${NYLORUN_SANDBOXES_IMAGE:?run nylorun sandbox enable}
    container_name: ${project}-sandboxes
    labels: *tenant
    user: "\${NYLORUN_UID:?run nylorun start}:\${NYLORUN_GID:?run nylorun start}" # reads the 0600 token
    environment:
      NYLORUN_SANDBOXES_TOKEN: \${NYLORUN_SANDBOXES_TOKEN:?run nylorun sandbox enable}
      NYLORUN_SANDBOXES_DIR: /run/nylorun/sandboxes
      NYLORUN_SANDBOXES_LISTEN: ":4300"
    extra_hosts:
      host.docker.internal: host-gateway # the API server when the kubeconfig names this machine's loopback
    volumes:
      # cluster.json (API server, CA, namespace) and the ServiceAccount token, read-only.
      - \${NYLORUN_HOST_ROOT:?run nylorun start}/sandboxes:/run/nylorun/sandboxes:ro
    healthcheck: # /ready: informers synced and the API server answers
      test: ["CMD", "/sandboxes", "healthcheck"]
      interval: 5s
      timeout: 5s
      retries: 24
    restart: unless-stopped
`;
}
