# Self-host example: Keycloak, oauth2-proxy, OpenBao and a resolver

A small team's installation on one machine, with no Nylorun account and nothing in the path that
belongs to Nylorun. It shows each front door of [SELF_HOSTING.md](../../SELF_HOSTING.md):

- people sign in with **Keycloak**, and their access tokens call the Runtime directly (a trusted
  issuer in [`identity.yaml`](./identity.yaml));
- a backend uses an **application key** and acts for any person with `Nylorun-Subject`;
- a person's own MCP credential comes from **OpenBao** through a **credential resolver**
  ([`resolver/resolver.mjs`](./resolver/resolver.mjs), about 50 lines, no dependencies);
- **oauth2-proxy** signs people in to Studio, and only those with the `studio` scope get in.

Everything here uses development settings: fixed secrets in the files, OpenBao in dev mode (in
memory), a password-grant client for the smoke, plain HTTP on loopback. Use it to learn the
shape, then replace each piece with your own.

| Service | Address | What it is |
| --- | --- | --- |
| Keycloak | `http://localhost:8180` (admin console: `admin` / `admin`) | Realm `nylorun` ([`keycloak/realm-nylorun.json`](./keycloak/realm-nylorun.json)): client `nylorun` for oauth2-proxy, client `nylorun-smoke` (password grant, smoke only), users `ada` / `ada` (scopes `agents:read`, `sessions:own`, `studio`) and `ben` / `ben` (`agents:read`, `sessions:own`) |
| oauth2-proxy | `http://localhost:4180` | Studio, behind Keycloak sign-in; passes the access token to Studio |
| OpenBao | `http://localhost:8200` (root token `selfhost-example-root-token`) | KV v2 at `secret/`; people's tokens at `secret/nylorun/<owner>/<server>` |
| Resolver | `http://localhost:8090`; `http://resolver:8090` for the gateway | Answers the gateway's credential lookups from OpenBao |
| The Tenant | the URLs `nylorun start` prints | Runtime, gateway, Studio and their stores, run by `nylorun` |

The realm's scopes are realm roles, put in the `nylorun_scopes` claim by a role mapper; an
audience mapper adds `nylorun` to `aud`, and a hardcoded `org_id: acme` claim gives every token
the sandbox grant `acme/*`. Every service joins the Tenant's Compose network (`nylorun-selfhost`),
so the runtime fetches Keycloak's keys at `http://keycloak:8080`, the gateway reaches
`http://resolver:8090`, and oauth2-proxy reaches Studio at `http://studio:3000`.

## Run it

Needs Docker with Compose v2, Node.js 24, `curl`, and a `nylorun` release that speaks protocol 8.
Run the commands from this directory. `--no-link` keeps the Tenant from linking a project here.

```sh
# 1. The Tenant, with the resolver and Studio's extra Host. nylorun start reads these three from
#    its environment on every start, so export them in the shell you start the Tenant from.
export NYLORUN_RESOLVER_URL=http://resolver:8090
export NYLORUN_RESOLVER_TOKEN=selfhost-example-resolver-token
export NYLORUN_STUDIO_ALLOWED_HOSTS=localhost:4180
npx nylorun start --tenant selfhost --no-link --no-open

# 2. The identity file, then a second start so the runtime reads it.
cp identity.yaml ~/.nylorun/tenants/selfhost/identity.yaml
npx nylorun start --tenant selfhost --no-link --no-open

# 3. Keycloak, oauth2-proxy, OpenBao and the resolver (Keycloak takes a minute the first time).
docker compose up -d --wait

# 4. The end-to-end check.
./smoke.sh
```

`NYLORUN_HOME` moves the Host root; copy `identity.yaml` there instead. Another Tenant name
works too: set `NYLORUN_TENANT_NETWORK=nylorun-<name>` for Compose and `NYLORUN_TENANT=<name>` for
the smoke.

Then open `http://localhost:4180` and sign in as `ada` / `ada`: Studio opens. Sign out of Keycloak
(or use a private window) and sign in as `ben` / `ben`: Studio refuses him, answering `403`
and naming the `studio` scope.

## What the smoke checks

[`smoke.sh`](./smoke.sh) needs `bash`, `curl` and `node`. It gets Keycloak tokens for `ben` and
`ada` with the password grant, then:

1. `GET /v1/me` with ben's token renders `issuer:keycloak`, the subject `u:<Keycloak user id>`,
   `agents:read` and `sessions:own` but not `studio`, and the sandbox grant `acme/*`; ada's has
   `studio`. A request with an `Origin` and ben's token is served.
2. An application key (`nylorun key put smoke`, which rotates that key on each run) acts for any
   person: it creates an agent, then a session for ben and one for another person with
   `Nylorun-Subject`. The same key sent with an `Origin` is `403 origin_rejected`.
3. ben's token lists his session and not the other one, gets `404` for the other one, `403` for a
   session owned by someone else, and `403` on `GET /v1/tenant/vaults` (the Management API).
4. It writes a token for ben to OpenBao and calls the resolver on its contract: `200` with
   `{ headers: { authorization: "Bearer …" } }` for ben's `github`, `404` for a person with none,
   `401` with a wrong bearer. It checks that the gateway has `NYLORUN_RESOLVER_URL` and reaches
   the resolver.
5. Through oauth2-proxy, Studio refuses a request without a credential, answers ben with `403`,
   and signs ada in (`/_studio/hello` answers `200`). oauth2-proxy passes requests that carry a
   valid Keycloak JWT (`--skip-jwt-bearer-tokens`), so the smoke needs no browser.

Settings: `NYLORUN_TENANT`, `NYLORUN_CLI` (default `npx --yes nylorun`), `RUNTIME_URL`,
`NYLORUN_KEY` (use this key instead of rotating `smoke`), `KEYCLOAK_URL`, `PROXY_URL`,
`RESOLVER_URL`, `NYLORUN_RESOLVER_TOKEN`, `BAO_ADDR` and `BAO_TOKEN`.

The smoke runs by hand, not in CI. It leaves its agent and sessions in the Tenant.

## A person's MCP credential

Put a person's token for an MCP server in OpenBao, under their subject and the server's name as
the agent declares it:

```sh
docker compose exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=selfhost-example-root-token \
  openbao bao kv put secret/nylorun/u:<Keycloak user id>/github token=<their token>
```

When one of that person's sessions calls the remote MCP server `github` and the session's attached
vaults hold nothing for its URL, the gateway asks the resolver and sends
`Authorization: Bearer <their token>`. `GET /v1/me` with their Keycloak token shows their subject.
The gateway keeps an answer for up to 60 seconds here (the resolver sends no `expiresAt`).

## Clean up

```sh
docker compose down -v
npx nylorun delete selfhost --yes
```

## From example to installation

- Serve Keycloak, oauth2-proxy and the Runtime's proxy over HTTPS, and set `--cookie-secure=true`.
- Replace every fixed secret: the Keycloak admin and client secret, oauth2-proxy's
  `--cookie-secret` (`openssl rand -base64 32 | head -c 32`), the resolver token, and OpenBao's
  root token. Run OpenBao sealed, with storage, and give the resolver a read-only policy on
  `secret/data/nylorun/*` instead of the root token.
- Delete the `nylorun-smoke` client, and drop `--skip-jwt-bearer-tokens` unless your tools need
  it.
- Put `studio` only on the people who operate the installation.
