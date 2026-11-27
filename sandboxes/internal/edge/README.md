# The TLS edge for Substrate actors

The TLS front that Agent Substrate's actors reach the Runtime through. Substrate's egress gateway refuses WebSocket upgrades on cleartext and on intercepted HTTP, so an actor's engine reaches the Harness API and the gates over TLS the gateway passes through by name; the edge terminates that TLS and forwards to the Runtime's listeners on the Compose network, with the Host they accept (`edge.go:1-5`).

## Interface

- `Route` (`edge.go:21-27`): a name, its listen address and the upstream URL it forwards to.
- `Server` (`edge.go:31-34`): the certificate and the routes to serve.
- `Proxy` (`edge.go:39`): the handler for one upstream.
- `Server.Run` (`edge.go:56`): serves every route until the context ends.
- `WriteCert` (`cert.go:20`): the edge's CA and its certificate for a host, written into a directory for `enable`.

## Rules

- A route is reached by the name its certificate carries, which is the Host the upstream accepts (`edge.go:1-5`).
- The edge's CA is handed to a template so an actor trusts the edge (`substrate/template.go:72-73`).

## Side effects

- Listens on each route's address and forwards requests to its upstream over the network (`edge.go:21-27`, `edge.go:56`).
- `WriteCert` writes the CA and the host's certificate and key into the directory it is given (`cert.go:20`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
