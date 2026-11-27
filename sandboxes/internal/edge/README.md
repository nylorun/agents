# The edge

A TLS front for the Tenant's actors, for the Substrate backend: actors reach the Harness API and the gates by a name that resolves to the Docker host, and Substrate's egress refuses a WebSocket upgrade on a cleartext connection. The edge terminates that TLS on one certificate and forwards to the service on the Compose network.

## Interface

- `Route` (`edge.go`): `Name` (for logs), `Listen` (inside the container, `:8443`) and `Upstream` (the service on the Compose network, `http://runtime:4200`).
- `Server` (`edge.go`): `Cert`, `Routes`, `Log`; `Run(ctx)` serves every route and returns the first listener's error.
- `Proxy(upstream, log)` (`edge.go`): the reverse proxy a route serves.
- `WriteCert(dir, host, now)` (`cert.go`): writes a CA and a leaf certificate for `host`.

## Rules

- Each route serves TLS 1.2 or newer with the server's one certificate, and a `ReadHeaderTimeout` of 10 s (`edge.go`, `Run`).
- The proxy sends the upstream's `Host`, which its allow-list accepts, and deletes `Forwarded` (`edge.go`, `Proxy`).
- `FlushInterval` is -1, so WebSocket upgrades and server-sent events stream as they come (`edge.go`, `Proxy`).
- An upstream error answers `502` and one warning line (`edge.go`, `Proxy`).
- `WriteCert` writes `edge-ca.pem`, `edge.crt` and `edge.key` (mode 0600) in `dir`, and keeps no CA key: a new certificate is a new CA, so `nylorun local sandbox enable` rewrites it (`cert.go`).

## Side effects

- Listens on every route's address until the context ends (`edge.go`, `Run`).
- Writes the three certificate files under `dir` (`cert.go`).
- Logs one line per route when it starts, and a warning per failed upstream (`edge.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
