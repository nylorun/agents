# @nylorun/studio

The Studio server: the session dashboard and the trusted Runtime proxy on one
origin. It ships only as the `ghcr.io/nylorun/studio` image, which each local
Tenant runs as its `studio` Compose service. This workspace package is private
and is not published to npm. It depends only on `@nylorun/agents` and
`@nylorun/admin` among Nylorun packages. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Using Studio

Developers never install this package. `nylorun` runs it for each Tenant:

```sh
npx nylorun start      # starts the project's Tenant, including Studio, and opens it signed in
npx nylorun studio     # signs a browser in
npx nylorun status     # reports Studio's health and URL
npx nylorun logs studio
```

Studio publishes on loopback (`127.0.0.1:4161` by default) and the CLI opens it
as `http://localhost:<port>`. Each local Tenant's Studio has its own port and
session cookie; `nylorun studio --tenant <name>` opens any of them signed in.

## Login and access

Studio on this machine needs no sign-in: a request on the published loopback
address (`localhost` or `127.0.0.1` at Studio's port) with no session is served
as signed in, for the whole Tenant and no subject. A host in
`NYLORUN_STUDIO_ALLOWED_HOSTS` (a sign-in proxy) and an embedded Studio keep
their sign-in, below.

1. The CLI asks Studio for a login token: `POST /_studio/login-tokens` with the
   Host's admin key. The token is 256 random bits, single-use, and valid for
   two minutes. Its login URL is on the origin the CLI called (`localhost` or
   `127.0.0.1`).
2. The CLI opens `/login?token=…` (optionally `&next=/tenants/<id>`) in the
   browser and prints only Studio's origin. Studio consumes the token, sets an
   `HttpOnly`, `SameSite=Strict` session cookie for 30 days and redirects to
   `next` or `/`.
3. Every `/_studio/*` request needs that cookie (or an embedded session's
   bearer, or the loopback address). The dashboard's files carry no data and the `/` redirect names only
   the Tenant id, so they need none. The `Host` header must be `localhost` or
   `127.0.0.1` on the published port, or a host in
   `NYLORUN_STUDIO_ALLOWED_HOSTS` (any other answers `421`);
   state-changing requests must carry the request's own `Origin`; Studio never
   sends CORS headers.
4. The session cookie (`nylorun_studio_session`, or
   `NYLORUN_STUDIO_SESSION_COOKIE`) is `v1.<issued>.<nonce>.<signature>`, an
   HMAC-SHA256 with a key derived from the admin key. Studio keeps no session state, so a
   session survives container restarts and ends after 30 days or when the admin
   key changes (`nylorun reset`).
5. Behind a sign-in proxy, a request with no session that carries a JWT
   (`X-Forwarded-Access-Token`, or an `Authorization` bearer that is not a
   Studio session) signs in once the Runtime's `GET /v1/me` verifies it and
   reports the `studio` scope: Studio sets the same cookie, as
   `v3.<claims>.<signature>` naming the subject (for its log of state
   changes) and ending no later than the token. Without the scope it answers
   `403`; a token the Runtime refuses gets `401`. See
   [Studio behind a sign-in proxy](../guides/DEPLOYMENT.md#studio-behind-a-sign-in-proxy).

Studio serves its installation's one Tenant: there is no Tenant list, picker
or create. It reads the Tenant from the Runtime's `GET /v1/tenant` with its own
key, and `/` redirects to `/tenants/<id>`. While the Host cannot open its
Tenant, `/` answers `503` and points to `nylorun status` for the cause, the
dashboard shows the same, and Studio asks the Runtime again on the next request. The `/tenants/<id>` routes
and the `tenant` claim of embed login tokens stay (the embed contract); they
must name that Tenant, and any other id is an unknown Tenant (`404`).

A Tenant with no agents shows its name, full Tenant id and Runtime connection
status, with a short link to the documentation. Developers can use the SDK, CLI
or any Runtime API client; the agent list appears when the first agent registers.
Existing sessions open with their original owner and sandbox settings.
The dashboard calls the Runtime through
`/_studio/tenants/<id>/runtime/…`, which the server forwards with Studio's key
(`deriveStudioToken(adminKey)`, derived from the admin key in memory; role
`studio`, which reaches the Runtime API and the Management API) and no
`Nylorun-Tenant` header. No Runtime, admin or Tenant credential ever reaches
the browser.

Studio lists registered agents and sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. Each session shows chat beside an
**Events** inspector and an optional Agent Manifest tab. **Tenant settings** groups
Overview, Models and Credentials. Credentials lists installation vaults and
manages their URL-bound credentials through the Management API
(`@nylorun/admin/client`, `/v1/tenant/vaults`): a Bearer token or a Headers map
(name and value rows), with an optional gateway URL (`via`) and identity header,
and **Preview tools** on each one lists the MCP server's tools behind its URL
(`POST /v1/tenant/mcp/preview`). Overview and Models use it too;
secret reads return metadata only. Attach vaults explicitly using `vaultIds` when
creating a session with the SDK or API. Studio-created sessions attach none.
A person's own keys go in their user vault, which only their sessions attach.

Settings links use `/tenants/<id>/settings/overview`, `/settings/models` and
`/settings/credentials` under the same Tenant prefix. Legacy `/settings` and
`/vault` links redirect to Models and Credentials respectively, including embeds.
Token streaming, media, an approvals UI and a session vault selector are
deferred.

## The image

```sh
docker build -f studio/Dockerfile -t nylorun-studio:dev .   # from the repository root
NYLORUN_STUDIO_IMAGE=nylorun-studio:dev nylorun start        # run it for the Tenant
```

The container entry is `dist/server-main.js`:

| Variable | Meaning |
| --- | --- |
| `NYLORUN_RUNTIME_URL` | The Runtime, e.g. `http://runtime:4000` (required) |
| `NYLORUN_ADMIN_KEY_FILE` | `host-credentials.json`, mounted read-only (required) |
| `PORT` | Listen port inside the container (default `3000`) |
| `NYLORUN_STUDIO_PUBLIC_PORT` | The published loopback port the browser uses |
| `NYLORUN_STUDIO_ALLOWED_HOSTS` | Extra `Host` values Studio serves behind a sign-in proxy, comma-separated, such as `studio.acme.dev` (default none). See [Studio behind a sign-in proxy](../guides/DEPLOYMENT.md#studio-behind-a-sign-in-proxy) |
| `NYLORUN_STUDIO_SESSION_COOKIE` | The session cookie's name, `[A-Za-z0-9_-]+` (default `nylorun_studio_session`). `nylorun start` sets `nylorun_studio_<tenant>`: browsers share cookies across ports, so Studios on one host need their own |
| `NYLORUN_STUDIO_FRAME_ANCESTORS` | Exact origins that may frame the dashboard (default none) |
| `NYLORUN_STUDIO_ANALYTICS_ID` | Google Analytics measurement id for anonymous page views (default none: no analytics). `nylorun start` sets it unless telemetry is off; see [Telemetry](../nylorun/README.md#telemetry) |

`npm run build` type-checks and builds the server (`dist/*.js`) and the
dashboard (`dist/web`). `startStudioServer()` is exported for tests.

For repository development, see [CONTRIBUTING](../CONTRIBUTING.md).
