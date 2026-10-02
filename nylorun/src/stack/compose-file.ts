import { PINNED_IMAGES } from "./images.js";

/**
 * A local stack's Compose file (Runtime Architecture §14.3), written to
 * `<Host root>/stack/compose.yaml` by `nylorun start`. Each stack is one installation with
 * one Tenant (tenancy.md §6): its own Compose project (`nylorun-<name>`, the file's `name`),
 * volumes, network and ports. Everything else that varies (ports, the Postgres password,
 * UID/GID, the Host root, the images, the stack's name) comes from `stack/.env`.
 *
 * The Tenant's state is the stack's Postgres database, executed through Restate, with its
 * history in s2-lite; the Runtime's /ready checks all three. Postgres initialises the
 * database with C collation (`--locale=C`) and runs with `wal_level=logical`: the stream
 * relay feeds s2-lite from the record over logical replication (Durable Streams), and
 * `max_slot_wal_keep_size` caps the WAL a stuck relay can hold. The Runtime creates the
 * Tenant on its first start, named after the stack (`NYLORUN_TENANT_NAME`), with the derived
 * principals of `NYLORUN_DERIVED_PRINCIPALS` (`project` for the Project link).
 *
 * Restate signs requests to the Worker endpoint with the private key in
 * `stack/restate-identity.pem`, mounted read-only; the Runtime gets the public
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
 * host-credentials.json. The runtime mounts the Host root with `keys/` and `stack/`
 * covered by empty read-only mounts, so it can read neither the vault key nor
 * Restate's private key and `.env`. The runtime does not wait for the gateway: while
 * it is down, model and MCP calls fail, deliveries are retried, vault writes and
 * token minting answer 503, and the session takes the next message.
 */
