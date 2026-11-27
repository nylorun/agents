# The keys provider

The provider Substrate's egress gateway calls for one request's header value, so an actor's request reaches a keyed host without the actor ever holding the key. It serves `ate-secret://` references and asks the Tenant's own egress service to decide, then fetches from the person's outside source (Cloud's Connections) when the decision says so. The key passes through it and is never written anywhere.

## Interface

- `Config`, `Tenant`, `Outside` (`provider.go`): the config file, one entry per Tenant by its atespace: `decideUrl`, `token`, `edgeCa`, and an optional `outside` (`url`, `token`, `ca`).
- `Server` (`provider.go`): `Name`, `ConfigFile`, `Budget`, `Log`; `FetchSecret` is the gRPC call `credprovider.CredentialProvider` serves.
- `Reference`, `ParseReference(name, raw)` (`provider.go`): `ate-secret://<name>/<base64url sandbox id>/<host>`.
- `Actor`, `ParseActor(raw)` (`provider.go`): the egress gateway's identity, `spiffe://<trust domain>/actor/<atespace>/<name>`.
- `DefaultName` (`keys.nylorun.dev`), `DefaultBudget` (3 s) (`provider.go`).
- `post(ctx, client, target, token, body, out)` (`provider.go`): the JSON call the decisions and the outside fetch both use.

## Rules

- A reference must be scheme `ate-secret`, that host, and a path of exactly two segments: a base64url sandbox id and a host; anything else is `InvalidArgument` (`ParseReference`).
- The host may be a lowercase DNS name or one with `*` as its leftmost label (`provider.go`, `hostPattern`).
- An identity that is not an actor's SPIFFE ID is `PermissionDenied` (`ParseActor`, `FetchSecret`).
- An atespace the config has no Tenant for is `PermissionDenied` (`fetch`).
- The budget covers decide and fetch together, 3 s when the server names none (`fetch`).
- A decision with `value` is the answer; with `fetch` and no outside source it is `NotFound`; with neither it is `Unavailable` (`fetch`).
- `403` and `401` become `PermissionDenied`, `404` `NotFound`, `400` `InvalidArgument`, and every other answer `Unavailable`, so the egress gateway retries only what can succeed (`post`).
- An answer over 16 KiB, or one that is not JSON, is `Unavailable` (`post`, `maxValue`).
- The config file is re-read only when its modification time changed, and the per-CA HTTP clients are dropped with it (`load`).

## Side effects

- Reads `ConfigFile` (`load`).
- Sends POSTs to each Tenant's `decideUrl` and to its outside source (`fetch`).
- Logs one line per released key and one per refusal, with the sandbox, host, atespace, actor and duration; never the value (`FetchSecret`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
