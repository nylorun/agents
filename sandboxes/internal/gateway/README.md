# The sandbox gateway

The one client of Agent Substrate's router the Runtime adds. Core and the harness call `/{sandbox}/…` with a computer ticket; the gateway checks it, opens an mTLS CONNECT tunnel to atenet-router with `ate-target-actor: <atespace>/<sandbox>`, and proxies the request to the computer's engine inside it (`gateway.go:1-5`).

## Interface

- `Header` (`gateway.go:31`): `X-Nylorun-Ticket`, the header every request carries its ticket in.
- `Router` (`gateway.go:34-44`): the router's address, the name its certificate is checked against, this pod's credential and the router's CA.
- `Server`, `Handler` (`gateway.go:47-57`, `gateway.go:67`): the gateway's settings and its HTTP handler.
- `Connect` (`gateway.go:155`): the mTLS CONNECT tunnel to the router for one actor.
- `LoadPublic` (`gateway.go:197`): the ticket key's public half from a PEM file.

## Rules

- A request's ticket must be valid for the sandbox in its path, else `401` (`gateway.go:1-3`).
- The tunnel names its actor as `<atespace>/<sandbox>` in `ate-target-actor` (`gateway.go:1-4`).
- It holds no Kubernetes rights and keeps no state: the router resumes, parks and routes each request (`gateway.go:4-5`).

## Side effects

- Opens an mTLS connection to atenet-router and proxies each request through it (`gateway.go:130-155`).
- Reads its credential and CA files and the ticket's public key (`gateway.go:41-43`, `gateway.go:197`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
