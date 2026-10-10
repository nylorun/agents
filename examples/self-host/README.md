# Self-host example: Keycloak and oauth2-proxy

A small team's installation on one machine, with no Nylorun account and nothing in the path that
belongs to Nylorun. It shows each front door of [SELF_HOSTING.md](../../guides/SELF_HOSTING.md):

- people sign in with **Keycloak**, and their access tokens call the Runtime directly (a trusted
  issuer in [`identity.yaml`](./identity.yaml));
- a backend uses an **application key** and acts for any person with `Nylorun-Subject`;
- **oauth2-proxy** signs people in to Studio, and only those with the `studio` scope get in.

Everything here uses development settings: fixed secrets in the files, a password-grant client
for the smoke, plain HTTP on loopback. Use it to learn the
shape, then replace each piece with your own.

| Service | Address | What it is |
| --- | --- | --- |
| Keycloak | `http://localhost:8180` (admin console: `admin` / `admin`) | Realm `nylorun` ([`keycloak/realm-nylorun.json`](./keycloak/realm-nylorun.json)): client `nylorun` for oauth2-proxy, client `nylorun-smoke` (password grant, smoke only), users `ada` / `ada` (scopes `agents:read`, `sessions:own`, `studio`) and `ben` / `ben` (`agents:read`, `sessions:own`) |
| oauth2-proxy | `http://localhost:4180` | Studio, behind Keycloak sign-in; passes the access token to Studio |
| The Tenant | the URLs `nylorun start` prints | Runtime, gateway, Studio and their stores, run by `nylorun` |

The realm's scopes are realm roles, put in the `nylorun_scopes` claim by a role mapper; an
audience mapper adds `nylorun` to `aud`, and a hardcoded `org_id: acme` claim gives every token
the sandbox grant `acme/*`. Every service joins the Tenant's Compose network (`nylorun-selfhost`),
so the runtime fetches Keycloak's keys at `http://keycloak:8080` and oauth2-proxy reaches Studio
at `http://studio:3000`.

## Run it

Needs Docker with Compose v2, Node.js 24, `curl`, and a `nylorun` release that speaks protocol 10.
Run the commands from this directory. `--no-link` keeps the Tenant from linking a project here.

```sh
# 1. The Tenant, with Studio's extra Host. nylorun start reads it from its environment on every
#    start, so export it in the shell you start the Tenant from.
export NYLORUN_STUDIO_ALLOWED_HOSTS=localhost:4180
npx nylorun start --tenant selfhost --no-link --no-open

# 2. The identity file, then a second start so the runtime reads it.
cp identity.yaml ~/.nylorun/tenants/selfhost/identity.yaml
npx nylorun start --tenant selfhost --no-link --no-open

# 3. Keycloak and oauth2-proxy (Keycloak takes a minute the first time).
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
4. Through oauth2-proxy, Studio refuses a request without a credential, answers ben with `403`,
   and signs ada in (`/_studio/hello` answers `200`). oauth2-proxy passes requests that carry a
   valid Keycloak JWT (`--skip-jwt-bearer-tokens`), so the smoke needs no browser.

Settings: `NYLORUN_TENANT`, `NYLORUN_CLI` (default `npx --yes nylorun`), `RUNTIME_URL`,
`NYLORUN_KEY` (use this key instead of rotating `smoke`), `KEYCLOAK_URL` and `PROXY_URL`.

The smoke runs by hand, not in CI. It leaves its agent and sessions in the Tenant.

## A person's MCP credential

A person's own key for an MCP server goes in their user vault (`ownerUserId` set to their
subject: `u:<their Keycloak sub>` with this example's identity file), as a `bearer` or `headers`
credential bound to the server's URL; only their sessions attach it. A server that needs each person's sign-in goes through an MCP gateway: one
credential in an installation vault with the gateway's key, `via` and an identity header, which
the Runtime fills with the session owner's subject. See "Reaching a person's accounts" in
[DEPLOYMENT.md](../../guides/DEPLOYMENT.md#reaching-a-persons-accounts). This example adds neither.

## Clean up

```sh
docker compose down -v
npx nylorun delete selfhost --yes
```

## From example to installation

- Serve Keycloak, oauth2-proxy and the Runtime's proxy over HTTPS, and set `--cookie-secure=true`.
- Replace every fixed secret: the Keycloak admin and client secret, and oauth2-proxy's
  `--cookie-secret` (`openssl rand -base64 32 | head -c 32`).
- Delete the `nylorun-smoke` client, and drop `--skip-jwt-bearer-tokens` unless your tools need
  it.
- Put `studio` only on the people who operate the installation.
