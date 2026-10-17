# Self-hosting

How a team runs Nylorun on its own machines with its own identity provider and secret store,
and no Nylorun account. Open source verifies and enforces; it never signs anyone in, never
manages people, and holds a person's secrets only where your app writes them: in an
Agent's vault. Your identity provider and your secret store plug in.

Read [DEPLOYMENT.md](./DEPLOYMENT.md) first: it covers the Tenant's containers, the reverse proxy
in front of the Runtime, Postgres, the gateway and the harness. This guide covers who gets in
and where credentials come from. [`examples/self-host`](../examples/self-host/README.md) runs
all of it on one machine with Keycloak and oauth2-proxy, and checks
it end to end. Upgrading from protocol 16:
[MIGRATION.md](./MIGRATION.md#a-queue-per-session-protocol-17); from protocol 15:
[MIGRATION.md](./MIGRATION.md#agents-from-one-manifest-protocol-16-harness-api-5); from protocol 10:
[MIGRATION.md](./MIGRATION.md#environments-replace-sandboxes-and-vaults-protocol-11-a-fresh-start);
from protocol 7: [MIGRATION.md](./MIGRATION.md#runtime-and-management-apis-protocol-8); from an
earlier release: [MIGRATION.md](./MIGRATION.md#open-source-auth-protocol-7).

## Scope

**One installation per trust domain.** A Runtime serves exactly one Tenant, the one its own
Postgres database holds. Everyone the installation serves shares its agent manifests, its
operators and its application keys, which reach every Agent. People or teams that must not share
those get separate installations.

Open source includes:

- verifying JWTs from your identity provider ([trusted issuers](#the-identity-file)), with
  scopes and Agent grants per issuer;
- application keys for your servers, which act for the whole Tenant or for one person, and
  management keys for your operators' tools;
- each person's sessions kept to that person (another person's session is a `404`);
- Agents, each with its own vault: one per person for their own keys (kept to them by the owner
  guard), or one per project or team for shared ones;
- Studio behind a sign-in proxy, for the people you give the `studio` scope.

It leaves out, on purpose:

- **sign-in**: no login page, passwords, sessions or social login. Use your identity provider;
- **user management**: no directory, invitations, groups or roles. A person is the subject
  your tokens or your server name; revoke people at your identity provider;
- **per-person OAuth**: Nylorun signs no one in to their tools and refreshes no token. A
  gateway holds each person's sign-ins
  ([DEPLOYMENT.md](./DEPLOYMENT.md#reaching-a-persons-accounts));
- **multi-tenancy**: one Tenant per installation;
- **CORS and rate limits**: your reverse proxy answers both.

Nothing calls Nylorun. Studio's anonymous page-view analytics is the only outbound call, and
nothing depends on it (`nylorun local telemetry disable`, or `NYLORUN_TELEMETRY_DISABLED=1`).

## Front doors

Every Tenant serves two APIs on one URL: the **Runtime API** (agent manifests,
Agents, sessions and artifacts) for apps and people, and the **Management API**
(`/v1/tenant/*`) for operators. There are four ways in, and an installation can use all of them:

| Front door | Credential | Who it acts for |
| --- | --- | --- |
| **An app server** | An [application key](#keys), with `Nylorun-Subject` and `Nylorun-Scopes` | On the Runtime API: any person your server names, with the scopes it names; the whole Tenant without them |
| **Browsers and apps** | A JWT from your identity provider, as `Authorization: Bearer` | On the Runtime API: the token's subject, with the scopes and Agents the [identity file](#the-identity-file) allows |
| **A sign-in proxy** | The person's JWT, forwarded by the proxy | The same as a browser's; Studio admits it with the `studio` scope ([Studio](#studio-behind-a-sign-in-proxy)) |
| **An operator's tool** (the CLI, CI, your scripts) | A [management key](#keys), from a server | Itself only, on the Management API: models, credential coverage, MCP previews, signing keys, settings, application keys, seed and reset. Never a person |

**An app server** signs people in itself and calls the Runtime for each one:
`client.as(subject, { scopes })` in `@nylorun/agents`
([sdks/agents/README.md](../sdks/agents/README.md#acting-for-a-person-app-servers)), which sends
`Nylorun-Subject` and `Nylorun-Scopes`. The key stays on the server. The server drops every
`Nylorun-*` header its own clients send, and never forwards `Origin`: the Runtime refuses an
application key sent with one (`403 origin_rejected`).

**Browsers and apps** present the token your identity provider gave the person, with
`Nylorun-Protocol: 17` (the Runtime serves 16 and 17; the SDKs send 17). The Runtime verifies it against the identity file and takes the subject,
scopes and Agent grants from it. Nylorun mints no token and ships no browser client:
use your provider's SDK to sign in, and put the Runtime behind a reverse proxy that answers
[CORS](#cors-at-your-proxy). An issuer's token cannot act for anyone else: with
`Nylorun-Subject` it is a `403`.

**A sign-in proxy** (oauth2-proxy, or your gateway's OIDC plugin) signs people in and passes
their token on. In front of Studio, oauth2-proxy's `--pass-access-token` sends it as
`X-Forwarded-Access-Token`. In front of the Runtime, the token must arrive as
`Authorization: Bearer`; oauth2-proxy's `--pass-authorization-header` sends the ID token there,
so set the issuer's `audience` to the proxy's client id and put the scope claim in ID tokens.

`GET /v1/me` answers, for any of these credentials, who the Runtime takes the caller to be: the
subject, scopes, Agent grants (`agents`) and `via` (`application:<id>`, `subject`,
`issuer:<name>` or `management:<id>`).

## Keys

Each API takes its own kind of key, and a key never crosses over: an application key on
`/v1/tenant/*`, or a management key anywhere else, is `403 key_role_mismatch`. Only `/v1/me`
and the public `GET /v1/access/jwks` answer both. You name each key, one per server or tool,
so you can rotate or delete one without touching the others. A key is 64 hex characters,
returned once; the Runtime keeps only its SHA-256. A rotated or deleted key stops working on
its next request.

| Key | Reaches | Issued by | Held by |
| --- | --- | --- | --- |
| **Application key** (role `application`) | The Runtime API, for the whole Tenant or for a person with `Nylorun-Subject` | A management key (`PUT /v1/tenant/keys/{keyId}`), or `nylorun tenant keys put <id>` on the machine | App servers |
| **Management key** (role `management`) | The Management API (`/v1/tenant/*`), as itself. Refused with `Origin`, `Nylorun-Subject` or `Nylorun-Scopes` | Only the Tenant's machine | Operators, CI, the CLI |

Studio's key (principal `studio`) is the only key derived from the admin key, and the only one
that reaches both APIs.

**Application keys.** From a terminal, on the Tenant's machine:

```sh
npx nylorun tenant keys put app-server     # create, or rotate: prints the new key once on stdout
npx nylorun tenant keys list       # id, role, when issued (never the keys); --json
npx nylorun tenant keys rm app-server  # it stops working at once
```

Add `--tenant <name>` outside the project the Tenant belongs to. From code, with a management
key: `@nylorun/admin` (`admin.keys.put(id)`, `admin.keys.list()`, `admin.keys.delete(id)`;
[sdks/admin/README.md](../sdks/admin/README.md)), or `PUT /v1/tenant/keys/{keyId}`, `GET /v1/tenant/keys`
and `DELETE /v1/tenant/keys/{keyId}`. The Management API issues application keys only.

**Management keys** are issued only on the Tenant's machine, so a leaked key can't mint
another:

```sh
npx nylorun tenant keys put ops --management                                # a local Tenant
docker compose exec runtime nylorun-operate keys put ops --role management   # a Compose file of your own
kubectl exec <runtime pod> -- nylorun-operate keys put ops --role management  # Kubernetes
```

`nylorun-operate` runs inside the runtime container; `keys list` and `keys rm <id>` list and
delete keys of either role. Where no one can run it, give the runtime a **bootstrap secret**:
a file holding a key of 64 lowercase hex characters (`openssl rand -hex 32`), named by
`NYLORUN_MANAGEMENT_KEY_FILE`. The Runtime registers it as the management key `bootstrap` at
every start, and replaces it when the file changes. Mount it as a secret file, never as an
environment value printed in logs.

- Ids match `^[a-z][a-z0-9-]{0,31}$`. `studio` and `bootstrap` are reserved. Putting an id
  that holds the other role is refused; rotating keeps the role.
- `nylorun start` gives the projects it links the application key `project` and the
  management key `project-management`, kept in `<Host root>/project-credentials.json` (0600)
  and the Project's `.nylorun/credentials.json` (`managementKey`, `managementPrincipalId`).
  Outside a project, `nylorun` keeps `cli` and `cli-management` in
  `<Host root>/cli-credentials.json`.
- `@nylorun/admin` reads a management key from `NYLORUN_MANAGEMENT_KEY` (with
  `NYLORUN_RUNTIME_URL`), else from those files; `nylorun` from `NYLORUN_MANAGEMENT_KEY`
  (with `NYLORUN_RUNTIME_URL`), else the local Tenant's Project credentials or Host root.
- Keep keys in your servers' secret store, never in a browser or a shipped app.

## The identity file

The identity file lists the identity providers whose JWTs the Runtime accepts (Host feature
`trusted-issuers`). Put it at `<Host root>/identity.yaml`
(`~/.nylorun/tenants/<tenant>/identity.yaml`): `nylorun start` then mounts it and sets
`NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml` on the runtime. A Runtime you deploy yourself
reads the path in `NYLORUN_IDENTITY_FILE`. The file is read once at boot. After adding it, run
`nylorun start` again; after editing it, restart the runtime (`nylorun stop`, then
`nylorun start`). A malformed file stops the runtime, naming the issuer and the field; an
unreachable JWKS never does. A key the file does not define is ignored, and the runtime logs
`identity_file_key_ignored` naming it: an older file's `maxLifetime` (removed in protocol 9),
or a typo. Check that log after an edit, since a misspelled optional field such as `agent:`
is ignored rather than refused.

Nylorun is never the authorization server: your identity provider signs people in and sets
how long their tokens live. Most installations list one provider:

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng
    audience: https://agents.acme.dev
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs
```

With every field:

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng
    audience: https://agents.acme.dev
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs
    subject: "u:{sub}"
    scopes: { claim: nylorun_scopes }
    allowedScopes: [agents:read, sessions:own, agents:write, studio]
    agents: ["{org_id}/*", support]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Matches `^[a-z][a-z0-9-]{0,31}$`, unique in the file. Tokens report `via: issuer:<name>` |
| `issuer` | yes | The tokens' `iss`, exactly; unique in the file. A bearer whose `iss` names it is verified by this issuer only |
| `audience` | yes | A value the tokens' `aud` must hold. Use the Runtime's public URL (`NYLORUN_PUBLIC_URL`) where your provider lets you: that is the RFC 8707 `resource` an OAuth client asks for. Some providers fix it to an id instead (Entra ID puts the API app's client id there) |
| `jwks` | one of `jwks`, `keys` | An `http(s)` URL without credentials. Fetched only there, without following redirects, within 5 s; keys are cached by `kid`, a token with an unknown `kid` refetches at most once a minute, and the cache refreshes in the background after 10 minutes |
| `keys` | one of `jwks`, `keys` | 1 to 16 PEM public keys: RSA of at least 2048 bits (RS256), P-256 (ES256) or Ed25519 (EdDSA) |
| `subject` | no, `{sub}` | The person, rendered from scalar claims (strings or numbers): `{sub}`, `u:{sub}`, `{oid}`, `{org_id}:{sub}`. It must reference a claim, may use braces only around claim names, and must render to 1–200 visible ASCII characters other than `host` and `installation`. A token missing the claim is refused. Use a stable id claim, never `email` or a username. An app server acting for the same people with `Nylorun-Subject` sends the same subject |
| `scopes` | no, `{ claim: scope }` | Where the token's scopes come from: `{ claim: <name> }` (an array, or a space-separated string) or `{ fixed: [<scope>, …] }` (within `allowedScopes`). The default is OAuth's `scope` claim; Entra ID and Okta use `scp` |
| `allowedScopes` | no, all but `studio` | The scopes this issuer may grant: any of `agents:read`, `sessions:own`, `agents:write` and `studio`. Others in the claim are dropped. The default is the first three: list `studio` explicitly to let this provider sign people in to Studio. `environments:write` (protocol 15) and `sandboxes:write` (protocol 10) stop the runtime, naming `agents:write` |
| `agents` | no | Agent grant templates, each rendering to `*`, an Agent id or a prefix ending in `/*` (`users/{sub}/*` reaches `users/alice/web`, not `users/alice`). A claim used here must be one id segment (`acme`, not `acme/x`), or that grant reaches nothing. Absent reaches no Agent. An `environments` key (protocol 15) or a `sandboxes` key (protocol 10) stops the runtime |

| Scope | Allows |
| --- | --- |
| `sessions:own` | The person's own sessions: create, list, read, stream, message, approve, respond, cancel; and their artifacts |
| `agents:read` | Reading and listing the Agents its grants reach |
| `agents:write` | Making, changing, stopping, resetting and deleting the Agents its grants reach, and writing their secrets |
| `studio` | Signing in to Studio through a proxy (an operator scope: Studio shows the whole Tenant) |

Tokens are checked like this:

- RS256, ES256 or EdDSA only, no longer than a request's headers may be (Node's `http.maxHeaderSize`, 16 KiB), with `exp`, and a 30 s clock tolerance. An
  `iat` in the future is refused. How long a token lives is your provider's setting. A
  header naming its own key (`jku`, `jwk`, `x5u`, `x5c`) or `crit` is refused.
- Refusals follow OAuth 2.1 (§5.3), each with a `WWW-Authenticate: Bearer` challenge:

  | Answer | When | Challenge |
  | --- | --- | --- |
  | `401 credential_required` | No `Authorization` header | `Bearer resource_metadata="…"` |
  | `401 credential_invalid` | A key the Tenant does not know, or a token that fails a check | `Bearer error="invalid_token", resource_metadata="…"` |
  | `401 token_expired` | Past `exp` | `Bearer error="invalid_token", error_description="The access token expired", …` |
  | `401 issuer_unavailable` | A new `kid` while the JWKS cannot be fetched; cached keys keep working | `Bearer resource_metadata="…"` |
  | `403 scope_required` | The token lacks the route's scope | `Bearer error="insufficient_scope", scope="sessions:own", …` |

  `nylorun local logs runtime` shows why a credential was refused (`credential rejected`); the
  client is never told. The Management API answers a missing or unknown key with the same
  `401` codes and a bare `Bearer` challenge: it takes management keys only and is no OAuth
  resource.
- Only its expiry ends a token, and an event stream opened with it ends then too
  (`token_expired`). Keep tokens short-lived and revoke people at your identity provider.

A token never reads or saves agent manifests: `agent-manifests:write` is for app servers and
operators, with an application key. To check a file, call `GET /v1/me` with a real token: it
shows the subject, scopes and Agent grants (`agents`) the token renders to.

### Discovery

With an identity file, the Runtime publishes its OAuth 2.0 protected resource metadata
(RFC 9728) at `GET /.well-known/oauth-protected-resource`, with no key, `Nylorun-Protocol` or
`Origin` rule:

```json
{
  "resource": "https://agents.acme.dev",
  "authorization_servers": ["https://sso.acme.dev/realms/eng"],
  "scopes_supported": ["agents:read", "sessions:own", "agents:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Nylorun Runtime API"
}
```

`resource` is `NYLORUN_PUBLIC_URL`, or the origin the request reached when it is unset, so set
it behind a proxy. Every `401` from the Runtime API points at this document, and a request
that sends neither a credential nor `Nylorun-Protocol` (a generic OAuth or MCP client) gets
that `401` rather than `426`. A client reads `authorization_servers`, signs the person in at
one of them, and calls again with the token. Without an identity file the document is a `404`
and challenges carry no `resource_metadata`.

`authorization_servers` keeps the identity file's order, and clients usually take the first:
list the provider generic clients should use first. A second provider is for a different
group of people (staff signing in to Studio through company sign-in, customers through Clerk or
Auth0) or for a migration. Give its `subject` a prefix of its own (`staff:{oid}`), or two
providers can name the same person.

### Keycloak

In the realm (the example's is
[`examples/self-host/keycloak/realm-nylorun.json`](../examples/self-host/keycloak/realm-nylorun.json)):

1. Create realm roles named after the scopes (`agents:read`, `sessions:own`, `studio`) and
   give them to people.
2. On your client (or a client scope it uses), add two mappers: an **Audience** mapper that
   adds the Runtime's audience (`nylorun` here) to the access token, and a **User Realm Role**
   mapper, multivalued, with the claim name `nylorun_scopes`.
3. For Agent grants, map an attribute (or a hardcoded value) to a claim such as `org_id`.

Then:

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng      # Keycloak's hostname plus /realms/<realm>
    audience: nylorun
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs
    subject: "u:{sub}"                           # sub is the Keycloak user id
    scopes: { claim: nylorun_scopes }            # the realm roles; roles that are not scopes are dropped
    allowedScopes: [agents:read, sessions:own, agents:write, studio]
    agents: ["{org_id}/*"]
```

Set Keycloak's hostname (`KC_HOSTNAME`) so the `iss` is the same however Keycloak is reached,
and point `jwks` at an address the runtime container can reach.

## Credentials

A session's MCP and HTTP tool credentials come from the vault of the Agent the session runs on:
the slot a server names in its manifest, else the credential bound to the URL the agent names
([DEPLOYMENT.md](./DEPLOYMENT.md#mcp-servers-and-http-tools) has the operator's whole flow:
credential types, previews, tool settings and errors). The model credential is the Tenant's own,
set by `nylorun start` from the project's `.env` or in Studio.

### Agents and their secrets

Each Agent has one vault, created and deleted with it. Your app server decides who uses which
Agent: one per person for their own keys, one per project or team for shared tool keys and MCP
gateway keys. A key many Agents use is written into each. Write them in Studio, or on the
Runtime API with an application key:

```ts
import { createClient } from "@nylorun/agents";

const client = await createClient(); // NYLORUN_RUNTIME_URL + NYLORUN_SERVER_KEY, or the Project link
// The manifest triage declares the slot: "linear": { "type": "bearer", "url": "https://mcp.linear.app/mcp" }
await client.agents.put("teams/support", { manifest: "triage" });
await client.agents.secrets.put("teams/support", "linear", { value: process.env.LINEAR_TOKEN! });
await client.createSession({ agent: "teams/support", ownerUserId: "u_7c41" });
```

Over HTTP that is `PUT /v1/agents/{id}` with `{ "manifest": "triage" }`, then
`PUT /v1/agents/{id}/secrets/{name}` (an id holding `/` is sent percent-encoded as one path
segment). An application key reaches every Agent; acting for a person, writing one needs
`agents:write`, and a trusted issuer's token reaches only the ids its issuer grants. No call
reads a secret back. Set `owner` on a person's Agent, so that only their sessions may run on it.

### Reaching a person's accounts

Nylorun holds no OAuth client, refreshes no token and asks no credential resolver (protocol 10).
A session reaches a person's tools in one of two ways, both set by the operator per server URL:

- **The person's own key** (a personal access token, say) goes in their own Agent, whose
  `owner` is them, as a `bearer` or `headers` credential bound to the server's URL. Only
  their sessions may run on it.
- **An MCP gateway** holds each person's sign-ins and refreshes them, for the servers that take
  only a person's OAuth sign-in. Put one credential for the server's URL in each Agent
  whose sessions use it: the gateway's key, `via` (the gateway's endpoint for that server) and an
  identity header.
  The Runtime fills that header with the session owner's subject, and leaves it out for a session
  owned by `installation`.

Before you put an MCP gateway in front of your people:

- The identity header carries the subject your identity provider or app server names (the
  `sub` of a trusted issuer's token, or the `ownerUserId` your app server sends). Have the
  MCP gateway know your people by that same id, and keep it stable: a renamed subject is a new
  person to it.
- The MCP gateway trusts whoever holds its key to name any person. No call reads it back from an
  Agent, replacing it takes a new value, and the Runtime takes the identity from the session
  record, never from the model or a manifest. Keep the key scoped to what your agents need, and
  give `agents:write` only to callers you trust to write the Agents that hold it.
- Check what your MCP gateway does with a request that names no one: an installation session sends
  none.
- Every tool argument and result passes through the MCP gateway, so it is part of your installation's
  trust domain.

The credential fields, recipes for Arcade, ToolHive, Obot and Nylorun Cloud, the proxy for gateways
that mint something per person (Composio, Klavis, Smithery, Pipedream), and servers that exchange a
client id and secret: [DEPLOYMENT.md](./DEPLOYMENT.md#reaching-a-persons-accounts).

## Studio behind a sign-in proxy

Studio serves operators on loopback, where it needs no sign-in: a request on its published
loopback address (`localhost` or `127.0.0.1` at its port) acts as signed in. Any other `Host`
and an embedded Studio keep their sign-in. To open it to a team, put a sign-in proxy such as [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front of
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

The gateway's outbound requests to URLs that agents name (HTTP tools and remote MCP servers), to a
credential's `via`, and those of MCP tool previews follow three settings. Each is checked on the
address actually connected to, so a DNS answer cannot steer a request, and no redirect is
followed.

| Setting | Values | Default |
| --- | --- | --- |
| `NYLORUN_ENDPOINT_PRIVATE` | `allow` or `refuse`: private, loopback and link-local addresses | `allow` |
| `NYLORUN_ENDPOINT_HTTP` | `allow` or `refuse`: plain `http` URLs | `allow` |
| `NYLORUN_ENDPOINT_LOOPBACK` | `docker-host`: `localhost` means the machine that runs Docker | unset; a local Tenant sets it |

A local Tenant allows private addresses, so it reaches HTTP tools, MCP servers and MCP gateways
on the same machine. **On a server, refuse them:** set `NYLORUN_ENDPOINT_PRIVATE=refuse` (and
`NYLORUN_ENDPOINT_HTTP=refuse`) on the gateway and the runtime, so a tool's URL, a `via` or a
server's metadata cannot point the gateway at your internal network. If the services your tools
call live on a private network, keep `allow` and limit the gateway's egress with your firewall instead.
The identity file's `jwks` URLs are yours, so they are not subject to these settings.

## Timeouts and retries

Every timeout, retry, poll interval and internal size of the Runtime's processes has a default
and can be set in `NYLORUN_TUNING`, one JSON object such as
`{"tenant":{"openTimeoutMs":60000}}`. Give every container the same value: each reads the parts
it uses, and core passes the harness's part to sandbox pods. The settings, their defaults and
their ceilings are in [Host tuning](./DEPLOYMENT.md#host-tuning).

## Backups

Back up two things together, and keep them apart from each other:

- **Postgres**: agent manifests, Agents, sessions and their event record, settings, key hashes,
  and the encrypted secrets of every vault (each Agent's and the model's).
- **`<Host root>/keys/`**: the vault key (`vault-kek`). Without it the stored secrets
  cannot be read; with it and the database, anyone can read them. Store its copy apart from the
  database dumps.

Back up the Object store's volume (file artifacts and skill files) with Postgres, and the Host
root's `host-credentials.json` (the admin key), `identity.yaml` and `docker/.env`. Your identity
provider and secret store keep the people and their credentials; back those up on their own
terms.

## Keep the root secrets on the machine

- **The admin key** in `host-credentials.json` is no request's credential, but Studio's key,
  which reaches both APIs, derives from it, and whoever holds it can mint Studio login tokens.
  Keep the file on the machine (mode 0600), out of images and repositories. Only an app that
  embeds Studio needs it, on its backend.
- **The bootstrap secret** (`NYLORUN_MANAGEMENT_KEY_FILE`) is a management key on disk. Handle
  it like the admin key: a secret file (a Kubernetes Secret, for example), never an environment
  value printed in logs. Change the file to rotate it.
- **Management keys** reach every setting of the Tenant, but no session or its content. Give
  them to operators and CI, never to app servers or browsers.
- **Optionally, limit `/v1/tenant/*` to operator networks at your proxy**, on top of the key
  role: the Management API then answers only from the addresses your operators and CI use
  ([DEPLOYMENT.md](./DEPLOYMENT.md#reaching-the-runtime-from-another-machine)).

Restate's UI, the gateway (no published port) and your secret store don't
belong on a public address either, and Studio reaches one only through a sign-in proxy.
