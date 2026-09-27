# @nylorun/studio

The Studio server: the session dashboard and the trusted Runtime proxy on one
origin. It ships only as the `ghcr.io/nylorun/studio` image, which the local
Docker stack runs as its `studio` service. This workspace package is private
and is not published to npm. It depends only on `@nylorun/agents` and
`@nylorun/admin` among Nylorun packages. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Using Studio

Developers never install this package. The CLI runs it:

```sh
nylorun start      # starts the stack, including Studio, and prints a login URL
nylorun studio     # opens a fresh login (on the linked Project's Tenant)
nylorun dev        # runs the Project and opens Studio on its Tenant
nylorun status     # reports Studio's health and URL
nylorun logs studio
```

Studio publishes on loopback (`127.0.0.1:4161` by default) and the CLI opens it
as `http://localhost:<port>`.

## Login and access

1. The CLI asks Studio for a login token: `POST /_studio/login-tokens` with the
   Host's admin key. The token is 256 random bits, single-use, and valid for
   two minutes.
2. The CLI opens `/login?token=…` (optionally `&next=/tenants/<id>`). Studio
   consumes the token, sets an `HttpOnly`, `SameSite=Strict` session cookie and
   redirects to `next` or `/`.
3. Every request needs that cookie, except `GET /healthz`. The `Host` header
   must be `localhost` or `127.0.0.1` on the published port; state-changing
   requests must carry this origin's `Origin`; Studio never sends CORS headers.
4. Sessions live in the Studio process and end when the container restarts.

The dashboard lists Tenants through the Admin API. Each Tenant view calls the
Tenant API through `/_studio/tenants/<id>/runtime/…`, which the server forwards
with that Tenant's Studio key (derived from the admin key in memory). No
Runtime, admin or Tenant credential ever reaches the browser.

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