export function renderComposeFile(project: string): string {
  return `# Written by \`nylorun start\`; rewritten on every start. Settings live in .env.
name: ${project}

services:
  postgres: # Session Store
    image: ${PINNED_IMAGES.postgres}
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
    command: ["--node-name=restate-1"] # stable name, so data is found on restart
    environment:
      RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE: /run/nylorun/restate-identity.pem
    volumes:
      - restate:/restate-data
      - \${NYLORUN_HOST_ROOT:?run nylorun start}/stack/restate-identity.pem:/run/nylorun/restate-identity.pem:ro
    ports:
      - "127.0.0.1:\${NYLORUN_RESTATE_PORT:?run nylorun start}:9070" # Restate UI and admin, for debugging
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:9070/health"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  s2: # Durable Streams; not published, only the Runtime reaches it
    image: ${PINNED_IMAGES.s2}
    command: ["lite", "--local-root", "/home/nonroot/data"] # local disk; listens on port 80
    # The image runs as uid 65532. Docker fills a new volume with the image's
    # /home/nonroot, owned by that user; a volume at a path the image lacks
    # (e.g. /data) is root-owned and s2-lite cannot write it.
    volumes:
      - s2:/home/nonroot
    # The s2 image has no shell or HTTP client, so it has no health check;
    # the Runtime's /ready covers it.
    restart: unless-stopped

  gateway: # the Model and Tool Gates and keys: the vault key, credentials, signing, outbound calls; not published
    image: \${NYLORUN_RUNTIME_IMAGE:?run nylorun start}
    command: ["--service", "gates,keys"]
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
      # Action endpoints on this machine: \`localhost\` in a registered URL means the Docker host.
      NYLORUN_ENDPOINT_LOOPBACK: docker-host
    extra_hosts:
      host.docker.internal: host-gateway # model servers, MCP servers and Action endpoints on this machine
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
    command: ["--service", "core,loop"]
    user: "\${NYLORUN_UID:?run nylorun start}:\${NYLORUN_GID:?run nylorun start}"
    depends_on:
      postgres: { condition: service_healthy }
      restate: { condition: service_healthy }
      s2: { condition: service_started }
    environment:
      NYLORUN_HOME: /nylorun
      NYLORUN_PACKING: combined
      # The Tenant the Runtime creates on its first start (later starts open it).
      NYLORUN_TENANT_NAME: \${NYLORUN_STACK_NAME:?run nylorun start}
      NYLORUN_DERIVED_PRINCIPALS: \${NYLORUN_DERIVED_PRINCIPALS:-project}
      # Model calls, remote MCP calls and deliveries go through the gateway, and vault writes
      # and token signing through its keys service: this container never reads a credential
      # or the vault key.
      NYLORUN_GATES_URL: http://gateway:4100
      NYLORUN_KEYS_URL: http://gateway:4100
      NYLORUN_GATES_TOKEN: \${NYLORUN_GATES_TOKEN:?run nylorun start}
      NYLORUN_LISTEN_HOST: 0.0.0.0
      NYLORUN_LISTEN_PORT: "4000"
      # Host headers the Runtime accepts: the stack network name, and the
      # published port as clients on this machine address it.
      NYLORUN_ALLOWED_HOSTS: runtime:4000,localhost:\${NYLORUN_PORT},127.0.0.1:\${NYLORUN_PORT}
      NYLORUN_PUBLIC_URL: http://localhost:\${NYLORUN_PORT} # reported by /v1/admin/status
      # The Admin API on its own listener, published on loopback only; Studio reaches it on
      # the stack network. Port 4000 serves the Tenant API alone.
      NYLORUN_ADMIN_LISTEN_PORT: "4001"
      NYLORUN_ADMIN_ALLOWED_HOSTS: runtime:4001,localhost:\${NYLORUN_ADMIN_PORT},127.0.0.1:\${NYLORUN_ADMIN_PORT}
      NYLORUN_DATABASE_URL: postgres://nylorun:\${NYLORUN_POSTGRES_PASSWORD}@postgres:5432/nylorun
      NYLORUN_RESTATE_INGRESS_URL: http://restate:8080
      NYLORUN_RESTATE_ADMIN_URL: http://restate:9070
      NYLORUN_WORKER_URL: http://runtime:9080 # registered with Restate; not published
      NYLORUN_RESTATE_IDENTITY_KEY: \${NYLORUN_RESTATE_IDENTITY_KEY:?run nylorun start}
      NYLORUN_S2_ENDPOINT: http://s2:80
      NYLORUN_S2_TOKEN: ignored # s2-lite has no access tokens yet
      NYLORUN_WORKSPACE_STORE_URL: file:///workspaces
      # Action endpoints on this machine: \`localhost\` in a registered URL means the Docker host.
      NYLORUN_ENDPOINT_LOOPBACK: docker-host
    extra_hosts:
      host.docker.internal: host-gateway # the Docker host, also on Linux Docker Engine
    volumes:
      - \${NYLORUN_HOST_ROOT:?run nylorun start}:/nylorun # Host root
      # Empty and read-only over the vault key (keys/) and the stack's secrets (stack/):
      # only the gateway reads the key, and only Restate its private key.
      - type: tmpfs
        target: /nylorun/keys
        read_only: true
        tmpfs: { size: 4096, mode: 0755 } # empty, and listable by the runtime user
      - type: tmpfs
        target: /nylorun/stack
        read_only: true
        tmpfs: { size: 4096, mode: 0755 } # empty, and listable by the runtime user
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
    user: "\${NYLORUN_UID}:\${NYLORUN_GID}" # reads the 0600 admin key file
    depends_on:
      runtime: { condition: service_healthy }
    environment:
      NYLORUN_RUNTIME_URL: http://runtime:4001 # the operator listener: Admin and Tenant API
      NYLORUN_ADMIN_KEY_FILE: /run/nylorun/host-credentials.json
      PORT: "3000"
      # Studio's Host check accepts localhost/127.0.0.1 on the published port.
      NYLORUN_STUDIO_PUBLIC_PORT: \${NYLORUN_STUDIO_PORT}
      # Exact origins that may frame Studio (Babai Desktop); kept in .env.
      NYLORUN_STUDIO_FRAME_ANCESTORS: \${NYLORUN_STUDIO_FRAME_ANCESTORS:-}
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

volumes:
  postgres: {}
  restate: {}
  s2: {}
  workspaces: {}
`;
}
