# Tickets

Reads, signs and checks the ticket core gives a computer: a compact JWS signed with Ed25519 (`alg: EdDSA`), with `aud: "nylorun-computer"`, `sub` the sandbox's name and `exp` in seconds. The sandbox gateway checks a ticket before it tunnels, and the computer checks the same ticket again, so a request reaches a computer only with a ticket for that computer.

## Interface

- `Audience` (`ticket.go`): `nylorun-computer`, every ticket's `aud`.
- `Claims` (`ticket.go`): `aud`, `sub`, `exp`.
- `LoadPrivate(path)` (`ticket.go`): a PKCS #8 PEM Ed25519 private key.
- `PublicPEM(private)` (`ticket.go`): the key's public half as SPKI PEM, which a template carries.
- `Sign(private, subject, expires)` (`ticket.go`): a ticket, for tests and tools; core signs the real ones.
- `Verify(token, public, now) (Claims, error)` (`ticket.go`): signature, audience and expiry; `ErrInvalid` is every ticket that does not hold.
- `Check(token, public, subject, now) string` (`ticket.go`): the computer's own check, `""` when the ticket holds for `subject`, else the reason in the engine's words: `no ticket`, `malformed`, `alg`, `signature`, `audience`, `subject` or `expired`.

## Rules

- Only `EdDSA` is accepted; any other `alg` is `alg` (`Verify`, `Check`).
- A ticket's `sub` must be the computer's name, and its `exp` must be in the future at `now` (`Verify`, `Check`).
- `Check` matches the engine's `checkTicket` in `runtime/server/src/harness/computer.ts`: it decodes base64url as leniently as Node's `Buffer.from(s, "base64url")` and takes `exp` as any JSON number, compared in milliseconds (`Check`).
- `LoadPrivate` refuses a file that is not PEM or not an Ed25519 key (`LoadPrivate`).
- No secret is kept in the package: a key is read from a path the caller names (`LoadPrivate`).

## Side effects

- Reads the key file `LoadPrivate` is given, and nothing else (`ticket.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`); the cases are the engine's own, so a change here is checked against `runtime/server/src/harness/computer.ts`.
