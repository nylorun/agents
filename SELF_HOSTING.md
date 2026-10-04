# Self-hosting

How a team runs Nylorun on its own machines with its own identity provider and secret store,
and no Nylorun account. Open source verifies and enforces; it never signs anyone in, never
manages people and never holds a person's own secrets. Your identity provider and your secret
store plug in.

Read [DEPLOYMENT.md](./DEPLOYMENT.md) first: it covers the Tenant's containers, the reverse proxy
in front of the Runtime, Postgres, the gateway and the harness. This guide covers who gets in
and where credentials come from. [`examples/self-host`](./examples/self-host/README.md) runs
all of it on one machine with Keycloak, oauth2-proxy, OpenBao and a sample resolver, and checks
it end to end. Upgrading from a release before protocol 7:
[MIGRATION.md](./MIGRATION.md#open-source-auth-protocol-7).

## Scope

**One installation per trust domain.** A Runtime serves exactly one Tenant, the one its own
Postgres database holds. Everyone the installation serves shares its agents, its installation
vaults and its operators. People or teams that must not share those get separate
installations.

Open source includes:

- verifying JWTs from your identity provider ([trusted issuers](#the-identity-file)), with
  scopes, an agent allowlist and sandbox grants per issuer;
- operator keys for your servers, which act for the whole Tenant or for one person;
- each person's sessions kept to that person (another person's session is a `404`);
- installation vaults for shared credentials, including OAuth MCP servers the installation
  signs in to once;
- a hook to your own credential store for each person's credentials (the resolver);
- Studio behind a sign-in proxy, for the people you give the `studio` scope.

It leaves out, on purpose:

- **sign-in**: no login page, passwords, sessions or social login. Use your identity provider;
- **user management**: no directory, invitations, groups or roles. A person is the subject
  your tokens or your server name; revoke people at your identity provider;
- **per-person secret storage**: Nylorun never stores a person's own tokens. They stay in your
  secret store, and the resolver hands them over per request;
- **multi-tenancy**: one Tenant per installation;
- **CORS and rate limits**: your reverse proxy answers both.

Nothing calls Nylorun. Studio's anonymous page-view analytics is the only outbound call, and
nothing depends on it (`nylorun telemetry disable`, or `NYLORUN_TELEMETRY_DISABLED=1`).

## Front doors

There are three ways in, and an installation can use all of them:

| Front door | Credential | Who it acts for |
| --- | --- | --- |
| **An app server** | An [operator key](#operator-keys), with `Nylorun-Subject` and `Nylorun-Scopes` | Any person your server names, with the scopes it names; the whole Tenant without them |
| **Browsers and apps** | A JWT from your identity provider, as `Authorization: Bearer` | The token's subject, with the scopes, agents and sandboxes the [identity file](#the-identity-file) allows |
| **A sign-in proxy** | The person's JWT, forwarded by the proxy | The same as a browser's; Studio admits it with the `studio` scope ([Studio](#studio-behind-a-sign-in-proxy)) |

**An app server** signs people in itself and calls the Runtime for each one:
`client.as(subject, { scopes })` in `@nylorun/agents`
([agents/README.md](./agents/README.md#acting-for-a-person-app-servers)), which sends
`Nylorun-Subject` and `Nylorun-Scopes`. The key stays on the server. The server drops every
`Nylorun-*` header its own clients send, and never forwards `Origin`: the Runtime refuses an
application key sent with one (`403 origin_rejected`).

**Browsers and apps** present the token your identity provider gave the person, with
`Nylorun-Protocol: 7`. The Runtime verifies it against the identity file and takes the subject,
scopes, agents and sandbox grants from it. Nylorun mints no token and ships no browser client:
use your provider's SDK to sign in, and put the Runtime behind a reverse proxy that answers
[CORS](#cors-at-your-proxy). An issuer's token cannot act for anyone else: with
`Nylorun-Subject` it is a `403`.

**A sign-in proxy** (oauth2-proxy, or your gateway's OIDC plugin) signs people in and passes
their token on. In front of Studio, oauth2-proxy's `--pass-access-token` sends it as
`X-Forwarded-Access-Token`. In front of the Runtime, the token must arrive as
`Authorization: Bearer`; oauth2-proxy's `--pass-authorization-header` sends the ID token there,
so set the issuer's `audience` to the proxy's client id and put the scope claim in ID tokens.

`GET /v1/me` answers, for any of these credentials, who the Runtime takes the caller to be: the
subject, scopes, agents, sandbox grants and `via` (`application:<id>`, `subject` or
`issuer:<name>`).

## Operator keys

An operator key is an application key you create by name, one per server or tool, so you can
rotate or delete one without touching the others. It acts for the whole Tenant, or for a person
with `Nylorun-Subject`. A key is 64 hex characters, returned once; the Runtime keeps only its
SHA-256. A rotated or deleted key stops working on its next request.

From a terminal, on the Tenant's machine:

```sh
npx nylorun key put app-server     # create, or rotate: prints the new key once on stdout
npx nylorun key list               # id, role, when issued (never the keys); --json
npx nylorun key rm app-server      # it stops working at once
```

Add `--tenant <name>` outside the project the Tenant belongs to. From code, `@nylorun/admin`
(`admin.keys.put(id)`, `admin.keys.list()`, `admin.keys.delete(id)`;
[admin/README.md](./admin/README.md)), or the Admin API on the operator listener with the admin
key: `PUT /v1/admin/keys/{id}`, `GET /v1/admin/keys` and `DELETE /v1/admin/keys/{id}`.

- Ids match `^[a-z][a-z0-9-]{0,31}$`. `studio` is refused: Studio's key is derived from the
  admin key and is the only derived key.
- `nylorun start` gives the projects it links the key `project`, kept in
  `<Host root>/project-credentials.json` (0600) so every linked checkout shares it.
  `nylorun sandbox` and `nylorun mcp connect` use the key `cli` outside a project, kept in
  `<Host root>/cli-credentials.json`.
- Keep keys in your servers' secret store, never in a browser or a shipped app.

## The identity file

The identity file lists the identity providers whose JWTs the Runtime accepts (Host feature
`trusted-issuers`). Put it at `<Host root>/identity.yaml`
(`~/.nylorun/tenants/<tenant>/identity.yaml`): `nylorun start` then mounts it and sets
`NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml` on the runtime. A Runtime you deploy yourself
reads the path in `NYLORUN_IDENTITY_FILE`. The file is read once at boot. After adding it, run
`nylorun start` again; after editing it, restart the runtime (`nylorun stop`, then
`nylorun start`). A malformed file stops the runtime, naming the issuer and the field; an
unreachable JWKS never does.

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng
    audience: nylorun
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs
    subject: "u:{sub}"
    scopes: { claim: nylorun_scopes }
    allowedScopes: [agents:read, sessions:own, sandboxes:write, studio]
    agents: [support]
    sandboxes: ["{org_id}/*"]
    maxLifetime: 15m
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Matches `^[a-z][a-z0-9-]{0,31}$`, unique in the file. Tokens report `via: issuer:<name>` |
| `issuer` | yes | The tokens' `iss`, exactly; unique in the file. A bearer whose `iss` names it is verified by this issuer only |
| `audience` | yes | A value the tokens' `aud` must hold |
| `jwks` | one of `jwks`, `keys` | An `http(s)` URL without credentials. Fetched only there, without following redirects, within 5 s; keys are cached by `kid`, a token with an unknown `kid` refetches at most once a minute, and the cache refreshes in the background after 10 minutes |
| `keys` | one of `jwks`, `keys` | 1 to 16 PEM public keys: RSA of at least 2048 bits (RS256), P-256 (ES256) or Ed25519 (EdDSA) |
| `subject` | yes | The person, rendered from scalar claims (strings or numbers): `u:{sub}`, `{org_id}:{sub}`. It must reference a claim, may use braces only around claim names, and must render to 1–200 visible ASCII characters other than `host` and `installation`. A token missing the claim is refused |
| `scopes` | yes | Where the token's scopes come from: `{ claim: <name> }` (an array, or a space-separated string) or `{ fixed: [<scope>, …] }` (within `allowedScopes`) |
| `allowedScopes` | yes | The scopes this issuer may grant: any of `agents:read`, `sessions:own`, `sandboxes:write` and `studio`. Others in the claim are dropped |
| `agents` | no | The agent ids its tokens reach; absent reaches every agent |
| `sandboxes` | no | Up to 16 sandbox grant templates, each rendering to a sandbox id or a prefix ending in `/*`. A claim used here must be one id segment (`acme`, not `acme/x`), or that grant reaches nothing. Absent reaches no sandbox |
| `maxLifetime` | yes | The longest `exp - iat` accepted, from `1s` to `24h` (`15m`, `1h`) |

| Scope | Allows |
| --- | --- |
| `sessions:own` | The person's own sessions: create, list, read, stream, message, approve, respond, cancel; and their artifacts |
| `agents:read` | Listing the agents the token reaches |
| `sandboxes:write` | Creating and deleting the sandboxes its grants reach |
| `studio` | Signing in to Studio through a proxy (an operator scope: Studio shows the whole Tenant) |

Tokens are checked like this:

- RS256, ES256 or EdDSA only, at most 16 KiB, with `exp` and `iat`, and a 30 s clock
  tolerance. A header naming its own key (`jku`, `jwk`, `x5u`, `x5c`) or `crit` is refused.
- An expired token is `401` with `code: "token_expired"`. While a JWKS cannot be fetched,
  cached keys keep working and a token with a new `kid` is `401 issuer_unavailable`. Every
  other refusal is the opaque `404`; `nylorun logs runtime` shows the reason
  (`credential rejected`).
- Only its expiry ends a token, and an event stream opened with it ends then too
  (`token_expired`). Keep tokens short-lived and revoke people at your identity provider.

To check a file, call `GET /v1/me` with a real token: it shows the subject, scopes, agents and
sandbox grants the token renders to.

### Keycloak

In the realm (the example's is
[`examples/self-host/keycloak/realm-nylorun.json`](./examples/self-host/keycloak/realm-nylorun.json)):

1. Create realm roles named after the scopes (`agents:read`, `sessions:own`, `studio`) and
   give them to people.
2. On your client (or a client scope it uses), add two mappers: an **Audience** mapper that
   adds `nylorun` to the access token, and a **User Realm Role** mapper, multivalued, with the
   claim name `nylorun_scopes`.
3. For sandbox grants, map an attribute (or a hardcoded value) to a claim such as `org_id`.

Then:

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng      # Keycloak's hostname plus /realms/<realm>
    audience: nylorun
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs
    subject: "u:{sub}"                           # sub is the Keycloak user id
    scopes: { claim: nylorun_scopes }            # the realm roles; roles that are not scopes are dropped
    allowedScopes: [agents:read, sessions:own, sandboxes:write, studio]
    sandboxes: ["{org_id}/*"]
    maxLifetime: 15m                             # Keycloak's access tokens live 5 minutes by default
```

Set Keycloak's hostname (`KC_HOSTNAME`) so the `iss` is the same however Keycloak is reached,
and point `jwks` at an address the runtime container can reach.

## Credentials

A session's MCP credential comes from the session's attached vaults first, then from your
credential resolver. The model credential is the Tenant's own, set by `nylorun start` from the
project's `.env` or in Studio.

### Installation vaults

Installation vaults hold the installation's own credentials: shared tool keys and the MCP
servers the installation signs in to. Any session may attach one (`vaultIds` when the session
is created). Create them on Studio's **Connections** page, or with an application key acting for
no one:

```ts
const vault = await app.createVault({ scope: "installation", name: "tools", idempotencyKey: "tools" });
await app.createCredential(vault.id, {
  name: "linear",
  idempotencyKey: "linear",
  auth: { type: "bearer", url: "https://mcp.linear.app/mcp", token: process.env.LINEAR_TOKEN! },
});
```

Over HTTP that is `POST /v1/vaults` with `{ requestId, idempotencyKey, name, scope: "installation" }`,
then `POST /v1/vaults/{vaultId}/credentials`. Every vault route takes only an application key
acting for no one: acting for a person, or with an issuer's token, it is
`403 scope_required`.

### OAuth MCP servers

A remote MCP server that signs clients in with OAuth is connected once for the installation:

```sh
npx nylorun mcp connect https://mcp.example.com/mcp --server linear
# a server without dynamic client registration: register a client whose redirect URI is the
# callback below, and pass its id
npx nylorun mcp connect https://mcp.example.com/mcp --server linear --client-id <id>
```

It creates the installation vault `mcp` (or uses `--vault <id>`), opens the sign-in page and
waits up to 10 minutes for the credential, which the gateway refreshes. Connecting again
rotates it. An app server does the same with
`POST /v1/vaults/{vaultId}/oauth/start` (`{ url, server, clientId? }`, answering
`{ authorizeUrl, expiresAt }`).

The authorization server sends the browser back to `NYLORUN_PUBLIC_URL` +
`/v1/oauth/callback`. A local Tenant's is `http://localhost:<port>`, so sign in from a browser on
that machine. A Runtime you deploy yourself behind a proxy sets `NYLORUN_PUBLIC_URL` to its public
address; the proxy forwards `/v1/*`, which includes the callback. The gateway runs every OAuth
step; tokens never reach the runtime container. See
[DEPLOYMENT.md](./DEPLOYMENT.md#connecting-a-remote-mcp-server-with-oauth).

### The credential resolver

A person's own credentials (their GitHub token, their Linear connection) stay in your secret
store. When a person's session calls a remote MCP server and its attached vaults hold nothing for
the server's URL, the gateway asks your resolver:

```text
POST <NYLORUN_RESOLVER_URL>
Authorization: Bearer <NYLORUN_RESOLVER_TOKEN>
Content-Type: application/json

{ "owner": "u:priya", "session": "s_…", "turn": "t_…" | null,
  "target": { "kind": "mcp", "server": "github", "agent": "support", "url": "https://…/mcp" } }
```

| Answer | Effect |
| --- | --- |
| `200 { "headers": { "authorization": "Bearer …" }, "expiresAt"?: "<ISO time>" }` | The headers go on the MCP requests |
| `404` | The call goes without a credential |
| Anything else, a malformed body, or no answer within 5 s | The server is refused: `credential_unavailable` |

- `owner` is the session's owner and `turn` its active turn, from the Runtime's own record,
  never from the agent. `server` and `agent` are the MCP server's name and the agent that
  declares it.
- `headers` is a non-empty object of header names to strings, without line breaks. The
  transport's own headers (`host`, `content-length`, `content-type`, `transfer-encoding`,
  `connection`, `accept`, `mcp-session-id`, `mcp-protocol-version`) are refused.
- The gateway keeps `200` and `404` answers per owner and URL until `expiresAt`, at most 5
  minutes, and 60 s without one; concurrent lookups share one request; failures are not kept. A
  revoked credential can work for up to 5 minutes.
- The resolver is never asked for the installation's own sessions, only for a person's.
- The gateway allows private addresses for the resolver and never follows a redirect. Keep it
  on a private network, check the bearer, and answer `404` for a person who has not connected.

Set `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the gateway, both or neither (the
token has no whitespace). A local Tenant passes them from the shell that runs `nylorun start`, on
every start. In process: `TenantConfig.resolver`, or `startEphemeralRuntime({ resolver })`.

[`examples/self-host/resolver/resolver.mjs`](./examples/self-host/resolver/resolver.mjs) is a
resolver in about 50 lines: it reads `secret/data/nylorun/<owner>/<server>` from OpenBao's KV
and answers `{ headers: { authorization: "Bearer <token>" } }`, or `404`. A self-hosted Nango
or your own token service fits behind the same contract.

## Studio behind a sign-in proxy

Studio serves operators on loopback, signed in by `nylorun studio`. To open it to a team, put a
sign-in proxy such as [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front of
it, signed in against an issuer of the identity file:

1. List `studio` in the issuer's `allowedScopes` and put it in the tokens of the people who
   operate the installation. Admitted people see the whole Tenant, as an operator does.
2. Run the proxy with Studio as its upstream (`http://127.0.0.1:<NYLORUN_STUDIO_PORT>` on the
   same machine, or `http://studio:3000` from a container on the Tenant's network
   `nylorun-<tenant>`), passing the access token and the browser's `Host`:

   ```sh
   oauth2-proxy --provider=oidc --oidc-issuer-url=https://sso.acme.dev/realms/eng \
     --client-id=nylorun --client-secret=… --cookie-secret=… --email-domain='*' \
     --upstream=http://127.0.0.1:<studio port> --http-address=0.0.0.0:4180 \
     --pass-access-token=true --pass-host-header=true --cookie-refresh=4m
   ```

   The access token must be a JWT whose `iss` and `aud` match the identity file. If your
   provider's access tokens are opaque, pass the ID token with `--pass-authorization-header`
   and set the issuer's `audience` to the client id. Refresh the cookie (`--cookie-refresh`)
   more often than the access token expires.
3. Start the Tenant with the proxy's host name, comma-separated if there are several:
   `NYLORUN_STUDIO_ALLOWED_HOSTS=studio.acme.dev nylorun start`. Studio then accepts that `Host`
   beside `localhost` and `127.0.0.1`. It is read from the environment on every start, not kept.

Studio sends each forwarded token (`X-Forwarded-Access-Token`, or an `Authorization` bearer that
is a JWT) to the Runtime's `GET /v1/me` before it trusts it. With the `studio` scope it sets its
usual session cookie, which names the person in Studio's log of changes and ends no later than
the token. Without the scope it answers `403`, naming `studio`; a token the Runtime refuses gets
`401`. The cookie is `Secure` when the proxy sends `X-Forwarded-Proto: https`: serve the proxy
over HTTPS.

Embedding Studio in another app is separate and off by default
(`nylorun start --studio-embed-origin <origin>`).

## CORS at your proxy

The Runtime sends no CORS headers, and an `OPTIONS` request that reaches it gets `204` with
none, so browsers can call it only through a reverse proxy that answers CORS for your app's
origins (the rest of the proxy rules:
[DEPLOYMENT.md](./DEPLOYMENT.md#reaching-the-runtime-from-another-machine)):

- Answer preflights yourself: `Access-Control-Allow-Origin` with the exact origin,
  `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Nylorun-Protocol, Last-Event-ID`.
- On responses to those origins, add `Access-Control-Allow-Origin` and
  `Access-Control-Expose-Headers: Retry-After, WWW-Authenticate`, with `Vary: Origin`.
- Bearer tokens need no `Access-Control-Allow-Credentials`. Never answer `*`.
- Limit turns and requests per person here too: the Runtime has no per-person limits.

In the Caddy site of DEPLOYMENT.md, before the `@api` handle:

```caddyfile
	@preflight {
		method OPTIONS
		header Origin https://app.example.com
	}
	handle @preflight {
		header Access-Control-Allow-Origin "https://app.example.com"
		header Access-Control-Allow-Methods "GET, POST, PUT, DELETE"
		header Access-Control-Allow-Headers "Authorization, Content-Type, Nylorun-Protocol, Last-Event-ID"
		header Access-Control-Max-Age "600"
		header Vary Origin
		respond 204
	}
	@app header Origin https://app.example.com
	header @app Access-Control-Allow-Origin "https://app.example.com"
	header @app Access-Control-Expose-Headers "Retry-After, WWW-Authenticate"
	header @app Vary Origin
```

## Private addresses

The gateway's outbound requests to URLs that agents and apps name, Action deliveries and
endpoint pings, and every MCP OAuth step (discovery, registration, the code exchange and
refresh), follow three settings. Each is checked on the address actually connected to, so a DNS
answer cannot steer a request, and no redirect is followed.

| Setting | Values | Default |
| --- | --- | --- |
| `NYLORUN_ENDPOINT_PRIVATE` | `allow` or `refuse`: private, loopback and link-local addresses | `allow` |
| `NYLORUN_ENDPOINT_HTTP` | `allow` or `refuse`: plain `http` URLs | `allow` |
| `NYLORUN_ENDPOINT_LOOPBACK` | `docker-host`: `localhost` means the machine that runs Docker | unset; a local Tenant sets it |

A local Tenant allows private addresses, so it reaches Action endpoints and OAuth servers on the
same machine. **On a server, refuse them:** set `NYLORUN_ENDPOINT_PRIVATE=refuse` (and
`NYLORUN_ENDPOINT_HTTP=refuse`) on the gateway and the runtime, so a discovery document or a
registered URL cannot point the gateway at your internal network. If your Action endpoints live
on a private network, keep `allow` and limit the gateway's egress with your firewall instead.
The resolver and the identity file's `jwks` URLs are yours, so they are not subject to these
settings.

## Backups

Back up two things together, and keep them apart from each other:

- **Postgres**: agents, sessions and their event record, settings, key hashes, and the vault's
  encrypted credentials.
- **`<Host root>/keys/`**: the vault key (`vault-kek`). Without it the vault's credentials
  cannot be read; with it and the database, anyone can read them. Store its copy apart from the
  database dumps.

Back up the Object store's volume (file artifacts) with Postgres, and the Host root's
`host-credentials.json` (the admin key), `identity.yaml` and `docker/.env`. Your identity
provider and secret store keep the people and their credentials; back those up on their own
terms.

## Never expose the admin port

The operator listener (`NYLORUN_ADMIN_PORT`) serves the Admin API: operator keys and Host
status, with the admin key in `host-credentials.json`, which controls the whole installation.
`nylorun start` publishes it on `127.0.0.1` only. Never forward it, never publish it beyond
loopback, and keep the admin key on the machine. Proxy only the Runtime port, and answer
`/v1/admin/*` with `403` there as well
([DEPLOYMENT.md](./DEPLOYMENT.md#reaching-the-runtime-from-another-machine)). The same goes for
Restate's UI, the gateway (no published port), your secret store and your resolver: none of them
belongs on a public address.
