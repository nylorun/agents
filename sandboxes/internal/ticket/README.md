# Computer tickets

Reads and checks the tickets that let the Runtime reach a computer: compact JWS tokens core signs with Ed25519, `aud: "nylorun-computer"`, `sub` the sandbox's name and `exp` in seconds (`ticket.go:1-4`). The sandbox gateway (`internal/gateway`) checks them, and the computer's engine checks them again with the public key its template carries.

## Interface

- `Audience` (`ticket.go:21`): the only audience a ticket may name.
- `Claims` (`ticket.go:24-28`): `Audience`, `Subject`, `Expires`.
- `LoadPrivate` (`ticket.go:31`): the signing key from a PKCS #8 PEM file.
- `PublicPEM` (`ticket.go:52`): the public key as PEM, for a template's environment.
- `Sign` (`ticket.go:61`): a ticket for a subject that expires at a time.
- `Verify` (`ticket.go:73`): the claims of a valid ticket, or `ErrInvalid`.
- `Check` (`ticket.go:119`): the subject when the ticket is valid for it, else a short reason.
- `ErrInvalid` (`ticket.go:70`): what every rejection wraps.

## Rules

- A ticket must be three base64url parts (`ticket.go:75-76`).
- Only `alg: EdDSA` is accepted (`ticket.go:84-87`).
- The signature is checked over `header.payload` with the public key, before the claims are read (`ticket.go:90-91`).
- The audience must be `nylorun-computer`, the subject must not be empty, and `now < exp` (`ticket.go:101-108`).
- `Check` decodes base64url as leniently as Node does and reads `exp` as any JSON number, so it answers where the engine would (`ticket.go:116-118`).

## Side effects

- Reads a PEM file when it is asked for the private key; it writes nothing and keeps nothing (`ticket.go:31`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
