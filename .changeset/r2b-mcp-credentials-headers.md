---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
---

**Header map, gateway and identity header credentials; `credential_rejected` on a `401`** (R2b C1, C2). For remote MCP servers and HTTP tools alike, in installation and user vaults. MIGRATION.md (protocol 10, "Header and gateway credentials" and "Tool errors the model sees") has the details.

- `@nylorun/core`: `CreateCredentialRequest` and `RotateCredentialRequest` gain `type: "headers"` with a `headers` map, and optional `via` (where requests go, such as a gateway: `https`, or `http` to a loopback host, with no userinfo, query string or fragment) and `identity: { header }` on both kinds; a rotation may change them, and `null` removes one. `CredentialInfo` gains `headers` in its type, `headerNames`, `via` and `identity`, never a value. `ERROR_CODES` gains `credential_rejected`, and `tool.completed`'s `error` documents `server` and `vault`. The admin client's vault methods take the new bodies through these types.
- `@nylorun/runtime`: a `headers` credential is sealed like a token and sends every header in its map; the transport's headers, `Idempotency-Key` and `Nylorun-*` are refused (`400`), and a credential header replaces a manifest header of the same name. A credential with `via` sends the server's requests there, while the manifest's URL still picks the credential and names the tools. An identity header carries the session owner's subject from the session record, and is left out for a session owned by `installation`. A `401` from an MCP server or HTTP tool is a failed tool call with code `credential_rejected` that the model sees, never retried and never `uncertain`. `via`, `identity` and the header names are stored unsealed in the credential's binding: no migration.
- `@nylorun/studio`: the Credentials page adds Bearer or Headers credentials (name and value rows), with an optional gateway URL and identity header, and shows them without values.
