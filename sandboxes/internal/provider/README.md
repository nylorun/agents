# The keys provider

The credential provider Agent Substrate's egress gateway asks for the header of a keyed request, run as `sandboxes provider`. It runs as a pod beside the egress, in Substrate's namespace, and does what Substrate's own providers do: mutual TLS with its servicedns pod certificate, only the egress gateway's identity admitted, and the value read live from where it is stored (`provider.go:1-6`). It stores nothing and decides nothing.

## Interface

- `Server` (`provider.go:80-87`): the provider's name, its config file, its budget and its logger.
- `Config`, `Tenant`, `Outside` (`provider.go:54-76`): the tenants, each with a decide URL, a token, an edge CA and an outside source.
- `ParseReference` (`provider.go:105`), `Reference` (`provider.go:102`): `ate-secret://<provider>/<sandbox>/<host>` split into its parts.
- `ParseActor` (`provider.go:125`), `Actor` (`provider.go:122`): the atespace and name a caller's actor reference holds.
- `DefaultName` (`provider.go:45`), `DefaultBudget` (`provider.go:48`): `keys.nylorun.dev`, and 3 s for one `FetchSecret`.
- `ServerTLS`, `DefaultInjector` (`tls.go:19`, `tls.go:13`): the mutual TLS config, and the only identity it admits.

## Rules

- The sandbox id in a reference is base64url-encoded, so an id may hold a slash (`provider.go:8-9`).
- A reference's segments must match `^[A-Za-z0-9_-]{1,344}$` and its host the host pattern; anything else is refused (`provider.go:96-105`).
- A value is at most 16 KiB (`provider.go:51`).
- One `FetchSecret` takes at most `DefaultBudget`, 3 s, under the egress gateway's own 5 s (`provider.go:48`).
- Only the egress gateway's SPIFFE ID is admitted: `spiffe://cluster.local/ns/ate-system/sa/atenet-egress` (`tls.go:11-13`).
- The decision is the tenant's: a vault value comes back, or `fetch` with the Agent, owner and host of a person's key (`provider.go:11-14`).

## Side effects

- Posts to the tenant's decide URL, through the edge, with its token (`provider.go:11`).
- On `fetch`, posts to the outside credential source's `/v1/fetch` (`provider.go:13-14`).
- Reads its config file and logs the sandbox, host and outcome, never a value (`provider.go:85`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
