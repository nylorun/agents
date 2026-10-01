import { PINNED_IMAGES } from "./images.js";

/**
 * The local stack's Compose file (Runtime Architecture §14.3), written to
 * `<Host root>/stack/compose.yaml` by `nylorun start`. It is the same for every
 * machine: everything that varies (ports, the Postgres password, UID/GID, the
 * Host root, the Runtime and Studio images) comes from `stack/.env`.
 *
 * Tenants are Postgres schemas, executed through Restate, with their history in
 * s2-lite; the Runtime's /ready checks all three.
 *
 * Restate signs requests to the Worker endpoint with the private key in
 * `stack/restate-identity.pem`, mounted read-only; the Runtime gets the public
 * key as NYLORUN_RESTATE_IDENTITY_KEY.
 */
export function renderComposeFile(): string {
  return `# Written by \`nylorun start\`; rewritten on every start. Settings live in .env.
name: nylorun

services:
  postgres: # Session Store
    image: ${PINNED_IMAGES.postgres}
    environment:
      POSTGRES_USER: nylorun
      POSTGRES_PASSWORD: \${NYLORUN_POSTGRES_PASSWORD:?run nylorun start}
      POSTGRES_DB: nylorun
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

  runtime:
    image: \${NYLORUN_RUNTIME_IMAGE:?run nylorun start}
    command: ["--role", "all"]
    user: "\${NYLORUN_UID:?run nylorun start}:\${NYLORUN_GID:?run nylorun start}"
    depends_on:
      postgres: { condition: service_healthy }
      restate: { condition: service_healthy }
      s2: { condition: service_started }
    environment:
      NYLORUN_HOME: /nylorun
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
      - workspaces:/workspaces
    ports:
      - "127.0.0.1:\${NYLORUN_PORT:?run nylorun start}:4000" # Tenant API, SSE, browsers
      - "127.0.0.1:\${NYLORUN_ADMIN_PORT:?run nylorun start}:4001" # Admin API (operators only)
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:4000/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
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
