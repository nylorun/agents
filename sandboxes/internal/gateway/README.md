# The sandbox gateway

The computers' one way in. A caller with a ticket for a sandbox asks for `/{sandbox}/{path}`; the gateway checks the ticket, opens an mTLS CONNECT tunnel to Substrate's `atenet-router` for that actor, and proxies the request inside it, ticket included, so the computer checks it too. It holds no Kubernetes rights and keeps no state.

## Interface

- `Header` (`gateway.go`): `X-Nylorun-Ticket`, the header a caller puts its ticket in and the gateway passes on.
- `Router` (`gateway.go`): `Address` (`atenet-router.ate-system.svc:8444`), `ServerName`, `CredentialFile` (this pod's podCertificate), `CAFile` (the router's serving CA).
- `Server` (`gateway.go`): `Public` (the ticket key), `Atespace`, `Port` (the computer's port), `Router`, `Log`, `Now`, `Dial`; `Handler()` serves `GET /healthz` and `/{sandbox}/{path...}`.
- `Connect(ctx, dial, address, actor, authority)` (`gateway.go`): the CONNECT tunnel to the router for one actor.
- `LoadPublic(path)` (`gateway.go`): the ticket public key from PEM.

## Rules

- A sandbox name that is not `driver.NamePattern` is `404 not_found` (`gateway.go`, `serve`).
- A ticket that is missing, expired or for another sandbox is `401 unauthorized`; the ticket's `sub` must be the sandbox in the path (`gateway.go`, `serve`).
- The tunnel goes to `<atespace>/<sandbox>` with the computer's port as its authority (`gateway.go`, `Handler`).
- The upstream host is `<sandbox>:<port>`, so the computer sees its own name (`gateway.go`, `Handler`).
- `FlushInterval` is -1 and compression is off, so a stream arrives as it is written (`gateway.go`, `Handler`).
- A tunnel the router refuses is `502 computer_unreachable` (`gateway.go`, `Handler`).
- The router's credential and CA files are read per handshake and per dial, so a rotated certificate needs no restart (`gateway.go`, `Router`).

## Side effects

- Opens TLS connections to `atenet-router` (`gateway.go`, `Router.dial`).
- Reads the credential bundle and the router's CA file (`gateway.go`).
- Logs a warning per unreachable computer (`gateway.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
