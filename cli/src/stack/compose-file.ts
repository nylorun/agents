import { PINNED_IMAGES } from "./images.js";

/**
 * The local stack's Compose file (Runtime Architecture §14.3), written to
 * `<Host root>/stack/compose.yaml` by `nylorun start`. It is the same for every
 * machine: everything that varies (ports, the Postgres password, UID/GID, the
 * Host root, the Runtime and Studio images) comes from `stack/.env`.
 *
 * This wave the Runtime still keeps Tenants in SQLite under the Host root.
 * Postgres, Restate and s2-lite run and are healthy; the Runtime receives their
 * endpoints and starts using them in Wave 3.
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
    volumes:
      - restate:/restate-data
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
    command: ["lite", "--local-root", "/data"] # local disk; listens on port 80
    volumes:
      - s2:/data
    # The s2 image has no shell or HTTP client, so it has no health check;
    # the Runtime's /ready covers it once it uses S2.
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
      NYLORUN_DATABASE_URL: postgres://nylorun:\${NYLORUN_POSTGRES_PASSWORD}@postgres:5432/nylorun
      NYLORUN_RESTATE_INGRESS_URL: http://restate:8080
      NYLORUN_RESTATE_ADMIN_URL: http://restate:9070
      NYLORUN_WORKER_URL: http://runtime:9080 # registered with Restate; not published
      NYLORUN_S2_ENDPOINT: http://s2:80
      NYLORUN_S2_TOKEN: ignored # s2-lite has no access tokens yet
      NYLORUN_WORKSPACE_STORE_URL: file:///workspaces
    volumes:
      - \${NYLORUN_HOST_ROOT:?run nylorun start}:/nylorun # Host root
      - workspaces:/workspaces
    ports:
      - "127.0.0.1:\${NYLORUN_PORT:?run nylorun start}:4000" # Tenant API, Admin API, SSE
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
      NYLORUN_RUNTIME_URL: http://runtime:4000
      NYLORUN_ADMIN_KEY_FILE: /run/nylorun/host-credentials.json
      NYLORUN_STUDIO_PUBLIC_PORT: \${NYLORUN_STUDIO_PORT}
    volumes:
      - \${NYLORUN_HOST_ROOT}/host-credentials.json:/run/nylorun/host-credentials.json:ro
    ports:
      - "127.0.0.1:\${NYLORUN_STUDIO_PORT:?run nylorun start}:3000" # opened as http://localhost:<port>
    restart: unless-stopped

volumes:
  postgres: {}
  restate: {}
  s2: {}
  workspaces: {}
`;
}
