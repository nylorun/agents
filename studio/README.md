# @nylorun/studio

The Studio server: the session dashboard and the trusted Runtime proxy on one
origin. It ships only as the `ghcr.io/nylorun/studio` image, which the local
Docker stack runs as its `studio` service. This workspace package is private
and is not published to npm. It depends only on `@nylorun/agents` and
`@nylorun/admin` among Nylorun packages. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Using Studio

Developers never install this package. `nylorun` runs it in each stack:

```sh
npx nylorun start      # starts the project's stack, including Studio, and opens it signed in
npx nylorun studio     # signs a browser in
npx nylorun status     # reports Studio's health and URL
npx nylorun logs studio
```

Studio publishes on loopback (`127.0.0.1:4161` by default) and the CLI opens it
as `http://localhost:<port>`.

## Login and access

1. The CLI asks Studio for a login token: `POST /_studio/login-tokens` with the
   Host's admin key. The token is 256 random bits, single-use, and valid for
   two minutes.
2. The CLI opens `/login?token=…` (optionally `&next=/tenants/<id>`) in the
   browser and prints only `http://localhost:<port>`. Studio consumes the
   token, sets an `HttpOnly`, `SameSite=Strict` session cookie for 30 days and
   redirects to `next` or `/`.
3. Every `/_studio/*` request needs that cookie (or an embedded session's
   bearer). The dashboard's files carry no data and the `/` redirect names only
   the Tenant id, so they need none. The `Host` header must be `localhost` or
   `127.0.0.1` on the published port; state-changing requests must carry this
   origin's `Origin`; Studio never sends CORS headers.
4. The session cookie is `v1.<issued>.<nonce>.<signature>`, an HMAC-SHA256
   with a key derived from the admin key. Studio keeps no session state, so a
   session survives container restarts and ends after 30 days or when the admin
   key changes (`nylorun reset`).

Studio serves its installation's one Tenant: there is no Tenant list, picker
or create. It reads the Tenant from the Admin API (`admin.status().tenant`), and
`/` redirects to `/tenants/<id>`. While the Host cannot open its Tenant, `/`
answers `503` with the cause and its repair, the dashboard shows the same, and
Studio asks the Admin API again on the next request. The `/tenants/<id>` routes
and the `tenant` claim of embed login tokens stay (the embed contract); they
must name that Tenant, and any other id is an unknown Tenant (`404`).

A Tenant with no agents shows **Connect your code**: the model provider,
`npx nylorun start` in the project (it creates the project's stack and Tenant
and links the project to it) and `npm run dev`, and it switches to the agent
list when the first agent registers. The dashboard calls the Tenant API through
`/_studio/tenants/<id>/runtime/…`, which the server forwards with the Tenant's
Studio key (derived from the admin key and the Tenant id in memory) and no
`Nylorun-Tenant` header. No Runtime, admin or Tenant credential ever reaches
the browser.

Studio lists registered agents and sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. Each session shows chat beside an
**Events** inspector and an optional Agent Manifest tab. **Vault** and **Model
Settings** use the Tenant API. Token streaming, media and an approvals UI are
deferred.

## The image

```sh
docker build -f studio/Dockerfile -t nylorun-studio:dev .   # from the repository root
NYLORUN_STUDIO_IMAGE=nylorun-studio:dev nylorun start        # run it in the stack
```

The container entry is `dist/server-main.js`:

| Variable | Meaning |
| --- | --- |
| `NYLORUN_RUNTIME_URL` | The Runtime, e.g. `http://runtime:4000` (required) |
| `NYLORUN_ADMIN_KEY_FILE` | `host-credentials.json`, mounted read-only (required) |
| `PORT` | Listen port inside the container (default `3000`) |
| `NYLORUN_STUDIO_PUBLIC_PORT` | The published loopback port the browser uses |

`npm run build` type-checks and builds the server (`dist/*.js`) and the
dashboard (`dist/web`). `startStudioServer()` is exported for tests.

For repository development, see [CONTRIBUTING](../CONTRIBUTING.md).
